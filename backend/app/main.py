from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterator, Literal, Optional, get_args

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, create_model, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .facebook import FacebookError, client_from_settings
from .sales_desk_auth import current_user, init_auth_db, router as sales_desk_auth_router
from .sales_desk import init_sales_desk_db, router as sales_desk_router


# --------------------------------------------------------------------------- settings
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_api_key: str = ""
    database_path: str = "./data/impala_hub.db"
    rfq_bootstrap_admin_username: str = ""
    rfq_bootstrap_admin_password: str = ""
    upload_dir: str = "./uploads"
    max_upload_mb: int = 15
    allow_insecure_local_dev: bool = False  # set ALLOW_INSECURE_LOCAL_DEV=true in .env to allow a weak key
    # Facebook Page publishing. Leave the page id or token empty to keep publishing switched off.
    facebook_page_id: str = ""
    facebook_page_token: str = ""
    facebook_api_version: str = "v26.0"  # use the version shown in your Meta app dashboard
    meta_app_id: str = ""
    meta_app_secret: str = ""
    facebook_oauth_redirect_uri: str = "http://localhost:8000/api/integrations/facebook/callback"
    # Must be the same origin you open the app on (sessionStorage, which holds the API key, is per origin).
    facebook_frontend_url: str = "http://127.0.0.1:5173"
    facebook_token_encryption_key: str = ""
    # Set true only if your Page lives in a Meta Business Portfolio and "me/accounts" comes back empty.
    facebook_request_business_management: bool = False
    instagram_oauth_redirect_uri: str = "http://localhost:8000/api/integrations/instagram/callback"
    publisher_interval_seconds: int = 30
    facebook_sync_minutes: int = 10  # how often to import posts and figures from the Page; 0 turns it off


settings = Settings()
log = logging.getLogger("impala.api")
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
    # SQLite is used by the API, background publisher and Sales Desk concurrently.
    # Give short-lived writers time to finish instead of surfacing transient 500s.
    db = sqlite3.connect(DB_PATH, timeout=30.0)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 30000")
    db.execute("PRAGMA synchronous = NORMAL")
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


SCHEMA_FACEBOOK_OAUTH = """
CREATE TABLE IF NOT EXISTS facebook_oauth_states (
    state TEXT PRIMARY KEY,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS facebook_pending_pages (
    page_id TEXT PRIMARY KEY,
    page_name TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    token_expires_at INTEGER,
    data_access_expires_at INTEGER,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS facebook_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    page_id TEXT NOT NULL,
    page_name TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    token_expires_at INTEGER,
    data_access_expires_at INTEGER,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_flags (name TEXT PRIMARY KEY, value TEXT NOT NULL);
"""



SCHEMA_BUYOUTS = """
CREATE TABLE IF NOT EXISTS buyout_requests (
    id TEXT PRIMARY KEY,
    part_number TEXT NOT NULL,
    part_description TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK(qty > 0),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supplier_quotes (
    id TEXT PRIMARY KEY,
    supplier TEXT NOT NULL,
    brand TEXT NOT NULL,
    cost REAL NOT NULL CHECK(cost >= 0),
    msrp REAL NOT NULL CHECK(msrp >= 0),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
"""


SCHEMA_PARTS_QUERIES = """
CREATE TABLE IF NOT EXISTS development_statuses (
    name TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS parts_query_suppliers (
    id TEXT PRIMARY KEY,
    query_id TEXT NOT NULL REFERENCES parts_queries(id) ON DELETE CASCADE,
    supplier TEXT NOT NULL,
    cost REAL,
    msrp REAL,
    notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS parts_queries (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    part_number TEXT NOT NULL,
    description TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK(qty > 0),
    supplier TEXT NOT NULL DEFAULT '',
    cost REAL,
    msrp REAL,
    development_status TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('In Progress','Submitted','Cancelled'))
);
"""

SCHEMA_RETURNS_CLAIMS = """
CREATE TABLE IF NOT EXISTS returns_claims (
 id TEXT PRIMARY KEY, date TEXT NOT NULL, company TEXT NOT NULL, rfc_book_number TEXT NOT NULL,
 customer TEXT NOT NULL, contact_person TEXT NOT NULL, contact_number TEXT NOT NULL, invoice_number TEXT NOT NULL,
 invoice_date TEXT NOT NULL, reason TEXT NOT NULL, part_number TEXT NOT NULL, description TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty > 0), outcome_request TEXT, returned_by TEXT NOT NULL, received_by TEXT NOT NULL,
 supplier_received TEXT NOT NULL DEFAULT 'No', comments TEXT NOT NULL DEFAULT '', attachments_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
"""
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


SCHEMA_V3 = """
ALTER TABLE posts DROP COLUMN facebook_groups_json;
PRAGMA user_version = 3;
"""

SCHEMA_V4 = """
ALTER TABLE posts ADD COLUMN reach INTEGER;
ALTER TABLE posts ADD COLUMN impressions INTEGER;
PRAGMA user_version = 4;
"""

SCHEMA_V5 = """
ALTER TABLE campaigns ADD COLUMN stage TEXT NOT NULL DEFAULT 'new';
PRAGMA user_version = 5;
"""

SCHEMA_V6 = """
ALTER TABLE posts ADD COLUMN views INTEGER;
PRAGMA user_version = 6;
"""


def init_db() -> None:
    conn = connect()
    try:
        # Initialise WAL once so readers do not block the publisher and Sales Desk writers.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            conn.executescript(SCHEMA_V1)
        if version < 2:
            conn.executescript(SCHEMA_V2)
        if version < 3:
            conn.executescript(SCHEMA_V3)
        if version < 4:
            conn.executescript(SCHEMA_V4)
        if version < 5:
            conn.executescript(SCHEMA_V5)
        if version < 6:
            conn.executescript(SCHEMA_V6)
        conn.executescript(SCHEMA_FACEBOOK_OAUTH)
        conn.executescript(SCHEMA_BUYOUTS)
        conn.executescript(SCHEMA_PARTS_QUERIES)
        conn.executescript(SCHEMA_RETURNS_CLAIMS)
        columns = {r['name']: r for r in conn.execute('PRAGMA table_info(returns_claims)')}
        if 'attachments_json' not in columns:
            conn.execute("ALTER TABLE returns_claims ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
        if columns.get('outcome_request') and columns['outcome_request']['notnull']:
            conn.executescript("""
                ALTER TABLE returns_claims RENAME TO returns_claims_legacy;
                CREATE TABLE returns_claims (
                    id TEXT PRIMARY KEY, date TEXT NOT NULL, company TEXT NOT NULL, rfc_book_number TEXT NOT NULL,
                    customer TEXT NOT NULL, contact_person TEXT NOT NULL, contact_number TEXT NOT NULL, invoice_number TEXT NOT NULL,
                    invoice_date TEXT NOT NULL, reason TEXT NOT NULL, part_number TEXT NOT NULL, description TEXT NOT NULL,
                    qty INTEGER NOT NULL CHECK(qty > 0), outcome_request TEXT, returned_by TEXT NOT NULL, received_by TEXT NOT NULL,
                    supplier_received TEXT NOT NULL DEFAULT 'No', comments TEXT NOT NULL DEFAULT '',
                    attachments_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                INSERT INTO returns_claims SELECT id,date,company,rfc_book_number,customer,contact_person,contact_number,
                    invoice_number,invoice_date,reason,part_number,description,qty,outcome_request,returned_by,received_by,
                    supplier_received,comments,attachments_json,status,created_at,updated_at
                    FROM returns_claims_legacy;
                DROP TABLE returns_claims_legacy;
            """)
        if not any(r["name"] == "sales_code_id" for r in conn.execute("PRAGMA table_info(parts_queries)")):
            conn.execute("ALTER TABLE parts_queries ADD COLUMN sales_code_id TEXT")
        if not any(r["name"] == "qty" for r in conn.execute("PRAGMA table_info(parts_query_suppliers)")):
            conn.execute("ALTER TABLE parts_query_suppliers ADD COLUMN qty INTEGER NOT NULL DEFAULT 1 CHECK(qty > 0)")
        conn.executemany("INSERT OR IGNORE INTO development_statuses(name) VALUES(?)", [("New",), ("Under Review",), ("Approved",), ("Rejected",)])
        conn.execute("DELETE FROM facebook_oauth_states WHERE created_at < ?", (time.time() - 900,))
        conn.execute("DELETE FROM facebook_pending_pages WHERE created_at < ?", (time.time() - 1800,))
        conn.commit()
        init_auth_db(settings.rfq_bootstrap_admin_username, settings.rfq_bootstrap_admin_password, DB_PATH)
        init_sales_desk_db(DB_PATH)
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    from .publisher import run_forever  # imported here because publisher imports this module

    # Pass the factory, not a client: the worker re-reads the connection every cycle, so connecting,
    # reconnecting or disconnecting Facebook in the UI takes effect without restarting the API.
    worker = asyncio.create_task(run_forever(facebook_client, settings.publisher_interval_seconds, settings.facebook_sync_minutes))
    try:
        yield
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)


