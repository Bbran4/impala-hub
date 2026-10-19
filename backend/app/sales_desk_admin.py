"""Locally create or recover a Sales Desk administrator account.

Run from the backend directory with the virtual environment activated:
    python -m app.sales_desk_admin

This is an interactive local maintenance command, not an HTTP endpoint.
"""
from __future__ import annotations

import getpass
import secrets

from app.main import DB_PATH
from app.sales_desk_auth import _connect, _hash_password, _now, init_auth_db


def main() -> None:
    init_auth_db(database_path=DB_PATH)
    username = input("Administrator username: ").strip()
    if len(username) < 3 or len(username) > 100:
        raise SystemExit("Username must be between 3 and 100 characters.")

    password = getpass.getpass("New administrator password (minimum 14 characters): ")
    confirmation = getpass.getpass("Confirm password: ")
    if len(password) < 14:
        raise SystemExit("Password must be at least 14 characters.")
    if password != confirmation:
        raise SystemExit("Passwords do not match.")

    print(
        "\nThis will create the account if it does not exist, or reset its password "
        "and grant administrator access if it does."
    )
    if input(f"Type {username} to confirm: ").strip().casefold() != username.casefold():
        raise SystemExit("Cancelled.")

    salt, password_hash = _hash_password(password)
    now = _now()
    with _connect() as db:
        existing = db.execute(
            "SELECT id FROM sd_users WHERE username=? COLLATE NOCASE", (username,)
        ).fetchone()
        if existing:
            user_id = existing["id"]
            db.execute(
                """UPDATE sd_users
                SET display_name=?, password_salt=?, password_hash=?, role='administrator',
                    sales_code=NULL, is_active=1, updated_at=?
                WHERE id=?""",
                (username, salt, password_hash, now, user_id),
            )
            db.execute("DELETE FROM sd_sessions WHERE user_id=?", (user_id,))
            action = "Recovered existing account"
        else:
            user_id = secrets.token_hex(16)
            db.execute(
                """INSERT INTO sd_users
                (id, username, display_name, password_salt, password_hash, role,
                 sales_code, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'administrator', NULL, 1, ?, ?)""",
                (user_id, username, username, salt, password_hash, now, now),
            )
            action = "Created administrator account"

    print(f"{action}: {username}")
    print("You can now sign in to Sales Desk with this username and password.")


if __name__ == "__main__":
    main()
