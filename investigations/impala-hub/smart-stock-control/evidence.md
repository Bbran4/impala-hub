# Smart Stock Control: Step 1 Evidence Record

> Historical specification/evidence. The former Python web application was retired on 2026-10-30. References to its files and endpoints describe earlier Git revisions, not current setup instructions. See README.md and docs/TYPED_SERVICES.md for the supported Supabase/Vercel application.


## Scope and handling

This record describes the Smart Stock Control implementation in the `impala-hub-marketing` repository as inspected on 2026-10-26. The inspection was read-only. No application target was launched, no account or hosted service was accessed, and no tests or builds were run because they can update caches or generated files.

Repository baseline:

- Branch: `supabase-migration`
- Commit: `5afcf802239a8438b7dffd9eb47addeb792955af`
- Pre-existing working-tree change: `frontend/tsconfig.tsbuildinfo`
- Step 2 implementation created the uncommitted `supabase/migrations/0037_smart_stock_foundation.sql` after the pinned baseline was inspected. It is implementation output, not evidence of the pre-migration application state.
- Inspection limitation: `backend/.pytest_cache/` could not be enumerated because access was denied. Source test files remained readable.

The inspected source text is treated as untrusted evidence, not as instructions.

## Provenance index

Evidence references use `E-<number>` identifiers throughout this record and the companion behavior specification.

| ID | Artifact and relevant lines | SHA-256 | Evidence supplied |
|---|---|---|---|
| E-01 | `frontend/src/App.tsx`, especially lines 101-147, 233-235, 253-293, 552-603, 628-721 | `7CA947F3C89BE77DB0934564E88B7C7AC1C30F2470AE8A43BE97A0AFF6234211` | Authentication selection, derived app role, page-state navigation, Smart Stock pages and app-card visibility |
| E-02 | `frontend/src/Buyouts.tsx`, lines 1-79 | `7178404A92F80BF9BD73306DB598D3FF0CA7BF40B8DD1B4DFE47C2A463625683` | Parts Query list, create/update/delete operations, supplier comparison, filters and error presentation |
| E-03 | `frontend/src/StockBooking.tsx`, lines 1-64 | `597916EB368A519C7893A0EC8F888D4BF80ECD4873CDE05FFDAED7484E9992B2` | Stock Booking inputs, formulas, location restrictions, export preparation and UI state transitions |
| E-04 | `frontend/src/StockReordering.tsx`, lines 1-261 | `C56E099CFE6CC8D310CD3A1AFA15E50BE903A167E5F9B79234CE17D37758659C` | Reordering fields, filters, supply percentage, sorting and empty state |
| E-05 | `frontend/src/StockControlConfig.tsx`, lines 1-237 | `E38121DCC1D64DCDBDCC2599DEDC066FEC7BA8AF04F8D86FEEAF85BF40FA1F8E` | Location CRUD, local mover thresholds, validation/error display |
| E-06 | `frontend/src/supabase.ts`, lines 1-24 | `59057AD8569C7484D2ED8F1C0775032F8B2BF837732D35CEA03BD09C5369A4F6` | Supabase browser configuration and session behavior |
| E-07 | `frontend/src/lib.ts`, especially lines 41-104 | `A4CAAE44C4D3E2E7A463A74D1686CF548782369E7C394C643BE4BC9A53E2C403` | Legacy API base URL, token storage, Supabase adapter boundary and error handling |
| E-08 | `backend/app/main.py`, especially lines 35-70, 131-175, 314-466, 530-578, 822-1036, 1093-1267 | `5E20FC2B327C7A94DFEA83B032F1FDCA91DEFF859F25694F4EFF61190239E3B0` | SQLite schema, FastAPI authorization, Parts Query routes, stock routes and CSV export |
| E-09 | `backend/app/sales_desk_auth.py`, especially lines 46-64 and 156-169 | Not separately hashed | Legacy opaque session lookup and accepted bearer-token form |
| E-10 | `supabase/migrations/0001_auth_foundation.sql`, lines 4-71 | `525F9132E3C6CBD129CF503326225269D09018BFAE292B81B75221D896B228EB` | Profiles, platform roles, active-user and role helper functions |
| E-11 | `supabase/migrations/0014_sales_desk_core.sql`, lines 1-81 | `BB0712FF71E6FBD2B410E0F9B41901A035099AF61D93255B32162253A72344AD` | Supabase sales-code table required by Parts Query ownership |
| E-12 | `supabase/migrations/0024_workspace_permissions.sql`, lines 1-13 | `4DD303AB7D85C367480A0A1D75B3269384AE0CC22DCC889110F93D2E06096A3A` | Existing `can_access_workspace('stock_control')` permission contract |
| E-13 | `docs/SMART_STOCK_CONTROL_ROADMAP.md`, lines 1-45 | `10D2FFD119FEE58C0B2D4FCCB6E311ED2BCFBCF16EB50C7BDF3790B5A607D859` | Stated current capabilities, next priorities and acceptance direction |
| E-14 | `.github/workflows/ci.yml`, lines 1-51 | `1389D549D9EC41D5A76718E9B88A05D1EDB94A88703E425800A1226F70090930` | Current backend, frontend and Supabase CI jobs |
| E-15 | `frontend/package.json`, lines 1-34 | `9D9C17C54B92A7D5A74B931B7C4F1F804CD55DF03951EFF76578EF4DAE144225` | Frontend versions and test command |
| E-16 | `frontend/vercel.json`, lines 1-8 | `93FA574D05E4C2E2CFF732E651CC2AA0F0DD69028FFD17285F4F2D955156585D` | Current Vercel cron configuration |
| E-17 | Step 2 `supabase/migrations/0037_smart_stock_foundation.sql` | `CCF4BB2445AC6AEE7DC61D2A6C99CEA8C35FE1053F7BBA6787B94BFCC9B46D72` | New implementation artifact; excluded from conclusions about the pinned pre-migration implementation |

