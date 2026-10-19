# Connecting Impala Hub to your Facebook Page

This connects the app to **one Facebook Page that you administer**, using a Page access token kept in `backend/.env`. It is intended for internal use. A full "Connect with Facebook" login flow can be added later.

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
FACEBOOK_API_VERSION=v26.0
```

Set `FACEBOOK_API_VERSION` to the Graph API version shown in your Meta app dashboard. Restart the API. Open **Configuration**: Facebook should show **Connected: <your Page name>**. If it shows a connection error, the message from Facebook is displayed there.

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

## 5. Before the app is used by anyone else

Page tokens in `.env` are fine for your own computer. For a shared or hosted deployment you need the items in the README's "Before a hosted, multi-user deployment" list, plus Meta's App Review / Business Verification if people outside the app's roles will connect their Pages.
