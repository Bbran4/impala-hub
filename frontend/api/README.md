# Vercel server functions

Functions in this directory run on Vercel and are separate from the browser bundle.
Never expose `META_APP_SECRET`, provider tokens, or a Supabase service-role key as
`VITE_*` variables. The current status endpoint validates the Supabase access token
and reports whether server-side Meta configuration exists. Provider OAuth and
publishing must live here before corresponding UI actions are enabled. Facebook
uses these server functions; Instagram remains deferred on Supabase/Vercel.

## Shared server helpers

`api/_lib/` contains server configuration/aliases, Supabase client construction, HTTP errors, employee permission gates, cron authentication, Meta AES-256-GCM token encryption and the Facebook Graph URL/version policy. Its underscore-prefixed directory is a library, not an endpoint.

Employee handlers use `requireMarketingSession` with an explicit `workspace`, `accounts` or `publishing` policy. Live permission checks run on the employee's bearer-token client before the service-role client is created. The OAuth callback continues to validate expiring OAuth state rather than requiring a browser bearer token, and the publishing scheduler continues to require `CRON_SECRET`.

`FACEBOOK_API_VERSION` overrides the single default in `_lib/facebook.ts` for token exchange, Page discovery/checks, sync, insights and publishing. No handler owns a separate version. Changing this optional Vercel setting requires a redeployment.

The token format remains compatible with existing saved connections: base64 IV, authentication tag and ciphertext separated by dots, using AES-256-GCM and a base64-encoded 32-byte `META_TOKEN_ENCRYPTION_KEY`. Do not rotate that key as part of a code refactor.

New local server imports use explicit `.ts` paths; the project's TypeScript configuration rewrites them to `.js` in compiled output. The server startup test compiles and imports all Marketing handlers, including shared dependencies, and checks their method/authentication boundaries. Keep these checks when adding handlers.
