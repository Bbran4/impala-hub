from __future__ import annotations

import asyncio
import json
import secrets
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterator, Literal, Optional, get_args

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, create_model, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .facebook import FacebookError, client_from_settings


# --------------------------------------------------------------------------- settings
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_api_key: str = ""
    database_path: str = "./data/impala_hub.db"
    upload_dir: str = "./uploads"
    max_upload_mb: int = 15
    allow_insecure_local_dev: bool = False  # set ALLOW_INSECURE_LOCAL_DEV=true in .env to allow a weak key
    # Facebook Page publishing. Leave the page id or token empty to keep publishing switched off.
    facebook_page_id: str = ""
    facebook_page_token: str = ""
    facebook_api_version: str = "v26.0"  # use the version shown in your Meta app dashboard
    publisher_interval_seconds: int = 30
    facebook_sync_minutes: int = 10  # how often to import posts and figures from the Page; 0 turns it off


settings = Settings()
DB_PATH = Path(settings.database_path).resolve()
UPLOAD_PATH = Path(settings.upload_dir).resolve()
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
UPLOAD_PATH.mkdir(parents=True, exist_ok=True)

PLACEHOLDER_KEYS = {"", "local-dev-change-me", "replace-with-a-long-random-secret"}
MIN_KEY_LENGTH = 24


# --------------------------------------------------------------------------- database
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    """Commit on success, roll back on error, and always close the connection."""
    conn = connect()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    objective TEXT NOT NULL DEFAULT '',
    start_date TEXT,
    end_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    caption TEXT NOT NULL DEFAULT '',
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    channels_json TEXT NOT NULL DEFAULT '[]',
    facebook_groups_json TEXT NOT NULL DEFAULT '[]',
    whatsapp_recipient_type TEXT,
    whatsapp_recipient_id TEXT,
    whatsapp_recipient_name TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft','scheduled','published','needs_attention')),
    publish_at TEXT,
    media_json TEXT NOT NULL DEFAULT '[]',
    provider_ids_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
"""

# v2: title, approval/failed statuses, published_at, and nullable engagement metrics
# (NULL = "not reported by the platform", never 0). SQLite cannot alter a CHECK
# constraint, so the posts table is rebuilt and existing rows are copied across.
SCHEMA_V2 = """
BEGIN;
ALTER TABLE posts RENAME TO posts_v1;
CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    channels_json TEXT NOT NULL DEFAULT '[]',
    facebook_groups_json TEXT NOT NULL DEFAULT '[]',
    whatsapp_recipient_type TEXT,
    whatsapp_recipient_id TEXT,
    whatsapp_recipient_name TEXT,
    status TEXT NOT NULL CHECK(status IN ('draft','awaiting_approval','scheduled','published','failed')),
    publish_at TEXT,
    published_at TEXT,
    media_json TEXT NOT NULL DEFAULT '[]',
    provider_ids_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    clicks INTEGER,
    likes INTEGER,
    comments INTEGER,
    shares INTEGER,
    metrics_refreshed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT INTO posts(id, caption, campaign_id, channels_json, facebook_groups_json, whatsapp_recipient_type,
                  whatsapp_recipient_id, whatsapp_recipient_name, status, publish_at, media_json,
                  provider_ids_json, last_error, created_at, updated_at)
SELECT id, caption, campaign_id, channels_json, facebook_groups_json, whatsapp_recipient_type,
       whatsapp_recipient_id, whatsapp_recipient_name,
       CASE status WHEN 'needs_attention' THEN 'draft' ELSE status END,
       publish_at, media_json, provider_ids_json, last_error, created_at, updated_at
