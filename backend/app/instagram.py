"""Instagram Graph API support for professional accounts.

Instagram publishing uses Meta's OAuth grant and the selected Facebook Page's
linked Instagram professional account. Tokens remain server-side; this module
contains no browser-facing secrets.
"""
from __future__ import annotations

from typing import Optional
import httpx

class InstagramError(Exception):
    def __init__(self, message: str, *, transient: bool = False):
        super().__init__(message)
        self.transient = transient

class InstagramClient:
    def __init__(self, account_id: str, token: str, version: str = "v26.0", transport: Optional[httpx.BaseTransport] = None):
        self.account_id = account_id
        self._token = token
        self._http = httpx.Client(base_url=f"https://graph.facebook.com/{version}", timeout=60, transport=transport)

    def _request(self, method: str, path: str, **kwargs) -> dict:
        kwargs.setdefault("params", {})
        kwargs["params"]["access_token"] = self._token
        try:
            response = self._http.request(method, path, **kwargs)
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise InstagramError("Could not connect to Instagram.", transient=True) from exc
        if response.status_code >= 400 or (isinstance(body, dict) and body.get("error")):
            error = body.get("error", {}) if isinstance(body, dict) else {}
            raise InstagramError(error.get("message", f"Instagram returned HTTP {response.status_code}."))
        return body

    def check(self) -> dict:
        return self._request("GET", f"/{self.account_id}", params={"fields": "id,username,name,profile_picture_url,followers_count"})

    def insights(self, metrics: str = "impressions,reach,profile_views") -> dict:
        return self._request("GET", f"/{self.account_id}/insights", params={"metric": metrics, "period": "day"})

    def publish_image(self, image_url: str, caption: str = "") -> dict:
        container = self._request("POST", f"/{self.account_id}/media", params={"image_url": image_url, "caption": caption, "media_type": "IMAGE"})
        creation_id = container.get("id")
        if not creation_id:
            raise InstagramError("Instagram did not return a media container.")
        return self._request("POST", f"/{self.account_id}/media_publish", params={"creation_id": creation_id})

    def media(self, limit: int = 100) -> dict:
        return self._request("GET", f"/{self.account_id}/media", params={"fields": "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count,insights.metric(reach,saved,total_interactions)", "limit": limit})
