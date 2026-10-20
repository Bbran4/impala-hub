from unittest.mock import Mock
import httpx

from app.instagram import InstagramClient, InstagramError

def transport(response):
    return httpx.MockTransport(lambda request: response(request))

def test_instagram_check_uses_account_token():
    def handler(request):
        assert request.url.path.endswith("/ig-1")
        assert request.url.params["access_token"] == "token"
        return httpx.Response(200, json={"id": "ig-1", "username": "impala"})
    client = InstagramClient("ig-1", "token", transport=transport(handler))
    assert client.check()["username"] == "impala"

def test_instagram_publish_image_creates_and_publishes_container():
    calls = []
    def handler(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/media"):
            return httpx.Response(200, json={"id": "container-1"})
        return httpx.Response(200, json={"id": "media-1"})
    client = InstagramClient("ig-1", "token", transport=transport(handler))
    assert client.publish_image("https://cdn.example/image.jpg", "Hello")["id"] == "media-1"
    assert calls == ["/v26.0/ig-1/media", "/v26.0/ig-1/media_publish"]

def test_instagram_rejects_missing_container():
    client = InstagramClient("ig-1", "token", transport=transport(lambda request: httpx.Response(200, json={})))
    try:
        client.publish_image("https://cdn.example/image.jpg")
    except InstagramError as exc:
        assert "media container" in str(exc)
    else:
        raise AssertionError("expected InstagramError")
