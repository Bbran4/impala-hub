"""Sales Desk tests (identity, sales codes, RFQ form rules, attachments, invoices, configuration).

These replace the Sales Desk tests that used to sit at the bottom of test_api.py.
"""
import os
import re
import secrets
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="impala-hub-sd-test-"))
os.environ.setdefault("APP_API_KEY", "test-key-" + "x" * 32)
os.environ.setdefault("DATABASE_PATH", str(_tmp / "test.db"))
os.environ.setdefault("UPLOAD_DIR", str(_tmp / "uploads"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import sales_desk as sd  # noqa: E402
from app import sales_desk_auth as auth  # noqa: E402
from app.main import app  # noqa: E402

PASSWORD = "workflow-test-password-2026"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
PDF = b"%PDF-1.4\n%test\n"


@pytest.fixture(autouse=True)
def _db():
    auth.init_auth_db()
    sd.init_sales_desk_db()


def _direct_user(role: str) -> tuple[str, str]:
    username = f"{role}-{secrets.token_hex(4)}"
    salt, password_hash = auth._hash_password(PASSWORD)
    now = auth._now()
    with auth._connect() as db:
        db.execute(
            """INSERT INTO sd_users(id,username,display_name,password_salt,password_hash,role,sales_code,is_active,created_at,updated_at)
            VALUES(?,?,?,?,?,?,NULL,1,?,?)""",
            (secrets.token_hex(16), username, username, salt, password_hash, role, now, now),
        )
    return username, PASSWORD


def _login(client, username, password=PASSWORD) -> dict:
    response = client.post("/api/sales-desk/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def _staff(client, role: str) -> dict:
    return _login(client, _direct_user(role)[0])


def _consultant(client, admin: dict, full_name: str) -> tuple[dict, dict]:
    """Create a salesperson through the API (this is what generates the sales code)."""
    username = "sp-" + secrets.token_hex(4)
    created = client.post("/api/sales-desk/auth/users", headers=admin, json={
        "username": username, "display_name": full_name, "password": PASSWORD, "role": "salesperson"})
    assert created.status_code == 201, created.text
    return _login(client, username), created.json()


def _config(client, headers) -> dict:
    response = client.get("/api/sales-desk/config", headers=headers)
    assert response.status_code == 200
    return response.json()


def _status_id(client, headers, name) -> str:
    return next(s["id"] for s in _config(client, headers)["statuses"] if s["name"] == name)


def _media(client, admin) -> str:
    response = client.post("/api/sales-desk/config/media-platforms", headers=admin, json={"name": "Src-" + secrets.token_hex(3)})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _code_id(client, headers, code) -> str:
    return next(c["id"] for c in _config(client, headers)["sales_codes"] if c["code"] == code)


# --------------------------------------------------------------------------- identity and sales codes
def test_login_and_role_protection():
    with TestClient(app) as client:
        username, _ = _direct_user("administrator")
        assert client.post("/api/sales-desk/auth/login", json={"username": username, "password": "wrong"}).status_code == 401
        admin = _login(client, username)
        assert client.get("/api/sales-desk/auth/me", headers=admin).json()["role"] == "administrator"
        assert client.get("/api/sales-desk/auth/users", headers=_staff(client, "manager")).status_code == 403
        assert client.post("/api/sales-desk/auth/logout", headers=admin).status_code == 200
        assert client.get("/api/sales-desk/auth/me", headers=admin).status_code == 401


def test_sales_code_is_generated_from_initials_with_unique_numbers():
    with TestClient(app) as client:
        admin = _staff(client, "administrator")
        _, first = _consultant(client, admin, "Zed Quill")
        _, second = _consultant(client, admin, "Zara van Quinn")  # surname = last word
        _, other = _consultant(client, admin, "Wendy Fox")
        assert first["sales_code"] == "ZQ01"
        assert second["sales_code"] == "ZQ02"
        assert other["sales_code"] == "WF01"
        assert re.fullmatch(r"[A-Z]{2}\d{2}", first["sales_code"])
        assert any(c["code"] == "ZQ01" and c["is_active"] for c in _config(client, admin)["sales_codes"])
        # A single name cannot produce initials, and a failed sign-up leaves no orphan code.
        before = len(_config(client, admin)["sales_codes"])
        bad = client.post("/api/sales-desk/auth/users", headers=admin, json={
            "username": "one-name-" + secrets.token_hex(2), "display_name": "Cher", "password": PASSWORD, "role": "salesperson"})
        assert bad.status_code == 422
        dup = client.post("/api/sales-desk/auth/users", headers=admin, json={
            "username": first["username"], "display_name": "Zack Quest", "password": PASSWORD, "role": "salesperson"})
        assert dup.status_code == 409
        assert len(_config(client, admin)["sales_codes"]) == before
        # Managers and administrators have no sales code of their own.
        manager = client.post("/api/sales-desk/auth/users", headers=admin, json={
            "username": "mgr-" + secrets.token_hex(3), "display_name": "Zoe Quade", "password": PASSWORD, "role": "manager"})
        assert manager.json()["sales_code"] is None


def test_sales_codes_cannot_be_added_and_only_status_changes():
    with TestClient(app) as client:
        admin, manager = _staff(client, "administrator"), _staff(client, "manager")
        assert client.post("/api/sales-desk/config/sales-codes", headers=admin, json={"code": "XX99", "display_name": "X"}).status_code in (404, 405)
        _, user = _consultant(client, admin, "Alan Bright")
        code_id = _code_id(client, admin, user["sales_code"])
        assert client.patch(f"/api/sales-desk/config/sales-codes/{code_id}", headers=manager, json={"is_active": False}).status_code == 200
        assert client.patch(f"/api/sales-desk/config/sales-codes/{code_id}", headers=admin, json={"code": "NEW1"}).status_code == 422
        salesperson, _ = _consultant(client, admin, "Alice Bright")
        assert client.patch(f"/api/sales-desk/config/sales-codes/{code_id}", headers=salesperson, json={"is_active": True}).status_code == 403
        assert client.patch(f"/api/sales-desk/config/sales-codes/{code_id}", headers=admin, json={"is_active": True}).json()["is_active"] == 1


# --------------------------------------------------------------------------- RFQ form rules
def test_rfq_edit_rules_assignment_and_claimed_date():
    with TestClient(app) as client:
        admin, manager = _staff(client, "administrator"), _staff(client, "manager")
        media = _media(client, admin)
        sp_a, user_a = _consultant(client, admin, "Wanda Gale")
        sp_b, user_b = _consultant(client, admin, "Wilf Gray")
        code_a, code_b = _code_id(client, admin, user_a["sales_code"]), _code_id(client, admin, user_b["sales_code"])

        created = client.post("/api/sales-desk/rfqs", headers=manager, json={
            "media_platform_id": media, "customer_name": "Form customer", "sales_code_id": code_a,
            "received_at": "2026-10-19T07:00:00Z", "claimed_at": "2026-10-19T08:00:00Z"})
        assert created.status_code == 201, created.text
        rfq = created.json()
        assert rfq["rfq_type"] == "quotation" and rfq["status"] == "New"
        assert rfq["claimed_at"].startswith("2026-10-19T08:00") and rfq["received_at"].startswith("2026-10-19T07:00")
        url = f"/api/sales-desk/rfqs/{rfq['id']}"

        # Claimed date without a sales code, or before the received date, is refused.
        assert client.post("/api/sales-desk/rfqs", headers=manager, json={
            "media_platform_id": media, "customer_name": "x", "claimed_at": "2026-10-19T08:00:00Z"}).status_code == 422
        assert client.patch(url, headers=manager, json={"claimed_at": "2026-10-19T06:00:00Z"}).status_code == 422

        # Consultant: allowed fields work, locked fields are refused, other consultants cannot see it.
        for locked in ({"status_id": rfq["status_id"]}, {"sales_code_id": code_b}, {"media_platform_id": media}):
            assert client.patch(url, headers=sp_a, json=locked).status_code == 403
        ok = client.patch(url, headers=sp_a, json={
            "customer_name": "Renamed Co", "contact_number": "011 555 0100", "email_address": "a@b.co.za",
            "document_number": "Q-1001", "remarks": "Called back", "claimed_at": "2026-10-19T09:30:00Z"})
        assert ok.status_code == 200, ok.text
        body = ok.json()
        assert (body["customer_name"], body["document_number"], body["remarks"]) == ("Renamed Co", "Q-1001", "Called back")
        assert body["claimed_at"].startswith("2026-10-19T09:30") and body["rfq_no"] == rfq["rfq_no"]
        assert client.get(url, headers=sp_b).status_code == 404
        assert client.patch(url, headers=sp_b, json={"remarks": "nope"}).status_code == 404

        # Manager reassigns through the same save; the claim time restarts and history shows the change.
        moved = client.patch(url, headers=manager, json={"sales_code_id": code_b})
        assert moved.status_code == 200, moved.text
        assert moved.json()["sales_code"] == user_b["sales_code"]
        assert not moved.json()["claimed_at"].startswith("2026-10-19T09:30")
        actions = [h["action"] for h in moved.json()["audit_history"]]
        assert "reassigned" in actions and "updated" in actions
        # Clearing the code clears the claimed date.
        cleared = client.patch(url, headers=manager, json={"sales_code_id": None})
        assert cleared.json()["sales_code"] is None and cleared.json()["claimed_at"] is None
        assert client.patch(url, headers=manager, json={"claimed_at": "2026-10-20T08:00:00Z"}).status_code == 422


def test_unclaimed_rfq_assigned_by_form_leaves_unclaimed_status():
    with TestClient(app) as client:
        admin, manager = _staff(client, "administrator"), _staff(client, "manager")
        media = _media(client, admin)
        _, user = _consultant(client, admin, "Ursula Vance")
        rfq = client.post("/api/sales-desk/rfqs", headers=manager, json={"media_platform_id": media, "customer_name": "Q"}).json()
        assert rfq["status"] == "Unclaimed" and rfq["claimed_at"] is None
        done = client.patch(f"/api/sales-desk/rfqs/{rfq['id']}", headers=manager, json={"sales_code_id": _code_id(client, admin, user["sales_code"])})
        assert done.json()["status"] == "New" and done.json()["claimed_at"]


# --------------------------------------------------------------------------- attachments
def test_attachments_upload_download_and_cannot_be_deleted():
    with TestClient(app) as client:
        admin, manager = _staff(client, "administrator"), _staff(client, "manager")
        media = _media(client, admin)
        sp, user = _consultant(client, admin, "Abel Cruz")
        other, _ = _consultant(client, admin, "Abby Crane")
        rfq = client.post("/api/sales-desk/rfqs", headers=manager, json={
            "media_platform_id": media, "customer_name": "Files", "sales_code_id": _code_id(client, admin, user["sales_code"])}).json()
        url = f"/api/sales-desk/rfqs/{rfq['id']}/attachments"

        up = client.post(url, headers=sp, files={"file": ("photo.png", PNG, "image/png")})
        assert up.status_code == 201, up.text
        assert client.post(url, headers=manager, files={"file": ("quote.pdf", PDF, "application/pdf")}).status_code == 201
        listed = client.get(f"/api/sales-desk/rfqs/{rfq['id']}", headers=sp).json()["attachments"]
        assert [a["original_name"] for a in listed] == ["photo.png", "quote.pdf"]
        assert listed[0]["uploaded_by_name"] and listed[0]["size"] == len(PNG)

        att = listed[0]["id"]
        download = client.get(f"{url}/{att}", headers=sp)
        assert download.status_code == 200 and download.content == PNG
        assert "attachment" in download.headers["content-disposition"]
        assert "inline" in client.get(f"{url}/{att}?inline=true", headers=sp).headers["content-disposition"]
        assert client.get(f"{url}/{att}", headers=other).status_code == 404  # another consultant's RFQ
        assert client.post(url, headers=other, files={"file": ("x.png", PNG, "image/png")}).status_code == 404

        # Type and content checks.
        assert client.post(url, headers=sp, files={"file": ("run.exe", b"MZ", "application/octet-stream")}).status_code == 415
        assert client.post(url, headers=sp, files={"file": ("fake.png", b"not a png", "image/png")}).status_code == 415

        # No delete anywhere: not in the API, and the database refuses it too.
        assert client.delete(f"{url}/{att}", headers=admin).status_code == 405
        with pytest.raises(sqlite3.IntegrityError):
            with sd._connect() as db:
                db.execute("DELETE FROM sd_rfq_attachments WHERE id=?", (att,))
        assert len(client.get(f"/api/sales-desk/rfqs/{rfq['id']}", headers=admin).json()["attachments"]) == 2


# --------------------------------------------------------------------------- quotation -> invoice
def test_closed_rfq_converts_to_invoice_once():
    with TestClient(app) as client:
        admin, manager = _staff(client, "administrator"), _staff(client, "manager")
        media = _media(client, admin)
        sp, user = _consultant(client, admin, "Ivan Jones")
        rfq = client.post("/api/sales-desk/rfqs", headers=manager, json={
            "media_platform_id": media, "customer_name": "Invoice me", "sales_code_id": _code_id(client, admin, user["sales_code"])}).json()
        convert = f"/api/sales-desk/rfqs/{rfq['id']}/convert-to-invoice"
        assert client.post(convert, headers=manager).status_code == 409  # still open
        assert client.patch(f"/api/sales-desk/rfqs/{rfq['id']}", headers=manager,
                            json={"status_id": _status_id(client, admin, "Closed")}).status_code == 200
        done = client.post(convert, headers=sp)  # the owning consultant may convert
        assert done.status_code == 200, done.text
        body = done.json()
        assert body["rfq_type"] == "invoice" and body["rfq_no"] == rfq["rfq_no"] + "INV"
        assert body["original_rfq_no"] == rfq["rfq_no"]
        assert any(h["action"] == "converted_to_invoice" for h in body["audit_history"])
        assert client.post(convert, headers=manager).status_code == 409
        assert client.get("/api/sales-desk/rfqs?rfq_type=invoice&search=INV", headers=manager).json()["total"] >= 1


# --------------------------------------------------------------------------- configuration
def test_reorder_and_delete_options():
    with TestClient(app) as client:
        admin = _staff(client, "administrator")
        a, b = _media(client, admin), _media(client, admin)
        ids = [m["id"] for m in _config(client, admin)["media_platforms"]]
        assert ids[-2:] == [a, b]  # new options are appended
        reordered = list(reversed(ids))
        result = client.put("/api/sales-desk/config/media-platforms/order", headers=admin, json={"ids": reordered})
        assert result.status_code == 200 and [m["id"] for m in result.json()] == reordered
        assert [m["id"] for m in _config(client, admin)["media_platforms"]] == reordered
        assert client.put("/api/sales-desk/config/media-platforms/order", headers=admin, json={"ids": reordered[:-1]}).status_code == 409
        assert client.put("/api/sales-desk/config/media-platforms/order", headers=_staff(client, "manager"), json={"ids": reordered}).status_code == 403

        client.post("/api/sales-desk/rfqs", headers=admin, json={"media_platform_id": a, "customer_name": "Linked"})
        assert client.delete(f"/api/sales-desk/config/media-platforms/{a}", headers=admin).status_code == 409
        assert client.delete(f"/api/sales-desk/config/media-platforms/{b}", headers=admin).status_code == 200
        assert b not in [m["id"] for m in _config(client, admin)["media_platforms"]]

        new_status = client.post("/api/sales-desk/config/statuses", headers=admin, json={"name": "Temp " + secrets.token_hex(2)}).json()
        assert client.delete(f"/api/sales-desk/config/statuses/{new_status['id']}", headers=admin).status_code == 200
        assert client.delete(f"/api/sales-desk/config/statuses/{_status_id(client, admin, 'Unclaimed')}", headers=admin).status_code == 409
        in_use = _status_id(client, admin, "Unclaimed")
        assert next(s for s in _config(client, admin)["statuses"] if s["id"] == in_use)["rfq_count"] >= 1


def test_status_closed_flag():
    with TestClient(app) as client:
        admin = _staff(client, "administrator")
        status = client.post("/api/sales-desk/config/statuses", headers=admin, json={"name": "Closed test " + secrets.token_hex(3), "is_closed": True})
        assert status.status_code == 201 and status.json()["is_closed"] == 1
        patched = client.patch(f"/api/sales-desk/config/statuses/{status.json()['id']}", headers=admin, json={"is_closed": False})
        assert patched.json()["is_closed"] == 0


# --------------------------------------------------------------------------- claiming and concurrency
def test_claim_workflow_and_dashboard():
    with TestClient(app) as client:
        admin, manager = _staff(client, "administrator"), _staff(client, "manager")
        media = _media(client, admin)
        sp_a, user_a = _consultant(client, admin, "Cara Dunn")
        sp_b, _ = _consultant(client, admin, "Cole Dunn")
        rfq = client.post("/api/sales-desk/rfqs", headers=manager, json={"media_platform_id": media, "customer_name": "Claim me"}).json()
        assert client.get("/api/sales-desk/dashboard", headers=sp_a).json()["unclaimed"] >= 1
        claimed = client.post(f"/api/sales-desk/rfqs/{rfq['id']}/claim", headers=sp_a)
        assert claimed.status_code == 200 and claimed.json()["sales_code"] == user_a["sales_code"]
        assert client.post(f"/api/sales-desk/rfqs/{rfq['id']}/claim", headers=sp_b).status_code == 409
        assert client.get(f"/api/sales-desk/rfqs/{rfq['id']}", headers=sp_b).status_code == 404
        assert client.post(f"/api/sales-desk/rfqs/{rfq['id']}/claim", headers=manager).status_code == 403
        assert client.post("/api/sales-desk/rfqs", headers=sp_a, json={"media_platform_id": media, "customer_name": "x"}).status_code == 403


def test_concurrent_numbering_and_claim():
    with TestClient(app) as client:
        admin = _staff(client, "administrator")
        media = _media(client, admin)
        payload = {"media_platform_id": media, "customer_name": "Parallel RFQ"}
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(lambda _: client.post("/api/sales-desk/rfqs", headers=admin, json=payload), range(8)))
        assert all(r.status_code == 201 for r in responses), [r.text for r in responses]
        numbers = sorted(int(r.json()["rfq_no"][9:]) for r in responses)
        assert numbers == list(range(numbers[0], numbers[0] + 8))

        sp_a, _ = _consultant(client, admin, "Race Alpha")
        sp_b, _ = _consultant(client, admin, "Race Bravo")
        url = f"/api/sales-desk/rfqs/{responses[0].json()['id']}/claim"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [f.result() for f in [pool.submit(client.post, url, headers=sp_a), pool.submit(client.post, url, headers=sp_b)]]
        assert sorted(r.status_code for r in results) == [200, 409]
