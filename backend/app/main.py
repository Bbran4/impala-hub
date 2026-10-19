from __future__ import annotations

import json
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_api_key: str = "local-dev-change-me"
    database_path: str = "./data/impala_hub.db"
    upload_dir: str = "./uploads"
    max_upload_mb: int = 15

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
DB_PATH = Path(settings.database_path).resolve()
UPLOAD_PATH = Path(settings.upload_dir).resolve()
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
UPLOAD_PATH.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Impala Hub Marketing API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_PATH)), name="uploads")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init_db() -> None:
    with connect() as db:
        db.executescript(
            """
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
        )


@app.on_event("startup")
def startup() -> None:
    init_db()


def require_api_key(authorization: Optional[str] = Header(default=None)) -> None:
    expected = settings.app_api_key
    if not expected or expected == "local-dev-change-me":
        # Prevent accidentally exposing a server with the placeholder secret.
        if os.getenv("ALLOW_INSECURE_LOCAL_DEV", "0") != "1":
            raise HTTPException(status_code=503, detail="Set APP_API_KEY in backend/.env before using the API")
        expected = "local-dev-change-me"
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Missing or invalid API key")


def audit(db: sqlite3.Connection, action: str, entity_type: str, entity_id: str, details: dict) -> None:
    db.execute(
        "INSERT INTO audit_log(action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?)",
        (action, entity_type, entity_id, json.dumps(details), now_iso()),
    )


class CampaignIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    objective: str = Field(default="", max_length=1000)
    start_date: Optional[str] = None
    end_date: Optional[str] = None


class PostIn(BaseModel):
    caption: str = Field(default="", max_length=10000)
    campaign_id: Optional[str] = None
    channels: list[str] = Field(default_factory=list)
    facebook_groups: list[str] = Field(default_factory=list, max_length=3)
    whatsapp_recipient_type: Optional[str] = None
    whatsapp_recipient_id: Optional[str] = None
    whatsapp_recipient_name: Optional[str] = None
    status: str = "draft"
    publish_at: Optional[str] = None
    media: list[dict] = Field(default_factory=list)

    def validate_business_rules(self) -> None:
        allowed = {"facebook", "instagram", "whatsapp"}
        if any(c not in allowed for c in self.channels):
            raise HTTPException(422, "Unsupported channel selected")
        if len(set(self.facebook_groups)) > 3:
            raise HTTPException(422, "Choose no more than three additional Facebook groups")
        if self.status not in {"draft", "scheduled", "published", "needs_attention"}:
            raise HTTPException(422, "Unsupported post status")
        if self.status == "scheduled" and not self.publish_at:
            raise HTTPException(422, "A publication date and time is required for scheduled posts")
        if "whatsapp" in self.channels and self.whatsapp_recipient_type not in {"contact", "group"}:
            raise HTTPException(422, "Choose a WhatsApp contact or group")


def campaign_row(row: sqlite3.Row) -> dict:
    return dict(row)


def post_row(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["channels"] = json.loads(item.pop("channels_json"))
    item["facebook_groups"] = json.loads(item.pop("facebook_groups_json"))
    item["media"] = json.loads(item.pop("media_json"))
    item["provider_ids"] = json.loads(item.pop("provider_ids_json"))
    return item


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "impala-hub-marketing", "version": app.version}


@app.get("/api/campaigns", dependencies=[Depends(require_api_key)])
def list_campaigns() -> list[dict]:
    with connect() as db:
        return [campaign_row(r) for r in db.execute("SELECT * FROM campaigns ORDER BY updated_at DESC")]


@app.post("/api/campaigns", dependencies=[Depends(require_api_key)], status_code=201)
def create_campaign(payload: CampaignIn) -> dict:
    campaign_id, stamp = str(uuid.uuid4()), now_iso()
    with connect() as db:
        db.execute(
            "INSERT INTO campaigns(id,name,objective,start_date,end_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (campaign_id, payload.name.strip(), payload.objective, payload.start_date, payload.end_date, stamp, stamp),
        )
        audit(db, "created", "campaign", campaign_id, {"name": payload.name})
        return campaign_row(db.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone())


@app.patch("/api/campaigns/{campaign_id}", dependencies=[Depends(require_api_key)])
def update_campaign(campaign_id: str, payload: CampaignIn) -> dict:
    with connect() as db:
        cur = db.execute(
            "UPDATE campaigns SET name=?,objective=?,start_date=?,end_date=?,updated_at=? WHERE id=?",
            (payload.name.strip(), payload.objective, payload.start_date, payload.end_date, now_iso(), campaign_id),
        )
        if not cur.rowcount:
            raise HTTPException(404, "Campaign not found")
        audit(db, "updated", "campaign", campaign_id, {"name": payload.name})
        return campaign_row(db.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone())


@app.get("/api/posts", dependencies=[Depends(require_api_key)])
def list_posts(status: Optional[str] = None, campaign_id: Optional[str] = None) -> list[dict]:
    query, args = "SELECT * FROM posts", []
    filters = []
    if status:
        filters.append("status=?"); args.append(status)
    if campaign_id:
        filters.append("campaign_id=?"); args.append(campaign_id)
    if filters:
        query += " WHERE " + " AND ".join(filters)
    query += " ORDER BY COALESCE(publish_at,created_at) DESC"
    with connect() as db:
        return [post_row(r) for r in db.execute(query, args)]


@app.post("/api/posts", dependencies=[Depends(require_api_key)], status_code=201)
def create_post(payload: PostIn) -> dict:
    payload.validate_business_rules()
    post_id, stamp = str(uuid.uuid4()), now_iso()
    with connect() as db:
        if payload.campaign_id and not db.execute("SELECT 1 FROM campaigns WHERE id=?", (payload.campaign_id,)).fetchone():
            raise HTTPException(422, "Selected campaign does not exist")
        db.execute(
            """INSERT INTO posts(id,caption,campaign_id,channels_json,facebook_groups_json,whatsapp_recipient_type,
               whatsapp_recipient_id,whatsapp_recipient_name,status,publish_at,media_json,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (post_id, payload.caption, payload.campaign_id, json.dumps(payload.channels), json.dumps(payload.facebook_groups),
             payload.whatsapp_recipient_type, payload.whatsapp_recipient_id, payload.whatsapp_recipient_name,
             payload.status, payload.publish_at, json.dumps(payload.media), stamp, stamp),
        )
        audit(db, "created", "post", post_id, {"status": payload.status, "channels": payload.channels})
        return post_row(db.execute("SELECT * FROM posts WHERE id=?", (post_id,)).fetchone())


@app.patch("/api/posts/{post_id}", dependencies=[Depends(require_api_key)])
def update_post(post_id: str, payload: PostIn) -> dict:
    payload.validate_business_rules()
    with connect() as db:
        if not db.execute("SELECT 1 FROM posts WHERE id=?", (post_id,)).fetchone():
            raise HTTPException(404, "Post not found")
        if payload.campaign_id and not db.execute("SELECT 1 FROM campaigns WHERE id=?", (payload.campaign_id,)).fetchone():
            raise HTTPException(422, "Selected campaign does not exist")
        db.execute(
            """UPDATE posts SET caption=?,campaign_id=?,channels_json=?,facebook_groups_json=?,whatsapp_recipient_type=?,
               whatsapp_recipient_id=?,whatsapp_recipient_name=?,status=?,publish_at=?,media_json=?,updated_at=? WHERE id=?""",
            (payload.caption, payload.campaign_id, json.dumps(payload.channels), json.dumps(payload.facebook_groups),
             payload.whatsapp_recipient_type, payload.whatsapp_recipient_id, payload.whatsapp_recipient_name,
             payload.status, payload.publish_at, json.dumps(payload.media), now_iso(), post_id),
        )
        audit(db, "updated", "post", post_id, {"status": payload.status, "channels": payload.channels})
        return post_row(db.execute("SELECT * FROM posts WHERE id=?", (post_id,)).fetchone())


@app.delete("/api/posts/{post_id}", dependencies=[Depends(require_api_key)], status_code=204)
def delete_post(post_id: str) -> None:
    with connect() as db:
        cur = db.execute("DELETE FROM posts WHERE id=?", (post_id,))
        if not cur.rowcount:
            raise HTTPException(404, "Post not found")
        audit(db, "deleted", "post", post_id, {})


@app.post("/api/media", dependencies=[Depends(require_api_key)], status_code=201)
def upload_media(file: UploadFile = File(...)) -> dict:
    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    if file.content_type not in allowed_types:
        raise HTTPException(415, "Upload a JPG, PNG, WEBP or GIF image")
    raw = file.file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(raw) > settings.max_upload_mb * 1024 * 1024:
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
    return {"id": name, "name": Path(file.filename or name).name, "url": f"/uploads/{name}", "content_type": file.content_type, "size": len(raw)}


@app.get("/api/integrations", dependencies=[Depends(require_api_key)])
def integrations() -> list[dict]:
    # Deliberately no fake connected accounts. Provider OAuth is added after Meta app setup.
    return [
        {"provider": "facebook", "label": "Facebook Pages", "status": "not_connected", "capabilities": ["page_posts", "page_media"]},
        {"provider": "instagram", "label": "Instagram Professional", "status": "not_connected", "capabilities": ["image_posts", "carousel_posts"]},
        {"provider": "whatsapp", "label": "WhatsApp Business Platform", "status": "not_connected", "capabilities": ["business_messaging"], "note": "Group messaging availability depends on account eligibility and supported Meta APIs."},
    ]
