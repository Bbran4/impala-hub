# Impala Hub deployment runbook

## Release gate

Use a local Supabase stack for database tests. Do not run `supabase/tests/` against the hosted project.

From the repository root in PowerShell:

```powershell
npm.cmd --prefix frontend ci
npx.cmd --no-install --prefix frontend supabase start
npx.cmd --no-install --prefix frontend supabase db reset
npx.cmd --no-install --prefix frontend supabase test db
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
```

All commands must pass before applying migrations or starting a Vercel production deployment. GitHub Actions repeats the frontend and Supabase tests on pushes to `main`, `supabase-migration`, `feature/**`, and pull requests to `main`.

The project and GitHub Actions both use the pinned Supabase CLI version from `frontend/package.json` (`2.122.0`).

## Production sequence

1. Confirm the branch contains only reviewed source, migration, test and documentation changes. Generated files such as `frontend/tsconfig.tsbuildinfo` must not be committed.
2. Confirm a current Supabase backup is available.
3. Preview pending migrations:

   ```powershell
   npx.cmd --no-install --prefix frontend supabase db push --dry-run
   ```

4. Apply the database migration before deploying code that depends on it:

   ```powershell
   npx.cmd --no-install --prefix frontend supabase db push
   ```

5. Push the tested branch to GitHub. Verify GitHub Actions passes and allow Vercel to deploy the intended branch or production commit.
6. Verify Vercel contains the production Supabase URL and publishable browser key. Never expose or configure the service-role key in the frontend.

## Returns & Claims smoke checks

- Signed out: the Apps Dashboard and Returns & Claims data are unavailable.
- Returns employee: create, reopen, edit and soft-delete a test claim; verify its history names the actor.
- Sales employee: Returns & Claims is unavailable and direct data requests return no records.
- Inactive employee: workspace and record access are denied.
- Administrator and management: verify the access currently defined by the workspace policies.
- Attachments: upload an allowed image and PDF, verify hosted Storage rejects disallowed MIME types and files above the bucket limit, preview/download them through signed URLs, then permanently delete one and confirm its audit event.
- Validation: reject an unsupported file, a file over 15 MB and an eleventh attachment.
- Reporting: check due-soon/overdue counts and compare filtered CSV and XLSX exports with visible records.

## Failure and rollback

- If migration 0035 reports unsupported legacy statuses, stop. Correct the listed records and rerun the migration.
- If a database migration fails, do not deploy the frontend and do not manually mark the migration as applied.
- A Vercel rollback changes frontend code only; it does not reverse Supabase schema changes.
- Database migrations are forward-only. Restore from the confirmed backup or prepare a reviewed corrective migration when database recovery is required.
- Record the deployed Git commit, Vercel deployment and final Supabase migration in the release notes.