def _fernet() -> Fernet:
    key = settings.facebook_token_encryption_key.strip()
    if not key:
        raise HTTPException(503, "Facebook OAuth is not configured. Set FACEBOOK_TOKEN_ENCRYPTION_KEY in backend/.env.")
    try:
        return Fernet(key.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise HTTPException(503, "FACEBOOK_TOKEN_ENCRYPTION_KEY must be a valid Fernet key. Generate one with Fernet.generate_key().") from exc


def _stored_facebook_connection() -> Optional[dict]:
    with db_session() as db:
        row = db.execute("SELECT * FROM facebook_connection WHERE id=1").fetchone()
    if not row:
        return None
    try:
        token = _fernet().decrypt(row["encrypted_token"].encode()).decode()
    except (InvalidToken, UnicodeDecodeError, HTTPException):
        return None
    return {**dict(row), "token": token}


FB_ENV_DISABLED = "facebook_env_token_disabled"

def _flag(name: str) -> bool:
    with db_session() as db:
        return db.execute("SELECT 1 FROM integration_flags WHERE name=?", (name,)).fetchone() is not None

def _set_flag(db: sqlite3.Connection, name: str, on: bool) -> None:
    if on:
        db.execute("INSERT OR REPLACE INTO integration_flags(name,value) VALUES(?, '1')", (name,))
    else:
        db.execute("DELETE FROM integration_flags WHERE name=?", (name,))

def _remove_network_posts(db: sqlite3.Connection, provider: str) -> int:
    rows = db.execute("SELECT id, provider_ids_json FROM posts WHERE status='published'").fetchall()
    ids = [r["id"] for r in rows if json.loads(r["provider_ids_json"] or "{}").get(provider)]
    db.executemany("DELETE FROM posts WHERE id=?", [(i,) for i in ids])
    return len(ids)

def facebook_client():
    stored = _stored_facebook_connection()
    if stored:
        return client_from_settings(stored["page_id"], stored["token"], settings.facebook_api_version)
    if _flag(FB_ENV_DISABLED):
        return None
    return client_from_settings(settings.facebook_page_id, settings.facebook_page_token, settings.facebook_api_version)


app = FastAPI(title="Impala Hub Marketing API", version="0.2.0", lifespan=lifespan)
app.include_router(sales_desk_auth_router)
app.include_router(sales_desk_router)
app.add_middleware(
    CORSMiddleware,
    # Vite may move to 5174/5175 when a port is already occupied. Keep local origins
    # explicit, rather than allowing arbitrary browser origins.
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
        "http://localhost:5175", "http://127.0.0.1:5175",
        "http://localhost:4173", "http://127.0.0.1:4173",
    ],
    # Also allow local Vite fallback ports and localhost/127.0.0.1 consistently.
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
# Images are loaded by <img> tags, which cannot send an Authorization header, so /uploads is public.
# File names are random UUIDs, but do not upload anything confidential.
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_PATH)), name="uploads")


# --------------------------------------------------------------------------- auth
def key_is_weak(key: str) -> bool:
    return key in PLACEHOLDER_KEYS or len(key) < MIN_KEY_LENGTH


def require_api_key(authorization: Optional[str] = Header(default=None)) -> None:
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    expected = settings.app_api_key
    if expected and not key_is_weak(expected) and secrets.compare_digest(supplied.encode(), expected.encode()):
        return
    # Production requests may use an individual server-side session instead of the legacy
    # shared development key. The session token is opaque and never stored in plaintext.
    if supplied:
        current_user(authorization)
        return
    if key_is_weak(expected) and not settings.allow_insecure_local_dev:
        raise HTTPException(status_code=503, detail="Sign in or configure APP_API_KEY in backend/.env")
    raise HTTPException(status_code=401, detail="Missing or invalid session")


def audit(db: sqlite3.Connection, action: str, entity_type: str, entity_id: str, details: dict) -> None:
    db.execute(
        "INSERT INTO audit_log(action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?)",
        (action, entity_type, entity_id, json.dumps(details), now_iso()),
    )


# --------------------------------------------------------------------------- models
Channel = Literal["facebook", "instagram", "whatsapp"]
PostStatus = Literal["draft", "awaiting_approval", "scheduled", "published", "failed"]
# Clients may only choose these. "published" and "failed" are set by the publishing worker.
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
    stage: Literal["new", "in_progress", "done"] = "new"
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

    @field_validator("channels")
    @classmethod
    def dedupe_channels(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))

    @field_validator("publish_at")
    @classmethod
    def to_utc(cls, v: Optional[datetime]) -> Optional[datetime]:
        if v is None:
            return None
        return (v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v).astimezone(timezone.utc)

    @model_validator(mode="after")
    def business_rules(self) -> "PostIn":
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
        data.title, data.caption, data.campaign_id, json.dumps(data.channels),
        data.whatsapp_recipient_type, data.whatsapp_recipient_id, data.whatsapp_recipient_name, data.status,
        data.publish_at.isoformat() if data.publish_at else None,
        json.dumps([m.model_dump() for m in data.media]),
    )


# --------------------------------------------------------------------------- routes
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "impala-hub-marketing", "version": app.version}


class BuyoutRequestIn(BaseModel):
    part_number: str = Field(min_length=1, max_length=120)
    part_description: str = Field(min_length=1, max_length=500)
    qty: int = Field(gt=0, le=1000000)


class SupplierQuoteIn(BaseModel):
    supplier: str = Field(min_length=1, max_length=160)
    brand: str = Field(min_length=1, max_length=160)
    cost: float = Field(ge=0)
    msrp: float = Field(ge=0)
    notes: str = Field(default='', max_length=5000)


def buyout_id(prefix: str) -> str:
    return f"{prefix}-{datetime.now(timezone.utc):%Y%m%d}-{secrets.token_hex(3).upper()}"


@app.get("/api/buyouts/requests", dependencies=[Depends(require_api_key)])
def list_buyout_requests() -> list[dict]:
    with db_session() as db:
        return [dict(r) for r in db.execute("SELECT * FROM buyout_requests ORDER BY created_at DESC")]


@app.post("/api/buyouts/requests", dependencies=[Depends(require_api_key)], status_code=201)
def create_buyout_request(payload: BuyoutRequestIn) -> dict:
    record_id, stamp = buyout_id("BR"), now_iso()
    with db_session() as db:
        db.execute("INSERT INTO buyout_requests(id,part_number,part_description,qty,created_at) VALUES(?,?,?,?,?)",
                   (record_id, payload.part_number.strip(), payload.part_description.strip(), payload.qty, stamp))
        audit(db, "created", "buyout_request", record_id, payload.model_dump())
        return dict(db.execute("SELECT * FROM buyout_requests WHERE id=?", (record_id,)).fetchone())


@app.get("/api/buyouts/quotes", dependencies=[Depends(require_api_key)])
def list_supplier_quotes() -> list[dict]:
    with db_session() as db:
        return [dict(r) for r in db.execute("SELECT * FROM supplier_quotes ORDER BY created_at DESC")]


@app.post("/api/buyouts/quotes", dependencies=[Depends(require_api_key)], status_code=201)
def create_supplier_quote(payload: SupplierQuoteIn) -> dict:
    record_id, stamp = buyout_id("SQ"), now_iso()
    with db_session() as db:
        db.execute("INSERT INTO supplier_quotes(id,supplier,brand,cost,msrp,notes,created_at) VALUES(?,?,?,?,?,?,?)",
                   (record_id, payload.supplier.strip(), payload.brand.strip(), payload.cost, payload.msrp, payload.notes.strip(), stamp))
        audit(db, "created", "supplier_quote", record_id, payload.model_dump())
        return dict(db.execute("SELECT * FROM supplier_quotes WHERE id=?", (record_id,)).fetchone())


