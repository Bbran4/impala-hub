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

1. Confirm the branch contains only reviewed changes and that a current Supabase backup is available.
2. For schema changes, inspect the Supabase GitHub integration's migration results for the intended branch. Confirm required migrations are applied before relying on the new frontend. Do not run a competing manual migration deployment when the integration owns this workflow.
3. Push the tested branch and inspect GitHub Actions and Vercel deployment results.
4. Configure the browser's Supabase URL and publishable key and the private server variables described in `frontend/.env.example` in the Vercel project settings. Private values must not have a `VITE_` prefix.
5. Run the appropriate hosted checks below. The application has no separate web-server process; the Reporting sync agent is a separate supported component.

Local UI development uses Vite and Supabase. Use the linked Vercel project with `vercel dev` when testing `/api/marketing/` or `/api/reporting/` functions locally. See `README.md` and `FACEBOOK_SETUP.md` for setup.

## Administrator normal user view

Migration `0103_administrator_normal_user_view.sql` adds the **Use normal user view** checkbox to administrator accounts under **Profile and security**. The preference is saved on the account. It suppresses the administrator override in database role checks as well as in the UI; other assigned roles and explicit permission overrides continue to apply. It does not impersonate another employee or remove any role assignments.

- Administrator with no other roles: enable normal view and confirm workspaces are unavailable, while the account profile remains accessible.
- Administrator with employee roles: enable normal view and confirm only assigned workspaces, permissions and permitted data are available. Administrator settings and import controls should disappear.
- Untick the checkbox from the profile and confirm full administrator access returns without signing out. Switching modes discards loaded workspace data and Sales Desk session metadata.
- Ordinary and inactive accounts must not be able to change viewing mode through the RPC or direct profile updates.
- The GitHub integration must apply migration 0103 before the matching frontend is used. The database regression suite is `supabase/tests/administrator_normal_user_view.test.sql`.

## Chat settings and shared Sales Desk milestones

- Migration `0105_chat_settings.sql` adds **App Settings → Chat and channels**. Administrators can assign each active employee a name colour and permissions to create channels, invite people, remove members and delete joined channels. Creation and invitation retain their previous default availability; removal and deletion require an explicit grant. Administrator view retains all actions, while normal user view uses the saved employee permissions. Non-administrators must also be members of a channel before managing it.
- All colour controls for stock highlights, milestones and chat names share a visual selector plus editable RGB and hex values. Chat name colours apply in the dock and Channels workspace.
- Migration `0107_sales_desk_shared_milestones.sql` moves monthly sales and GP% targets and colours into Supabase. Use **Save milestones** in Sales Desk settings. A successful save applies to everyone and is independent of Vercel deployments. Failed saves retain the draft; stale saves require reloading milestones.
- On the first shared setup, **Import and save browser milestones** can recover valid settings saved by the previous browser-only implementation. The app does not silently import them or overwrite an existing shared configuration.
- Verify a saved target and custom colour in a second Sales Desk account. Confirm zero GP% thresholds work, duplicate values are rejected, and saved empty milestone groups stay empty after reopening.
- The new SQL regression suites are `chat_settings.test.sql` and `sales_desk_milestones.test.sql` under `supabase/tests/`.

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

Smart Stock uses Supabase for Parts Queries, Booking, Reordering, imports and shared configuration. The former Python web application is retired.

- Confirm the migration seeds `10 — Warehouse`, `ERBAKKIE` and `PTABAKKIE` location mappings, the four development statuses and shared mover thresholds of `2` and `10`.
- Administrator: confirm configuration and import foundation rows are writable.
- Stock employee: confirm Parts Queries are writable while settings, locations and import batches are read-only.
- Management: confirm all Smart Stock foundation data is read-only.
- Sales, unrelated-role, inactive and signed-out users: confirm direct table requests return no Smart Stock rows and all writes are rejected.
- Confirm Parts Query and supplier actors are assigned by the database and corresponding audit records are created automatically.
- Confirm staged snapshot rows are visible only to administrators and become visible to Stock/Management users only after their import batch is validated and activated.
- Verify the active Supabase workflows below; there is no Python web-server fallback.

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

### Stock Reordering cutover checks

After migration `0043_stock_reordering_workspace.sql` and the Stage 8 frontend are deployed:

- Activate an import and confirm Stock Reordering shows only that snapshot for Stock, Management and administrator users.
- Compare representative supply percentages with `(QOH ER + QOH PTA + QOH WH) / Global Safety × 100`; confirm zero Global Safety produces `0.0%`.
- Change the shared slow and A&B thresholds in configuration, refresh Reordering and confirm the filter labels and matching records change together.
- Test inclusive threshold boundaries, Local/International supplier filters and the 25%/50% supply filters.
- Search by part number, description, supplier and each alternative-number field.
- Sort numeric columns containing values such as 2 and 10 and confirm numeric rather than alphabetic ordering.
- Import more than 1,000 Reordering rows and confirm all records load in bounded requests while only 200 rows render per visible page.
- Confirm administrators do not see staged, rejected or superseded rows mixed into the active workspace.
- Sales, unrelated-role, inactive and signed-out users: confirm the workspace view returns no records or is inaccessible.

### External stock data