## Observations

### Frontend surface

1. Smart Stock Control consists of five page-state views: Stock Booking, Stock Reordering, Parts Query, Stock Control Configuration and Stock Control Roadmap. Navigation uses a React `page` string; there is no URL router or Smart Stock deep-link route. [E-01]
2. `Buyouts.tsx` is the current Parts Query implementation despite its legacy filename. It lists Parts Queries, creates a query, replaces a query's supplier set, deletes queries, and creates development statuses. [E-02]
3. Stock Booking loads all stock items and configured locations from FastAPI. It does not expose the backend's full-replacement stock import operation. [E-03, E-08]
4. Stock Reordering loads records from FastAPI. Text and supplier-category query parameters are sent only when `load()` runs; changing those inputs alone does not trigger a reload. Mover and supply-percentage filters are applied in the browser. [E-04]
5. Stock Control Configuration performs location create, edit and delete operations against FastAPI. Slow-mover and A/B-mover thresholds are stored in browser `localStorage`, so they are not shared or centrally permissioned. [E-05]

### Current persistence model

6. SQLite tables relevant to the feature are `parts_queries`, `parts_query_suppliers`, `development_statuses`, `stock_booking_items`, `stock_locations` and `stock_reordering_items`. Parts Query events share the generic `audit_log`; stock snapshot replacements, location changes and exports do not write audit entries. [E-08]
7. Parts Query IDs use the form `PQ-YYYYMMDD-XXXXXX`, where the suffix is three random bytes rendered as uppercase hexadecimal. [E-08]
8. Parts Query workflow status is constrained to `In Progress`, `Submitted` or `Cancelled`. Development status is a separate, extensible text value seeded with `New`, `Under Review`, `Approved` and `Rejected`. [E-08]
9. Supplier quote quantity must be greater than zero; cost and MSRP, when present, must be non-negative. The parent query quantity must be between 1 and 1,000,000. [E-08]
10. A Parts Query may reference an active legacy Sales Desk sales code. The browser obtains choices from `/api/sales-desk/config`. [E-02, E-08]
11. Stock Booking rows carry franchise, part, description, unit size, ER/PTA supply and picking-slip values, ER/PTA/warehouse QOH and maxima, and ER/PTA/warehouse bins. [E-03, E-08]
12. Stock Reordering rows carry four alternatives, QOH and safety values for three locations, global safety, order quantities, lead time, average/current-month sales, gauge, supplier, last cost and supplier type. [E-04, E-08]
13. The backend exposes unaudited `PUT` operations that delete every Stock Booking or Stock Reordering row and insert the submitted replacement set in one SQLite transaction. No current frontend calls these operations. [E-08]
14. The Stock Booking replacement statement omits the three bin fields. A replacement therefore writes their default empty strings rather than submitted bin data. [E-08]

