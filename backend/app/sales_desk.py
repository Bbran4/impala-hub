"""Sales Desk configuration and RFQ records.

All timestamps are stored as UTC ISO strings. RFQ numbers use the Africa/Johannesburg
business date and a database-serialized sequence per date. Converting a quotation to an
invoice appends "INV" to the number (the original number is kept in original_rfq_no).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from .sales_desk_auth import current_user, require_admin

router = APIRouter(prefix="/api/sales-desk", tags=["Sales Desk"])
DB_PATH = Path(os.getenv("DATABASE_PATH", "./data/impala_hub.db")).resolve()
BUSINESS_TZ = ZoneInfo("Africa/Johannesburg")
MAX_ATTACHMENT_BYTES = int(os.getenv("MAX_UPLOAD_MB", "15")) * 1024 * 1024
MAX_ATTACHMENTS_PER_RFQ = 30


def _connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=15000")
    return db


def init_sales_desk_db(database_path: Optional[Path] = None) -> None:
    global DB_PATH
    if database_path is not None:
        DB_PATH = Path(database_path).resolve()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS sd_media_platforms (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sd_sales_codes (
            id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sd_statuses (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
            is_closed INTEGER NOT NULL DEFAULT 0 CHECK(is_closed IN (0,1)),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sd_rfq_daily_sequences (
            business_date TEXT PRIMARY KEY, last_number INTEGER NOT NULL CHECK(last_number > 0)
        );
        CREATE TABLE IF NOT EXISTS sd_rfqs (
            id TEXT PRIMARY KEY,
            rfq_no TEXT NOT NULL UNIQUE,
            business_date TEXT NOT NULL,
            daily_number INTEGER NOT NULL,
            rfq_type TEXT NOT NULL DEFAULT 'quotation' CHECK(rfq_type IN ('quotation','invoice')),
            original_rfq_no TEXT,
            converted_at TEXT,
            media_platform_id TEXT REFERENCES sd_media_platforms(id) ON DELETE RESTRICT,
            customer_name TEXT NOT NULL,
            contact_number TEXT NOT NULL DEFAULT '',
            email_address TEXT NOT NULL DEFAULT '',
            query_information TEXT NOT NULL DEFAULT '',
            sales_code_id TEXT REFERENCES sd_sales_codes(id) ON DELETE RESTRICT,
            claimed_at TEXT,
            received_at TEXT NOT NULL,
            remarks TEXT NOT NULL DEFAULT '',
            status_id TEXT NOT NULL REFERENCES sd_statuses(id) ON DELETE RESTRICT,
            document_number TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(business_date,daily_number)
        );
        CREATE INDEX IF NOT EXISTS idx_sd_rfqs_status ON sd_rfqs(status_id);
        CREATE INDEX IF NOT EXISTS idx_sd_rfqs_sales_code ON sd_rfqs(sales_code_id);
        CREATE INDEX IF NOT EXISTS idx_sd_rfqs_received ON sd_rfqs(received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sd_rfqs_customer ON sd_rfqs(customer_name);
        CREATE TABLE IF NOT EXISTS sd_rfq_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rfq_id TEXT NOT NULL REFERENCES sd_rfqs(id) ON DELETE RESTRICT,
            actor_user_id TEXT NOT NULL,
            action TEXT NOT NULL,
            changes_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sd_rfq_attachments (
            id TEXT PRIMARY KEY,
            rfq_id TEXT NOT NULL REFERENCES sd_rfqs(id) ON DELETE RESTRICT,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL UNIQUE,
            content_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            uploaded_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sd_attachments_rfq ON sd_rfq_attachments(rfq_id);
        -- Attachments are permanent. The database itself refuses deletes, not just the API.
        CREATE TRIGGER IF NOT EXISTS trg_sd_attachments_no_delete BEFORE DELETE ON sd_rfq_attachments
        BEGIN SELECT RAISE(ABORT, 'Attachments cannot be deleted'); END;
        """)
        # Additive migrations for databases created before these columns existed.
        status_columns = {row["name"] for row in db.execute("PRAGMA table_info(sd_statuses)").fetchall()}
        if "is_closed" not in status_columns:
            db.execute("ALTER TABLE sd_statuses ADD COLUMN is_closed INTEGER NOT NULL DEFAULT 0")
        rfq_columns = {row["name"] for row in db.execute("PRAGMA table_info(sd_rfqs)").fetchall()}
        if "rfq_type" not in rfq_columns:
            db.execute("ALTER TABLE sd_rfqs ADD COLUMN rfq_type TEXT NOT NULL DEFAULT 'quotation' CHECK(rfq_type IN ('quotation','invoice'))")
        if "original_rfq_no" not in rfq_columns:
            db.execute("ALTER TABLE sd_rfqs ADD COLUMN original_rfq_no TEXT")
        if "converted_at" not in rfq_columns:
            db.execute("ALTER TABLE sd_rfqs ADD COLUMN converted_at TEXT")
        now = _now()
        for name, order, closed in (
            ("Unclaimed", 0, 0), ("New", 1, 0), ("In Progress", 2, 0),
            ("Awaiting Customer", 3, 0), ("Quotation Issued", 4, 0),
            ("Converted to Sale", 5, 1), ("Lost", 6, 1), ("Closed", 7, 1),
        ):
            db.execute(
                "INSERT OR IGNORE INTO sd_statuses(id,name,sort_order,is_active,is_closed,created_at,updated_at) VALUES(?,?,?,1,?,?,?)",
                (uuid.uuid4().hex, name, order, closed, now, now),
            )
        for name, order in (("Facebook", 0), ("WhatsApp", 1), ("Email", 2), ("Telephone", 3), ("Walk-in", 4)):
            db.execute(
                "INSERT OR IGNORE INTO sd_media_platforms(id,name,sort_order,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)",
                (uuid.uuid4().hex, name, order, now, now),
            )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc(value: datetime) -> datetime:
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value).astimezone(timezone.utc)