Google Sheets ingestion has been retired. Apply migration `0045_retire_google_stock_ingestion.sql` to deactivate any configured source and revoke its execution functions. The Vercel endpoint and cron no longer exist. Remove `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` from Vercel if they were added, and revoke/delete the unused Google service-account key in Google Cloud.

For now, administrators load demonstration snapshots through **Smart Stock Control → Stock Data Import** using the documented CSV/XLSX format. Qlik, ERP/ODBC and other real external data sources are intentionally deferred.

## Reporting (data loader) checks

Migration `0046_bi_reporting.sql` adds the `reporting` role, extends `can_access_workspace` with `reporting`, and creates the `bi`/`bi_data` schemas, the `bi_agent` database role and the `public.bi_*` functions used by the Reporting workspace. Browsers have no privileges on `bi` or `bi_data`. The on-premises sync agent and its setup are documented in `bi-agent/README.md`.

After the migration and the matching frontend are deployed:

- Enable the agent login by hand in the SQL editor (`alter role bi_agent with login password '…'`). Never put this password in Git or Vercel.
- Administrator: the Apps Dashboard shows **Reporting**; Data, Data Loads, Run History, Audit Log and Reporting Roadmap are available.
- Management and `reporting` users: Reporting shows Data and the roadmap only; Data Loads, Run History and Audit Log are absent and their functions return permission errors.
- Sales, stock, returns and marketing users without `reporting`, inactive users and signed-out users: no Reporting card; `bi_data_tables` and all other `bi_*` functions are denied.
- Before the agent connects, Data Loads shows "No sync agent has connected yet" and Data shows "No data loaded yet".
- With the agent running and `tables.toml` applied: the agent shows **Online**; **Test connection** returns the ERP database name; **Reload**, **Full** and **Pause/Resume** change the table or group and appear in the Audit Log with the administrator's name; Run History shows the resulting runs.
- Confirm direct table requests to `bi` and `bi_data` from the browser fail, including for administrators.
- Confirm the `bi_agent` role cannot read `public` tables (for example `select * from public.profiles` as `bi_agent` fails).

## Administrator Settings checks

Migration `0049_admin_settings.sql` is the first migration in the odd-number-only
sequence. It adds the Fleet and E-commerce access roles, administrator RPCs for
application access, immutable access-change auditing, administrator-only
campaign-type mutation policies and the final shared workspace-access function.

After the migration and matching frontend are deployed:

- Administrator: confirm **Settings** appears directly below **Apps Dashboard**.
- Non-administrator and signed-out user: confirm Settings is absent and direct
  calls to `admin_list_app_access` and `admin_set_app_access` are denied.
- Open each of the seven application entries and confirm only active employee
  accounts appear under **Who can open this app**.
- Grant and revoke a normal employee's access, refresh that employee's session,
  and confirm the dashboard card and direct workspace entry agree.
- Confirm administrator, management and Sales Manager inherited access is
  labelled and cannot be removed with an individual app toggle.
- Confirm Fleet Management and E-commerce access can be prepared but their app
  cards remain planned and unavailable.
- In Marketing settings, check Facebook, reconnect/select a Page and disconnect.
  Confirm a non-administrator receives `403` from every connection-changing
  endpoint.
- Sign in as a different Marketing user and confirm the same shared Facebook
  Page appears, sync does not duplicate already imported provider posts, and
  publish-now uses the shared Page connection.
- Confirm authenticated browsers cannot select or mutate
  `provider_connections` directly; encrypted provider tokens remain available
  only to the server-side functions.
- Add, reorder and remove an unused campaign type as administrator. Confirm an
  ordinary active user can read campaign types but cannot mutate them directly.
- Confirm `admin_app_access_audit` records each effective grant/revoke with the
  administrator, target profile, application and role.
- Confirm users can still edit their permitted Profile fields but cannot update
  their own `active` state.

## Reporting apps checks

Migration `0048_bi_apps.sql` adds the `report_builder` role, apps (`bi.apps`, `bi.app_tables`, `bi.app_access`, `bi.sheets`), the expression compiler and `public.bi_query`, and lets report builders open the Reporting workspace. User guide: `docs/REPORTING_APPS.md`.

After the migration and the matching frontend are deployed:

- Administrator and report builder: **Reporting → Dashboards** shows **Create app**. Create an app from loaded tables, link them, add master measures, share it with a role, add a sheet with a KPI, bar chart, table and filter pane, and save.
- Click a bar and a filter value: every object on every sheet of the app filters, and the selections bar shows them. Ctrl+click adds values; Clear all resets.
- A user with the shared role (or added by name) sees the app with no edit controls; a user with neither sees no apps, and a direct `bi_query` for that app is denied.
- People added to an app by name see the Reporting card even without a Reporting role, but not the Data catalogue.
- Type an invalid expression (unknown field, missing bracket, an aggregation inside another): the editor explains it and nothing is saved or queried.
- Delete a test app and confirm its sheets are gone and the deletion is in the Audit Log.

## Failure and rollback

- If migration 0035 reports unsupported legacy statuses, stop. Correct the listed records and rerun the migration.
- If a database migration fails, do not deploy the frontend and do not manually mark the migration as applied.
- A Vercel rollback changes frontend code only; it does not reverse Supabase schema changes.
- Database migrations are forward-only. Restore from the confirmed backup or prepare a reviewed corrective migration when database recovery is required.
- Record the deployed Git commit, Vercel deployment and final Supabase migration in the release notes.
