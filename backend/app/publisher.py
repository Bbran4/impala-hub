"""Background worker that publishes due scheduled posts to Facebook.

Safety rules (a social post cannot be un-sent, so duplicates are worse than failures):
- A post is "claimed" with an optimistic UPDATE before any call to Facebook, so it cannot be sent twice.
- If the process dies mid-publish, the stale claim is turned into a `failed` post that asks a person
  to check the Page. It is never retried automatically.
- Only rate limits and connection failures that never reached Facebook are retried (up to 3 times).
- A post for a channel that is not connected is failed, never partly published.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from .facebook import FacebookClient, FacebookError
from .main import UPLOAD_PATH, audit, db_session, now_iso

log = logging.getLogger("impala.publisher")

STALE_CLAIM = timedelta(minutes=10)  # a claim older than this means the process died mid-publish
MAX_LATE = timedelta(hours=24)  # do not publish a post that missed its slot by more than this
MAX_ATTEMPTS = 3
SUPPORTED_CHANNELS = {"facebook"}
PENDING = "fb_pending_since"
ATTEMPTS = "fb_attempts"


def _fail(post_id: str, message: str, ids: dict) -> None:
    """Mark a post failed and clear the in-flight markers (a Facebook post id, if any, is kept)."""
    kept = {k: v for k, v in ids.items() if k not in (PENDING, ATTEMPTS)}
    with db_session() as db:
        db.execute(
            "UPDATE posts SET status='failed',last_error=?,provider_ids_json=?,updated_at=? WHERE id=?",
            (message, json.dumps(kept), now_iso(), post_id),
        )
        audit(db, "failed", "post", post_id, {"error": message})


def _recover_stale(now: datetime) -> None:
    with db_session() as db:
        rows = db.execute("SELECT id, provider_ids_json FROM posts WHERE status='scheduled'").fetchall()
    for row in rows:
        ids = json.loads(row["provider_ids_json"])
        since = ids.get(PENDING)
        if since and now - datetime.fromisoformat(since) > STALE_CLAIM:
            _fail(
                row["id"],
                "Publishing was interrupted. Check the Facebook Page to see whether this post went out "
                "before scheduling it again.",
                ids,
            )


def _process_one(client: FacebookClient, row, now: datetime, stats: dict) -> None:
    post = dict(row)
    post_id = post["id"]
    raw_ids = post["provider_ids_json"]
    ids = json.loads(raw_ids)
    if PENDING in ids:
        return  # already in flight (or waiting for stale recovery)

    channels = json.loads(post["channels_json"])
    unsupported = [c for c in channels if c not in SUPPORTED_CHANNELS]
    if now - datetime.fromisoformat(post["publish_at"]) > MAX_LATE:
        _fail(post_id, "This post missed its scheduled time by more than 24 hours and was not published.", ids)
        stats["failed"] += 1
        return
    if unsupported or "facebook" not in channels:
        names = ", ".join(unsupported) or "No supported channel"
        _fail(post_id, f"{names} is not connected yet. Remove it from this post and schedule it again.", ids)
        stats["failed"] += 1
        return

    # Claim the post. The WHERE clause makes this a compare-and-swap: only one claimer can win.
    with db_session() as db:
        claimed = db.execute(
            "UPDATE posts SET provider_ids_json=?,updated_at=? WHERE id=? AND status='scheduled' AND provider_ids_json=?",
            (json.dumps({**ids, PENDING: now_iso()}), now_iso(), post_id, raw_ids),
        )
        if claimed.rowcount != 1:
            return

    try:
        facebook_id = client.publish(post["caption"], [UPLOAD_PATH / m["id"] for m in json.loads(post["media_json"])])
    except FacebookError as exc:
        attempts = ids.get(ATTEMPTS, 0) + 1
        if exc.transient and attempts < MAX_ATTEMPTS:
            with db_session() as db:  # release the claim; the next cycle tries again
                db.execute(
                    "UPDATE posts SET provider_ids_json=?,last_error=?,updated_at=? WHERE id=?",
                    (json.dumps({**ids, ATTEMPTS: attempts}), f"Attempt {attempts} failed: {exc}. Retrying.", now_iso(), post_id),
                )
            stats["retry"] += 1
            return
        _fail(post_id, str(exc), ids)
        stats["failed"] += 1
        return
    except Exception as exc:  # e.g. an image file is missing. Never retry: Facebook may have received something.
        log.exception("Unexpected error publishing post %s", post_id)
        _fail(post_id, f"Unexpected error ({exc.__class__.__name__}). Check the Facebook Page before trying again.", ids)
        stats["failed"] += 1
        return

    with db_session() as db:
        db.execute(
            "UPDATE posts SET status='published',published_at=?,provider_ids_json=?,last_error=NULL,updated_at=? WHERE id=?",
            (now_iso(), json.dumps({"facebook": facebook_id}), now_iso(), post_id),
        )
        audit(db, "published", "post", post_id, {"status": "published", "channels": ["facebook"], "facebook_post_id": facebook_id})
    stats["published"] += 1


def process_due(client: FacebookClient, now: Optional[datetime] = None) -> dict:
    """Run one publishing cycle. Returns counts, which the tests use."""
    now = now or datetime.now(timezone.utc)
    stats = {"published": 0, "failed": 0, "retry": 0}
    _recover_stale(now)
    with db_session() as db:
        rows = db.execute("SELECT * FROM posts WHERE status='scheduled' AND publish_at IS NOT NULL").fetchall()
    due = sorted((r for r in rows if datetime.fromisoformat(r["publish_at"]) <= now), key=lambda r: r["publish_at"])
    for row in due:
        _process_one(client, row, now, stats)
    return stats


def _fb_time(value: str) -> str:
    """Facebook sends 2026-10-01T08:00:00+0000. Normalise to ISO UTC like the rest of the database."""
    value = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", value)
    return datetime.fromisoformat(value).astimezone(timezone.utc).isoformat()


def sync_posts(client: FacebookClient, limit: int = 100) -> dict:
    """Import the Page's published posts and refresh their likes, comments and shares.

    Posts already known to the app (published from here, or imported before) only get their figures
    updated. New ones are added as published posts. Facebook's natively scheduled posts are NOT
    imported, because the worker would then publish them a second time.
    """
    remote = client.list_published_posts(limit)
    stats = {"imported": 0, "updated": 0}
    stamp = now_iso()
    with db_session() as db:
        known = {}
        for row in db.execute("SELECT id, provider_ids_json FROM posts"):
            fb_id = json.loads(row["provider_ids_json"]).get("facebook")
            if fb_id:
                known[fb_id] = (row["id"], json.loads(row["provider_ids_json"]))
        for item in remote:
            # Keep sync bounded: the Page post listing supplies engagement in one paginated
            # flow. Fetching Insights separately for every post can turn one sync into dozens
            # of extra Graph API requests and cause the browser request to fail or time out.
            # Preserve any previously stored organic reach/impressions until a bounded
            # Insights refresh can run independently.
            insights = {"reach": None, "impressions": None}
            if item["id"] in known:
                local_id, ids = known[item["id"]]
                if item["permalink_url"]:
                    ids["permalink"] = item["permalink_url"]
                db.execute(
                    "UPDATE posts SET likes=COALESCE(?,likes),comments=COALESCE(?,comments),shares=COALESCE(?,shares),"
                    "reach=COALESCE(?,reach),impressions=COALESCE(?,impressions),"
                    "metrics_refreshed_at=?,provider_ids_json=? WHERE id=?",
                    (item["likes"], item["comments"], item["shares"], insights["reach"], insights["impressions"], stamp, json.dumps(ids), local_id),
                )
                stats["updated"] += 1
                continue
            local_id = "fb-" + item["id"].replace("_", "-")
            ids = {"facebook": item["id"], **({"permalink": item["permalink_url"]} if item["permalink_url"] else {})}
            media = [
                {"id": f"{local_id}-{n}", "name": "Facebook image", "url": src} for n, src in enumerate(item["images"], 1)
            ]
            published_at = _fb_time(item["created_time"]) if item["created_time"] else stamp
            db.execute(
                """INSERT INTO posts(id,title,caption,channels_json,status,published_at,media_json,provider_ids_json,
                   likes,comments,shares,reach,impressions,metrics_refreshed_at,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (local_id, "", item["message"], json.dumps(["facebook"]), "published", published_at, json.dumps(media),
                 json.dumps(ids), item["likes"], item["comments"], item["shares"], insights["reach"], insights["impressions"], stamp, stamp, stamp),
            )
            audit(db, "imported", "post", local_id, {"status": "published", "channels": ["facebook"], "facebook_post_id": item["id"]})
            stats["imported"] += 1
    return stats