def _audit(db: sqlite3.Connection, rfq_id: str, actor: str, action: str, changes: dict) -> None:
    db.execute(
        "INSERT INTO sd_rfq_audit(rfq_id,actor_user_id,action,changes_json,created_at) VALUES(?,?,?,?,?)",
        (rfq_id, actor, action, json.dumps(changes, ensure_ascii=False), _now()),
    )


def _rfq(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["media_platform"] = item.pop("media_platform_name", None)
    item["sales_code"] = item.pop("sales_code_value", None)
    item["status"] = item.pop("status_name", None)
    item["status_is_closed"] = bool(item.get("status_is_closed"))
    return item


RFQ_SELECT = """SELECT r.*, m.name AS media_platform_name, sc.code AS sales_code_value,
    (SELECT u.display_name FROM sd_users u WHERE u.sales_code=sc.code COLLATE NOCASE
       AND u.role='salesperson' AND u.is_active=1 ORDER BY u.display_name LIMIT 1) AS salesperson_name,
    st.name AS status_name, st.is_closed AS status_is_closed,
    (SELECT COUNT(*) FROM sd_rfq_attachments a WHERE a.rfq_id=r.id) AS attachment_count
    FROM sd_rfqs r
    LEFT JOIN sd_media_platforms m ON m.id=r.media_platform_id
    LEFT JOIN sd_sales_codes sc ON sc.id=r.sales_code_id
    JOIN sd_statuses st ON st.id=r.status_id"""


def _owns(user: dict, row: sqlite3.Row) -> bool:
    """Administrators and managers act on any RFQ; a salesperson only on their own claimed ones."""
    if user["role"] != "salesperson":
        return True
    return bool(row["sales_code_value"]) and row["sales_code_value"].lower() == (user.get("sales_code") or "").lower()


def _visible(user: dict, row: sqlite3.Row) -> bool:
    """Salespeople can also see unclaimed RFQs so they can claim them."""
    return _owns(user, row) or (user["role"] == "salesperson" and not row["sales_code_value"])


def _detail(db: sqlite3.Connection, rfq_id: str) -> dict:
    row = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
    if not row:
        raise HTTPException(404, "RFQ not found")
    result = _rfq(row)
    history = db.execute("SELECT action,changes_json,created_at,actor_user_id FROM sd_rfq_audit WHERE rfq_id=? ORDER BY id", (rfq_id,)).fetchall()
    result["audit_history"] = [{**dict(x), "changes": json.loads(x["changes_json"])} for x in history]
    attachments = db.execute(
        """SELECT a.id,a.original_name,a.content_type,a.size,a.created_at,u.display_name AS uploaded_by_name
        FROM sd_rfq_attachments a LEFT JOIN sd_users u ON u.id=a.uploaded_by
        WHERE a.rfq_id=? ORDER BY a.created_at,a.id""", (rfq_id,)).fetchall()
    result["attachments"] = [dict(x) for x in attachments]
    return result


def require_manager(user: dict = Depends(current_user)) -> dict:
    if user["role"] not in {"administrator", "manager"}:
        raise HTTPException(403, "Manager or administrator permission required")
    return user


# --------------------------------------------------------------------------- models
class ConfigOptionIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    is_closed: bool = False

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


class OrderIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)


class RFQCreateIn(BaseModel):
    media_platform_id: str
    customer_name: str = Field(min_length=1, max_length=200)
    contact_number: str = Field(default="", max_length=80)
    email_address: str = Field(default="", max_length=254)
    query_information: str = Field(default="", max_length=12000)
    remarks: str = Field(default="", max_length=12000)
    status_id: Optional[str] = None
    sales_code_id: Optional[str] = None
    document_number: str = Field(default="", max_length=120)
    received_at: Optional[datetime] = None
    claimed_at: Optional[datetime] = None

    @field_validator("customer_name")
    @classmethod
    def customer_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Customer name cannot be blank")
        return v


class RFQPatchIn(BaseModel):
    media_platform_id: Optional[str] = None
    customer_name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    contact_number: Optional[str] = Field(default=None, max_length=80)
    email_address: Optional[str] = Field(default=None, max_length=254)
    query_information: Optional[str] = Field(default=None, max_length=12000)
    remarks: Optional[str] = Field(default=None, max_length=12000)
    status_id: Optional[str] = None
    document_number: Optional[str] = Field(default=None, max_length=120)
    sales_code_id: Optional[str] = None  # explicit null removes the assignment
    received_at: Optional[datetime] = None
    claimed_at: Optional[datetime] = None  # explicit null clears it (only valid without a sales code)


NULLABLE_PATCH_FIELDS = {"sales_code_id", "claimed_at"}
TEXT_FIELDS = ("customer_name", "contact_number", "email_address", "query_information", "remarks", "document_number")
# Salespeople may NOT change: RFQ number (never editable), media platform, sales code, status.
SALESPERSON_FIELDS = set(TEXT_FIELDS) | {"received_at", "claimed_at"}


