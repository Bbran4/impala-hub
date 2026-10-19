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
from datetime import datetime, timedelta, timezone
from typing import Optional

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


async def run_forever(client: FacebookClient, interval: int) -> None:
    log.info("Facebook publisher started (checks every %s seconds)", interval)
    while True:
        try:
            stats = await asyncio.to_thread(process_due, client)
            if any(stats.values()):
                log.info("Publisher cycle: %s", stats)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Publisher cycle failed")
        await asyncio.sleep(max(5, interval))
