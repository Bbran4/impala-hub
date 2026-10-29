# Sales Desk transactional commands

Migration `0099_sales_desk_transactions.sql` adds the following database commands. Confirm the connected Supabase GitHub integration has applied it successfully before using the matching frontend.

- `create_sales_desk_rfq`: validates input, allocates a Johannesburg daily number, inserts the RFQ and writes its audit in one transaction. The counter row is locked by an atomic upsert. An insertion/audit failure rolls back the number too. References support more than 99 records per day.
- `claim_sales_desk_rfq`: locks the RFQ, verifies the caller's active sales code and current assignment permission, then assigns it and writes one audit. Two concurrent claimants cannot both win.
- `update_sales_desk_rfq` and `archive_sales_desk_rfq`: lock the current row, enforce ownership/action permissions and editable fields, and write audit records atomically. Salespeople can edit only their own RFQs; identity and attribution fields cannot be supplied by the client.
- `convert_sales_desk_rfq_to_invoice`: locks the source, checks ownership and closed status, creates an invoice with the existing `INV` suffix, and audits both records. Retries return the existing active invoice without duplicate audit events. Invoice copies use the same daily counter so they cannot collide with the existing `(business_date,daily_number)` constraint.
- `reorder_sales_desk_config`: locks the selected configuration table, validates that the complete ID set is supplied once, and applies one set-based update. Invalid/stale input rolls back entirely.
- `sales_desk_configuration`: returns configuration, visible grouped RFQ usage counts and consultant names in one JSON response. Usage includes archived references because they still prevent deletion. No RFQ collection is downloaded to calculate these counts.
- `sales_desk_session_context`: supplies profile/role display metadata, cached in memory for the authenticated session. Concurrent requests share the lookup; a new user/session, sign-out or user update invalidates it. Token refresh does not reload it. Cached role information never authorizes a command: PostgreSQL checks current permissions and ownership for every operation.

Browser writes to RFQs, audit rows and counters are revoked. Audit triggers also cover trusted imports, advance numbering high-water marks and preserve actor names. Audits can only be read for RFQs visible to the caller. Existing SQL dashboard/analytics RPCs from 0095 continue to use Johannesburg dates, ISO weeks and explicit status categories.

Approval requests/decisions, Kanban, bulk actions and exports remain separate work. The existing approval placeholder now reports that no request was sent instead of reporting success without persistence.

Verification includes pgTAP rollback/ownership/audit/count tests and session-cache tests. `scripts/test_sales_desk_concurrency.py` runs against the disposable Supabase Docker database in CI before the database suites. It checks 20 parallel creations, competing claims, concurrent invoice retries and exact audit counts, then removes its fixtures. It refuses to run outside GitHub Actions and never accepts a hosted database URL.