# --------------------------------------------------------------------------- configuration
@router.get("/config")
def get_config(user: dict = Depends(current_user)) -> dict:
    with _connect() as db:
        media = db.execute(
            """SELECT p.*, (SELECT COUNT(*) FROM sd_rfqs r WHERE r.media_platform_id=p.id) AS rfq_count
            FROM sd_media_platforms p ORDER BY sort_order,name""").fetchall()
        statuses = db.execute(
            """SELECT s.*, (SELECT COUNT(*) FROM sd_rfqs r WHERE r.status_id=s.id) AS rfq_count
            FROM sd_statuses s ORDER BY sort_order,name""").fetchall()
        code_query = """SELECT sc.*, (SELECT u.display_name FROM sd_users u WHERE u.sales_code=sc.code COLLATE NOCASE
            AND u.role='salesperson' ORDER BY u.display_name LIMIT 1) AS consultant_name,
            (SELECT COUNT(*) FROM sd_rfqs r WHERE r.sales_code_id=sc.id) AS rfq_count FROM sd_sales_codes sc"""
        if user["role"] == "salesperson":
            codes = db.execute(code_query + " WHERE sc.code=? COLLATE NOCASE", (user.get("sales_code") or "",)).fetchall()
        else:
            codes = db.execute(code_query + " ORDER BY sc.code").fetchall()
    return {"media_platforms": [dict(x) for x in media], "sales_codes": [dict(x) for x in codes],
            "statuses": [dict(x) for x in statuses], "can_configure": user["role"] == "administrator"}


def _reorder(table: str, ids: list[str]) -> list[dict]:
    """table is always an internal constant, never user input."""
    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = {r["id"] for r in db.execute(f"SELECT id FROM {table}")}
        if len(set(ids)) != len(ids) or set(ids) != existing:
            raise HTTPException(409, "The list has changed. Refresh the page and try again.")
        now = _now()
        for position, ident in enumerate(ids):
            db.execute(f"UPDATE {table} SET sort_order=?,updated_at=? WHERE id=?", (position, now, ident))
        return [dict(r) for r in db.execute(f"SELECT * FROM {table} ORDER BY sort_order,name")]


def _delete_option(table: str, column: str, option_id: str, label: str) -> dict:
    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(f"SELECT * FROM {table} WHERE id=?", (option_id,)).fetchone()
        if not row:
            raise HTTPException(404, f"{label} not found")
        if table == "sd_statuses" and row["name"].lower() == "unclaimed":
            raise HTTPException(409, "The Unclaimed status is required for new RFQs and cannot be deleted")
        if db.execute(f"SELECT 1 FROM sd_rfqs WHERE {column}=? LIMIT 1", (option_id,)).fetchone():
            raise HTTPException(409, f"This {label.lower()} is linked to RFQs and cannot be deleted. Deactivate it instead.")
        db.execute(f"DELETE FROM {table} WHERE id=?", (option_id,))
    return {"deleted": True}


@router.post("/config/media-platforms", status_code=201)
def create_media(payload: ConfigOptionIn, _: dict = Depends(require_admin)) -> dict:
    now, ident = _now(), uuid.uuid4().hex
    with _connect() as db:
        try:  # new options go to the end of the list
            db.execute("""INSERT INTO sd_media_platforms(id,name,sort_order,is_active,created_at,updated_at)
                SELECT ?,?,COALESCE(MAX(sort_order)+1,0),1,?,? FROM sd_media_platforms""", (ident, payload.name, now, now))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "Media platform already exists") from exc
        return dict(db.execute("SELECT * FROM sd_media_platforms WHERE id=?", (ident,)).fetchone())


@router.put("/config/media-platforms/order")
def order_media(payload: OrderIn, _: dict = Depends(require_admin)) -> list[dict]:
    return _reorder("sd_media_platforms", payload.ids)


@router.patch("/config/media-platforms/{option_id}")
def patch_media(option_id: str, payload: dict, _: dict = Depends(require_admin)) -> dict:
    allowed = {"name", "is_active"}
    if not payload or set(payload) - allowed:
        raise HTTPException(422, "Only name and is_active can be changed")
    with _connect() as db:
        row = db.execute("SELECT * FROM sd_media_platforms WHERE id=?", (option_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Media platform not found")
        name = str(payload.get("name", row["name"])).strip()
        if not name or len(name) > 100:
            raise HTTPException(422, "Name must contain 1 to 100 characters")
        active_value = payload.get("is_active", bool(row["is_active"]))
        if not isinstance(active_value, (bool, int)) or active_value not in (False, True, 0, 1):
            raise HTTPException(422, "is_active must be true or false")
        try:
            db.execute("UPDATE sd_media_platforms SET name=?,is_active=?,updated_at=? WHERE id=?",
                       (name, int(active_value), _now(), option_id))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "A media platform with that name already exists") from exc
        return dict(db.execute("SELECT * FROM sd_media_platforms WHERE id=?", (option_id,)).fetchone())


@router.delete("/config/media-platforms/{option_id}")
def delete_media(option_id: str, _: dict = Depends(require_admin)) -> dict:
    return _delete_option("sd_media_platforms", "media_platform_id", option_id, "Media platform")


@router.patch("/config/sales-codes/{option_id}")
def patch_sales_code(option_id: str, payload: dict, _: dict = Depends(require_manager)) -> dict:
    """Sales codes are generated when a consultant account is created, so they cannot be added or renamed.
    Managers and administrators can only switch them active or inactive."""
    if not payload or set(payload) != {"is_active"}:
        raise HTTPException(422, "Only is_active can be changed on a sales code")
    active_value = payload["is_active"]
    if not isinstance(active_value, (bool, int)) or active_value not in (False, True, 0, 1):
        raise HTTPException(422, "is_active must be true or false")
    with _connect() as db:
        if not db.execute("SELECT 1 FROM sd_sales_codes WHERE id=?", (option_id,)).fetchone():
            raise HTTPException(404, "Sales code not found")
        db.execute("UPDATE sd_sales_codes SET is_active=?,updated_at=? WHERE id=?", (int(active_value), _now(), option_id))
        return dict(db.execute("SELECT * FROM sd_sales_codes WHERE id=?", (option_id,)).fetchone())


@router.post("/config/statuses", status_code=201)
def create_status(payload: ConfigOptionIn, _: dict = Depends(require_admin)) -> dict:
    now, ident = _now(), uuid.uuid4().hex
    with _connect() as db:
        try:
            db.execute("""INSERT INTO sd_statuses(id,name,sort_order,is_active,is_closed,created_at,updated_at)
                SELECT ?,?,COALESCE(MAX(sort_order)+1,0),1,?,?,? FROM sd_statuses""",
                       (ident, payload.name, int(payload.is_closed), now, now))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "Status already exists") from exc
        return dict(db.execute("SELECT * FROM sd_statuses WHERE id=?", (ident,)).fetchone())


