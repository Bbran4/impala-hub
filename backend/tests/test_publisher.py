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


def test_check_returns_the_page_name():
    def handler(request):
        assert request.url.params["fields"] == "name"
        return httpx.Response(200, json={"id": "PAGE1", "name": "Impala Spares"})

    assert graph(handler).check()["name"] == "Impala Spares"