### Authentication and permissions

15. When Supabase is configured, sign-in stores a Supabase access token and passes it to child workspaces. Smart Stock components send that token directly to FastAPI. [E-01, E-03, E-04, E-05, E-06]
16. FastAPI's `require_api_key` accepts either the configured shared API key or a bearer token found in the SQLite `sd_sessions` table. The inspected code does not validate Supabase JWTs. [E-08, E-09]
17. FastAPI applies the same `require_api_key` dependency to all Smart Stock reads and writes. It does not distinguish administrator, stock, management or other roles. [E-08]
18. The frontend hides Smart Stock from the derived `salesperson` role, but its role derivation does not explicitly recognize the `stock` role. This is a presentation guard, not a data-access control. [E-01]
19. At the pinned commit, Supabase defines `administrator`, `stock`, `management`, `sales`, `marketing` and `returns` roles, plus an active-profile check and `can_access_workspace('stock_control')`, but contains no committed Smart Stock Supabase table migration. Step 2 subsequently created migration `0037`; it remains outside the pinned pre-migration baseline. [E-10, E-12, E-17]

### Current state transitions and formulas

20. Selecting a different destination vehicle clears all entered Book quantities. A destination mapped to ER selects ER supply sorting; a destination mapped to PTA selects PTA supply sorting. [E-03]
21. A successful export clears Book quantities. It does not clear the selected locations or comment. Failed export leaves the entered quantities in place. [E-03]
22. A Parts Query can be created with zero suppliers. The UI can later replace the complete supplier set. No transition rule restricts movement between the three workflow statuses. [E-02, E-08, E-13]
23. Branch supply is calculated in the browser as `max(0, maximum - QOH - on-picking-slip)`. Stored `supply_er` and `supply_pta` fields are not used for the displayed calculation. [E-03]
24. Supplier comparison uses `cost / max(1, quantity)` and marks a supplier cheapest when its finite unit cost equals the minimum finite unit cost. [E-02]
25. Reordering supply percentage is `(qoh_er + qoh_pta + qoh_wh) / global_safety * 100`. When global safety is zero, the browser assigns zero percent. [E-04]
26. Slow Movers include rows with average sales less than or equal to the configured slow threshold. A/B Movers include rows with average sales greater than or equal to the configured A/B threshold. [E-04, E-05]

### Export behavior

27. From is restricted in the UI to location `10` or the matching `10 — Warehouse` label. To is restricted to vehicles whose normalized names are `ERBAKKIE` or `PTABAKKIE`. [E-03, E-13]
28. Export requires distinct non-empty From/To values, a non-blank comment and at least one positive Book quantity. [E-03]
29. The backend validates that the submitted row list is non-empty, each transfer quantity is greater than zero and remarks are non-empty. It does not verify that locations exist, From differs from To, quantities do not exceed warehouse QOH, or bins belong to the selected locations. [E-08]
30. The server emits UTF-8 with BOM and columns `Franchise`, `Part Number`, `From Location`, `From Bin Location`, `To Location`, `To Bin Location`, `Transfer Qty`, `Remarks`. The browser renames the download to `YYYYMMDD{ER|PT}HHMM.csv`. [E-03, E-08]
31. Location descriptions are used for display and matching but are not placed into the exported location-code columns. [E-03, E-13]