FROM posts_v1;
DROP TABLE posts_v1;
CREATE INDEX IF NOT EXISTS idx_posts_campaign ON posts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
PRAGMA user_version = 2;
COMMIT;
"""


def init_db() -> None:
    conn = connect()
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            conn.executescript(SCHEMA_V1)
        if version < 2:
            conn.executescript(SCHEMA_V2)
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    worker = None
    client = facebook_client()
    if client:
        from .publisher import run_forever  # imported here because publisher imports this module

        worker = asyncio.create_task(run_forever(client, settings.publisher_interval_seconds, settings.facebook_sync_minutes))
    try:
        yield
    finally:
        if worker:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)


def facebook_client():
    return client_from_settings(settings.facebook_page_id, settings.facebook_page_token, settings.facebook_api_version)


app = FastAPI(title="Impala Hub Marketing API", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
# Images are loaded by <img> tags, which cannot send an Authorization header, so /uploads is public.
# File names are random UUIDs, but do not upload anything confidential.
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_PATH)), name="uploads")


# --------------------------------------------------------------------------- auth
def key_is_weak(key: str) -> bool:
    return key in PLACEHOLDER_KEYS or len(key) < MIN_KEY_LENGTH


def require_api_key(authorization: Optional[str] = Header(default=None)) -> None:
    expected = settings.app_api_key
    if key_is_weak(expected) and not settings.allow_insecure_local_dev:
        raise HTTPException(
            status_code=503,
            detail="Set APP_API_KEY in backend/.env to a random value of at least 24 characters, then restart the API",
        )
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    # Compare bytes: compare_digest raises TypeError on non-ASCII str, which would be a 500.
    if not expected or not secrets.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Missing or invalid API key")


def audit(db: sqlite3.Connection, action: str, entity_type: str, entity_id: str, details: dict) -> None:
    db.execute(
        "INSERT INTO audit_log(action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?)",
        (action, entity_type, entity_id, json.dumps(details), now_iso()),
    )


# --------------------------------------------------------------------------- models
Channel = Literal["facebook", "instagram", "whatsapp"]
PostStatus = Literal["draft", "awaiting_approval", "scheduled", "published", "failed"]
# Clients may only choose these. "published" and "failed" are set by the publishing worker (not built yet).
InputStatus = Literal["draft", "awaiting_approval", "scheduled"]
# Scheduled and published posts are frozen: only their campaign may be changed.
LOCKED_STATUSES = {"scheduled", "published"}


def validate(model: type[BaseModel], values: dict) -> BaseModel:
    try:
        return model.model_validate(values)
    except ValidationError as exc:
        raise HTTPException(422, detail=exc.errors(include_url=False, include_context=False, include_input=False))


class CampaignIn(BaseModel):
    name: str = Field(max_length=160)
    objective: str = Field(default="", max_length=1000)
    start_date: Optional[date] = None
    end_date: Optional[date] = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name must not be blank")
        return v

    @model_validator(mode="after")
    def dates_in_order(self) -> "CampaignIn":
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("End date must not be before the start date")
        return self


class MediaIn(BaseModel):
    id: str = Field(pattern=r"^[0-9a-f]{32}\.(jpg|png|webp|gif)$")
    name: str = Field(max_length=255)
    url: str
    content_type: Optional[str] = None
    size: Optional[int] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def url_is_local_upload(self) -> "MediaIn":
        if self.url != f"/uploads/{self.id}":
            raise ValueError("Media must reference a file uploaded through /api/media")
        return self


class PostIn(BaseModel):
    title: str = Field(default="", max_length=160)
    caption: str = Field(default="", max_length=10000)
    campaign_id: Optional[str] = None
    channels: list[Channel] = Field(default_factory=list)
    facebook_groups: list[str] = Field(default_factory=list, max_length=3)
    whatsapp_recipient_type: Optional[str] = None  # WhatsApp rules are deliberately unchanged for now
    whatsapp_recipient_id: Optional[str] = None
    whatsapp_recipient_name: Optional[str] = None
    status: InputStatus = "draft"
    publish_at: Optional[datetime] = None
    media: list[MediaIn] = Field(default_factory=list, max_length=10)

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str) -> str:
        return v.strip()

    @field_validator("channels", "facebook_groups")
    @classmethod
    def dedupe(cls, v: list) -> list:
        return list(dict.fromkeys(v))

    @field_validator("publish_at")
    @classmethod
    def to_utc(cls, v: Optional[datetime]) -> Optional[datetime]:
        if v is None:
            return None
        return (v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v).astimezone(timezone.utc)

    @model_validator(mode="after")
    def business_rules(self) -> "PostIn":
        if "facebook" not in self.channels:
            self.facebook_groups = []
        if "whatsapp" not in self.channels:
            self.whatsapp_recipient_type = self.whatsapp_recipient_id = self.whatsapp_recipient_name = None
        elif self.whatsapp_recipient_type not in {"contact", "group"}:
            raise ValueError("Choose a WhatsApp contact or group")
        if self.status == "scheduled":
            if not self.publish_at:
                raise ValueError("A publication date and time is required for scheduled posts")
            if self.publish_at <= datetime.now(timezone.utc):
                raise ValueError("Choose a future date and time to schedule a post")
            if not self.channels:
                raise ValueError("Choose at least one channel before scheduling")
            if "instagram" in self.channels and not self.media:
                raise ValueError("Instagram posts need at least one image")
        return self


# Partial-update models: same fields as the full models, all optional.
CampaignPatch = create_model(
    "CampaignPatch", **{n: (Optional[f.annotation], None) for n, f in CampaignIn.model_fields.items()}
)
PostPatch = create_model("PostPatch", **{n: (Optional[f.annotation], None) for n, f in PostIn.model_fields.items()})


# --------------------------------------------------------------------------- row helpers
def campaign_row(row: sqlite3.Row) -> dict:
    return dict(row)


def post_row(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["channels"] = json.loads(item.pop("channels_json"))
    item["facebook_groups"] = json.loads(item.pop("facebook_groups_json"))
    item["media"] = json.loads(item.pop("media_json"))
    item["provider_ids"] = json.loads(item.pop("provider_ids_json"))
    return item


def fetch_post(db: sqlite3.Connection, post_id: str) -> dict:
    row = db.execute("SELECT * FROM posts WHERE id=?", (post_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Post not found")
    return post_row(row)


def fetch_campaign(db: sqlite3.Connection, campaign_id: str) -> dict:
    row = db.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Campaign not found")
    return campaign_row(row)


def check_references(db: sqlite3.Connection, data: PostIn) -> None:
    if data.campaign_id and not db.execute("SELECT 1 FROM campaigns WHERE id=?", (data.campaign_id,)).fetchone():
        raise HTTPException(422, "Selected campaign does not exist")
    for m in data.media:
        if not (UPLOAD_PATH / m.id).is_file():
            raise HTTPException(422, f"Image {m.name} was not uploaded to this server")


def post_values(data: PostIn) -> tuple:
    return (
        data.title, data.caption, data.campaign_id, json.dumps(data.channels), json.dumps(data.facebook_groups),
        data.whatsapp_recipient_type, data.whatsapp_recipient_id, data.whatsapp_recipient_name, data.status,
        data.publish_at.isoformat() if data.publish_at else None,
        json.dumps([m.model_dump() for m in data.media]),
    )


# --------------------------------------------------------------------------- routes
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "impala-hub-marketing", "version": app.version}


@app.get("/api/campaigns", dependencies=[Depends(require_api_key)])
def list_campaigns() -> list[dict]:
    with db_session() as db:
        return [campaign_row(r) for r in db.execute("SELECT * FROM campaigns ORDER BY updated_at DESC")]


def campaign_values(data: CampaignIn) -> tuple:
    return (
        data.name, data.objective,
        data.start_date.isoformat() if data.start_date else None,
        data.end_date.isoformat() if data.end_date else None,
    )


@app.post("/api/campaigns", dependencies=[Depends(require_api_key)], status_code=201)
def create_campaign(payload: CampaignIn) -> dict:
    campaign_id, stamp = str(uuid.uuid4()), now_iso()
    with db_session() as db:
        db.execute(
            "INSERT INTO campaigns(id,name,objective,start_date,end_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (campaign_id, *campaign_values(payload), stamp, stamp),
        )
        audit(db, "created", "campaign", campaign_id, {"name": payload.name})
        return fetch_campaign(db, campaign_id)


@app.patch("/api/campaigns/{campaign_id}", dependencies=[Depends(require_api_key)])
def update_campaign(campaign_id: str, patch: CampaignPatch) -> dict:  # type: ignore[valid-type]
    with db_session() as db:
        current = fetch_campaign(db, campaign_id)
        merged = {k: current[k] for k in CampaignIn.model_fields} | patch.model_dump(exclude_unset=True)
        data = validate(CampaignIn, merged)
        db.execute(
            "UPDATE campaigns SET name=?,objective=?,start_date=?,end_date=?,updated_at=? WHERE id=?",
            (*campaign_values(data), now_iso(), campaign_id),
        )
        audit(db, "updated", "campaign", campaign_id, {"name": data.name})
        return fetch_campaign(db, campaign_id)


@app.get("/api/posts", dependencies=[Depends(require_api_key)])
def list_posts(status: Optional[PostStatus] = None, campaign_id: Optional[str] = None) -> list[dict]:
    query, args, filters = "SELECT * FROM posts", [], []
    if status:
        filters.append("status=?")
        args.append(status)
    if campaign_id:
        filters.append("campaign_id=?")
        args.append(campaign_id)
    if filters:
        query += " WHERE " + " AND ".join(filters)
    query += " ORDER BY COALESCE(publish_at,created_at) DESC"
    with db_session() as db:
        return [post_row(r) for r in db.execute(query, args)]


@app.post("/api/posts", dependencies=[Depends(require_api_key)], status_code=201)
def create_post(payload: PostIn) -> dict:
    post_id, stamp = str(uuid.uuid4()), now_iso()
    with db_session() as db:
        check_references(db, payload)
        db.execute(
            """INSERT INTO posts(id,title,caption,campaign_id,channels_json,facebook_groups_json,whatsapp_recipient_type,
               whatsapp_recipient_id,whatsapp_recipient_name,status,publish_at,media_json,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (post_id, *post_values(payload), stamp, stamp),
        )
        audit(db, "created", "post", post_id, {"status": payload.status, "channels": payload.channels})
        return fetch_post(db, post_id)