async def run_forever(get_client: Callable[[], Optional[FacebookClient]], interval: int, sync_minutes: int = 10) -> None:
    """Run publishing and syncing until cancelled.

    get_client is called every cycle, so connecting, reconnecting or disconnecting a Page in the UI
    takes effect immediately. With no client configured the loop simply idles.
    """
    log.info("Facebook publisher started (publishes every %s s, syncs every %s min)", interval, sync_minutes)
    last_sync: Optional[datetime] = None
    while True:
        try:
            client = await asyncio.to_thread(get_client)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Could not read the Facebook connection")
            client = None
        if client:
            try:
                stats = await asyncio.to_thread(process_due, client)
                if any(stats.values()):
                    log.info("Publisher cycle: %s", stats)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Publisher cycle failed")
            if sync_minutes > 0 and (last_sync is None or datetime.now(timezone.utc) - last_sync >= timedelta(minutes=sync_minutes)):
                last_sync = datetime.now(timezone.utc)  # set first so a failing sync is not retried every cycle
                try:
                    stats = await asyncio.to_thread(sync_posts, client)
                    log.info("Facebook sync: %s", stats)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("Facebook sync failed")
        else:
            last_sync = None  # sync again promptly after a Page is connected
        await asyncio.sleep(max(5, interval))