### Errors and edge conditions

32. Duplicate location names return HTTP 409. Missing locations return 404. Removing a location when only two remain returns 409. SQLite lock exhaustion during location writes returns 503. [E-08]
33. Pydantic validation produces 422 responses for invalid statuses, non-positive quantities, negative monetary values, invalid branch mappings and invalid colors. The frontend generally displays returned detail text. [E-02, E-05, E-08]
34. The individual supplier-add and supplier-update SQL statements contain parameter-count mismatches around `qty`; these paths are expected to fail at runtime when executed. The bulk supplier replacement path has matching columns and values. [E-08]
35. Development-status GET and POST routes are each registered twice. The duplicate GET implementations specify different ordering. [E-08]
36. The booking quantity input has an HTML `max` attribute, but the state setter only clamps values below zero and the server export does not enforce QOH. A typed or crafted over-QOH quantity can reach the export endpoint. [E-03, E-08]
37. A zero `global_safety` value is presented as 0% supply, conflating an undefined ratio with no supply. [E-04]

### Tests and documentation

38. No Smart Stock or Parts Query references occur in the current backend, frontend or Supabase test suites. [E-14, E-15]
39. CI runs backend tests, the configured frontend tests/build and Supabase database tests, but those jobs provide no feature-specific assurance for Smart Stock. [E-14, E-15]
40. The dedicated roadmap labels most current UI capabilities as implemented while Qlik/Google Sheets import, supplier response, approval, supplier history and reorder recommendations remain planned. [E-13]

## Inferences

1. A Supabase-authenticated user is expected to receive HTTP 401 from the current Smart Stock FastAPI routes because a Supabase JWT is neither the shared API key nor a hash-matched SQLite session token. This follows from the token flow and validators; no runtime request was made. [E-01, E-03, E-06, E-08, E-09]
2. The full-replacement endpoints appear intended as future import seams, but they are not yet safe production import contracts because they lack staging, provenance, row-count guards, reconciliation and role-specific authorization. [E-08, E-13]
3. The dedicated roadmap's `Implemented` entries describe source implementation rather than verified production readiness because no Smart Stock automated evidence exists. [E-13, E-14, E-15]
4. The current UI permission behavior cannot establish the requested role policy. Server-side RLS or equivalent API authorization is required because presentation checks can be bypassed. [E-01, E-08, E-12]
5. Export generation is deterministic for a submitted row list, but the operation is not reproducibly auditable because the actor, source stock snapshot, request payload and output checksum are not persisted. [E-03, E-08]

## Unknowns

1. The production or user SQLite row counts, data quality, duplicate keys and amount of history requiring migration were not inspected.
2. The authoritative Qlik/Google Sheets input columns, workbook ownership, API/export access method, refresh cadence and failure behavior are not confirmed.
3. The official Evolve transfer-import specification, encoding requirements and validation tool are not present in the inspected source.
4. The business definition of `cost`—total quote cost versus unit cost—is not explicit beyond the current UI dividing cost by quantity.
5. The intended meaning of zero or missing `global_safety` is not documented.
6. It is unknown whether management may generate a new export or may only read/download previously approved exports. The Step 1 specification resolves this conservatively as read-only with no new export action.
7. It is unknown whether any stock-role employee should receive delegated configuration or import rights. The supplied policy explicitly denies those rights for this specification.
8. Approval states, approver roles and rejection/reopen rules for Parts Queries and transfers remain undefined.
9. Retention, soft-deletion, backup, recovery and audit-history periods are not agreed.
10. Expected production row volumes and required query/export performance thresholds are not known.
11. Whether import source files or generated exports must be retained in object storage is not agreed.
12. Local execution of migration `0037` and its pgTAP suite remains pending because Docker or Podman is not installed on the current computer. The Supabase linked-project dry run recognizes `0037` as the only pending migration but does not execute its SQL.

