"""Publisher and Facebook client tests. Nothing here talks to Facebook: the Graph API is mocked."""
import json
import os
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Same temp-dir approach as test_api.py; setdefault keeps whichever module imported app.main first consistent.
_tmp = Path(tempfile.mkdtemp(prefix="impala-hub-pub-test-"))
os.environ.setdefault("APP_API_KEY", "test-key-" + "x" * 32)
os.environ.setdefault("DATABASE_PATH", str(_tmp / "test.db"))
os.environ.setdefault("UPLOAD_DIR", str(_tmp / "uploads"))

import httpx  # noqa: E402
import pytest  # noqa: E402

from app.facebook import FacebookClient, FacebookError  # noqa: E402
from app.main import UPLOAD_PATH, db_session, init_db, now_iso  # noqa: E402
from app.publisher import MAX_ATTEMPTS, PENDING, process_due  # noqa: E402

NOW = datetime.now(timezone.utc)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture(autouse=True)
def _db():
    init_db()


class FakeClient:
    def __init__(self, result="123_456", error=None):
        self.result, self.error, self.calls = result, error, []

    def publish(self, caption, images):
        self.calls.append((caption, images))
        if self.error:
            raise self.error
        return self.result


def make_post(channels=("facebook",), publish_at=None, media=(), ids=None, status="scheduled") -> str:
    pid = "pub-" + uuid.uuid4().hex[:8]
    publish_at = publish_at or (NOW - timedelta(minutes=5))
    with db_session() as db:
        db.execute(
            """INSERT INTO posts(id,title,caption,channels_json,status,publish_at,media_json,provider_ids_json,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (pid, "T", "Hello", json.dumps(list(channels)), status, publish_at.isoformat(), json.dumps(list(media)),
             json.dumps(ids or {}), now_iso(), now_iso()),
        )
    return pid


def get(pid) -> dict:
    with db_session() as db:
        return dict(db.execute("SELECT * FROM posts WHERE id=?", (pid,)).fetchone())


# --------------------------------------------------------------------------- worker
def test_due_post_is_published_once():
    pid, client = make_post(), FakeClient()
    assert process_due(client, NOW)["published"] == 1
    row = get(pid)
    assert row["status"] == "published" and row["published_at"] and row["last_error"] is None
    assert json.loads(row["provider_ids_json"]) == {"facebook": "123_456"}
    process_due(client, NOW)  # a second cycle must not publish it again
    assert len([c for c in client.calls if c[0] == "Hello"]) == 1


def test_future_post_is_left_alone():
    pid, client = make_post(publish_at=NOW + timedelta(hours=1)), FakeClient()
    process_due(client, NOW)
    assert get(pid)["status"] == "scheduled" and client.calls == []


def test_images_are_read_from_the_upload_folder():
    name = uuid.uuid4().hex + ".png"
    (UPLOAD_PATH / name).write_bytes(PNG)
    pid = make_post(media=[{"id": name, "name": "a.png", "url": f"/uploads/{name}"}])
    client = FakeClient()
    process_due(client, NOW)
    assert client.calls[-1][1] == [UPLOAD_PATH / name]
    assert get(pid)["status"] == "published"


def test_permanent_error_fails_the_post_with_the_reason():
    pid = make_post()
    process_due(FakeClient(error=FacebookError("Invalid OAuth access token.")), NOW)
    row = get(pid)
    assert row["status"] == "failed" and row["last_error"] == "Invalid OAuth access token."


def test_unsupported_channel_fails_without_calling_facebook():
    pid, client = make_post(channels=("facebook", "instagram")), FakeClient()
    process_due(client, NOW)
    row = get(pid)
    assert row["status"] == "failed" and "instagram" in row["last_error"] and client.calls == []


def test_rate_limit_is_retried_then_fails_after_max_attempts():
    pid, client = make_post(), FakeClient(error=FacebookError("Too many calls.", transient=True))
    for attempt in range(1, MAX_ATTEMPTS):
        assert process_due(client, NOW)["retry"] == 1
        assert get(pid)["status"] == "scheduled"
    process_due(client, NOW)
    assert get(pid)["status"] == "failed"
    assert len(client.calls) == MAX_ATTEMPTS


def test_missing_image_file_fails_instead_of_retrying():
    name = uuid.uuid4().hex + ".png"  # never written to disk
    pid = make_post(media=[{"id": name, "name": "a.png", "url": f"/uploads/{name}"}])

    class Reads(FakeClient):
        def publish(self, caption, images):
            images[0].read_bytes()

    process_due(Reads(), NOW)
    assert get(pid)["status"] == "failed"


def test_post_that_missed_its_slot_by_a_day_is_not_published():
    pid, client = make_post(publish_at=NOW - timedelta(hours=30)), FakeClient()
    process_due(client, NOW)
    assert get(pid)["status"] == "failed" and client.calls == []


def test_in_flight_post_is_skipped_and_a_stale_claim_is_failed_for_review():
    fresh = make_post(ids={PENDING: now_iso()})
    stale = make_post(ids={PENDING: (NOW - timedelta(minutes=30)).isoformat()})
    client = FakeClient()
    process_due(client, NOW)
    assert get(fresh)["status"] == "scheduled"
    row = get(stale)
    assert row["status"] == "failed" and "Check the Facebook Page" in row["last_error"]
    assert client.calls == []


# --------------------------------------------------------------------------- Graph API client
def graph(handler):
    return FacebookClient("PAGE1", "SECRET-TOKEN", "v26.0", transport=httpx.MockTransport(handler))


def test_text_post_goes_to_feed():
    seen = {}

    def handler(request):
        seen["path"], seen["body"] = request.url.path, request.content.decode()
        return httpx.Response(200, json={"id": "PAGE1_99"})

    assert graph(handler).publish("Hi there", []) == "PAGE1_99"
    assert seen["path"] == "/v26.0/PAGE1/feed" and "message=Hi+there" in seen["body"]


def test_single_image_goes_to_photos_and_returns_the_post_id(tmp_path):
    img = tmp_path / "a.png"
    img.write_bytes(PNG)
    paths = []

    def handler(request):
        paths.append(request.url.path)
        return httpx.Response(200, json={"id": "PHOTO1", "post_id": "PAGE1_7"})

    assert graph(handler).publish("Cap", [img]) == "PAGE1_7"
    assert paths == ["/v26.0/PAGE1/photos"]


def test_several_images_are_uploaded_unpublished_then_attached(tmp_path):
    imgs = []
    for n in ("a.png", "b.png"):
        (tmp_path / n).write_bytes(PNG)
        imgs.append(tmp_path / n)
    calls, counter = [], iter(["M1", "M2"])

    def handler(request):
        calls.append((request.url.path, request.content))
        if request.url.path.endswith("/photos"):
            return httpx.Response(200, json={"id": next(counter)})
        return httpx.Response(200, json={"id": "PAGE1_55"})

    assert graph(handler).publish("Cap", imgs) == "PAGE1_55"
    assert [p for p, _ in calls] == ["/v26.0/PAGE1/photos", "/v26.0/PAGE1/photos", "/v26.0/PAGE1/feed"]
    assert b"published" in calls[0][1] and b"M1" in calls[2][1] and b"M2" in calls[2][1]


def test_empty_post_is_rejected_before_any_request():
    def handler(request):
        raise AssertionError("no request expected")

    with pytest.raises(FacebookError):
        graph(handler).publish("   ", [])


def test_errors_are_classified_and_never_leak_the_token():
    def bad_token(request):
        return httpx.Response(400, json={"error": {"message": "Invalid OAuth access token.", "code": 190}})

    def throttled(request):
        return httpx.Response(400, json={"error": {"message": "Too many calls.", "code": 17}})

    def server_error(request):
        return httpx.Response(500, json={})

    with pytest.raises(FacebookError) as e1:
        graph(bad_token).publish("x", [])
    assert not e1.value.transient and "SECRET-TOKEN" not in str(e1.value)
    with pytest.raises(FacebookError) as e2:
        graph(throttled).publish("x", [])
    assert e2.value.transient
    with pytest.raises(FacebookError) as e3:
        graph(server_error).publish("x", [])
    assert not e3.value.transient  # Facebook may have processed it, so no automatic retry


def test_dropped_connection_is_not_retried_but_connect_failure_is():
    def dropped(request):
        raise httpx.ReadTimeout("slow", request=request)

    def refused(request):
        raise httpx.ConnectError("no route", request=request)

    with pytest.raises(FacebookError) as e1:
        graph(dropped).publish("x", [])
    assert not e1.value.transient
    with pytest.raises(FacebookError) as e2:
        graph(refused).publish("x", [])
    assert e2.value.transient


def test_check_accepts_a_page_token_and_rejects_user_or_mismatched_tokens():
    def make(body):
        return graph(lambda request: httpx.Response(200, json=body))

    ok = make({"id": "PAGE1", "name": "Impala Spares", "metadata": {"type": "page"}})
    assert ok.check()["name"] == "Impala Spares"
    with pytest.raises(FacebookError, match="user token"):
        make({"id": "999", "name": "Brenden", "metadata": {"type": "user"}}).check()
    with pytest.raises(FacebookError, match="not FACEBOOK_PAGE_ID"):
        make({"id": "OTHER", "name": "Other Page", "metadata": {"type": "page"}}).check()


# --------------------------------------------------------------------------- importing posts from Facebook
from app.facebook import parse_post  # noqa: E402
from app.publisher import sync_posts  # noqa: E402


def fb_item(fid, message="Hello from Facebook", created="2026-10-01T08:00:00+0000", **kw):
    return {"id": fid, "message": message, "created_time": created, "permalink_url": f"https://facebook.com/{fid}",
            "images": kw.get("images", []), "likes": kw.get("likes", 5), "comments": kw.get("comments", 2), "shares": kw.get("shares", 1)}


class ListClient:
    def __init__(self, items):
        self.items = items

    def list_published_posts(self, limit=100):
        return self.items[:limit]


def test_new_facebook_posts_are_imported_once_and_figures_refresh():
    fid = "PAGE1_" + uuid.uuid4().hex[:8]
    client = ListClient([fb_item(fid, images=["https://cdn.example/a.jpg"])])
    assert sync_posts(client)["imported"] == 1
    local = "fb-" + fid.replace("_", "-")
    row = get(local)
    assert row["status"] == "published" and row["caption"] == "Hello from Facebook"
    assert row["published_at"] == "2026-10-01T08:00:00+00:00"
    assert (row["likes"], row["comments"], row["shares"]) == (5, 2, 1) and row["clicks"] is None
    assert json.loads(row["media_json"])[0]["url"] == "https://cdn.example/a.jpg"
    assert json.loads(row["provider_ids_json"])["permalink"].endswith(fid)
    client.items = [fb_item(fid, likes=9)]
    stats = sync_posts(client)
    assert stats == {"imported": 0, "updated": 1} and get(local)["likes"] == 9


def test_a_post_published_from_the_app_is_not_imported_twice():
    pid = make_post(status="published", ids={"facebook": "PAGE1_mine"})
    stats = sync_posts(ListClient([fb_item("PAGE1_mine", likes=12)]))
    assert stats == {"imported": 0, "updated": 1}
    assert get(pid)["likes"] == 12 and json.loads(get(pid)["provider_ids_json"])["facebook"] == "PAGE1_mine"


def test_parse_post_reads_images_counts_and_missing_shares():
    raw = {
        "id": "P_1", "created_time": "2026-10-01T08:00:00+0000",
        "attachments": {"data": [{"subattachments": {"data": [
            {"media": {"image": {"src": "https://cdn.example/1.jpg"}}},
            {"media": {"image": {"src": "https://cdn.example/2.jpg"}}}]}}]},
        "likes": {"summary": {"total_count": 7}}, "comments": {"summary": {"total_count": 3}},
    }
    post = parse_post(raw)
    assert post["images"] == ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"]
    assert (post["likes"], post["comments"], post["shares"], post["message"]) == (7, 3, 0, "")


def test_list_published_posts_follows_paging_and_respects_the_limit():
    page2_url = "https://graph.facebook.com/v26.0/PAGE1/published_posts?after=abc&access_token=SECRET-TOKEN"

    def handler(request):
        if "after=abc" in str(request.url):
            return httpx.Response(200, json={"data": [{"id": "P_3"}]})
        return httpx.Response(200, json={"data": [{"id": "P_1"}, {"id": "P_2"}], "paging": {"next": page2_url}})

    assert [p["id"] for p in graph(handler).list_published_posts(10)] == ["P_1", "P_2", "P_3"]
    assert [p["id"] for p in graph(handler).list_published_posts(2)] == ["P_1", "P_2"]


def test_sync_endpoint(monkeypatch):
    from fastapi.testclient import TestClient
    from app import main

    headers = {"Authorization": f"Bearer {os.environ['APP_API_KEY']}"}
    client = TestClient(main.app)  # no `with`: the background worker is not started
    monkeypatch.setattr(main, "facebook_client", lambda: None)
    assert client.post("/api/integrations/facebook/sync", headers=headers).status_code == 409
    fid = "PAGE1_" + uuid.uuid4().hex[:8]
    monkeypatch.setattr(main, "facebook_client", lambda: ListClient([fb_item(fid)]))
    res = client.post("/api/integrations/facebook/sync", headers=headers)
    assert res.status_code == 200 and res.json() == {"imported": 1, "updated": 0}

    class Broken:
        def list_published_posts(self, limit=100):
            raise FacebookError("Invalid OAuth access token.")

    monkeypatch.setattr(main, "facebook_client", lambda: Broken())
    assert client.post("/api/integrations/facebook/sync", headers=headers).status_code == 502


def test_import_falls_back_to_posts_without_figures_when_engagement_is_refused():
    def handler(request):
        if "likes" in request.url.params["fields"]:
            return httpx.Response(403, json={"error": {"message": "(#10) needs pages_read_engagement", "code": 10}})
        return httpx.Response(200, json={"data": [{"id": "P_1", "message": "Hi", "created_time": "2026-10-01T08:00:00+0000"}]})

    posts = graph(handler).list_published_posts()
    assert [p["id"] for p in posts] == ["P_1"]
    assert (posts[0]["likes"], posts[0]["comments"], posts[0]["shares"]) == (None, None, None)


def test_a_permission_error_on_the_basic_fields_is_still_reported():
    def handler(request):
        return httpx.Response(403, json={"error": {"message": "(#10) needs pages_read_engagement", "code": 10}})

    with pytest.raises(FacebookError, match="pages_read_engagement"):
        graph(handler).list_published_posts()
