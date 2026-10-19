"""API tests. Run from the backend folder:  python -m pytest"""
import os
import tempfile
from pathlib import Path

# Must be set before app.main is imported. A fresh temp dir works on Windows, macOS and Linux.
_tmp = Path(tempfile.mkdtemp(prefix="impala-hub-test-"))
KEY = "test-key-" + "x" * 32
os.environ["APP_API_KEY"] = KEY
os.environ["DATABASE_PATH"] = str(_tmp / "test.db")
os.environ["UPLOAD_DIR"] = str(_tmp / "uploads")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app, db_session, now_iso  # noqa: E402

H = {"Authorization": f"Bearer {KEY}"}
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def upload_png(client) -> dict:
    r = client.post("/api/media", headers=H, files={"file": ("a.png", PNG, "image/png")})
    assert r.status_code == 201, r.text
    return r.json()


def test_health_and_auth():
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/posts").status_code == 401
        assert client.get("/api/posts", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert client.get("/api/posts", headers=H).status_code == 200


def test_campaign_and_post_workflow():
    with TestClient(app) as client:
        campaign = client.post("/api/campaigns", headers=H, json={"name": "Test campaign", "objective": "Smoke test"})
        assert campaign.status_code == 201
        cid = campaign.json()["id"]
        post = client.post("/api/posts", headers=H, json={"title": "T", "caption": "Test post", "campaign_id": cid, "channels": ["facebook"]})
        assert post.status_code == 201
        body = post.json()
        assert body["campaign_id"] == cid and body["status"] == "draft"
        assert body["clicks"] is None and body["published_at"] is None  # unavailable, not zero
        assert client.get(f"/api/posts?campaign_id={cid}", headers=H).json()[0]["caption"] == "Test post"


def test_scheduled_post_rules():
    with TestClient(app) as client:
        base = {"caption": "x", "channels": ["facebook"], "status": "scheduled"}
        assert client.post("/api/posts", headers=H, json=base).status_code == 422  # no date
        no_channel = {**base, "channels": [], "publish_at": "2030-01-01T10:00:00Z"}
        assert client.post("/api/posts", headers=H, json=no_channel).status_code == 422
        ig = {**base, "channels": ["instagram"], "publish_at": "2030-01-01T10:00:00Z"}
        assert client.post("/api/posts", headers=H, json=ig).status_code == 422  # Instagram needs an image
        ok = client.post("/api/posts", headers=H, json={**base, "publish_at": "2030-01-01T10:00:00+02:00"})
        assert ok.status_code == 201
        assert ok.json()["publish_at"] == "2030-01-01T08:00:00+00:00"  # normalised to UTC


def test_client_cannot_set_published_or_failed():
    with TestClient(app) as client:
        for status in ("published", "failed"):
            assert client.post("/api/posts", headers=H, json={"caption": "x", "status": status}).status_code == 422


def test_media_must_be_a_real_upload():
    with TestClient(app) as client:
        fake = {"id": "a" * 32 + ".png", "name": "x.png", "url": "https://evil.example/x.png"}
        assert client.post("/api/posts", headers=H, json={"media": [fake]}).status_code == 422
        not_uploaded = {"id": "b" * 32 + ".png", "name": "x.png", "url": "/uploads/" + "b" * 32 + ".png"}
        assert client.post("/api/posts", headers=H, json={"media": [not_uploaded]}).status_code == 422
        m = upload_png(client)
        ig = client.post("/api/posts", headers=H, json={"channels": ["instagram"], "status": "scheduled", "publish_at": "2030-01-01T10:00:00Z", "media": [m]})
        assert ig.status_code == 201


def test_partial_patch_and_published_lock():
    with TestClient(app) as client:
        post = client.post("/api/posts", headers=H, json={"title": "Keep", "caption": "old", "channels": ["facebook"]}).json()
        patched = client.patch(f"/api/posts/{post['id']}", headers=H, json={"caption": "new"})
        assert patched.status_code == 200
        assert patched.json()["caption"] == "new" and patched.json()["title"] == "Keep"
        assert client.patch("/api/posts/missing", headers=H, json={"caption": "x"}).status_code == 404


def test_campaign_validation():
    with TestClient(app) as client:
        assert client.post("/api/campaigns", headers=H, json={"name": "   "}).status_code == 422
        bad = {"name": "C", "start_date": "2030-02-01", "end_date": "2030-01-01"}
        assert client.post("/api/campaigns", headers=H, json=bad).status_code == 422
        c = client.post("/api/campaigns", headers=H, json={"name": "  Padded  "}).json()
        assert c["name"] == "Padded"
        assert client.patch(f"/api/campaigns/{c['id']}", headers=H, json={"objective": "New"}).json()["name"] == "Padded"


def test_audit_log_is_readable():
    with TestClient(app) as client:
        client.post("/api/campaigns", headers=H, json={"name": "Audited"})
        entries = client.get("/api/audit", headers=H).json()
        assert entries and entries[0]["entity_type"] in {"campaign", "post"}


def insert_published_post(campaign_id=None) -> str:
    """Only the future publishing worker can create published posts, so tests insert one directly."""
    pid = "published-" + os.urandom(4).hex()
    with db_session() as db:
        db.execute(
            "INSERT INTO posts(id,title,caption,campaign_id,status,published_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (pid, "Live", "Already out", campaign_id, "published", now_iso(), now_iso(), now_iso()),
        )
    return pid


def test_published_post_only_allows_campaign_change():
    with TestClient(app) as client:
        cid = client.post("/api/campaigns", headers=H, json={"name": "For published"}).json()["id"]
        pid = insert_published_post()
        for body in ({"caption": "edit"}, {"status": "draft"}, {"title": "x"}, {"caption": "x", "campaign_id": cid}):
            assert client.patch(f"/api/posts/{pid}", headers=H, json=body).status_code == 409
        ok = client.patch(f"/api/posts/{pid}", headers=H, json={"campaign_id": cid})
        assert ok.status_code == 200 and ok.json()["campaign_id"] == cid
        assert ok.json()["caption"] == "Already out" and ok.json()["status"] == "published"
        assert client.patch(f"/api/posts/{pid}", headers=H, json={"campaign_id": "nope"}).status_code == 422
        assert client.delete(f"/api/posts/{pid}", headers=H).status_code == 409
        history = client.get(f"/api/posts/{pid}/history", headers=H).json()
        assert history[0]["details"]["changed"] == ["campaign_id"]


def test_scheduled_post_only_allows_campaign_change():
    with TestClient(app) as client:
        cid = client.post("/api/campaigns", headers=H, json={"name": "For scheduled"}).json()["id"]
        post = client.post(
            "/api/posts", headers=H,
            json={"caption": "soon", "channels": ["facebook"], "status": "scheduled", "publish_at": "2030-01-01T10:00:00Z"},
        ).json()
        url = f"/api/posts/{post['id']}"
        assert client.patch(url, headers=H, json={"caption": "changed"}).status_code == 409
        assert client.patch(url, headers=H, json={"status": "draft"}).status_code == 409
        ok = client.patch(url, headers=H, json={"campaign_id": cid})
        assert ok.status_code == 200 and ok.json()["campaign_id"] == cid and ok.json()["status"] == "scheduled"
        assert client.delete(url, headers=H).status_code == 204  # scheduled posts may still be deleted


def test_draft_edit_records_changed_fields_in_history():
    with TestClient(app) as client:
        post = client.post("/api/posts", headers=H, json={"caption": "a", "channels": ["facebook"]}).json()
        client.patch(f"/api/posts/{post['id']}", headers=H, json={"caption": "b"})
        history = client.get(f"/api/posts/{post['id']}/history", headers=H).json()
        assert [h["action"] for h in history] == ["updated", "created"]
        assert history[0]["details"]["changed"] == ["caption"]
        assert client.get("/api/posts/missing/history", headers=H).status_code == 404


def test_scheduling_needs_a_future_date_and_drag_style_patches_work():
    with TestClient(app) as client:
        past = {"caption": "x", "channels": ["facebook"], "status": "scheduled", "publish_at": "2020-01-01T10:00:00Z"}
        assert client.post("/api/posts", headers=H, json=past).status_code == 422
        draft = client.post("/api/posts", headers=H, json={"caption": "x", "channels": ["facebook"]}).json()
        url = f"/api/posts/{draft['id']}"
        # calendar drag: set only the date, status stays draft
        moved = client.patch(url, headers=H, json={"publish_at": "2031-05-05T07:00:00Z"}).json()
        assert moved["status"] == "draft" and moved["publish_at"].startswith("2031-05-05")
        # board drag: draft -> awaiting approval -> scheduled
        assert client.patch(url, headers=H, json={"status": "awaiting_approval"}).json()["status"] == "awaiting_approval"
        assert client.patch(url, headers=H, json={"status": "scheduled"}).json()["status"] == "scheduled"
        # scheduled is now locked, so it cannot be dragged back
        assert client.patch(url, headers=H, json={"status": "draft"}).status_code == 409


"""Sales Desk identity and authorization tests."""
import secrets

from app import sales_desk_auth as sd_auth


def test_sales_desk_login_and_role_protection():
    sd_auth.init_auth_db()
    salt, password_hash = sd_auth._hash_password("correct-horse-battery-staple-91")
    now = sd_auth._now()
    username = "admin-" + secrets.token_hex(4)
    user_id = secrets.token_hex(16)
    with sd_auth._connect() as db:
        db.execute(
            """INSERT INTO sd_users
            (id,username,display_name,password_salt,password_hash,role,sales_code,is_active,created_at,updated_at)
            VALUES(?,?,?,?,?,'administrator',NULL,1,?,?)""",
            (user_id, username, "Test Administrator", salt, password_hash, now, now),
        )

    with TestClient(app) as client:
        bad = client.post("/api/sales-desk/auth/login", json={"username": username, "password": "wrong-password"})
        assert bad.status_code == 401
        login = client.post(
            "/api/sales-desk/auth/login",
            json={"username": username, "password": "correct-horse-battery-staple-91"},
        )
        assert login.status_code == 200, login.text
        token = login.json()["access_token"]
        auth = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/sales-desk/auth/me", headers=auth).json()["role"] == "administrator"
        code_response = client.post(
            "/api/sales-desk/config/sales-codes",
            headers=auth,
            json={"code": "TEST01", "display_name": "Test Sales Code"},
        )
        assert code_response.status_code == 201, code_response.text
        created = client.post(
            "/api/sales-desk/auth/users",
            headers=auth,
            json={
                "username": "sales-" + secrets.token_hex(3),
                "display_name": "Test Salesperson",
                "password": "another-correct-horse-battery-92",
                "role": "salesperson",
                "sales_code": "TEST01",
            },
        )
        assert created.status_code == 201, created.text
        assert created.json()["sales_code"] == "TEST01"
        assert client.post("/api/sales-desk/auth/logout", headers=auth).status_code == 200
        assert client.get("/api/sales-desk/auth/me", headers=auth).status_code == 401


def test_sales_desk_rfq_numbering_and_audit():
    import secrets
    from app.sales_desk_auth import _hash_password, _now, _connect as auth_connect

    sd_auth.init_auth_db()
    username = "rfq-admin-" + secrets.token_hex(4)
    user_id = secrets.token_hex(16)
    salt, password_hash = _hash_password("secure-test-password-2026")
    now = _now()
    with auth_connect() as db:
        db.execute(
            """INSERT INTO sd_users
            (id,username,display_name,password_salt,password_hash,role,sales_code,is_active,created_at,updated_at)
            VALUES(?,?,?,?,?,'administrator',NULL,1,?,?)""",
            (user_id, username, "RFQ Test Admin", salt, password_hash, now, now),
        )
    with TestClient(app) as client:
        login = client.post("/api/sales-desk/auth/login", json={"username": username, "password": "secure-test-password-2026"})
        assert login.status_code == 200, login.text
        auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
        media = client.post("/api/sales-desk/config/media-platforms", headers=auth, json={"name": "Test source " + secrets.token_hex(3)})
        assert media.status_code == 201, media.text
        payload = {"media_platform_id": media.json()["id"], "customer_name": "Test Customer", "query_information": "Need a quotation"}
        first = client.post("/api/sales-desk/rfqs", headers=auth, json=payload)
        second = client.post("/api/sales-desk/rfqs", headers=auth, json=payload)
        assert first.status_code == 201, first.text
        assert second.status_code == 201, second.text
        assert first.json()["rfq_no"].startswith("IMP")
        assert int(second.json()["rfq_no"][-2:]) == int(first.json()["rfq_no"][-2:]) + 1
        detail = client.get("/api/sales-desk/rfqs/" + first.json()["id"], headers=auth)
        assert detail.status_code == 200
        assert any(item["action"] == "created" for item in detail.json()["audit_history"])