class SupplierQuoteIn(BaseModel):
    supplier: str = Field(default='', max_length=160)
    qty: int = Field(default=1, gt=0, le=1000000)
    cost: Optional[float] = Field(default=None, ge=0)
    msrp: Optional[float] = Field(default=None, ge=0)
    notes: str = Field(default='', max_length=2000)


class ReturnClaimIn(BaseModel):
    date: str
    company: Literal['Warehouse', 'Eastrand', 'Pretoria']
    rfc_book_number: str = Field(min_length=1, max_length=120)
    customer: str = Field(min_length=1, max_length=200)
    contact_person: str = Field(min_length=1, max_length=160)
    contact_number: str = Field(min_length=1, max_length=80)
    invoice_number: str = Field(min_length=1, max_length=120)
    invoice_date: str
    reason: Literal['Core', 'Goods Damaged', 'Incorrect Goods Supplied', 'Claim']
    part_number: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    qty: int = Field(gt=0, le=1000000)
    outcome_request: Optional[Literal['Credit', 'Replacement Part', '']] = None
    returned_by: str = Field(default='', max_length=160)
    received_by: str = Field(default='', max_length=160)
    supplier_received: Literal['Yes', 'No'] = 'No'
    comments: str = Field(default='', max_length=5000)
    attachments: list[dict] = Field(default_factory=list, max_length=10)
    status: Literal['Waiting for Info from Customer', 'Waiting for Reply from Supplier', 'In Progress', 'Completed', 'Awaiting Pickup/dropoff at supplier', 'Rejected'] = 'In Progress'


class ReturnClaimPatch(ReturnClaimIn):
    pass


class PartsSupplierIn(BaseModel):
    id: Optional[str] = None
    supplier: str = Field(default='', max_length=160)
    qty: int = Field(default=1, gt=0, le=1000000)
    cost: Optional[float] = Field(default=None, ge=0)
    msrp: Optional[float] = Field(default=None, ge=0)
    notes: str = Field(default='', max_length=2000)


class PartsQueryPatch(BaseModel):
    part_number: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, min_length=1, max_length=1000)
    status: Optional[Literal['In Progress', 'Submitted', 'Cancelled']] = None
    development_status: Optional[str] = Field(default=None, min_length=1, max_length=120)
    sales_code_id: Optional[str] = None
    suppliers: Optional[list[PartsSupplierIn]] = None


class PartsQueryIn(BaseModel):
    part_number: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    qty: int = Field(default=1, gt=0, le=1000000)
    sales_code_id: Optional[str] = None
    suppliers: list[PartsSupplierIn] = Field(default_factory=list, max_length=100)
    development_status: str = Field(min_length=1, max_length=120)
    status: Literal['In Progress', 'Submitted', 'Cancelled'] = 'In Progress'


@app.get("/api/parts-queries/development-statuses", dependencies=[Depends(require_api_key)])
def list_development_statuses() -> list[str]:
    with db_session() as db:
        return [r["name"] for r in db.execute("""
            SELECT name FROM development_statuses
            ORDER BY CASE name
                WHEN 'New' THEN 1
                WHEN 'Under Review' THEN 2
                WHEN 'Approved' THEN 3
                WHEN 'Rejected' THEN 4
                ELSE 5
            END, name COLLATE NOCASE
        """)]


@app.post("/api/parts-queries/development-statuses", dependencies=[Depends(require_api_key)], status_code=201)
def create_development_status(payload: dict) -> dict:
    name = str(payload.get("name", "")).strip()
    if not name or len(name) > 120:
        raise HTTPException(422, "Development status must contain between 1 and 120 characters")
    with db_session() as db:
        db.execute("INSERT OR IGNORE INTO development_statuses(name) VALUES(?)", (name,))
    return {"name": name}


@app.get("/api/parts-queries/development-statuses", dependencies=[Depends(require_api_key)])
def list_development_statuses() -> list[str]:
    with db_session() as db:
        return [r["name"] for r in db.execute("SELECT name FROM development_statuses ORDER BY name COLLATE NOCASE")]


@app.post("/api/parts-queries/development-statuses", dependencies=[Depends(require_api_key)], status_code=201)
def create_development_status(payload: dict) -> dict:
    name = str(payload.get("name", "")).strip()
    if not name or len(name) > 120:
        raise HTTPException(422, "Development status must contain between 1 and 120 characters")
    with db_session() as db:
        db.execute("INSERT OR IGNORE INTO development_statuses(name) VALUES(?)", (name,))
    return {"name": name}


def parts_query_row(db: sqlite3.Connection, row: sqlite3.Row) -> dict:
    item = dict(row)
    item["suppliers"] = [dict(r) for r in db.execute("SELECT id,supplier,qty,cost,msrp,notes FROM parts_query_suppliers WHERE query_id=? ORDER BY rowid", (item["id"],))]
    return item


