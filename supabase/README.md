# Supabase development

This directory contains versioned Supabase configuration and database migrations.

## First-time project setup

1. Install the Supabase CLI.
2. Run `supabase login` in your own terminal.
3. Run `supabase link --project-ref YOUR_PROJECT_REF`.
4. Run `supabase db push` to apply the migrations.
5. Create the first employee in Supabase Authentication.
6. Add the user's profile role from the Supabase SQL editor or an administrator workflow.

Do not commit access tokens, database passwords, service-role keys, or `.env` files.

The current application continues using FastAPI until the frontend and each workspace have been migrated to Supabase Auth and database access.
