"""Sales Desk configuration and RFQ records.

All timestamps are stored as UTC ISO strings. RFQ numbers use the Africa/Johannesburg
business date and a database-serialized sequence per date.
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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator

from .sales_desk_auth import current_user, require_admin

router = APIRouter(prefix="/api/sales-desk", tags=["Sales Desk"])
DB_PATH = Path(os.getenv("DATABASE_PATH", "./data/impala_hub.db")).resolve()
BUSINESS_TZ = ZoneInfo("Africa/Johannesburg")


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
        """)
        # Additive migration for databases created before status classification existed.
        status_columns = {row["name"] for row in db.execute("PRAGMA table_info(sd_statuses)").fetchall()}
        if "is_closed" not in status_columns:
            db.execute("ALTER TABLE sd_statuses ADD COLUMN is_closed INTEGER NOT NULL DEFAULT 0")
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


def _audit(db: sqlite3.Connection, rfq_id: str, actor: str, action: str, changes: dict) -> None:
    db.execute(
        "INSERT INTO sd_rfq_audit(rfq_id,actor_user_id,action,changes_json,created_at) VALUES(?,?,?,?,?)",
        (rfq_id, actor, action, json.dumps(changes, ensure_ascii=False), _now()),
    )


def _rfq(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["media_platform"] = item.pop("media_platform_name", None)
    item["sales_code"] = item.pop("sales_code_value", None)
    item["salesperson_name"] = item.pop("salesperson_name", None)
    item["status"] = item.pop("status_name", None)
    return item


RFQ_SELECT = """SELECT r.*, m.name AS media_platform_name, sc.code AS sales_code_value,
    (SELECT u.display_name FROM sd_users u WHERE u.sales_code=sc.code COLLATE NOCASE
       AND u.role='salesperson' AND u.is_active=1 ORDER BY u.display_name LIMIT 1) AS salesperson_name,
    st.name AS status_name, st.is_closed AS status_is_closed
    FROM sd_rfqs r
    LEFT JOIN sd_media_platforms m ON m.id=r.media_platform_id
    LEFT JOIN sd_sales_codes sc ON sc.id=r.sales_code_id
    JOIN sd_statuses st ON st.id=r.status_id"""


class ConfigOptionIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    sort_order: int = Field(default=0, ge=0, le=10000)
    is_closed: bool = False

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


class SalesCodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    display_name: str = Field(min_length=1, max_length=160)

    @field_validator("code", "display_name")
    @classmethod
    def clean_text(cls, v: str) -> str:
        return v.strip()


class RFQCreateIn(BaseModel):
    media_platform_id: str
    customer_name: str = Field(min_length=1, max_length=200)
    contact_number: str = Field(default="", max_length=80)
    email_address: str = Field(default="", max_length=254)
    query_information: str = Field(default="", max_length=12000)
    remarks: str = Field(default="", max_length=12000)
    status_id: Optional[str] = None
    document_number: str = Field(default="", max_length=120)
    received_at: Optional[datetime] = None

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


def _admin_or_manager(user: dict) -> bool:
    return user["role"] in {"administrator", "manager"}


def _assert_sales_code(db: sqlite3.Connection, code: Optional[str]) -> None:
    if code is None:
        return
    row = db.execute("SELECT is_active FROM sd_sales_codes WHERE code=? COLLATE NOCASE", (code,)).fetchone()
    if not row or not row["is_active"]:
        raise HTTPException(422, "Choose an active configured sales code")


@router.get("/config")
def get_config(user: dict = Depends(current_user)) -> dict:
    active_filter = "" if user["role"] == "administrator" else " WHERE is_active=1"
    with _connect() as db:
        media = db.execute("SELECT * FROM sd_media_platforms" + active_filter + " ORDER BY sort_order,name").fetchall()
        codes = db.execute("SELECT * FROM sd_sales_codes" + active_filter + " ORDER BY code").fetchall()
        statuses = db.execute("SELECT * FROM sd_statuses" + active_filter + " ORDER BY sort_order,name").fetchall()
    return {"media_platforms": [dict(x) for x in media], "sales_codes": [dict(x) for x in codes],
            "statuses": [dict(x) for x in statuses], "can_configure": user["role"] == "administrator"}


@router.post("/config/media-platforms", status_code=201)
def create_media(payload: ConfigOptionIn, _: dict = Depends(require_admin)) -> dict:
    now, ident = _now(), uuid.uuid4().hex
    with _connect() as db:
        try:
            db.execute("INSERT INTO sd_media_platforms(id,name,sort_order,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)",
                       (ident, payload.name, payload.sort_order, now, now))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "Media platform already exists") from exc
        return dict(db.execute("SELECT * FROM sd_media_platforms WHERE id=?", (ident,)).fetchone())


