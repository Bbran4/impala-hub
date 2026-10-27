# Smart Stock Control Roadmap

## Supabase migration status

| Stage | Scope | Status |
|---|---|---|
| 1 | Evidence-backed behavior, permissions and acceptance contract | Implemented; verification pending |
| 2 | Supabase tables, constraints, RLS, actor attribution and audit foundation | Implemented; deployment pending |
| 3 | Parts Query frontend and transactional supplier workflow | Implemented; deployment pending |
| 4 | Shared configuration and administrator controls | Implemented; deployment pending |
| 5 | Versioned stock-import pipeline | Implemented; deployment pending |
| 6 | CSV/XLSX import and validation UI | Implemented; deployment pending |
| 7 | Stock Booking, persisted transfer batches and Evolve export | Implemented; deployment pending |
| 8 | Stock Reordering and shared calculations | Implemented; deployment pending |
| 9 | Automated Google Sheets ingestion and replaceable source adapter | Implemented; deployment pending |
| 10 | Historical SQLite reconciliation | Planned |
| 11 | Full frontend and database acceptance suite | Planned |
| 12 | Production cutover and retirement of Smart Stock FastAPI routes | Planned |

The foundation is defined in `supabase/migrations/0037_smart_stock_foundation.sql`. It does not switch the current screens away from FastAPI. That cutover begins with Parts Queries in stage 3 after the migration is applied and verified.

Stage 3 is defined in `supabase/migrations/0038_smart_stock_parts_queries.sql` and the `PartsQueries` frontend. It moves Parts Query reads, atomic create/update with complete supplier replacement, audited archival, active Sales Code selection, role-aware editing and named history to Supabase.

Stage 4 is defined in `supabase/migrations/0039_smart_stock_configuration.sql` and the `StockConfiguration` frontend. Locations, shared mover thresholds and Parts Query Development Statuses now load from Supabase. Administrator-only database functions perform all changes, audit triggers retain the history, used statuses must be deactivated instead of deleted, and at least two locations must remain active. Stages 7 and 8 now consume this shared configuration directly.

Stage 5 is defined in `supabase/migrations/0040_smart_stock_import_pipeline.sql`. It adds administrator-only, chunked staging functions for Booking and Reordering rows, database-derived row counts and branch supply, SHA-256 source identity, retained validation diagnostics, semantic import audit events and serialized transactional activation. A new valid snapshot supersedes the previous active version in the same database transaction; validation or activation failure leaves the previous version active. The short-lived `validating` and `committing` states from the behavior specification are transaction-internal rather than externally visible, so clients see only `staged`, `validated`, `active`, `rejected` or `superseded`.

Stage 6 adds the administrator-only `Stock Data Import` screen. It reads UTF-8 CSV/TSV and XLSX files locally, selects matching worksheets, auto-maps known headers, allows explicit mapping corrections, blocks Excel formulas and unsafe formula-like text, validates database precision and duplicate part/franchise keys, previews a bounded sample, hashes the exact file pair and uploads sequential chunks to the Stage 5 pipeline. Staging/validation and activation remain separate confirmations. Rejected attempts remain auditable and may be retried with the same source checksum through `supabase/migrations/0041_stock_import_retry_support.sql`.

The import requires one Booking dataset and one Reordering dataset. Use either two CSV/TSV files or two XLSX files; a single XLSX workbook may be selected twice when it contains matching Booking and Reordering worksheets. Source mappings are documented in `docs/SMART_STOCK_IMPORT_FORMAT.md`. Background Google Sheets/Qlik execution and its service-job actor model remain Stage 9.

Stage 7 is defined in `supabase/migrations/0042_stock_booking_transfers.sql` and the Supabase Stock Booking frontend. The workspace reads only the active import snapshot and active location configuration. Stock operators and administrators can save a warehouse-to-ER/PTA transfer through one database function that validates the active snapshot, destination, whole-number quantity and remaining warehouse availability across earlier exports from that snapshot. Transfer creation is serialized to prevent concurrent overbooking. Every transfer receives a concurrent-safe `ST-` reference, retains its source and destination bins, appears in export history, can be downloaded again and writes an audit event before the browser downloads the Excel-compatible Evolve CSV. Management remains read-only and direct browser writes are denied.

Stage 8 is defined in `supabase/migrations/0043_stock_reordering_workspace.sql` and the Supabase Stock Reordering frontend. A security-invoker database view selects only the active snapshot and calculates supply percentage plus inclusive slow-mover and A&B-mover flags from the shared thresholds. The frontend loads large snapshots in bounded pages, searches parts, descriptions, suppliers and alternative numbers, retains supplier/mover/supply filters and performs stable numeric sorting. Visible results are paginated to keep the browser responsive. Signed-out, inactive, Sales and unrelated roles remain outside the underlying Row Level Security boundary.

