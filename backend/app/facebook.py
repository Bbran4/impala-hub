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

    def __init__(self, message: str, *, transient: bool = False, code: Optional[int] = None):
        super().__init__(message)
        self.transient = transient
        self.code = code  # Facebook's error code, e.g. 10 or 200 for a permission problem


BASE_FIELDS = "id,message,created_time,permalink_url,full_picture,attachments{media,subattachments}"
LIKES_FIELDS = ",likes.limit(0).summary(true),shares"
COMMENTS_FIELDS = ",comments.limit(0).summary(true)"
# Tried in this order. Comments are user-generated content and may need a different permission
# (pages_read_user_content) than likes and shares, so a refusal there must not hide the rest.
FIELD_SETS = [BASE_FIELDS + LIKES_FIELDS + COMMENTS_FIELDS, BASE_FIELDS + LIKES_FIELDS, BASE_FIELDS]


def _images(raw: dict) -> list[str]:
    urls = []
    for attachment in (raw.get("attachments") or {}).get("data") or []:
        subs = (attachment.get("subattachments") or {}).get("data") or [attachment]
        for item in subs:
            src = ((item.get("media") or {}).get("image") or {}).get("src")
            if src:
                urls.append(src)
    if not urls and raw.get("full_picture"):
        urls = [raw["full_picture"]]
    return list(dict.fromkeys(urls))[:10]


def _count(raw: dict, field: str) -> Optional[int]:
    return ((raw.get(field) or {}).get("summary") or {}).get("total_count")


def parse_post(raw: dict) -> dict:
    return {
        "id": raw["id"],
        "message": raw.get("message") or "",
        "created_time": raw.get("created_time"),
        "permalink_url": raw.get("permalink_url"),
        "images": _images(raw),
        "likes": _count(raw, "likes"),
        "comments": _count(raw, "comments"),
        # Facebook leaves "shares" out entirely when a post has none, so a missing value means 0 -- but only
        # when engagement figures were requested at all. Without them it is "not available".
        "shares": (raw.get("shares") or {}).get("count", 0) if "likes" in raw or "comments" in raw else None,
    }


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
            raise FacebookError(message, transient=transient, code=err.get("code"))
        return body

    @staticmethod
    def _file(path: Path) -> tuple:
        return (path.name, path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")

    # ------------------------------------------------------------------ public API
    def check(self) -> dict:
        """Confirm the token is a Page token for FACEBOOK_PAGE_ID. Returns {"id", "name"}."""
        body = self._request("GET", "/me", params={"fields": "id,name", "metadata": 1, "access_token": self._token})
        kind = (body.get("metadata") or {}).get("type")
        if kind == "user" or (kind is None and str(body.get("id")) != self.page_id):
            raise FacebookError(
                f"FACEBOOK_PAGE_TOKEN is a user token (for {body.get('name', 'a person')}), not a Page token. "
                "Get the Page token with GET {PAGE_ID}?fields=access_token using a user token that has a role on the Page."
            )
        if str(body.get("id")) != self.page_id:
            raise FacebookError(
                f"FACEBOOK_PAGE_TOKEN belongs to \"{body.get('name')}\" (id {body.get('id')}), "
                f"which is not FACEBOOK_PAGE_ID ({self.page_id})."
            )
        return body

    def connection_diagnostics(self, app_id: str = "", app_secret: str = "") -> dict:
        """Validate the configured Page token and report expiry/permission diagnostics when app credentials exist."""
        page = self.check()
        result = {
            "page_id": str(page.get("id", self.page_id)),
            "page_name": page.get("name", ""),
            "token_valid": True,
            "token_type": "page",
            "expires_at": None,
            "data_access_expires_at": None,
            "granted_permissions": [],
            "missing_permissions": [],
            "diagnostics_available": False,
        }
        required = {"pages_manage_posts", "pages_read_engagement"}
        if not app_id.strip() or not app_secret.strip():
            result["diagnostic_note"] = "Page identity is verified. Configure META_APP_ID and META_APP_SECRET to check token expiry and granted permissions."
            return result

        app_token = f"{app_id.strip()}|{app_secret.strip()}"
        debug = self._request(
            "GET", "/debug_token",
            params={"input_token": self._token, "access_token": app_token},
        ).get("data", {})
        if not debug.get("is_valid", False):
            raise FacebookError("The Facebook Page access token is invalid, expired, or revoked.")
        if str(debug.get("app_id", "")) != app_id.strip():
            raise FacebookError("The Facebook Page token was issued for a different Meta app.")
        token_type = str(debug.get("type", "")).lower()
        if token_type not in {"page", "user"}:
            raise FacebookError(f"Unexpected Facebook token type: {debug.get('type', 'unknown')}.")
        scopes = sorted(set(debug.get("scopes") or []))
        granular = debug.get("granular_scopes") or []
        # Page tokens commonly inherit permissions from the user token that generated them.
        for item in granular:
            scope = item.get("scope")
            if scope and scope not in scopes:
                scopes.append(scope)
        result.update({
            "token_type": token_type,
            "expires_at": debug.get("expires_at") or None,
            "data_access_expires_at": debug.get("data_access_expires_at") or None,
            "granted_permissions": sorted(set(scopes)),
            "missing_permissions": sorted(required - set(scopes)),
            "diagnostics_available": True,
            "application_name": debug.get("application"),
        })
        if result["missing_permissions"]:
            result["diagnostic_note"] = "The token is valid but may not have all permissions needed by Impala Hub."
        return result

    def list_published_posts(self, limit: int = 100) -> list[dict]:
        """Newest-first posts published by the Page itself (not visitor posts), with engagement counts.

        If Facebook refuses some engagement fields (permission errors 10 / 200), the posts are still
        listed with whatever figures it does allow; the rest stay "not available".
        """
        for i, fields in enumerate(FIELD_SETS):
            try:
                return self._list(limit, fields)
            except FacebookError as exc:
                if exc.code not in (10, 200) or i == len(FIELD_SETS) - 1:
                    raise
        raise AssertionError("unreachable")

    def _list(self, limit: int, fields: str) -> list[dict]:
        params = {"fields": fields, "limit": 25, "access_token": self._token}
        body = self._request("GET", f"/{self.page_id}/published_posts", params=params)
        posts: list[dict] = []
        while True:
            for raw in body.get("data", []):
                posts.append(parse_post(raw))
                if len(posts) >= limit:
                    return posts
            next_url = (body.get("paging") or {}).get("next")
            if not next_url:
                return posts
            body = self._request("GET", next_url)

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