@app.get("/api/parts-queries", dependencies=[Depends(require_api_key)])
def list_parts_queries(development_status: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
    query, args = "SELECT p.*, sc.code AS sales_code FROM parts_queries p LEFT JOIN sd_sales_codes sc ON sc.id=p.sales_code_id", []
    filters = []
    if development_status:
        filters.append("development_status=?"); args.append(development_status)
    if status:
        filters.append("status=?"); args.append(status)
    if filters: query += " WHERE " + " AND ".join(filters)
    query += " ORDER BY created_at DESC"
    with db_session() as db:
        return [parts_query_row(db, r) for r in db.execute(query, args)]


@app.post("/api/parts-queries", dependencies=[Depends(require_api_key)], status_code=201)
def create_parts_query(payload: PartsQueryIn) -> dict:
    for attempt in range(6):
        try:
            record_id, stamp = buyout_id("PQ"), now_iso()
            with db_session() as db:
                if payload.sales_code_id and not db.execute("SELECT 1 FROM sd_sales_codes WHERE id=? AND is_active=1", (payload.sales_code_id,)).fetchone():
                    raise HTTPException(422, "Choose an active Sales Code")
                if not db.execute("SELECT 1 FROM development_statuses WHERE name=?", (payload.development_status.strip(),)).fetchone():
                    db.execute("INSERT INTO development_statuses(name) VALUES(?)", (payload.development_status.strip(),))
                db.execute(
                    "INSERT INTO parts_queries(id,created_at,part_number,description,qty,supplier,cost,msrp,development_status,status,sales_code_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (record_id, stamp, payload.part_number.strip(), payload.description.strip(), payload.qty, '', None, None, payload.development_status.strip(), payload.status, payload.sales_code_id),
                )
                for quote in payload.suppliers:
                    db.execute("INSERT INTO parts_query_suppliers(id,query_id,supplier,qty,cost,msrp,notes) VALUES(?,?,?,?,?,?,?)",
                               (uuid.uuid4().hex, record_id, quote.supplier.strip(), quote.qty, quote.cost, quote.msrp, quote.notes.strip()))
                audit(db, "created", "parts_query", record_id, payload.model_dump())
                return parts_query_row(db, db.execute("SELECT * FROM parts_queries WHERE id=?", (record_id,)).fetchone())
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() or attempt == 5:
                raise
            time.sleep(0.25 * (attempt + 1))
    raise HTTPException(503, "Database is busy. Please retry creating the Parts Query.")


@app.patch("/api/parts-queries/{query_id}", dependencies=[Depends(require_api_key)])
def update_parts_query(query_id: str, patch: PartsQueryPatch) -> dict:
    for attempt in range(6):
        try:
            with db_session() as db:
                current = db.execute("SELECT * FROM parts_queries WHERE id=?", (query_id,)).fetchone()
                if not current:
                    raise HTTPException(404, "Parts Query not found")
                development_status = patch.development_status.strip() if patch.development_status is not None else current["development_status"]
                sales_code_id = patch.sales_code_id if patch.sales_code_id is not None else (current["sales_code_id"] if "sales_code_id" in current.keys() else None)
                if patch.development_status is not None:
                    db.execute("INSERT OR IGNORE INTO development_statuses(name) VALUES(?)", (development_status,))
                if patch.sales_code_id is not None and sales_code_id and not db.execute("SELECT 1 FROM sd_sales_codes WHERE id=? AND is_active=1", (sales_code_id,)).fetchone():
                    raise HTTPException(422, "Choose an active Sales Code")
                db.execute("UPDATE parts_queries SET part_number=?,description=?,status=?,development_status=?,sales_code_id=? WHERE id=?",
                           (patch.part_number.strip() if patch.part_number is not None else current["part_number"], patch.description.strip() if patch.description is not None else current["description"], patch.status or current["status"], development_status, sales_code_id, query_id))
                if patch.suppliers is not None:
                    submitted_ids = [quote.id for quote in patch.suppliers if quote.id]
                    if submitted_ids:
                        marks = ",".join("?" for _ in submitted_ids)
                        db.execute(f"DELETE FROM parts_query_suppliers WHERE query_id=? AND id NOT IN ({marks})", [query_id, *submitted_ids])
                    else:
                        db.execute("DELETE FROM parts_query_suppliers WHERE query_id=?", (query_id,))
                    for quote in patch.suppliers:
                        values = (quote.supplier.strip(), quote.qty, quote.cost, quote.msrp, quote.notes.strip())
                        if quote.id:
                            updated = db.execute("UPDATE parts_query_suppliers SET supplier=?,qty=?,cost=?,msrp=?,notes=? WHERE id=? AND query_id=?",
                                                 (*values, quote.id, query_id))
                            if updated.rowcount != 1:
                                raise HTTPException(404, "Supplier quote not found")
                        else:
                            db.execute("INSERT INTO parts_query_suppliers(id,query_id,supplier,qty,cost,msrp,notes) VALUES(?,?,?,?,?,?,?)",
                                       (uuid.uuid4().hex, query_id, values[0], quote.qty, values[1], values[2], values[3]))
                audit(db, "updated", "parts_query", query_id, patch.model_dump(exclude_none=True))
                return parts_query_row(db, db.execute("SELECT * FROM parts_queries WHERE id=?", (query_id,)).fetchone())
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() or attempt == 5:
                raise
            time.sleep(0.25 * (attempt + 1))
    raise HTTPException(503, "Database is busy. Please retry the Parts Query update.")


@app.post("/api/parts-queries/{query_id}/suppliers", dependencies=[Depends(require_api_key)], status_code=201)
def add_parts_query_supplier(query_id: str, payload: PartsSupplierIn) -> dict:
    supplier_id = uuid.uuid4().hex
    for attempt in range(6):
        try:
            with db_session() as db:
                if not db.execute("SELECT 1 FROM parts_queries WHERE id=?", (query_id,)).fetchone():
                    raise HTTPException(404, "Parts Query not found")
                db.execute("INSERT INTO parts_query_suppliers(id,query_id,supplier,cost,msrp,notes) VALUES(?,?,?,?,?,?)",
                           (supplier_id, query_id, payload.supplier.strip(), payload.qty, payload.cost, payload.msrp, payload.notes.strip()))
                audit(db, "supplier_added", "parts_query", query_id, payload.model_dump())
                return dict(db.execute("SELECT id,supplier,qty,cost,msrp,notes FROM parts_query_suppliers WHERE id=?", (supplier_id,)).fetchone())
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() or attempt == 5:
                raise
            time.sleep(0.25 * (attempt + 1))
    raise HTTPException(503, "Database is busy. Please retry adding the supplier.")


@app.patch("/api/parts-queries/{query_id}/suppliers/{supplier_id}", dependencies=[Depends(require_api_key)])
def update_parts_query_supplier(query_id: str, supplier_id: str, payload: PartsSupplierIn) -> dict:
    # The background publisher and browser refreshes can briefly hold SQLite's writer lock.
    # Reopen the transaction for each attempt so a transient lock does not become a 500.
    for attempt in range(6):
        try:
            with db_session() as db:
                updated = db.execute(
                    "UPDATE parts_query_suppliers SET supplier=?,cost=?,msrp=?,notes=? WHERE id=? AND query_id=?",
                    (payload.supplier.strip(), payload.qty, payload.cost, payload.msrp, payload.notes.strip(), supplier_id, query_id),
                )
                if updated.rowcount != 1:
                    raise HTTPException(404, "Supplier quote not found")
                audit(db, "supplier_updated", "parts_query", query_id, {"supplier_id": supplier_id, **payload.model_dump()})
                return dict(db.execute("SELECT id,supplier,cost,msrp,notes FROM parts_query_suppliers WHERE id=?", (supplier_id,)).fetchone())
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() or attempt == 5:
                raise
            time.sleep(0.25 * (attempt + 1))
    raise HTTPException(503, "Database is busy. Please retry the supplier update.")


@app.delete("/api/parts-queries/{query_id}/suppliers/{supplier_id}", dependencies=[Depends(require_api_key)])
def delete_parts_query_supplier(query_id: str, supplier_id: str) -> None:
    with db_session() as db:
        deleted = db.execute("DELETE FROM parts_query_suppliers WHERE id=? AND query_id=?", (supplier_id, query_id))
        if deleted.rowcount != 1:
            raise HTTPException(404, "Supplier quote not found")
        audit(db, "supplier_deleted", "parts_query", query_id, {"supplier_id": supplier_id})


@app.delete("/api/parts-queries/{query_id}", dependencies=[Depends(require_api_key)])
def delete_parts_query(query_id: str) -> dict:
    with db_session() as db:
        deleted = db.execute("DELETE FROM parts_queries WHERE id=?", (query_id,))
        if deleted.rowcount != 1:
            raise HTTPException(404, "Parts Query not found")
        audit(db, "deleted", "parts_query", query_id, {})
    return {"deleted": True, "id": query_id}


def returns_claim_row(row: sqlite3.Row) -> dict:
    item = dict(row)
    item['attachments'] = json.loads(item.pop('attachments_json', '[]') or '[]')
    return item


@app.get("/api/returns-claims", dependencies=[Depends(require_api_key)])
def list_returns_claims() -> list[dict]:
    with db_session() as db:
        return [returns_claim_row(r) for r in db.execute("SELECT * FROM returns_claims ORDER BY date DESC, created_at DESC")]


@app.post("/api/returns-claims", dependencies=[Depends(require_api_key)], status_code=201)
def create_returns_claim(payload: ReturnClaimIn) -> dict:
    record_id, stamp = buyout_id("RFC"), now_iso()
    values = payload.model_dump()
    columns = "id,date,company,rfc_book_number,customer,contact_person,contact_number,invoice_number,invoice_date,reason,part_number,description,qty,outcome_request,returned_by,received_by,supplier_received,comments,attachments_json,status,created_at,updated_at"
    params = (record_id, values["date"], values["company"], values["rfc_book_number"], values["customer"], values["contact_person"], values["contact_number"], values["invoice_number"], values["invoice_date"], values["reason"], values["part_number"], values["description"], values["qty"], values["outcome_request"] or None, values["returned_by"], values["received_by"], values["supplier_received"], values["comments"], json.dumps(values["attachments"]), values["status"], stamp, stamp)
    for attempt in range(4):
        try:
            with db_session() as db:
                db.execute(f"INSERT INTO returns_claims({columns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params)
                audit(db, "created", "returns_claim", record_id, values)
                return returns_claim_row(db.execute("SELECT * FROM returns_claims WHERE id=?", (record_id,)).fetchone())
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() or attempt == 3:
                raise
            time.sleep(0.25 * (attempt + 1))
    raise HTTPException(503, "Returns & Claims database is busy; please try again.")

@app.patch("/api/returns-claims/{record_id}", dependencies=[Depends(require_api_key)])
def update_returns_claim(record_id: str, payload: ReturnClaimPatch) -> dict:
    values = payload.model_dump()
    with db_session() as db:
        if not db.execute("SELECT 1 FROM returns_claims WHERE id=?", (record_id,)).fetchone():
            raise HTTPException(404, "Returns & Claims record not found")
        db.execute("""UPDATE returns_claims SET date=?,company=?,rfc_book_number=?,customer=?,contact_person=?,contact_number=?,
            invoice_number=?,invoice_date=?,reason=?,part_number=?,description=?,qty=?,outcome_request=?,returned_by=?,received_by=?,
            supplier_received=?,comments=?,attachments_json=?,status=?,updated_at=? WHERE id=?""",
            (values["date"], values["company"], values["rfc_book_number"], values["customer"], values["contact_person"], values["contact_number"], values["invoice_number"], values["invoice_date"], values["reason"], values["part_number"], values["description"], values["qty"], values["outcome_request"], values["returned_by"], values["received_by"], values["supplier_received"], values["comments"], json.dumps(values["attachments"]), values["status"], now_iso(), record_id))
        audit(db, "updated", "returns_claim", record_id, values)
        return dict(db.execute("SELECT * FROM returns_claims WHERE id=?", (record_id,)).fetchone())


@app.delete("/api/returns-claims/{record_id}", dependencies=[Depends(require_api_key)])
def delete_returns_claim(record_id: str) -> dict:
    with db_session() as db:
        deleted = db.execute("DELETE FROM returns_claims WHERE id=?", (record_id,))
        if deleted.rowcount != 1:
            raise HTTPException(404, "Returns & Claims record not found")
        audit(db, "deleted", "returns_claim", record_id, {})
    return {"deleted": True, "id": record_id}


@app.get("/api/campaigns", dependencies=[Depends(require_api_key)])
def list_campaigns() -> list[dict]:
    with db_session() as db:
        return [campaign_row(r) for r in db.execute("SELECT * FROM campaigns ORDER BY updated_at DESC")]


def campaign_values(data: CampaignIn) -> tuple:
    return (
        data.name, data.objective, data.stage,
        data.start_date.isoformat() if data.start_date else None,
        data.end_date.isoformat() if data.end_date else None,
    )


@app.post("/api/campaigns", dependencies=[Depends(require_api_key)], status_code=201)
def create_campaign(payload: CampaignIn) -> dict:
    campaign_id, stamp = str(uuid.uuid4()), now_iso()
    with db_session() as db:
        db.execute(
            "INSERT INTO campaigns(id,name,objective,stage,start_date,end_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
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
            "UPDATE campaigns SET name=?,objective=?,stage=?,start_date=?,end_date=?,updated_at=? WHERE id=?",
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
            """INSERT INTO posts(id,title,caption,campaign_id,channels_json,whatsapp_recipient_type,
               whatsapp_recipient_id,whatsapp_recipient_name,status,publish_at,media_json,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
            """UPDATE posts SET title=?,caption=?,campaign_id=?,channels_json=?,
               whatsapp_recipient_type=?,whatsapp_recipient_id=?,whatsapp_recipient_name=?,status=?,publish_at=?,
               media_json=?,updated_at=? WHERE id=?""",
            (*post_values(data), now_iso(), post_id),
        )
        changed = [k for k in PostIn.model_fields if getattr(before, k) != getattr(data, k)]
        audit(db, "updated", "post", post_id, {"status": data.status, "channels": data.channels, "changed": changed})
        return fetch_post(db, post_id)


@app.post("/api/posts/{post_id}/publish-now", dependencies=[Depends(require_api_key)])
def publish_post_now(post_id: str) -> dict:
    """Queue a supported Facebook post for the next publishing-worker cycle."""
    client = facebook_client()
    if not client:
        raise HTTPException(409, "Facebook is not connected. Connect a Page before publishing.")
    with db_session() as db:
        current = fetch_post(db, post_id)
        if current["status"] in LOCKED_STATUSES:
            raise HTTPException(409, f"A {current['status']} post cannot be published again.")
        if current["channels"] != ["facebook"]:
            raise HTTPException(422, "Publish now currently supports Facebook Page posts only. Select Facebook as the only channel.")
        if current["provider_ids"].get("facebook"):
            raise HTTPException(409, "This post already has a Facebook post ID. Check the Page before attempting another publication.")
        stamp = now_iso()
        db.execute(
            "UPDATE posts SET status='scheduled',publish_at=?,last_error=NULL,updated_at=? WHERE id=?",
            (stamp, stamp, post_id),
        )
        audit(db, "publish_requested", "post", post_id, {"status": "scheduled", "channels": ["facebook"], "requested_at": stamp})
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
    # A Facebook post must be confirmed absent before its local record can be removed.
    # API errors (permissions, expired tokens, throttling, connectivity) fail closed.
    with db_session() as db:
        current = fetch_post(db, post_id)
        facebook_id = current["provider_ids"].get("facebook")
        if facebook_id:
            client = facebook_client()
            if not client:
                raise HTTPException(409, "Cannot verify this post on Facebook because no Page connection is available.")
            try:
                exists = client.post_exists(facebook_id)
            except FacebookError as exc:
                # Surface Meta's actionable error text, but never credentials or request URLs.
                detail = str(exc).strip() or "Facebook returned an unspecified API error."
                raise HTTPException(
                    502,
                    f"Facebook could not verify this post: {detail} Check the Facebook connection and Page permissions, then try again.",
                ) from exc
            if exists:
                raise HTTPException(
                    409,
                    "This post still exists on Facebook. Delete it on Facebook first, then try deleting it here.",
                )
        elif current["status"] == "published":
            raise HTTPException(
                409,
                "This post is marked as published but has no Facebook post ID, so its deletion cannot be verified.",
            )
        db.execute("DELETE FROM posts WHERE id=?", (post_id,))
        audit(db, "deleted", "post", post_id, {"facebook_post_id": facebook_id, "facebook_absent_verified": bool(facebook_id)})


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


def _token_expiry_warning(expires_at, data_access_expires_at) -> Optional[str]:
    now = int(time.time())
    for label, stamp in (("Page access token", expires_at), ("Facebook data access", data_access_expires_at)):
        if not stamp:
            continue
        remaining = int(stamp) - now
        if remaining <= 0:
            return f"{label} has expired. Reconnect Facebook."
        if remaining <= 7 * 86400:
            return f"{label} expires within {max(1, remaining // 86400)} day(s). Reconnect soon."
    return None


FACEBOOK_LAST_CHECKED_AT: Optional[str] = None
FACEBOOK_LAST_SUCCESS_AT: Optional[str] = None


def facebook_integration() -> dict:
    global FACEBOOK_LAST_CHECKED_AT, FACEBOOK_LAST_SUCCESS_AT
    base = {"provider": "facebook", "label": "Facebook Pages", "capabilities": ["page_posts", "page_media"]}
    client = facebook_client()
    stored = _stored_facebook_connection()
    oauth_ready = bool(settings.meta_app_id and settings.meta_app_secret and settings.facebook_token_encryption_key)
    if not client:
        note = "No Facebook Page connected. Select Connect Facebook to authorize Meta and choose a Page."
        return {**base, "status": "not_connected", "note": note, "page_id": None, "oauth_configured": oauth_ready}
    try:
        details = client.connection_diagnostics(settings.meta_app_id, settings.meta_app_secret)
        status = "warning" if details.get("missing_permissions") else "connected"
        FACEBOOK_LAST_CHECKED_AT = now_iso()
        FACEBOOK_LAST_SUCCESS_AT = FACEBOOK_LAST_CHECKED_AT
        return {**base, "last_checked_at": FACEBOOK_LAST_CHECKED_AT, "last_success_at": FACEBOOK_LAST_SUCCESS_AT, "status": status, "account_name": details["page_name"],
                "page_id": details["page_id"], "followers_count": details.get("followers_count"), "token_type": details["token_type"], "connection_source": "oauth" if stored else "environment", "oauth_configured": oauth_ready,
                "token_valid": details["token_valid"], "expires_at": details["expires_at"],
                "data_access_expires_at": details["data_access_expires_at"], "token_warning": _token_expiry_warning(details.get("expires_at"), details.get("data_access_expires_at")),
                "granted_permissions": details["granted_permissions"],
                "missing_permissions": details["missing_permissions"],
                "diagnostics_available": details["diagnostics_available"],
                "diagnostic_note": details.get("diagnostic_note")}
    except FacebookError as exc:
        FACEBOOK_LAST_CHECKED_AT = now_iso()
        return {**base, "last_checked_at": FACEBOOK_LAST_CHECKED_AT, "last_success_at": FACEBOOK_LAST_SUCCESS_AT, "status": "error", "page_id": settings.facebook_page_id or None,
                "oauth_configured": oauth_ready, "followers_count": None, "connection_source": "oauth" if stored else "environment",
                "note": f"Facebook connection check failed: {exc}"}


# --------------------------------------------------------------------------- Facebook OAuth / Page selection
FACEBOOK_OAUTH_SCOPES = "pages_show_list,pages_read_engagement,pages_read_user_content,pages_manage_posts,read_insights"


def _meta_graph_get(path: str, params: dict) -> dict:
    url = f"https://graph.facebook.com/{settings.facebook_api_version}/{path.lstrip('/')}"
    try:
        response = httpx.get(url, params=params, timeout=25)
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "Could not complete the request to Meta. Please try again.") from exc
    if response.status_code >= 400 or (isinstance(body, dict) and body.get("error")):
        error = body.get("error", {}) if isinstance(body, dict) else {}
        # Do not return request URLs or token-bearing error details to the browser.
        raise HTTPException(502, f"Meta OAuth request failed: {error.get('message', 'unexpected response')}")
    return body


def _oauth_configured() -> None:
    missing = []
    if not settings.meta_app_id.strip(): missing.append("META_APP_ID")
    if not settings.meta_app_secret.strip(): missing.append("META_APP_SECRET")
    if not settings.facebook_oauth_redirect_uri.strip(): missing.append("FACEBOOK_OAUTH_REDIRECT_URI")
    if not settings.facebook_token_encryption_key.strip(): missing.append("FACEBOOK_TOKEN_ENCRYPTION_KEY")
    if missing:
        raise HTTPException(503, "Facebook OAuth setup is incomplete. Configure: " + ", ".join(missing) + " in backend/.env.")


@app.post("/api/integrations/facebook/oauth-url", dependencies=[Depends(require_api_key)])
def facebook_oauth_url() -> dict:
    _oauth_configured()
    _fernet()
    state = secrets.token_urlsafe(32)
    with db_session() as db:
        db.execute("DELETE FROM facebook_oauth_states WHERE created_at < ?", (time.time() - 900,))
        db.execute("INSERT INTO facebook_oauth_states(state,created_at) VALUES(?,?)", (state, time.time()))
    scopes = FACEBOOK_OAUTH_SCOPES + (",business_management" if settings.facebook_request_business_management else "")
    params = {
        "client_id": settings.meta_app_id.strip(),
        "redirect_uri": settings.facebook_oauth_redirect_uri.strip(),
        "state": state,
        "response_type": "code",
        "scope": scopes,
        "auth_type": "rerequest",  # shows the permission and Page-selection dialog again instead of reusing an old grant
    }
    return {"url": "https://www.facebook.com/" + settings.facebook_api_version + "/dialog/oauth?" + urlencode(params)}


def _granted_page_ids(user_token: str) -> tuple[list[str], bool]:
    """Page IDs the user ticked in Meta's dialog, read from the token's granular scopes.
    Returns (ids, granular_scopes_present)."""
    debug = _meta_graph_get("debug_token", {
        "input_token": user_token,
        "access_token": f"{settings.meta_app_id.strip()}|{settings.meta_app_secret.strip()}",
    }).get("data", {})
    granular = debug.get("granular_scopes") or []
    ids: list[str] = []
    for item in granular:
        if item.get("scope") in ("pages_show_list", "pages_manage_posts"):
            ids += [str(i) for i in item.get("target_ids") or []]
    return list(dict.fromkeys(ids)), bool(granular)


@app.get("/api/integrations/facebook/callback")
def facebook_oauth_callback(code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None, error_description: Optional[str] = None):
    frontend = settings.facebook_frontend_url.rstrip("/")
    if error:
        return RedirectResponse(frontend + "/?facebook_oauth=error&reason=authorization_cancelled")
    if not code or not state:
        return RedirectResponse(frontend + "/?facebook_oauth=error&reason=missing_code")
    with db_session() as db:
        valid = db.execute("SELECT state FROM facebook_oauth_states WHERE state=? AND created_at>=?", (state, time.time() - 900)).fetchone()
        db.execute("DELETE FROM facebook_oauth_states WHERE state=?", (state,))
    if not valid:
        return RedirectResponse(frontend + "/?facebook_oauth=error&reason=invalid_state")
    try:
        _oauth_configured()
        token_response = _meta_graph_get("oauth/access_token", {
            "client_id": settings.meta_app_id.strip(),
            "client_secret": settings.meta_app_secret.strip(),
            "redirect_uri": settings.facebook_oauth_redirect_uri.strip(),
            "code": code,
        })
        user_token = token_response.get("access_token")
        if not user_token:
            raise HTTPException(502, "Meta did not return an access token.")
        long_response = _meta_graph_get("oauth/access_token", {
            "grant_type": "fb_exchange_token",
            "client_id": settings.meta_app_id.strip(),
            "client_secret": settings.meta_app_secret.strip(),
            "fb_exchange_token": user_token,
        })
        long_token = long_response.get("access_token") or user_token
        # Try the long-lived user token first, then the freshly exchanged token. Some
        # Meta setups return an empty Page list for the exchanged token even though the
        # initial user token has the required Page permissions.
        pages_response = _meta_graph_get("me/accounts", {
            "fields": "id,name,access_token,tasks",
            "limit": 100,
            "access_token": long_token,
        })
        raw_pages = pages_response.get("data", [])
        if not raw_pages and user_token != long_token:
            pages_response = _meta_graph_get("me/accounts", {
                "fields": "id,name,access_token,tasks",
                "limit": 100,
                "access_token": user_token,
            })
            raw_pages = pages_response.get("data", [])

        granted_ids: list[str] = []
        had_granular = False
        if not [p for p in raw_pages if p.get("id") and p.get("access_token")]:
            # me/accounts can be empty for Business-Portfolio Pages even when access was granted.
            # Fall back to the Page IDs the user ticked in Meta's dialog and fetch each one directly.
            try:
                granted_ids, had_granular = _granted_page_ids(long_token)
            except HTTPException:
                pass
            for page_id in granted_ids:
                try:
                    page = _meta_graph_get(page_id, {"fields": "id,name,access_token", "access_token": long_token})
                except HTTPException:
                    continue
                if page.get("access_token"):
                    raw_pages.append(page)

        pages = [p for p in raw_pages if p.get("id") and p.get("access_token")]
        if not pages:
            # Give the frontend a useful, non-sensitive diagnosis rather than a generic
            # "no pages" message. Never include access tokens or raw Meta responses.
            granted = set()
            try:
                permission_response = _meta_graph_get("me/permissions", {"access_token": long_token})
                granted = {
                    item.get("permission")
                    for item in permission_response.get("data", [])
                    if item.get("status") == "granted"
                }
            except HTTPException:
                pass
            required = {"pages_show_list", "pages_manage_posts", "pages_read_engagement"}
            if not required.issubset(granted):
                reason = "missing_permissions"
            elif granted_ids:
                reason = "page_token_unavailable"
            elif had_granular:
                reason = "no_pages_selected"  # permissions granted, but no Page was ticked in the dialog
            else:
                reason = "no_pages"
            return RedirectResponse(frontend + f"/?facebook_oauth=error&reason={reason}")
        encrypted = _fernet()
        debug = _meta_graph_get("debug_token", {
            "input_token": long_token,
            "access_token": f"{settings.meta_app_id.strip()}|{settings.meta_app_secret.strip()}",
        }).get("data", {})
        user_expiry = debug.get("expires_at") or None
        data_expiry = debug.get("data_access_expires_at") or None
        with db_session() as db:
            db.execute("DELETE FROM facebook_pending_pages")
            for page in pages:
                db.execute(
                    """INSERT OR REPLACE INTO facebook_pending_pages
                    (page_id,page_name,encrypted_token,token_expires_at,data_access_expires_at,created_at)
                    VALUES(?,?,?,?,?,?)""",
                    (str(page["id"]), str(page.get("name") or "Facebook Page"),
                     encrypted.encrypt(str(page["access_token"]).encode()).decode(), user_expiry, data_expiry, time.time()),
                )
        return RedirectResponse(frontend + "/?facebook_oauth=choose_page")
    except HTTPException as exc:
        reason = "setup" if exc.status_code == 503 else "meta_request_failed"
        return RedirectResponse(frontend + f"/?facebook_oauth=error&reason={reason}")


@app.get("/api/integrations/facebook/pages", dependencies=[Depends(require_api_key)])
def facebook_oauth_pages() -> dict:
    with db_session() as db:
        db.execute("DELETE FROM facebook_pending_pages WHERE created_at < ?", (time.time() - 1800,))
        rows = db.execute("SELECT page_id,page_name FROM facebook_pending_pages ORDER BY page_name").fetchall()
    connection = _stored_facebook_connection()
    return {
        "pages": [{"id": r["page_id"], "name": r["page_name"]} for r in rows],
        "connected_page_id": connection["page_id"] if connection else None,
    }


class FacebookPageSelection(BaseModel):
    page_id: str = Field(min_length=1, max_length=100)


@app.post("/api/integrations/facebook/select-page", dependencies=[Depends(require_api_key)])
def select_facebook_page(payload: FacebookPageSelection) -> dict:
    _oauth_configured()
    with db_session() as db:
        row = db.execute("SELECT * FROM facebook_pending_pages WHERE page_id=? AND created_at>=?", (payload.page_id, time.time() - 1800)).fetchone()
    if not row:
        raise HTTPException(404, "That Page is no longer available. Click Connect Facebook and try again.")
    try:
        token = _fernet().decrypt(row["encrypted_token"].encode()).decode()
    except (InvalidToken, UnicodeDecodeError) as exc:
        raise HTTPException(500, "Could not read the saved Page credential. Reconnect Facebook.") from exc
    client = client_from_settings(row["page_id"], token, settings.facebook_api_version)
    try:
        diagnostics = client.connection_diagnostics(settings.meta_app_id, settings.meta_app_secret)
    except FacebookError as exc:
        raise HTTPException(502, f"Could not verify the selected Facebook Page: {exc}") from exc
    encrypted_token = _fernet().encrypt(token.encode()).decode()
    with db_session() as db:
        db.execute(
            """INSERT INTO facebook_connection(id,page_id,page_name,encrypted_token,token_expires_at,data_access_expires_at,updated_at)
            VALUES(1,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id,page_name=excluded.page_name,
            encrypted_token=excluded.encrypted_token,token_expires_at=excluded.token_expires_at,
            data_access_expires_at=excluded.data_access_expires_at,updated_at=excluded.updated_at""",
            (row["page_id"], row["page_name"], encrypted_token, diagnostics.get("expires_at"),
             diagnostics.get("data_access_expires_at"), now_iso()),
        )
        db.execute("DELETE FROM facebook_pending_pages")
        audit(db, "connected", "integration", "facebook", {"page_id": row["page_id"], "page_name": row["page_name"]})
    return {"connected": True, "page_id": row["page_id"], "page_name": row["page_name"], "expires_at": diagnostics.get("expires_at"), "data_access_expires_at": diagnostics.get("data_access_expires_at")}


@app.post("/api/integrations/facebook/disconnect", dependencies=[Depends(require_api_key)])
def disconnect_facebook() -> dict:
    with db_session() as db:
        row = db.execute("SELECT page_id FROM facebook_connection WHERE id=1").fetchone()
        db.execute("DELETE FROM facebook_connection WHERE id=1")
        db.execute("DELETE FROM facebook_pending_pages")
        _set_flag(db, FB_ENV_DISABLED, True)
        removed = _remove_network_posts(db, "facebook")
        audit(db, "disconnected", "integration", "facebook", {"page_id": row["page_id"] if row else (settings.facebook_page_id or None), "posts_removed_from_feed": removed})
    return {"disconnected": True, "posts_removed": removed, "environment_token_ignored": bool(settings.facebook_page_id and settings.facebook_page_token)}

@app.post("/api/integrations/facebook/check", dependencies=[Depends(require_api_key)])
def check_facebook_connection() -> dict:
    global FACEBOOK_LAST_CHECKED_AT, FACEBOOK_LAST_SUCCESS_AT
    client = facebook_client()
    if not client:
        raise HTTPException(409, "Facebook is not connected. Click Connect Facebook, or add FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN to backend/.env.")
    try:
        details = client.connection_diagnostics(settings.meta_app_id, settings.meta_app_secret)
        FACEBOOK_LAST_CHECKED_AT = now_iso()
        FACEBOOK_LAST_SUCCESS_AT = FACEBOOK_LAST_CHECKED_AT
        return {**details, "last_checked_at": FACEBOOK_LAST_CHECKED_AT, "last_success_at": FACEBOOK_LAST_SUCCESS_AT}
    except FacebookError as exc:
        FACEBOOK_LAST_CHECKED_AT = now_iso()
        raise HTTPException(502, detail=f"Facebook connection check failed: {exc}")


@app.post("/api/integrations/facebook/sync", dependencies=[Depends(require_api_key)])
def sync_facebook() -> dict:
    client = facebook_client()
    if not client:
        raise HTTPException(409, "Facebook is not connected. Click Connect Facebook in Configuration first.")
    from .publisher import sync_posts  # imported here because publisher imports this module

    try:
        return sync_posts(client)
    except FacebookError as exc:
        raise HTTPException(502, f"Facebook: {exc}")
    except Exception as exc:
        raise HTTPException(500, f"Facebook sync failed unexpectedly ({exc.__class__.__name__}). See the backend log.")


@app.get("/api/integrations", dependencies=[Depends(require_api_key)])
def integrations() -> list[dict]:
    # Deliberately no fake connected accounts: "connected" only after a live check against Facebook.
    return [
        facebook_integration(),
        _instagram_integration_status(),
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


def _instagram_integration_status() -> dict:
    _ensure_instagram_tables()
    with db_session() as db:
        row = db.execute("SELECT * FROM instagram_connection WHERE id=1").fetchone()
    if not row:
        return {"provider": "instagram", "label": "Instagram Professional", "status": "not_connected", "capabilities": ["image_posts", "carousel_posts", "insights"]}
    followers_count = None
    try:
        from .instagram import InstagramClient
        token = _fernet().decrypt(row["encrypted_token"].encode()).decode()
        profile = InstagramClient(row["account_id"], token, settings.facebook_api_version).check()
        followers_count = profile.get("followers_count")
    except Exception:
        pass
    return {"provider": "instagram", "label": "Instagram Professional", "status": "connected", "account_id": row["account_id"], "account_name": row["account_name"], "username": row["username"], "followers_count": followers_count, "last_checked_at": row["last_checked_at"] or row["updated_at"], "last_success_at": row["last_checked_at"] or row["updated_at"], "token_type": "page", "expires_at": row["token_expires_at"], "data_access_expires_at": row["data_access_expires_at"], "granted_permissions": json.loads(row["granted_permissions_json"] or "[]"), "connection_source": row["connection_source"], "capabilities": ["image_posts", "carousel_posts", "insights"]}

# --------------------------------------------------------------------------- Instagram OAuth / account connection
INSTAGRAM_OAUTH_SCOPES = "instagram_basic,instagram_manage_insights,instagram_content_publish,instagram_manage_comments,pages_show_list,pages_read_engagement,pages_manage_posts,pages_read_user_content"

def _ensure_instagram_tables() -> None:
    with db_session() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS instagram_oauth_states (
            state TEXT PRIMARY KEY, created_at REAL NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS instagram_connection (
            id INTEGER PRIMARY KEY CHECK (id = 1), account_id TEXT NOT NULL,
            account_name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
            encrypted_token TEXT NOT NULL, updated_at TEXT NOT NULL,
            last_checked_at TEXT, token_expires_at INTEGER, data_access_expires_at INTEGER,
            granted_permissions_json TEXT NOT NULL DEFAULT '[]', connection_source TEXT NOT NULL DEFAULT 'oauth'
        )""")
        for column, definition in (
            ("last_checked_at", "TEXT"), ("token_expires_at", "INTEGER"),
            ("data_access_expires_at", "INTEGER"), ("granted_permissions_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("connection_source", "TEXT NOT NULL DEFAULT 'oauth'"),
        ):
            try:
                db.execute(f"ALTER TABLE instagram_connection ADD COLUMN {column} {definition}")
            except sqlite3.OperationalError:
                pass

@app.post("/api/integrations/instagram/oauth-url", dependencies=[Depends(require_api_key)])
def instagram_oauth_url() -> dict:
    _ensure_instagram_tables()
    _oauth_configured()
    state = secrets.token_urlsafe(32)
    with db_session() as db:
        db.execute("DELETE FROM instagram_oauth_states WHERE created_at < ?", (time.time() - 900,))
        db.execute("INSERT INTO instagram_oauth_states(state,created_at) VALUES(?,?)", (state, time.time()))
    params = {
        "client_id": settings.meta_app_id.strip(),
        "redirect_uri": settings.instagram_oauth_redirect_uri.strip(),
        "state": state,
        "response_type": "code",
        "scope": INSTAGRAM_OAUTH_SCOPES,
        "auth_type": "rerequest",
    }
    return {"url": "https://www.facebook.com/" + settings.facebook_api_version + "/dialog/oauth?" + urlencode(params)}

@app.get("/api/integrations/instagram/callback")
def _instagram_oauth_callback_impl(code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None, error_description: Optional[str] = None, error_reason: Optional[str] = None, error_code: Optional[str] = None):
    _ensure_instagram_tables()
    frontend = settings.facebook_frontend_url.rstrip("/")
    if error:
        reason = "authorization_cancelled" if error_reason == "user_denied" else "meta_denied"
        return RedirectResponse(frontend + "/?instagram_oauth=error&reason=" + reason)
    if not code or not state:
        return RedirectResponse(frontend + "/?instagram_oauth=error&reason=missing_code")
    with db_session() as db:
        valid = db.execute("SELECT state FROM instagram_oauth_states WHERE state=? AND created_at>=?", (state, time.time() - 900)).fetchone()
        db.execute("DELETE FROM instagram_oauth_states WHERE state=?", (state,))
    if not valid:
        return RedirectResponse(frontend + "/?instagram_oauth=error&reason=invalid_state")
    try:
        token_response = _meta_graph_get("oauth/access_token", {
            "client_id": settings.meta_app_id.strip(), "client_secret": settings.meta_app_secret.strip(),
            "redirect_uri": settings.instagram_oauth_redirect_uri.strip(), "code": code,
        })
        token = token_response.get("access_token")
        if not token:
            return RedirectResponse(frontend + "/?instagram_oauth=error&reason=no_token")
        accounts = _meta_graph_get("me/accounts", {
            "fields": "id,name,access_token,instagram_business_account", "limit": 100, "access_token": token,
        }).get("data", [])
        candidates = []
        for page in accounts:
            ig = page.get("instagram_business_account") or {}
            if ig.get("id"):
                details = _meta_graph_get(str(ig["id"]), {"fields": "id,username,name", "access_token": page.get("access_token") or token})
                candidates.append({"id": str(details.get("id")), "name": details.get("name") or details.get("username") or "Instagram", "username": details.get("username") or "", "token": page.get("access_token") or token})
        if not candidates:
            return RedirectResponse(frontend + "/?instagram_oauth=error&reason=no_professional_account")
        encrypted = _fernet()
        with db_session() as db:
            db.execute("DELETE FROM instagram_connection")
            chosen = candidates[0]
            try:
                permissions = _meta_graph_get("me/permissions", {"access_token": token}).get("data", [])
            except HTTPException:
                permissions = []
            granted = [p.get("permission") for p in permissions if p.get("status") == "granted"]
            debug = _meta_graph_get("debug_token", {"input_token": chosen["token"], "access_token": f"{settings.meta_app_id.strip()}|{settings.meta_app_secret.strip()}"}).get("data", {})
            db.execute("INSERT INTO instagram_connection(id,account_id,account_name,username,encrypted_token,updated_at,last_checked_at,token_expires_at,data_access_expires_at,granted_permissions_json,connection_source) VALUES(1,?,?,?,?,?,?,?,?,?,?)",
                       (chosen["id"], chosen["name"], chosen["username"], encrypted.encrypt(chosen["token"].encode()).decode(), now_iso(), now_iso(), debug.get("expires_at"), debug.get("data_access_expires_at"), json.dumps(granted), "oauth"))
        return RedirectResponse(frontend + "/?instagram_oauth=connected")
    except HTTPException as exc:
        log.warning("Instagram OAuth failed: %s", exc.detail)
        if exc.status_code == 503:
            return RedirectResponse(frontend + "/?instagram_oauth=error&reason=setup")
        from urllib.parse import quote
        return RedirectResponse(frontend + "/?instagram_oauth=error&reason=meta_request_failed&detail=" + quote(str(exc.detail)[:250]))
    except Exception:
        log.exception("Instagram OAuth callback failed")
        return RedirectResponse(frontend + "/?instagram_oauth=error&reason=callback_failed")

 
@app.get("/api/integrations/instagram/callback")
def instagram_oauth_callback(code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None, error_description: Optional[str] = None, error_reason: Optional[str] = None, error_code: Optional[str] = None):
    try:
        return _instagram_oauth_callback_impl(code, state, error, error_description, error_reason, error_code)
    except Exception:
        frontend = settings.facebook_frontend_url.rstrip("/")
        return RedirectResponse(frontend + "/?instagram_oauth=error&reason=callback_failed")

@app.post("/api/integrations/instagram/disconnect", dependencies=[Depends(require_api_key)])
def disconnect_instagram() -> dict:
    _ensure_instagram_tables()
    with db_session() as db:
        db.execute("DELETE FROM instagram_connection")
        removed = _remove_network_posts(db, "instagram")
        audit(db, "disconnected", "integration", "instagram", {"posts_removed_from_feed": removed})
    return {"disconnected": True, "posts_removed": removed}

@app.post("/api/integrations/instagram/check", dependencies=[Depends(require_api_key)])
def check_instagram() -> dict:
    _ensure_instagram_tables()
    from .instagram import InstagramClient, InstagramError
    with db_session() as db:
        row = db.execute("SELECT * FROM instagram_connection WHERE id=1").fetchone()
    if not row:
        raise HTTPException(409, "Instagram is not connected.")
    try:
        token = _fernet().decrypt(row["encrypted_token"].encode()).decode()
        details = InstagramClient(row["account_id"], token, settings.facebook_api_version).check()
        return {"provider": "instagram", "status": "connected", "account_id": row["account_id"], "account_name": details.get("name"), "username": details.get("username")}
    except (InvalidToken, InstagramError) as exc:
        raise HTTPException(502, f"Instagram connection check failed: {exc}") from exc


@app.post("/api/integrations/sync", dependencies=[Depends(require_api_key)])
def sync_all_integrations() -> dict:
    result = {"facebook": None, "instagram": None}
    try:
        result["facebook"] = sync_facebook()
    except HTTPException as exc:
        result["facebook"] = {"status": "not_connected"} if exc.status_code == 409 else {"status": "error", "detail": exc.detail}
    try:
        _ensure_instagram_tables()
        from .instagram import InstagramClient, InstagramError
        with db_session() as db:
            row = db.execute("SELECT * FROM instagram_connection WHERE id=1").fetchone()
        if not row:
            result["instagram"] = {"status": "not_connected"}
        else:
            token = _fernet().decrypt(row["encrypted_token"].encode()).decode()
            client = InstagramClient(row["account_id"], token, settings.facebook_api_version)
            media = client.media()
            items = media.get("data") or []
            imported = 0
            updated = 0
            stamp = now_iso()
            with db_session() as db:
                known = {}
                for known_row in db.execute("SELECT id,provider_ids_json FROM posts"):
                    ids = json.loads(known_row["provider_ids_json"])
                    if ids.get("instagram"):
                        known[ids["instagram"]] = (known_row["id"], ids)
                for item in items:
                    instagram_id = str(item.get("id") or "")
                    if not instagram_id:
                        continue
                    insight_values = {}
                    for insight in (item.get("insights") or {}).get("data") or []:
                        values = insight.get("values") or []
                        if values:
                            insight_values[insight.get("name")] = values[-1].get("value")
                    likes = item.get("like_count")
                    comments = item.get("comments_count")
                    impressions = insight_values.get("impressions")
                    reach = insight_values.get("reach")
                    clicks = insight_values.get("total_interactions")
                    views = insight_values.get("views") or insight_values.get("impressions")
                    if instagram_id in known:
                        local_id, ids = known[instagram_id]
                        if item.get("permalink"):
                            ids["permalink"] = item["permalink"]
                        db.execute("UPDATE posts SET likes=COALESCE(?,likes),comments=COALESCE(?,comments),clicks=COALESCE(?,clicks),reach=COALESCE(?,reach),impressions=COALESCE(?,impressions),views=COALESCE(?,views),metrics_refreshed_at=?,provider_ids_json=? WHERE id=?", (likes, comments, clicks, reach, impressions, views, stamp, json.dumps(ids), local_id))
                        updated += 1
                        continue
                    local_id = "ig-" + instagram_id.replace("_", "-")
                    ids = {"instagram": instagram_id, **({"permalink": item["permalink"]} if item.get("permalink") else {})}
                    image_url = item.get("media_url")
                    media_json = [{"id": local_id + "-1", "name": "Instagram media", "url": image_url}] if image_url else []
                    published_at = item.get("timestamp") or stamp
                    db.execute("INSERT INTO posts(id,title,caption,channels_json,status,published_at,media_json,provider_ids_json,likes,comments,shares,reach,impressions,views,metrics_refreshed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (local_id, "", item.get("caption") or "", json.dumps(["instagram"]), "published", published_at, json.dumps(media_json), json.dumps(ids), likes, comments, clicks, reach, impressions, views, stamp, stamp, stamp))
                    imported += 1
                db.execute("UPDATE instagram_connection SET last_checked_at=?, updated_at=? WHERE id=1", (stamp, stamp))
            result["instagram"] = {"status": "synced", "account_id": row["account_id"], "items": len(items), "imported": imported, "updated": updated}
    except Exception as exc:
        result["instagram"] = {"status": "error", "detail": str(exc)}
    return result