@app.patch("/api/posts/{post_id}", dependencies=[Depends(require_api_key)])
def update_post(post_id: str, patch: PostPatch) -> dict:  # type: ignore[valid-type]
    changes = patch.model_dump(exclude_unset=True)
    with db_session() as db:
        current = fetch_post(db, post_id)
        if current["status"] in LOCKED_STATUSES:
            blocked = sorted(set(changes) - {"campaign_id"})
            if blocked:
                raise HTTPException(
                    409, f"A {current['status']} post can only have its campaign changed (not: {', '.join(blocked)})"
                )
            new_campaign = changes.get("campaign_id")
            if "campaign_id" in changes and new_campaign != current["campaign_id"]:
                if new_campaign and not db.execute("SELECT 1 FROM campaigns WHERE id=?", (new_campaign,)).fetchone():
                    raise HTTPException(422, "Selected campaign does not exist")
                db.execute("UPDATE posts SET campaign_id=?,updated_at=? WHERE id=?", (new_campaign, now_iso(), post_id))
                audit(db, "updated", "post", post_id, {"status": current["status"], "changed": ["campaign_id"]})
            return fetch_post(db, post_id)
        base = {k: current[k] for k in PostIn.model_fields}
        if base["status"] not in get_args(InputStatus):  # e.g. a failed post being reworked
            base["status"] = "draft"
        before = validate(PostIn, base)
        data = validate(PostIn, base | changes)
        check_references(db, data)
        db.execute(
            """UPDATE posts SET title=?,caption=?,campaign_id=?,channels_json=?,facebook_groups_json=?,
               whatsapp_recipient_type=?,whatsapp_recipient_id=?,whatsapp_recipient_name=?,status=?,publish_at=?,
               media_json=?,updated_at=? WHERE id=?""",
            (*post_values(data), now_iso(), post_id),
        )
        changed = [k for k in PostIn.model_fields if getattr(before, k) != getattr(data, k)]
        audit(db, "updated", "post", post_id, {"status": data.status, "channels": data.channels, "changed": changed})
        return fetch_post(db, post_id)


