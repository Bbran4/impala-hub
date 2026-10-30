# Facebook connection on Supabase and Vercel

Facebook connects through Meta OAuth using the Vercel functions in `frontend/api/marketing/facebook/`. Page access tokens are encrypted and stored in Supabase; they are not configured as browser variables or manually pasted into the application.

## Vercel project settings

Configure these server variables for the deployment environment:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `META_APP_ID`, `META_APP_SECRET`
- `META_TOKEN_ENCRYPTION_KEY`: a private base64-encoded 32-byte encryption key; keep it stable while encrypted connections exist.
- `FACEBOOK_OAUTH_REDIRECT_URI`: the exact deployed `/api/marketing/facebook/callback` URL registered in Meta.
- `FRONTEND_URL`: the application URL to return to after authorization.
- `CRON_SECRET`: authorizes the scheduled publishing handler.
- Optional `FACEBOOK_API_VERSION`: one Graph version override shared by every Marketing handler. Its default is pinned in `frontend/api/_lib/facebook.ts`.

The UI also needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Private credentials must never use the `VITE_` prefix. Redeploy after changing deployment configuration.

## Connect and verify

1. Give the employee the Marketing account-management permission.
2. Open App Settings → Marketing, or Marketing Accounts when permitted.
3. Select Connect Facebook, complete Meta authorization and choose the Page.
4. Check the connection and refresh posts. Confirm the Page identity, post previews, metrics availability and last successful update time.
5. Publish a controlled test post only when authorized. Verify the confirmed result and provider link before relying on scheduling.

The deployment's cron schedule is defined in `frontend/vercel.json`; due posts are processed on that schedule. Timeouts or interrupted publishing can produce `publish_unknown`, which requires checking Facebook before retrying.

Disconnecting removes the saved connection through the app. Revoke access in Facebook Business Integrations separately when required. Instagram and WhatsApp connectivity remain deferred.

## Troubleshooting

- Missing server configuration: check the Vercel environment settings for the deployed environment and redeploy.
- No Pages returned: confirm Page access, authorization choices and the Meta app's permissions.
- Redirect mismatch: the configured callback URL must exactly match Meta's registration.
- Permission or token errors: reconnect through Meta and confirm the required Page permissions were granted.
- Missing database functions or columns: inspect the Supabase GitHub integration and migration results; do not assume a Vercel deployment applies database changes.

For local server-function testing, use the linked Vercel project with `vercel dev`; plain Vite does not execute the server functions. See [Vercel's local development guide](https://vercel.com/docs/cli/dev).
