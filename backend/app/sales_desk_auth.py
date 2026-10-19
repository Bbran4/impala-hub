"""Identity and role management for the Sales Desk.

Uses individual password-authenticated accounts and opaque server-side sessions.
The legacy shared API key remains for existing Marketing endpoints only.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

router = APIRouter(prefix="/api/sales-desk/auth", tags=["Sales Desk authentication"])
DB_PATH = Path(os.getenv("DATABASE_PATH", "./data/impala_hub.db")).resolve()
SESSION_HOURS = 12
ROLES = {"administrator", "manager", "salesperson"}


def _connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init_auth_db(bootstrap_username: str = "", bootstrap_password: str = "", database_path: Optional[Path] = None) -> None:
    global DB_PATH
    if database_path is not None:
        DB_PATH = Path(database_path).resolve()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS sd_users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('administrator','manager','salesperson')),
            sales_code TEXT,
            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sd_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES sd_users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sd_sessions_user ON sd_sessions(user_id);
        """)
        # Bootstrap only the very first administrator. Never reset or replace an existing account.
        username = bootstrap_username.strip()
        password = bootstrap_password
        count = db.execute("SELECT COUNT(*) FROM sd_users").fetchone()[0]
        if count == 0 and username and password:
            if len(password) < 14:
                raise RuntimeError("RFQ_BOOTSTRAP_ADMIN_PASSWORD must be at least 14 characters")
            salt, password_hash = _hash_password(password)
            now = _now()
            db.execute(
                """INSERT INTO sd_users
                (id,username,display_name,password_salt,password_hash,role,sales_code,is_active,created_at,updated_at)
                VALUES(?,?,?,?,?,'administrator',NULL,1,?,?)""",
                (secrets.token_hex(16), username, username, salt, password_hash, now, now),
            )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_password(password: str, salt: Optional[bytes] = None) -> tuple[str, str]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64)
    return salt.hex(), digest.hex()


def _public_user(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "username": row["username"], "display_name": row["display_name"],
        "role": row["role"], "sales_code": row["sales_code"], "is_active": bool(row["is_active"]),
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=1024)


class UserCreateIn(BaseModel):
    username: str = Field(min_length=3, max_length=100, pattern=r"^[A-Za-z0-9._@+-]+$")
    display_name: str = Field(min_length=1, max_length=160)
    password: str = Field(min_length=14, max_length=1024)
    role: str
    sales_code: Optional[str] = Field(default=None, max_length=80)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Display name cannot be blank")
        return value

    @field_validator("role")
    @classmethod
    def valid_role(cls, value: str) -> str:
        if value not in ROLES:
            raise ValueError("Role must be administrator, manager or salesperson")
        return value

    @model_validator(mode="after")
    def validate_salesperson_code(self):
        if self.role == "salesperson" and not (self.sales_code or "").strip():
            raise ValueError("A salesperson must be linked to a sales code")
        if self.role != "salesperson" and self.sales_code:
            raise ValueError("Only salesperson accounts may be linked to a sales code")
        return self


def current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    token = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not token:
        raise HTTPException(401, "Sales Desk sign-in required")
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now = _now()
    with _connect() as db:
        row = db.execute(
            """SELECT u.* FROM sd_sessions s JOIN sd_users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1""",
            (token_hash, now),
        ).fetchone()
    if not row:
        raise HTTPException(401, "Session expired or invalid. Please sign in again.")
    return _public_user(row)


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "administrator":
        raise HTTPException(403, "Administrator permission required")
    return user


@router.post("/login")
def login(payload: LoginIn) -> dict:
    with _connect() as db:
        row = db.execute("SELECT * FROM sd_users WHERE username=? COLLATE NOCASE", (payload.username.strip(),)).fetchone()
        # Perform a hash even for unknown users to reduce username-enumeration timing differences.
        if row:
            salt = bytes.fromhex(row["password_salt"])
            expected = bytes.fromhex(row["password_hash"])
            actual = hashlib.scrypt(payload.password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64)
            valid = hmac.compare_digest(actual, expected)
        else:
            hashlib.scrypt(payload.password.encode("utf-8"), salt=b"impala-hub-dummy", n=2**14, r=8, p=1, dklen=64)
            valid = False
        if not row or not valid or not row["is_active"]:
            raise HTTPException(401, "Invalid username or password")
        token = secrets.token_urlsafe(48)
        created = datetime.now(timezone.utc)
        expires = created + timedelta(hours=SESSION_HOURS)
        db.execute("DELETE FROM sd_sessions WHERE expires_at<=?", (created.isoformat(),))
        db.execute(
            "INSERT INTO sd_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), row["id"], created.isoformat(), expires.isoformat()),
        )
        return {"access_token": token, "token_type": "bearer", "expires_at": expires.isoformat(), "user": _public_user(row)}


@router.post("/logout")
def logout(authorization: Optional[str] = Header(default=None)) -> dict:
    token = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if token:
        with _connect() as db:
            db.execute("DELETE FROM sd_sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
    return {"ok": True}


@router.get("/me")
def me(user: dict = Depends(current_user)) -> dict:
    return user


@router.get("/users")
def list_users(_: dict = Depends(require_admin)) -> list[dict]:
    with _connect() as db:
        rows = db.execute("SELECT * FROM sd_users ORDER BY display_name COLLATE NOCASE").fetchall()
    return [_public_user(row) for row in rows]


@router.post("/users", status_code=201)
def create_user(payload: UserCreateIn, _: dict = Depends(require_admin)) -> dict:
    salt, password_hash = _hash_password(payload.password)
    now = _now()
    user_id = secrets.token_hex(16)
    sales_code = payload.sales_code.strip() if payload.sales_code else None
    with _connect() as db:
        try:
            db.execute(
                """INSERT INTO sd_users
                (id,username,display_name,password_salt,password_hash,role,sales_code,is_active,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,1,?,?)""",
                (user_id, payload.username.strip(), payload.display_name.strip(), salt, password_hash,
                 payload.role, sales_code, now, now),
            )
        except sqlite3.IntegrityError as exc:
            if "username" in str(exc).lower():
                raise HTTPException(409, "That username already exists") from exc
            raise
        row = db.execute("SELECT * FROM sd_users WHERE id=?", (user_id,)).fetchone()
    return _public_user(row)