@app.get("/api/posts/{post_id}/history", dependencies=[Depends(require_api_key)])
def post_history(post_id: str) -> list[dict]:
    with db_session() as db:
        fetch_post(db, post_id)  # 404 if missing
        rows = db.execute(
            "SELECT * FROM audit_log WHERE entity_type='post' AND entity_id=? ORDER BY id DESC", (post_id,)
        ).fetchall()
    return [audit_item(r) for r in rows]


@app.delete("/api/posts/{post_id}", dependencies=[Depends(require_api_key)], status_code=204)
def delete_post(post_id: str) -> None:
    with db_session() as db:
        if fetch_post(db, post_id)["status"] == "published":
            raise HTTPException(409, "Published posts are kept as a record and cannot be deleted")
        db.execute("DELETE FROM posts WHERE id=?", (post_id,))
        audit(db, "deleted", "post", post_id, {})


@app.post("/api/media", dependencies=[Depends(require_api_key)], status_code=201)
def upload_media(file: UploadFile = File(...)) -> dict:
    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    if file.content_type not in allowed_types:
        raise HTTPException(415, "Upload a JPG, PNG, WEBP or GIF image")
    limit = settings.max_upload_mb * 1024 * 1024
    raw = file.file.read(limit + 1)
    if len(raw) > limit:
        raise HTTPException(413, f"Image exceeds the {settings.max_upload_mb} MB upload limit")
    signatures = {
        "image/jpeg": lambda b: b.startswith(b"\xff\xd8\xff"),
        "image/png": lambda b: b.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": lambda b: len(b) >= 12 and b.startswith(b"RIFF") and b[8:12] == b"WEBP",
        "image/gif": lambda b: b.startswith((b"GIF87a", b"GIF89a")),
    }
    if not raw or not signatures[file.content_type](raw):
        raise HTTPException(415, "The uploaded file does not match its image format")
    ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}[file.content_type]
    name = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_PATH / name).write_bytes(raw)
    return {
        "id": name,
        "name": Path(file.filename or name).name[:255],
        "url": f"/uploads/{name}",
        "content_type": file.content_type,
        "size": len(raw),
    }


