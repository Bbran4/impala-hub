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

## Smart Stock foundation checks

Migration `0037_smart_stock_foundation.sql` creates the Smart Stock data boundary but does not switch the existing Smart Stock screens away from FastAPI.

- Confirm the migration seeds `10 — Warehouse`, `ERBAKKIE` and `PTABAKKIE` location mappings, the four development statuses and shared mover thresholds of `2` and `10`.
- Administrator: confirm configuration and import foundation rows are writable.
- Stock employee: confirm Parts Queries are writable while settings, locations and import batches are read-only.
- Management: confirm all Smart Stock foundation data is read-only.
- Sales, unrelated-role, inactive and signed-out users: confirm direct table requests return no Smart Stock rows and all writes are rejected.
- Confirm Parts Query and supplier actors are assigned by the database and corresponding audit records are created automatically.
- Confirm staged snapshot rows are visible only to administrators and become visible to Stock/Management users only after their import batch is validated and activated.
- Do not remove the FastAPI Smart Stock routes until stages 3–8 have passed their production smoke checks.

### Parts Query cutover checks

After migration `0038_smart_stock_parts_queries.sql` and its matching frontend are deployed:

- Administrator and Stock employee: create a query with no suppliers, then create one with multiple suppliers.
- Edit part details, requested quantity, status, Development Status, Sales Code and the complete supplier set in one save.
- Submit one deliberately invalid supplier quantity and confirm the parent and previous supplier set remain unchanged.
- Confirm supplier unit-cost comparison uses cost divided by quote quantity.
- Archive a query and confirm it disappears from the active list while its named history remains available.
- Management: confirm the create, save, archive, supplier and Add Development Status controls are unavailable.
- Sales, unrelated-role, inactive and signed-out users: confirm direct table and RPC requests remain denied.

### Smart Stock configuration cutover checks

After migration `0039_smart_stock_configuration.sql` and its matching frontend are deployed:

- Administrator: create and edit a location, deactivate and reactivate it, and delete an unused location.
- Confirm the database refuses to deactivate or delete locations when doing so would leave fewer than two active locations.
- Save shared slow-mover and A&B-mover thresholds, reload on another browser, and confirm the values are shared rather than stored locally.
- Create an unused Development Status and delete it. Assign another status to a Parts Query and confirm it can be deactivated but not deleted.
- Confirm every successful configuration change produces a `stock_audit` row with the administrator as actor.
- Stock and Management users: confirm configuration is readable but the configuration page and all mutation functions are unavailable.
- Signed-out users: confirm configuration tables and mutation functions remain inaccessible.

### Versioned Smart Stock import checks

After migration `0040_smart_stock_import_pipeline.sql` is applied:

- Administrator: create a staged batch with a SHA-256 checksum and upload Booking and Reordering rows in multiple chunks.
- Confirm duplicate checksums, blank source names, unsupported source types and chunks above 2,000 rows are rejected.
- Upload an invalid numeric value or duplicate part/franchise key and confirm the complete chunk rolls back while the batch retains its validation message.
- Confirm validation derives stored row counts, requires both datasets and rejects any batch with diagnostics.
- Activate one valid batch, then activate a second. Confirm the first becomes `superseded`, the second becomes the sole `active` batch and Stock/Management users see only the second snapshot.
- Attempt to activate a rejected or staged batch and confirm the existing active snapshot remains unchanged.
- Confirm direct browser writes to import batches and snapshot rows fail, including for administrators.
- Confirm `stock_audit` contains semantic staging, validation, activation, supersession and rejection events with the administrator actor.
- Do not expose CSV/XLSX controls until Stage 6 parsing and column-mapping tests pass.

### CSV/XLSX Stock Data Import checks

After migration `0041_stock_import_retry_support.sql` and the Stage 6 frontend are deployed:

- Confirm only administrators can see **Stock Data Import** in the Smart Stock sidebar.
- Load CSV and XLSX sources containing both Booking and Reordering data. Confirm the correct worksheets and common header aliases are selected.
- Correct one automatic mapping manually and confirm the preview and validation update immediately.
- Confirm malformed CSV, invalid UTF-8, hidden-only workbooks, Excel formulas, duplicate normalized headers, unsupported formats and files above 25 MB fail before any Supabase batch is created.
- Confirm invalid integers, numeric precision, negative constrained values, supplier types, 121-character part numbers and duplicate Franchise/Part Number pairs block staging.
- Confirm the UI displays individual file hashes, a combined SHA-256 identity, bounded preview rows and bounded validation messages.
- Stage a valid pair and confirm the batch is `validated` but does not become active automatically.
- Activate it separately and confirm Stock Booking and Stock Reordering still show the previous snapshot until activation succeeds.
- Interrupt or reject an attempted import, reject its retained staged batch, then retry the same files and confirm both attempts remain in history.

### Stock Booking cutover checks

After migration `0042_stock_booking_transfers.sql` and the Stage 7 frontend are deployed:

- Activate a stock import and confirm Stock Booking shows only that snapshot, including imported bins and database-derived ER/PTA supply.
- Stock employee and administrator: choose `10 — Warehouse`, select ERBAKKIE or PTABAKKIE, enter comments and whole-number Book quantities, then select **Save and export**.
- Confirm Supabase creates one `ST-` transfer batch and the matching item rows before the CSV downloads.
- Open the CSV in Excel and verify the Evolve columns, UTF-8 characters, bins, quantities, remarks and timestamped ER/PT filename.
- Attempt a decimal, zero-only selection, quantity above remaining warehouse stock, stale snapshot ID and inactive location. Confirm no partial transfer is retained, and confirm two concurrent exports cannot overbook the same part.
- Confirm recent exports remain visible after refreshing and `stock_audit` contains the exporting user.
- Download a saved transfer again from history and confirm it reproduces the persisted rows without creating a duplicate transfer batch.
- Management: confirm Booking data and export history are readable but quantity, location, comment and export controls are unavailable.
- Sales, unrelated-role, inactive and signed-out users: confirm transfer tables and the creation function remain inaccessible.

## Failure and rollback

- If migration 0035 reports unsupported legacy statuses, stop. Correct the listed records and rerun the migration.
- If a database migration fails, do not deploy the frontend and do not manually mark the migration as applied.
- A Vercel rollback changes frontend code only; it does not reverse Supabase schema changes.
- Database migrations are forward-only. Restore from the confirmed backup or prepare a reviewed corrective migration when database recovery is required.
- Record the deployed Git commit, Vercel deployment and final Supabase migration in the release notes.