Stage 9 is defined in `supabase/migrations/0044_stock_ingestion_sources.sql`, the Vercel `/api/stock/ingestion/sync` function and the automated-source controls on **Stock Data Import**. The first adapter reads a private Google Sheet through a read-only Google service account, detects formulas, applies the same mapping and row validation as manual imports, computes a deterministic content checksum and uploads both datasets through service-only wrappers around the existing Stage 5 pipeline. Manual and daily scheduled runs are claimed per source to prevent overlap, retain sanitized run history and finish at `validated`; activation remains a separate administrator decision. Provider credentials remain server-only. The adapter contract is intentionally source-neutral so a later Qlik or ERP/ODBC extractor can produce the same canonical Booking/Reordering envelope without writing snapshot tables directly.

### Permission contract

- Administrators have full operational, configuration and import access.
- Stock users can operate Parts Queries and, in later stages, create validated booking exports. They cannot change shared configuration or replace stock snapshots.
- Management users have read-only access.
- Salesperson and unrelated workspace roles cannot access Smart Stock data.
- Inactive and signed-out users have no access.

These rules are enforced through Supabase Row Level Security. Frontend visibility is a usability measure, not the security boundary.

### Foundation data contract

- Parts Queries use a UUID internally and receive a concurrent-safe human reference beginning with `PQ-`.
- Query deletion is an audited archive; physical deletion is not available to browser users.
- Supplier quantity, cost, MSRP and notes are stored as query children and retain actor/timestamp information.
- Stock imports are versioned batches with source, checksum, row counts, validation results and activation state.
- Browser clients upload no more than 2,000 rows per staging call; the frontend helper defaults to 500-row chunks.
- Every import requires both Booking and Reordering rows and a 64-character SHA-256 checksum.
- Booking branch supply is derived during staging as `max(0, Max - QOH - On Picking Slip)` rather than trusting a supplied value.
- Booking and reordering rows always belong to an import batch, allowing a failed import to leave the current snapshot unchanged.
- Reordering thresholds are shared database settings rather than per-browser values.
- Locations can be deactivated later without erasing historical references.
- Stock audit rows are written by database triggers and cannot be forged by browser clients.

## Current workspace

- Parts Query records with generated date/time and editable part details.
- Multiple suppliers per query, with quantity, cost, MSRP and notes.
- Supplier comparison and cheapest unit-cost calculation.
- Sales-code assignment using active Sales Desk codes.
- Development Status and workflow Status fields.
- Search, filters, side-panel creation, editing, supplier management and deletion.
- Stock Booking workspace with branch stock comparison and one Book quantity per part.
- Stock Reordering workspace with franchise, alternatives, branch/warehouse QOH, safety stock, sales, supplier and reorder metrics.
- Stock Reordering filters for supplier, part number, description, alternative number and supplier category.
- Supabase-backed administrator configuration for locations, optional descriptions, vehicles, branch mappings, highlight colors, mover thresholds and Parts Query Development Statuses.
- From restricted to `10 — Warehouse`; To restricted to `ERBAKKIE` and `PTABAKKIE`.
- Calculated branch supply values: `Max - QOH - On Picking Slip`, with descending ER/PT supply sorting.
- Stock-state highlighting for picking slips, warehouse shortages and branch/warehouse comparisons.
- Franchise and bin-aware picking-list export with toolbar comments and date/branch/time filenames.

## Next priorities

| Priority | Capability | Outcome | Status |
|---|---|---|---|
| 1 | Private Google Sheets stock ingestion | Refresh and validate stock data without browser file uploads | Implemented |
| 2 | Evolve picking-list export | Export franchise, locations, bins, quantities and comments using the supplied transfer format | Implemented |
| 3 | Supplier response workflow | Track quote requests and responses | Planned |
| 4 | Approval workflow | Approve queries and supplier selections | Planned |
| 5 | Supplier history | Reuse supplier performance and pricing history | Planned |
| 6 | Qlik/ERP ODBC source adapter | Replace the pilot Sheet extractor without changing the snapshot pipeline | Planned |
| 7 | Reorder recommendations | Turn approved queries into stock actions | Planned |

Feature expansion remains behind migration parity. Supplier response, approval, supplier-history and recommendation work starts only after the existing Parts Query, Booking and Reordering workflows have passed the Supabase cutover checks.

## Acceptance direction

A Parts Query can be created without a supplier, then updated with one or more suppliers as quotes arrive. Supplier cost comparisons use cost divided by quantity.

Stock Booking acceptance direction:

- A user selects a warehouse From location and an ER or PTA vehicle To location.
- Changing the To vehicle clears all Book quantities and selects the matching supply sort.
- The export carries franchise, source/destination locations, source/destination bins, transfer quantity and comments.
- Location descriptions are display-only and are never included in exported location values.


## Wildcard search

Wildcard search is available across part numbers, descriptions, suppliers and sales codes.