def facebook_integration() -> dict:
    base = {"provider": "facebook", "label": "Facebook Pages", "capabilities": ["page_posts", "page_media"]}
    client = facebook_client()
    if not client:
        note = "Set FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN in backend/.env, then restart the API."
        return {**base, "status": "not_connected", "note": note}
    try:
        return {**base, "status": "connected", "account_name": client.check().get("name", client.page_id)}
    except FacebookError as exc:
        return {**base, "status": "error", "note": f"Facebook rejected the connection: {exc}"}


@app.post("/api/integrations/facebook/sync", dependencies=[Depends(require_api_key)])
def sync_facebook() -> dict:
    client = facebook_client()
    if not client:
        raise HTTPException(409, "Facebook is not connected. Set FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN in backend/.env.")
    from .publisher import sync_posts  # imported here because publisher imports this module

    try:
        return sync_posts(client)
    except FacebookError as exc:
        raise HTTPException(502, f"Facebook: {exc}")


@app.get("/api/integrations", dependencies=[Depends(require_api_key)])
def integrations() -> list[dict]:
    # Deliberately no fake connected accounts: "connected" only after a live check against Facebook.
    return [
        facebook_integration(),
        {"provider": "instagram", "label": "Instagram Professional", "status": "not_connected", "capabilities": ["image_posts", "carousel_posts"]},
        {"provider": "whatsapp", "label": "WhatsApp Business Platform", "status": "not_connected", "capabilities": ["business_messaging"], "note": "Group messaging availability depends on account eligibility and supported Meta APIs."},
    ]


def audit_item(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["details"] = json.loads(item.pop("details_json"))
    return item


@app.get("/api/audit", dependencies=[Depends(require_api_key)])
def audit_log(limit: int = Query(100, ge=1, le=500)) -> list[dict]:
    with db_session() as db:
        rows = db.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [audit_item(r) for r in rows]