@router.put("/config/statuses/order")
def order_statuses(payload: OrderIn, _: dict = Depends(require_admin)) -> list[dict]:
    return _reorder("sd_statuses", payload.ids)


@router.patch("/config/statuses/{option_id}")
def patch_status(option_id: str, payload: dict, _: dict = Depends(require_admin)) -> dict:
    allowed = {"name", "is_active", "is_closed"}
    if not payload or set(payload) - allowed:
        raise HTTPException(422, "Only name, is_active and is_closed can be changed")
    with _connect() as db:
        row = db.execute("SELECT * FROM sd_statuses WHERE id=?", (option_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Status not found")
        name = str(payload.get("name", row["name"])).strip()
        active_value = payload.get("is_active", bool(row["is_active"]))
        closed_value = payload.get("is_closed", bool(row["is_closed"]))
        if not name or len(name) > 100:
            raise HTTPException(422, "Name must contain 1 to 100 characters")
        if not isinstance(active_value, (bool, int)) or active_value not in (False, True, 0, 1):
            raise HTTPException(422, "is_active must be true or false")
        if not isinstance(closed_value, (bool, int)) or closed_value not in (False, True, 0, 1):
            raise HTTPException(422, "is_closed must be true or false")
        if row["name"].lower() == "unclaimed" and not active_value:
            raise HTTPException(409, "The Unclaimed status is required for new RFQs and cannot be deactivated")
        try:
            db.execute("UPDATE sd_statuses SET name=?,is_active=?,is_closed=?,updated_at=? WHERE id=?",
                       (name, int(active_value), int(closed_value), _now(), option_id))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "A status with that name already exists") from exc
        return dict(db.execute("SELECT * FROM sd_statuses WHERE id=?", (option_id,)).fetchone())


@router.delete("/config/statuses/{option_id}")
def delete_status(option_id: str, _: dict = Depends(require_admin)) -> dict:
    return _delete_option("sd_statuses", "status_id", option_id, "Status")


# --------------------------------------------------------------------------- RFQs
@router.get("/rfqs")
def list_rfqs(status_id: Optional[str] = None, sales_code_id: Optional[str] = None,
              rfq_type: Optional[str] = Query(default=None, pattern="^(quotation|invoice)$"),
              search: str = Query(default="", max_length=200), unclaimed_only: bool = False,
              limit: int = Query(default=100, ge=1, le=500),
              offset: int = Query(default=0, ge=0), user: dict = Depends(current_user)) -> dict:
    clauses, args = [], []
    if user["role"] == "salesperson":
        if not user.get("sales_code"):
            raise HTTPException(403, "Your account is not linked to a configured sales code")
        clauses.append("(r.sales_code_id=(SELECT id FROM sd_sales_codes WHERE code=? COLLATE NOCASE) OR r.sales_code_id IS NULL)")
        args.append(user["sales_code"])
    if unclaimed_only:
        clauses.append("r.sales_code_id IS NULL")
    if status_id:
        clauses.append("r.status_id=?"); args.append(status_id)
    if rfq_type:
        clauses.append("r.rfq_type=?"); args.append(rfq_type)
    if sales_code_id and user["role"] != "salesperson":
        clauses.append("r.sales_code_id=?"); args.append(sales_code_id)
    if search.strip():
        term = f"%{search.strip()}%"
        clauses.append("(r.rfq_no LIKE ? OR r.original_rfq_no LIKE ? OR r.customer_name LIKE ? OR r.document_number LIKE ?)")
        args.extend([term, term, term, term])
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    sort = "CASE WHEN r.sales_code_id IS NULL THEN 0 ELSE 1 END ASC, r.received_at ASC, r.rfq_no ASC"
    with _connect() as db:
        rows = db.execute(RFQ_SELECT + where + f" ORDER BY {sort} LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
        total = db.execute("SELECT COUNT(*) FROM sd_rfqs r" + where, args).fetchone()[0]
    return {"items": [_rfq(x) for x in rows], "total": total, "limit": limit, "offset": offset}


@router.post("/rfqs", status_code=201)
def create_rfq(payload: RFQCreateIn, user: dict = Depends(current_user)) -> dict:
    if user["role"] == "salesperson":
        raise HTTPException(403, "Salespeople cannot create RFQs directly")
    now = datetime.now(timezone.utc)
    received_at = _utc(payload.received_at).isoformat() if payload.received_at else now.isoformat()
    claimed_at = _utc(payload.claimed_at).isoformat() if payload.claimed_at else None
    if claimed_at and not payload.sales_code_id:
        raise HTTPException(422, "Choose a sales code before setting a claimed date")
    business_date = now.astimezone(BUSINESS_TZ).strftime("%y%m%d")
    ident = uuid.uuid4().hex
    with _connect() as db:
        if not db.execute("SELECT 1 FROM sd_media_platforms WHERE id=? AND is_active=1", (payload.media_platform_id,)).fetchone():
            raise HTTPException(422, "Choose an active media platform")
        code_value = None
        if payload.sales_code_id:
            code = db.execute("SELECT code FROM sd_sales_codes WHERE id=? AND is_active=1", (payload.sales_code_id,)).fetchone()
            if not code:
                raise HTTPException(422, "Choose an active configured sales code")
            code_value = code["code"]
            claimed_at = claimed_at or now.isoformat()
        if claimed_at and datetime.fromisoformat(claimed_at) < datetime.fromisoformat(received_at):
            raise HTTPException(422, "The claimed date cannot be before the received date")
        if payload.status_id:
            status = db.execute("SELECT id FROM sd_statuses WHERE id=? AND is_active=1", (payload.status_id,)).fetchone()
            if not status:
                raise HTTPException(422, "Choose an active status")
        else:
            status = None
            if code_value:
                status = db.execute("SELECT id FROM sd_statuses WHERE name='New' COLLATE NOCASE AND is_active=1").fetchone()
            status = status or db.execute("SELECT id FROM sd_statuses WHERE name='Unclaimed' COLLATE NOCASE AND is_active=1").fetchone()
            if not status:
                raise HTTPException(500, "The Unclaimed status is not configured")
        # BEGIN IMMEDIATE serializes number allocation across simultaneous writers.
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT last_number FROM sd_rfq_daily_sequences WHERE business_date=?", (business_date,)).fetchone()
        daily_number = (row["last_number"] + 1) if row else 1
        if row:
            db.execute("UPDATE sd_rfq_daily_sequences SET last_number=? WHERE business_date=?", (daily_number, business_date))
        else:
            db.execute("INSERT INTO sd_rfq_daily_sequences(business_date,last_number) VALUES(?,?)", (business_date, daily_number))
        rfq_no = f"IMP{business_date}{daily_number:02d}"
        db.execute("""INSERT INTO sd_rfqs
            (id,rfq_no,business_date,daily_number,rfq_type,media_platform_id,customer_name,contact_number,email_address,
             query_information,sales_code_id,claimed_at,received_at,remarks,status_id,document_number,
             created_by,updated_by,created_at,updated_at)
            VALUES(?,?,?,?, 'quotation', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ident, rfq_no, business_date, daily_number, payload.media_platform_id, payload.customer_name.strip(),
             payload.contact_number.strip(), payload.email_address.strip(), payload.query_information.strip(),
             payload.sales_code_id, claimed_at, received_at, payload.remarks.strip(), status["id"],
             payload.document_number.strip(), user["id"], user["id"], now.isoformat(), now.isoformat()))
        _audit(db, ident, user["id"], "created", {"rfq_no": rfq_no, "sales_code": code_value})
        return _detail(db, ident)


@router.get("/rfqs/{rfq_id}")
def get_rfq(rfq_id: str, user: dict = Depends(current_user)) -> dict:
    with _connect() as db:
        row = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
        if not row or not _visible(user, row):
            raise HTTPException(404, "RFQ not found")
        return _detail(db, rfq_id)


def _option_name(db: sqlite3.Connection, table: str, ident: Optional[str]) -> Optional[str]:
    if not ident:
        return None
    row = db.execute(f"SELECT name FROM {table} WHERE id=?", (ident,)).fetchone()
    return row["name"] if row else ident


def _code_value(db: sqlite3.Connection, ident: Optional[str]) -> Optional[str]:
    row = db.execute("SELECT code FROM sd_sales_codes WHERE id=?", (ident,)).fetchone() if ident else None
    return row["code"] if row else None


@router.patch("/rfqs/{rfq_id}")
def patch_rfq(rfq_id: str, payload: RFQPatchIn, user: dict = Depends(current_user)) -> dict:
    changes = payload.model_dump(exclude_unset=True)
    for key in [k for k, v in changes.items() if v is None and k not in NULLABLE_PATCH_FIELDS]:
        del changes[key]
    if not changes:
        raise HTTPException(422, "No changes supplied")
    if user["role"] == "salesperson" and set(changes) - SALESPERSON_FIELDS:
        raise HTTPException(403, "Salespeople cannot change the RFQ number, media platform, sales code or status")
    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
        if not row or not _owns(user, row):
            raise HTTPException(404, "RFQ not found")
        updates: dict = {}
        for field in TEXT_FIELDS:
            if field in changes:
                updates[field] = str(changes[field]).strip()
        if "customer_name" in updates and not updates["customer_name"]:
            raise HTTPException(422, "Customer name cannot be blank")
        if "media_platform_id" in changes:
            if not db.execute("SELECT 1 FROM sd_media_platforms WHERE id=? AND (is_active=1 OR id=?)",
                              (changes["media_platform_id"], row["media_platform_id"])).fetchone():
                raise HTTPException(422, "Choose an active media platform")
            updates["media_platform_id"] = changes["media_platform_id"]
        if "status_id" in changes:
            if not db.execute("SELECT 1 FROM sd_statuses WHERE id=? AND (is_active=1 OR id=?)",
                              (changes["status_id"], row["status_id"])).fetchone():
                raise HTTPException(422, "Choose an active status")
            updates["status_id"] = changes["status_id"]

        # Sales code, claimed date and received date are validated together.
        new_received = _utc(changes["received_at"]).isoformat() if "received_at" in changes else row["received_at"]
        if "received_at" in changes:
            updates["received_at"] = new_received
        code_changed, new_code_id = False, row["sales_code_id"]
        if "sales_code_id" in changes and changes["sales_code_id"] != row["sales_code_id"]:
            target = changes["sales_code_id"]
            if target is not None and not db.execute("SELECT 1 FROM sd_sales_codes WHERE id=? AND is_active=1", (target,)).fetchone():
                raise HTTPException(422, "Choose an active configured sales code")
            code_changed, new_code_id = True, target
        claimed = row["claimed_at"]
        if "claimed_at" in changes:
            if changes["claimed_at"] is None:
                if new_code_id:
                    raise HTTPException(422, "A claimed RFQ needs a claimed date. Remove the sales code to clear it.")
                claimed = None
            else:
                claimed = _utc(changes["claimed_at"]).isoformat()
        elif code_changed:
            claimed = _now() if new_code_id else None  # a new assignment starts a new claim
        if claimed and not new_code_id:
            raise HTTPException(422, "Choose a sales code before setting a claimed date")
        if new_code_id and not claimed:
            claimed = _now()
        if ("claimed_at" in changes or "received_at" in changes or code_changed) and claimed \
                and datetime.fromisoformat(claimed) < datetime.fromisoformat(new_received):
            raise HTTPException(422, "The claimed date cannot be before the received date")
        if code_changed:
            updates["sales_code_id"] = new_code_id
            # Assigning an unclaimed RFQ moves it out of "Unclaimed" unless the form chose a status.
            if row["sales_code_id"] is None and new_code_id and "status_id" not in updates \
                    and (row["status_name"] or "").lower() == "unclaimed":
                new_status = db.execute("SELECT id FROM sd_statuses WHERE name='New' COLLATE NOCASE AND is_active=1").fetchone()
                if new_status:
                    updates["status_id"] = new_status["id"]
        if claimed != row["claimed_at"]:
            updates["claimed_at"] = claimed
        updates = {k: v for k, v in updates.items() if v != row[k]}
        if not updates:
            return _detail(db, rfq_id)

        db.execute(
            "UPDATE sd_rfqs SET " + ",".join(f"{k}=?" for k in updates) + ",updated_by=?,updated_at=? WHERE id=?",
            (*updates.values(), user["id"], _now(), rfq_id))

        audit_changes: dict = {}
        for key, new in updates.items():
            if key == "sales_code_id" or (code_changed and key == "claimed_at"):
                continue
            old, label = row[key], key
            if key == "media_platform_id":
                label, old, new = "media_platform", _option_name(db, "sd_media_platforms", old), _option_name(db, "sd_media_platforms", new)
            elif key == "status_id":
                label, old, new = "status", _option_name(db, "sd_statuses", old), _option_name(db, "sd_statuses", new)
            audit_changes[label] = {"from": old, "to": new}
        if audit_changes:
            _audit(db, rfq_id, user["id"], "updated", audit_changes)
        if code_changed:
            previous, current = row["sales_code_value"], _code_value(db, new_code_id)
            action = "assigned" if previous is None else "unassigned" if current is None else "reassigned"
            _audit(db, rfq_id, user["id"], action, {"from_sales_code": previous, "to_sales_code": current, "claimed_at": claimed})
        return _detail(db, rfq_id)


@router.get("/rfqs/{rfq_id}/history")
def rfq_history(rfq_id: str, user: dict = Depends(current_user)) -> list[dict]:
    return get_rfq(rfq_id, user)["audit_history"]


@router.post("/rfqs/{rfq_id}/convert-to-invoice", status_code=201)
def convert_to_invoice(rfq_id: str, user: dict = Depends(current_user)) -> dict:
    """Create an invoice copy of a closed quotation, preserving the original quotation."""
    import shutil

    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
        if not row or not _owns(user, row):
            raise HTTPException(404, "RFQ not found")
        if row["rfq_type"] == "invoice":
            raise HTTPException(409, "An invoice cannot be converted to another invoice")
        if not row["status_is_closed"]:
            raise HTTPException(409, "Only a closed RFQ can be converted to an invoice. Set a closed status first.")

        source = db.execute("SELECT * FROM sd_rfqs WHERE id=?", (rfq_id,)).fetchone()
        new_no, now, invoice_id = row["rfq_no"] + "INV", _now(), uuid.uuid4().hex
        if db.execute("SELECT 1 FROM sd_rfqs WHERE rfq_no=?", (new_no,)).fetchone():
            raise HTTPException(409, f"An RFQ or invoice already uses the number {new_no}")

        # Each record must have a unique daily sequence even though the invoice reference
        # is derived from the original quotation number.
        next_daily = db.execute(
            "SELECT COALESCE(MAX(daily_number),0)+1 FROM sd_rfqs WHERE business_date=?",
            (source["business_date"],),
        ).fetchone()[0]
        # Keep the normal RFQ sequence in sync with the extra invoice record.
        db.execute(
            """INSERT INTO sd_rfq_daily_sequences(business_date,last_number) VALUES(?,?)
            ON CONFLICT(business_date) DO UPDATE SET last_number=MAX(last_number,excluded.last_number)""",
            (source["business_date"], next_daily),
        )
        db.execute(
            """INSERT INTO sd_rfqs
            (id,rfq_no,business_date,daily_number,rfq_type,original_rfq_no,converted_at,
             media_platform_id,customer_name,contact_number,email_address,query_information,
             sales_code_id,claimed_at,received_at,remarks,status_id,document_number,
             created_by,updated_by,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (invoice_id,new_no,source["business_date"],next_daily,"invoice",source["rfq_no"],now,
             source["media_platform_id"],source["customer_name"],source["contact_number"],
             source["email_address"],source["query_information"],source["sales_code_id"],
             source["claimed_at"],source["received_at"],source["remarks"],source["status_id"],
             source["document_number"],user["id"],user["id"],now,now),
        )

        # Duplicate the private attachment files as well, so the invoice has its own
        # attachment records and can be retained independently of the quotation.
        attachments = db.execute(
            "SELECT * FROM sd_rfq_attachments WHERE rfq_id=? ORDER BY created_at,id", (rfq_id,)
        ).fetchall()
        copied_files: list[Path] = []
        try:
            for attachment in attachments:
                old_path = _attachment_dir() / attachment["stored_name"]
                if not old_path.is_file():
                    raise HTTPException(409, f"Cannot copy missing attachment: {attachment['original_name']}")
                new_stored = uuid.uuid4().hex + Path(attachment["stored_name"]).suffix
                new_path = _attachment_dir() / new_stored
                shutil.copy2(old_path, new_path)
                copied_files.append(new_path)
                db.execute(
                    """INSERT INTO sd_rfq_attachments
                    (id,rfq_id,original_name,stored_name,content_type,size,uploaded_by,created_at)
                    VALUES(?,?,?,?,?,?,?,?)""",
                    (uuid.uuid4().hex,invoice_id,attachment["original_name"],new_stored,
                     attachment["content_type"],attachment["size"],user["id"],now),
                )
        except Exception:
            for path in copied_files:
                path.unlink(missing_ok=True)
            raise

        _audit(db, rfq_id, user["id"], "invoice_copy_created", {"to_rfq_no": new_no, "invoice_id": invoice_id})
        _audit(db, invoice_id, user["id"], "created_from_quotation", {"from_rfq_no": row["rfq_no"], "to_rfq_no": new_no})
        return _detail(db, invoice_id)


# --------------------------------------------------------------------------- attachments
_ZIP = lambda b: b.startswith(b"PK\x03\x04")
_OLE = lambda b: b.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
_JPEG = lambda b: b.startswith(b"\xff\xd8\xff")
ATTACHMENT_TYPES = {
    ".jpg": ("image/jpeg", _JPEG), ".jpeg": ("image/jpeg", _JPEG),
    ".png": ("image/png", lambda b: b.startswith(b"\x89PNG\r\n\x1a\n")),
    ".gif": ("image/gif", lambda b: b.startswith((b"GIF87a", b"GIF89a"))),
    ".webp": ("image/webp", lambda b: len(b) >= 12 and b.startswith(b"RIFF") and b[8:12] == b"WEBP"),
    ".pdf": ("application/pdf", lambda b: b.startswith(b"%PDF-")),
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", _ZIP),
    ".xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", _ZIP),
    ".doc": ("application/msword", _OLE),
    ".xls": ("application/vnd.ms-excel", _OLE),
}


def _attachment_dir() -> Path:
    """Private folder beside the database. Deliberately NOT under /uploads, which is public."""
    path = DB_PATH.parent / "rfq_attachments"
    path.mkdir(parents=True, exist_ok=True)
    return path


@router.post("/rfqs/{rfq_id}/attachments", status_code=201)
def upload_attachment(rfq_id: str, file: UploadFile = File(...), user: dict = Depends(current_user)) -> dict:
    name = re.sub(r"[\x00-\x1f\x7f]", "", Path(file.filename or "").name).strip()[:200]
    spec = ATTACHMENT_TYPES.get(Path(name).suffix.lower())
    if not spec:
        raise HTTPException(415, "Upload an image (JPG, PNG, WEBP, GIF), PDF, Word or Excel file")
    raw = file.file.read(MAX_ATTACHMENT_BYTES + 1)
    if len(raw) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(413, f"Files can be at most {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB")
    if not raw or not spec[1](raw):
        raise HTTPException(415, "The file content does not match its file type")
    with _connect() as db:
        row = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
        if not row or not _owns(user, row):
            raise HTTPException(404, "RFQ not found")
        if row["attachment_count"] >= MAX_ATTACHMENTS_PER_RFQ:
            raise HTTPException(409, f"An RFQ can have at most {MAX_ATTACHMENTS_PER_RFQ} attachments")
        stored = uuid.uuid4().hex + Path(name).suffix.lower()
        path = _attachment_dir() / stored
        path.write_bytes(raw)
        try:
            db.execute(
                "INSERT INTO sd_rfq_attachments(id,rfq_id,original_name,stored_name,content_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex, rfq_id, name, stored, spec[0], len(raw), user["id"], _now()))
            _audit(db, rfq_id, user["id"], "attachment_added", {"file": name, "size": len(raw)})
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return _detail(db, rfq_id)


@router.get("/rfqs/{rfq_id}/attachments/{attachment_id}")
def download_attachment(rfq_id: str, attachment_id: str, inline: bool = False, user: dict = Depends(current_user)):
    with _connect() as db:
        row = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
        if not row or not _visible(user, row):
            raise HTTPException(404, "RFQ not found")
        att = db.execute("SELECT * FROM sd_rfq_attachments WHERE id=? AND rfq_id=?", (attachment_id, rfq_id)).fetchone()
    if not att:
        raise HTTPException(404, "Attachment not found")
    path = _attachment_dir() / att["stored_name"]
    if not path.is_file():
        raise HTTPException(404, "The file is missing from storage. Contact an administrator.")
    viewable = att["content_type"].startswith("image/") or att["content_type"] == "application/pdf"
    return FileResponse(
        path, media_type=att["content_type"], filename=att["original_name"],
        content_disposition_type="inline" if inline and viewable else "attachment",
        headers={"X-Content-Type-Options": "nosniff"},
    )


# --------------------------------------------------------------------------- dashboard, claim, assign
@router.get("/dashboard")
def dashboard(user: dict = Depends(current_user)) -> dict:
    """Persisted summary totals, constrained to records visible to this user."""
    today = datetime.now(BUSINESS_TZ).date().isoformat()
    scope = ""
    args: list[str] = []
    if user["role"] == "salesperson":
        if not user.get("sales_code"):
            raise HTTPException(403, "Your account is not linked to a configured sales code")
        scope = " AND (r.sales_code_id=(SELECT id FROM sd_sales_codes WHERE code=? COLLATE NOCASE) OR r.sales_code_id IS NULL)"
        args.append(user["sales_code"])
    with _connect() as db:
        unclaimed = db.execute("SELECT COUNT(*) FROM sd_rfqs r WHERE r.sales_code_id IS NULL" + scope, args).fetchone()[0]
        claimed = db.execute("SELECT COUNT(*) FROM sd_rfqs r WHERE r.sales_code_id IS NOT NULL" + scope, args).fetchone()[0]
        received_today = db.execute(
            "SELECT COUNT(*) FROM sd_rfqs r WHERE date(r.received_at, '+2 hours')=?" + scope, [today, *args]
        ).fetchone()[0]
        opened = db.execute(
            "SELECT COUNT(*) FROM sd_rfqs r JOIN sd_statuses st ON st.id=r.status_id WHERE st.is_closed=0" + scope, args
        ).fetchone()[0]
    return {"unclaimed": unclaimed, "claimed": claimed, "received_today": received_today, "open": opened}


@router.post("/rfqs/{rfq_id}/claim")
def claim_rfq(rfq_id: str, user: dict = Depends(current_user)) -> dict:
    if user["role"] != "salesperson":
        raise HTTPException(403, "Only salespeople can claim RFQs for themselves")
    if not user.get("sales_code"):
        raise HTTPException(403, "Your account is not linked to a configured sales code")
    now = _now()
    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        code = db.execute("SELECT id FROM sd_sales_codes WHERE code=? COLLATE NOCASE AND is_active=1", (user["sales_code"],)).fetchone()
        if not code:
            raise HTTPException(403, "Your configured sales code is inactive")
        row = db.execute("SELECT * FROM sd_rfqs WHERE id=?", (rfq_id,)).fetchone()
        if not row:
            raise HTTPException(404, "RFQ not found")
        if row["sales_code_id"] is not None:
            raise HTTPException(409, "This RFQ has already been claimed. Refresh the list.")
        new_status = db.execute("SELECT id FROM sd_statuses WHERE name='New' COLLATE NOCASE AND is_active=1").fetchone()
        db.execute("UPDATE sd_rfqs SET sales_code_id=?,claimed_at=?,status_id=COALESCE(?,status_id),updated_by=?,updated_at=? WHERE id=? AND sales_code_id IS NULL",
                   (code["id"], now, new_status["id"] if new_status else None, user["id"], now, rfq_id))
        if db.execute("SELECT changes()").fetchone()[0] != 1:
            raise HTTPException(409, "This RFQ has already been claimed. Refresh the list.")
        _audit(db, rfq_id, user["id"], "claimed", {"sales_code": user["sales_code"], "claimed_at": now})
        return _detail(db, rfq_id)


@router.post("/rfqs/{rfq_id}/assign")
def assign_rfq(rfq_id: str, payload: dict, user: dict = Depends(require_manager)) -> dict:
    """Kept for API compatibility. The RFQ form now assigns through PATCH /rfqs/{id} with sales_code_id."""
    if set(payload) != {"sales_code_id"}:
        raise HTTPException(422, "Provide sales_code_id, or null to unassign this RFQ")
    sales_code_id = payload["sales_code_id"]
    now = _now()
    with _connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM sd_rfqs WHERE id=?", (rfq_id,)).fetchone()
        if not row:
            raise HTTPException(404, "RFQ not found")
        if sales_code_id is not None and not db.execute("SELECT 1 FROM sd_sales_codes WHERE id=? AND is_active=1", (sales_code_id,)).fetchone():
            raise HTTPException(422, "Choose an active configured sales code, or null to unassign")
        previous, current = _code_value(db, row["sales_code_id"]), _code_value(db, sales_code_id)
        if row["sales_code_id"] == sales_code_id:
            raise HTTPException(409, "RFQ is already assigned to that sales code")
        claimed_at = now if sales_code_id else None
        db.execute("UPDATE sd_rfqs SET sales_code_id=?,claimed_at=?,updated_by=?,updated_at=? WHERE id=?",
                   (sales_code_id, claimed_at, user["id"], now, rfq_id))
        action = "assigned" if previous is None and current else "unassigned" if current is None else "reassigned"
        _audit(db, rfq_id, user["id"], action, {"from_sales_code": previous, "to_sales_code": current, "claimed_at": claimed_at})
        return _detail(db, rfq_id)
