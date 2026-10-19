"""Smoke tests for the local development API. Run from backend with pytest."""
import os
from pathlib import Path

os.environ["APP_API_KEY"] = "test-key"
os.environ["DATABASE_PATH"] = str(Path("/tmp/impala-hub-test.db"))
os.environ["UPLOAD_DIR"] = str(Path("/tmp/impala-hub-test-uploads"))

from fastapi.testclient import TestClient
from app.main import app


def test_health_and_auth():
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/posts").status_code == 401
        assert client.get("/api/posts", headers={"Authorization": "Bearer test-key"}).status_code == 200


def test_campaign_and_post_workflow():
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer test-key"}
        campaign = client.post("/api/campaigns", headers=headers, json={"name": "Test campaign", "objective": "Smoke test"})
        assert campaign.status_code == 201
        campaign_id = campaign.json()["id"]
        post = client.post("/api/posts", headers=headers, json={"caption": "Test post", "campaign_id": campaign_id, "channels": ["facebook"], "status": "draft"})
        assert post.status_code == 201
        assert post.json()["campaign_id"] == campaign_id
        assert client.get(f"/api/posts?campaign_id={campaign_id}", headers=headers).json()[0]["caption"] == "Test post"


def test_scheduled_post_requires_datetime():
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer test-key"}
        response = client.post("/api/posts", headers=headers, json={"caption": "Missing date", "channels": ["facebook"], "status": "scheduled"})
        assert response.status_code == 422
