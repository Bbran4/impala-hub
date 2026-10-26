# Smart Stock Control Roadmap

## Supabase migration status

| Stage | Scope | Status |
|---|---|---|
| 1 | Evidence-backed behavior, permissions and acceptance contract | Implemented; verification pending |
| 2 | Supabase tables, constraints, RLS, actor attribution and audit foundation | Implemented; deployment pending |
| 3 | Parts Query frontend and transactional supplier workflow | Planned |
| 4 | Shared configuration and administrator controls | Planned |
| 5 | Versioned stock-import pipeline | Planned |
| 6 | CSV/XLSX import and validation UI | Planned |
| 7 | Stock Booking, persisted transfer batches and Evolve export | Planned |
| 8 | Stock Reordering and shared calculations | Planned |
| 9 | Google Sheets or Qlik ingestion | Planned |
| 10 | Historical SQLite reconciliation | Planned |
| 11 | Full frontend and database acceptance suite | Planned |
| 12 | Production cutover and retirement of Smart Stock FastAPI routes | Planned |

The foundation is defined in `supabase/migrations/0037_smart_stock_foundation.sql`. It does not switch the current screens away from FastAPI. That cutover begins with Parts Queries in stage 3 after the migration is applied and verified.

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
- Configurable From/To locations with optional descriptions, vehicles, branch mappings and highlight colors.
- From restricted to `10 — Warehouse`; To restricted to `ERBAKKIE` and `PTABAKKIE`.
- Calculated branch supply values: `Max - QOH - On Picking Slip`, with descending ER/PT supply sorting.
- Stock-state highlighting for picking slips, warehouse shortages and branch/warehouse comparisons.
- Franchise and bin-aware picking-list export with toolbar comments and date/branch/time filenames.

## Next priorities

| Priority | Capability | Outcome | Status |
|---|---|---|---|
| 1 | Qlik/Google Sheets stock import | Refresh stock data without manual API entry | Planned |
| 2 | Evolve picking-list export | Export franchise, locations, bins, quantities and comments using the supplied transfer format | Implemented |
| 3 | Supplier response workflow | Track quote requests and responses | Planned |
| 4 | Approval workflow | Approve queries and supplier selections | Planned |
| 5 | Supplier history | Reuse supplier performance and pricing history | Planned |
| 6 | Reorder recommendations | Turn approved queries into stock actions | Planned |

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
