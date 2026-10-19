"""Minimal Facebook Page client (Graph API). No imports from the rest of the app."""
from __future__ import annotations

import json
import mimetypes
from pathlib import Path
from typing import Optional

import httpx

# Error codes where Facebook answered that nothing was posted and a later retry is safe
# (rate limits / temporary throttling).
RETRY_SAFE_CODES = {4, 17, 32, 341, 368, 613}


class FacebookError(Exception):
    """transient=True means nothing was posted and retrying later is safe."""

    def __init__(self, message: str, *, transient: bool = False):
        super().__init__(message)
        self.transient = transient


class FacebookClient:
    def __init__(self, page_id: str, token: str, version: str = "v26.0", transport: Optional[httpx.BaseTransport] = None):
        self.page_id = page_id
        self._token = token
        self._http = httpx.Client(base_url=f"https://graph.facebook.com/{version}", timeout=60, transport=transport)

    # ------------------------------------------------------------------ plumbing
    def _request(self, method: str, path: str, **kwargs) -> dict:
        try:
            res = self._http.request(method, path, **kwargs)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            # The request never reached Facebook, so retrying cannot create a duplicate.
            raise FacebookError("Could not connect to Facebook.", transient=True) from exc
        except httpx.HTTPError as exc:
            # The request may or may not have been processed. Do not retry automatically.
            raise FacebookError(
                f"The connection to Facebook dropped ({exc.__class__.__name__}). "
                "Check the Facebook Page before scheduling this post again."
            ) from exc
        try:
            body = res.json()
        except ValueError:
            body = {}
        if res.status_code >= 400 or (isinstance(body, dict) and "error" in body):
            err = body.get("error", {}) if isinstance(body, dict) else {}
            message = err.get("message") or f"Facebook returned HTTP {res.status_code}."
            transient = res.status_code == 429 or err.get("code") in RETRY_SAFE_CODES
            raise FacebookError(message, transient=transient)
        return body

    @staticmethod
    def _file(path: Path) -> tuple:
        return (path.name, path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")

    # ------------------------------------------------------------------ public API
    def check(self) -> dict:
        """Confirm the Page ID and token work. Returns {"id", "name"}."""
        return self._request("GET", f"/{self.page_id}", params={"fields": "name", "access_token": self._token})

    def publish(self, caption: str, images: list[Path]) -> str:
        """Publish now to the Page. Returns the Facebook post id."""
        pid, token = self.page_id, self._token
        if not images:
            if not caption.strip():
                raise FacebookError("A post needs a caption or at least one image.")
            return self._request("POST", f"/{pid}/feed", data={"message": caption, "access_token": token})["id"]
        if len(images) == 1:
            body = self._request(
                "POST", f"/{pid}/photos",
                data={"caption": caption, "access_token": token}, files={"source": self._file(images[0])},
            )
            return body.get("post_id") or body["id"]
        # Several images: upload each unpublished, then attach them all to one feed post.
        media_ids = []
        for image in images:
            body = self._request(
                "POST", f"/{pid}/photos",
                data={"published": "false", "access_token": token}, files={"source": self._file(image)},
            )
            media_ids.append(body["id"])
        data = {"message": caption, "access_token": token}
        for i, media_id in enumerate(media_ids):
            data[f"attached_media[{i}]"] = json.dumps({"media_fbid": media_id})
        return self._request("POST", f"/{pid}/feed", data=data)["id"]


def client_from_settings(page_id: str, token: str, version: str, transport=None) -> Optional[FacebookClient]:
    if not page_id.strip() or not token.strip():
        return None
    return FacebookClient(page_id.strip(), token.strip(), version.strip() or "v26.0", transport)
