# Vercel server functions

Functions in this directory run on Vercel and are separate from the browser bundle.
Never expose `META_APP_SECRET`, provider tokens, or a Supabase service-role key as
`VITE_*` variables. The current status endpoint validates the Supabase access token
and reports whether server-side Meta configuration exists. Provider OAuth and
publishing should be added here before enabling the corresponding UI actions.

The Smart Stock ingestion function follows the same rule. Google service-account
credentials and `SUPABASE_SERVICE_ROLE_KEY` are server-only Vercel variables. The
browser stores only the workbook ID and tab names through an administrator RPC;
it never receives the Google private key or the Supabase service-role key.
