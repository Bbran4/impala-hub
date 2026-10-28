# Vercel server functions

Functions in this directory run on Vercel and are separate from the browser bundle.
Never expose `META_APP_SECRET`, provider tokens, or a Supabase service-role key as
`VITE_*` variables. The current status endpoint validates the Supabase access token
and reports whether server-side Meta configuration exists. Provider OAuth and
publishing must live here before corresponding UI actions are enabled. Facebook
uses these server functions; Instagram remains deferred on Supabase/Vercel.
