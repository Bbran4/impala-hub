# Supabase development and deployment

This directory contains versioned Supabase configuration and database migrations.

Starting after migration `0047`, the two people working on the database use separate number series
so their branches never collide:

- **Odd numbers** (`0049`, `0051`, `0053`, …): core platform (Marketing, Sales Desk, Smart Stock,
  Returns & Claims, admin settings).
- **Even numbers** (`0048`, `0052`, `0054`, …): Reporting (`bi` schema).

Before creating a migration, inspect the directory (and the target branch) and choose the next unused
number in your series that is **higher than every migration already there**: Supabase refuses to apply a
migration numbered lower than one already applied (which is why `0050` is skipped). Never renumber a
migration that has already been applied.

## First-time project setup

1. Install the Supabase CLI.
2. Run `supabase login` in your own terminal.
3. Run `supabase link --project-ref YOUR_PROJECT_REF`.
4. Run `supabase db push` to apply the migrations.
5. Create the first employee in Supabase Authentication.
6. Add the user's profile role from the Supabase SQL editor or an administrator workflow.

Do not commit access tokens, database passwords, service-role keys, or `.env` files.

## Automated local verification

Database tests run against the disposable local Supabase stack. They must never be pointed at the hosted project because they create test identities and records inside a transaction.

From the repository root:

```powershell
npm.cmd --prefix frontend ci
npx.cmd --no-install --prefix frontend supabase start
npx.cmd --no-install --prefix frontend supabase db reset
npx.cmd --no-install --prefix frontend supabase test db
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
```

The project pins Supabase CLI `2.122.0` in `frontend/devDependencies`; CI uses the same version.

The pgTAP suite in `supabase/tests/` verifies Returns & Claims RLS, role access, create/edit/soft-delete behavior, attachment policies and limits, audit events, and signed-out privileges. GitHub Actions runs the same database suite in an isolated local Supabase environment and does not require hosted-project credentials.

## Hosted deployment order

1. Confirm the local database tests, frontend tests and production build pass.
2. Review the migration plan without changing the hosted database:
   `npx.cmd --no-install --prefix frontend supabase db push --dry-run`.
3. Take or confirm a current Supabase database backup before a production migration.
4. Apply migrations before deploying frontend code:
   `npx.cmd --no-install --prefix frontend supabase db push`.
5. Push the tested branch to GitHub and allow Vercel to deploy it.
6. Check the GitHub Actions result and complete the signed-in and signed-out smoke checks in `docs/DEPLOYMENT.md`.

Migration `0035_returns_status_sla.sql` intentionally stops if existing claims contain unsupported statuses. Correct those records and rerun the migration; do not bypass the validation or mark a failed migration as applied. Migration `0036_returns_claim_integrity.sql` must be applied with the matching frontend because lifecycle audit writes move from the browser into atomic database triggers.

Never commit Supabase access tokens, database passwords, service-role keys, `.env` files, or production test credentials.