@router.patch("/config/media-platforms/{option_id}")
def patch_media(option_id: str, payload: dict, _: dict = Depends(require_admin)) -> dict:
    allowed = {"name", "sort_order", "is_active"}
    if not payload or set(payload) - allowed:
        raise HTTPException(422, "Only name, sort_order and is_active can be changed")
    with _connect() as db:
        row = db.execute("SELECT * FROM sd_media_platforms WHERE id=?", (option_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Media platform not found")
        name = str(payload.get("name", row["name"])).strip()
        if not name or len(name) > 100:
            raise HTTPException(422, "Name must contain 1 to 100 characters")
        sort_order = payload.get("sort_order", row["sort_order"])
        active_value = payload.get("is_active", bool(row["is_active"]))
        if isinstance(sort_order, bool) or not isinstance(sort_order, int) or not 0 <= sort_order <= 10000:
            raise HTTPException(422, "Sort order must be an integer from 0 to 10000")
        if not isinstance(active_value, (bool, int)) or active_value not in (False, True, 0, 1):
            raise HTTPException(422, "is_active must be true or false")
        active = int(active_value)
        db.execute("UPDATE sd_media_platforms SET name=?,sort_order=?,is_active=?,updated_at=? WHERE id=?",
                   (name, sort_order, active, _now(), option_id))
        return dict(db.execute("SELECT * FROM sd_media_platforms WHERE id=?", (option_id,)).fetchone())


@router.post("/config/sales-codes", status_code=201)
def create_sales_code(payload: SalesCodeIn, _: dict = Depends(require_admin)) -> dict:
    now, ident = _now(), uuid.uuid4().hex
    with _connect() as db:
        try:
            db.execute("INSERT INTO sd_sales_codes(id,code,display_name,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)",
                       (ident, payload.code, payload.display_name, now, now))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "Sales code already exists") from exc
        return dict(db.execute("SELECT * FROM sd_sales_codes WHERE id=?", (ident,)).fetchone())


@router.patch("/config/sales-codes/{option_id}")
def patch_sales_code(option_id: str, payload: dict, _: dict = Depends(require_admin)) -> dict:
    allowed = {"code", "display_name", "is_active"}
    if not payload or set(payload) - allowed:
        raise HTTPException(422, "Only code, display_name and is_active can be changed")
    with _connect() as db:
        row = db.execute("SELECT * FROM sd_sales_codes WHERE id=?", (option_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Sales code not found")
        code = str(payload.get("code", row["code"])).strip()
        display = str(payload.get("display_name", row["display_name"])).strip()
        active_value = payload.get("is_active", bool(row["is_active"]))
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", code) or not display or len(display) > 160:
            raise HTTPException(422, "Use a sales code of 1-80 letters, numbers, underscores or hyphens and a display name of 1-160 characters")
        if not isinstance(active_value, (bool, int)) or active_value not in (False, True, 0, 1):
            raise HTTPException(422, "is_active must be true or false")
        active = int(active_value)
        if code != row["code"] and db.execute("SELECT 1 FROM sd_rfqs WHERE sales_code_id=?", (option_id,)).fetchone():
            raise HTTPException(409, "A sales code used by RFQs cannot be renamed; deactivate it instead")
        try:
            db.execute("UPDATE sd_sales_codes SET code=?,display_name=?,is_active=?,updated_at=? WHERE id=?",
                       (code, display, active, _now(), option_id))
            db.execute("UPDATE sd_users SET sales_code=?,updated_at=? WHERE sales_code=? COLLATE NOCASE",
                       (code, _now(), row["code"]))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "Sales code already exists") from exc
        return dict(db.execute("SELECT * FROM sd_sales_codes WHERE id=?", (option_id,)).fetchone())


@router.post("/config/statuses", status_code=201)
def create_status(payload: ConfigOptionIn, _: dict = Depends(require_admin)) -> dict:
    now, ident = _now(), uuid.uuid4().hex
    with _connect() as db:
        try:
            db.execute("INSERT INTO sd_statuses(id,name,sort_order,is_active,is_closed,created_at,updated_at) VALUES(?,?,?,1,?,?,?)",
                       (ident, payload.name, payload.sort_order, int(payload.is_closed), now, now))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "Status already exists") from exc
        return dict(db.execute("SELECT * FROM sd_statuses WHERE id=?", (ident,)).fetchone())


@router.patch("/config/statuses/{option_id}")
def patch_status(option_id: str, payload: dict, _: dict = Depends(require_admin)) -> dict:
    allowed = {"name", "sort_order", "is_active", "is_closed"}
    if not payload or set(payload) - allowed:
        raise HTTPException(422, "Only name, sort_order, is_active and is_closed can be changed")
    with _connect() as db:
        row = db.execute("SELECT * FROM sd_statuses WHERE id=?", (option_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Status not found")
        name = str(payload.get("name", row["name"])).strip()
        sort_order = payload.get("sort_order", row["sort_order"])
        active_value = payload.get("is_active", bool(row["is_active"]))
        closed_value = payload.get("is_closed", bool(row["is_closed"]))
        if not name or len(name) > 100:
            raise HTTPException(422, "Name must contain 1 to 100 characters")
        if isinstance(sort_order, bool) or not isinstance(sort_order, int) or not 0 <= sort_order <= 10000:
            raise HTTPException(422, "Sort order must be an integer from 0 to 10000")
        if not isinstance(active_value, (bool, int)) or active_value not in (False, True, 0, 1):
            raise HTTPException(422, "is_active must be true or false")
        if not isinstance(closed_value, (bool, int)) or closed_value not in (False, True, 0, 1):
            raise HTTPException(422, "is_closed must be true or false")
        if row["name"].lower() == "unclaimed" and not active_value:
            raise HTTPException(409, "The Unclaimed status is required for new RFQs and cannot be deactivated")
        try:
            db.execute("UPDATE sd_statuses SET name=?,sort_order=?,is_active=?,is_closed=?,updated_at=? WHERE id=?",
                       (name, sort_order, int(active_value), int(closed_value), _now(), option_id))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "A status with that name already exists") from exc
        return dict(db.execute("SELECT * FROM sd_statuses WHERE id=?", (option_id,)).fetchone())


@router.get("/rfqs")
def list_rfqs(status_id: Optional[str] = None, sales_code_id: Optional[str] = None,
              search: str = Query(default="", max_length=200), limit: int = Query(default=100, ge=1, le=500),
              offset: int = Query(default=0, ge=0), user: dict = Depends(current_user)) -> dict:
    clauses, args = [], []
    unclaimed_only = False
    if user["role"] == "salesperson":
        if not user.get("sales_code"):
            raise HTTPException(403, "Your account is not linked to a configured sales code")
        clauses.append("(r.sales_code_id=(SELECT id FROM sd_sales_codes WHERE code=? COLLATE NOCASE) OR r.sales_code_id IS NULL)")
        args.append(user["sales_code"])
    unclaimed = None
    if unclaimed_only:
        clauses.append("r.sales_code_id IS NULL")
    if status_id:
        clauses.append("r.status_id=?"); args.append(status_id)
    if sales_code_id and _admin_or_manager(user):
        clauses.append("r.sales_code_id=?"); args.append(sales_code_id)
    if search.strip():
        term = f"%{search.strip()}%"
        clauses.append("(r.rfq_no LIKE ? OR r.customer_name LIKE ? OR r.document_number LIKE ?)")
        args.extend([term, term, term])
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    sort = "CASE WHEN r.sales_code_id IS NULL THEN 0 ELSE 1 END ASC, r.received_at ASC, r.rfq_no ASC"
    with _connect() as db:
        rows = db.execute(RFQ_SELECT + where + f" ORDER BY {sort} LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
        total = db.execute("SELECT COUNT(*) FROM sd_rfqs r" + where, args).fetchone()[0]
    return {"items": [_rfq(x) for x in rows], "total": total, "limit": limit, "offset": offset}


@router.post("/rfqs", status_code=201)
def create_rfq(payload: RFQCreateIn, user: dict = Depends(current_user)) -> dict:
    now = datetime.now(timezone.utc)
    received = payload.received_at
    received_at = (received.replace(tzinfo=timezone.utc) if received and received.tzinfo is None else received).astimezone(timezone.utc).isoformat() if received else now.isoformat()
    business_date = now.astimezone(BUSINESS_TZ).strftime("%y%m%d")
    ident = uuid.uuid4().hex
    with _connect() as db:
        if user["role"] == "salesperson":
            raise HTTPException(403, "Salespeople cannot create RFQs directly")
        media = db.execute("SELECT id FROM sd_media_platforms WHERE id=? AND is_active=1", (payload.media_platform_id,)).fetchone()
        if not media:
            raise HTTPException(422, "Choose an active media platform")
        status_id = payload.status_id
        if status_id:
            status = db.execute("SELECT id FROM sd_statuses WHERE id=? AND is_active=1", (status_id,)).fetchone()
            if not status:
                raise HTTPException(422, "Choose an active status")
        else:
            status = db.execute("SELECT id FROM sd_statuses WHERE name='Unclaimed' COLLATE NOCASE AND is_active=1").fetchone()
            if not status:
                raise HTTPException(500, "The Unclaimed status is not configured")
            status_id = status["id"]
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
            (id,rfq_no,business_date,daily_number,media_platform_id,customer_name,contact_number,email_address,
             query_information,sales_code_id,claimed_at,received_at,remarks,status_id,document_number,
             created_by,updated_by,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?)""",
            (ident, rfq_no, business_date, daily_number, payload.media_platform_id, payload.customer_name.strip(),
             payload.contact_number.strip(), payload.email_address.strip(), payload.query_information.strip(),
             received_at, payload.remarks.strip(), status_id, payload.document_number.strip(), user["id"], user["id"], now.isoformat(), now.isoformat()))
        _audit(db, ident, user["id"], "created", {"rfq_no": rfq_no})
        row = db.execute(RFQ_SELECT + " WHERE r.id=?", (ident,)).fetchone()
    return _rfq(row)


@router.get("/rfqs/{rfq_id}")
def get_rfq(rfq_id: str, user: dict = Depends(current_user)) -> dict:
    with _connect() as db:
        row = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
        if not row:
            raise HTTPException(404, "RFQ not found")
        if user["role"] == "salesperson" and row["sales_code_value"] and row["sales_code_value"].lower() != (user.get("sales_code") or "").lower():
            raise HTTPException(404, "RFQ not found")
        history = db.execute("SELECT action,changes_json,created_at,actor_user_id FROM sd_rfq_audit WHERE rfq_id=? ORDER BY id", (rfq_id,)).fetchall()
    result = _rfq(row)
    result["audit_history"] = [{**dict(x), "changes": json.loads(x["changes_json"])} for x in history]
    return result


@router.patch("/rfqs/{rfq_id}")
def patch_rfq(rfq_id: str, payload: RFQPatchIn, user: dict = Depends(current_user)) -> dict:
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not changes:
        raise HTTPException(422, "No changes supplied")
    if user["role"] == "salesperson" and set(changes) - {"remarks", "query_information", "document_number"}:
        raise HTTPException(403, "Salespeople may only update remarks, query information and document number")
    with _connect() as db:
        row = db.execute("SELECT * FROM sd_rfqs WHERE id=?", (rfq_id,)).fetchone()
        if not row:
            raise HTTPException(404, "RFQ not found")
        if user["role"] == "salesperson":
            code = db.execute("SELECT code FROM sd_sales_codes WHERE id=?", (row["sales_code_id"],)).fetchone() if row["sales_code_id"] else None
            if not code or code["code"].lower() != (user.get("sales_code") or "").lower():
                raise HTTPException(404, "RFQ not found")
        normalized = dict(changes)
        for field in ("customer_name", "contact_number", "email_address", "query_information", "remarks", "document_number"):
            if field in normalized and isinstance(normalized[field], str):
                normalized[field] = normalized[field].strip()
        if "media_platform_id" in normalized:
            valid_media = db.execute("SELECT 1 FROM sd_media_platforms WHERE id=? AND (is_active=1 OR id=?)",
                                     (normalized["media_platform_id"], row["media_platform_id"])).fetchone()
            if not valid_media:
                raise HTTPException(422, "Choose an active media platform")
        if "status_id" in normalized:
            valid_status = db.execute("SELECT 1 FROM sd_statuses WHERE id=? AND (is_active=1 OR id=?)",
                                      (normalized["status_id"], row["status_id"])).fetchone()
            if not valid_status:
                raise HTTPException(422, "Choose an active status")
        allowed = {"media_platform_id","customer_name","contact_number","email_address","query_information","remarks","status_id","document_number"}
        if set(normalized) - allowed:
            raise HTTPException(422, "Unsupported RFQ field")
        before = {k: row[k] for k in normalized}
        assignments = ",".join(f"{k}=?" for k in normalized)
        db.execute(f"UPDATE sd_rfqs SET {assignments},updated_by=?,updated_at=? WHERE id=?",
                   (*normalized.values(), user["id"], _now(), rfq_id))
        _audit(db, rfq_id, user["id"], "updated", {k: {"from": before[k], "to": normalized[k]} for k in normalized})
        updated = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
    return _rfq(updated)


@router.get("/rfqs/{rfq_id}/history")
def rfq_history(rfq_id: str, user: dict = Depends(current_user)) -> list[dict]:
    get_rfq(rfq_id, user)
    with _connect() as db:
        rows = db.execute("SELECT action,changes_json,created_at,actor_user_id FROM sd_rfq_audit WHERE rfq_id=? ORDER BY id", (rfq_id,)).fetchall()
    return [{**dict(x), "changes": json.loads(x["changes_json"])} for x in rows]


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
            "SELECT COUNT(*) FROM sd_rfqs r WHERE date(r.received_at, '+2 hours')=?"+scope, [today, *args]
        ).fetchone()[0]
        opened = db.execute(
            "SELECT COUNT(*) FROM sd_rfqs r JOIN sd_statuses st ON st.id=r.status_id WHERE st.is_closed=0"+scope, args
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
        updated = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
    return _rfq(updated)


@router.post("/rfqs/{rfq_id}/assign")
def assign_rfq(rfq_id: str, payload: dict, user: dict = Depends(require_admin)) -> dict:
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
        previous = db.execute("SELECT code FROM sd_sales_codes WHERE id=?", (row["sales_code_id"],)).fetchone() if row["sales_code_id"] else None
        next_code = db.execute("SELECT code FROM sd_sales_codes WHERE id=?", (sales_code_id,)).fetchone() if sales_code_id else None
        if row["sales_code_id"] == sales_code_id:
            raise HTTPException(409, "RFQ is already assigned to that sales code")
        claimed_at = now if sales_code_id else None
        db.execute("UPDATE sd_rfqs SET sales_code_id=?,claimed_at=?,updated_by=?,updated_at=? WHERE id=?",
                   (sales_code_id, claimed_at, user["id"], now, rfq_id))
        action = "assigned" if previous is None and next_code else "unassigned" if next_code is None else "reassigned"
        _audit(db, rfq_id, user["id"], action, {"from_sales_code": previous["code"] if previous else None,
                                                 "to_sales_code": next_code["code"] if next_code else None,
                                                 "claimed_at": claimed_at})
        updated = db.execute(RFQ_SELECT + " WHERE r.id=?", (rfq_id,)).fetchone()
    return _rfq(updated)
