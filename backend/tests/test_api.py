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

from app.main import app  # noqa: E402

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
