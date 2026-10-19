# Connecting Impala Hub to your Facebook Page

This connects the app to **one Facebook Page that you administer**, using a Page access token kept server-side in `backend/.env`. Configuration now checks the Page identity and can inspect token expiry and permissions when Meta app credentials are configured. This is still the interim single-Page setup, not OAuth.

## 1. Create the Meta app (about 10 minutes)

1. Go to <https://developers.facebook.com> and log in with the Facebook account that administers the Impala Spares Page.
2. **My Apps > Create App**. Choose the Business type (or the "Other" / Business option if asked) and give it a name.
3. Make sure your own account has a role on the app (Admin, Developer or Tester). While the app is in development mode, people with a role on it can use Page permissions with their own Pages.
4. Meta's screens and rules change. If a step below looks different, follow the labels in the dashboard and Meta's Pages API documentation.

## 2. Get the Page ID and a Page access token

1. Open **Tools > Graph API Explorer** and select your app.
2. Under User or Page, choose **Get User Access Token** and tick these permissions:
   `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`.
3. Generate the token and approve the dialog, selecting the Impala Spares Page.
4. In the query box run `GET me/accounts`. Find your Page in the result and copy its `id` (the **Page ID**) and its `access_token` (the **Page token**).
5. A Page token derived from a *long-lived* user token does not expire. To get one, first exchange the short-lived user token (Access Token Debugger > "Extend Access Token", or the `oauth/access_token` call with `grant_type=fb_exchange_token`), then run `GET me/accounts` again with the long-lived token.

## 3. Configure the app

Add to `backend/.env` (never commit this file):

```
FACEBOOK_PAGE_ID=your_page_id
FACEBOOK_PAGE_TOKEN=your_page_token
META_APP_ID=your_meta_app_id
META_APP_SECRET=your_meta_app_secret
FACEBOOK_API_VERSION=v26.0
```

Set `FACEBOOK_API_VERSION` to the Graph API version shown in your Meta app dashboard. Restart the API. Open **Configuration** and select **Check connection**. The response verifies the configured Page identity, displays its name and ID, checks whether the token is valid and belongs to the configured Meta app, and reports granted/missing permissions plus token and data-access expiry when `META_APP_ID` and `META_APP_SECRET` are configured. Without those app credentials, only Page identity can be verified; expiry and permission diagnostics are explicitly marked unavailable. The API does not return the token or app secret to the browser.

## 4. How publishing behaves

- A background worker checks every `PUBLISHER_INTERVAL_SECONDS` (default 30) for scheduled posts that are due and publishes them to the Page. It runs only while the API is running, so keep the API running when posts are due.
- On success the post becomes **published**, with its real publication time. The Facebook post id is stored in `provider_ids_json`.
- On failure the post becomes **failed** with the reason in `last_error`. Failed posts can be edited and rescheduled.
- Only rate limits and connection failures that never reached Facebook are retried (up to 3 times). Anything else is not retried automatically, so a post can never be sent twice.
- If the API stops while a post is being sent, that post is marked **failed** with a note to check the Page before trying again.
- A post more than 24 hours past its scheduled time is marked failed rather than published late.
- Posts that include Instagram or WhatsApp fail with a clear message until those channels are built. Remove them from the post and schedule again.
- Images are uploaded to Facebook as files. One image becomes a photo post; several become one post with all images attached.
- The "Additional Facebook groups" choices are still samples and are ignored when publishing. Meta restricts group publishing for apps, so these are unlikely to become real.

## 5. Posts imported from Facebook

- When the API starts, and then every `FACEBOOK_SYNC_MINUTES` (default 10), the app imports the Page's published posts (up to the latest 100) and refreshes likes, comments and shares on posts it already has. **Sync from Facebook** on the Posts page does this immediately.
- Imported posts appear as **published** and are locked like any other published post. Their date is the time they went out on Facebook, so they show in the right month in the list, board and calendar. Open one for a "View on Facebook" link.
- Images on imported posts are loaded from Facebook's own servers. These links can stop working after a while.
- Clicks stay "—": Facebook does not give them per post through this connection.
- Posts you scheduled natively inside Facebook are not imported, because the app would then publish them a second time.
- Reading posts needs `pages_read_engagement`, which you already requested.

## 6. Before the app is used by anyone else

Page tokens in `.env` are fine for your own computer. For a shared or hosted deployment you need the items in the README's "Before a hosted, multi-user deployment" list, plus Meta's App Review / Business Verification if people outside the app's roles will connect their Pages.


## Connection health and disconnect/reconnect

- **Check connection** calls the backend's live Graph API diagnostic endpoint; a stored Page ID alone is never treated as proof of connection.
- A successful identity check verifies the configured Page ID matches the Page returned by Meta.
- When Meta app credentials are set, the backend uses the Graph API token debugger to check validity, app ownership, token type, expiry, data-access expiry, and available scopes. The currently required scopes for the Page workflow are `pages_manage_posts` and `pages_read_engagement`. Actual API access remains subject to Meta's app mode, review, Page roles, and current platform rules.
- To **disconnect** the interim integration, remove `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_TOKEN` from `backend/.env` and restart the API. To reconnect, configure a valid Page ID and Page token and restart, then use **Check connection**. This is intentionally explicit but is not yet a one-click OAuth disconnect.
- **OAuth remains the next step** before multi-user/multi-Page rollout. It requires a Meta app with a configured redirect URL and server-side app credentials. The present environment-based token flow is for validating the first live Page workflow, not the permanent employee connection experience.
