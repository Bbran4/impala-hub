# Sales Desk: RFQs

## Scope and architectural fit

The first Sales Desk release is the RFQ workspace only. It remains inside the existing Impala Hub application shell and uses the current FastAPI backend, SQLite database/migration approach, React + TypeScript frontend, and shared configuration/navigation conventions. Do not create a separate application or replace the marketing workspace.

This is an implementation specification and acceptance checklist. The RFQ feature is not considered implemented until its backend, UI, permission enforcement, migrations, and automated tests are merged and verified.

## Roles and access control

- **Administrator:** maintain media-platform options, sales codes and statuses; view all RFQs; assign or reassign RFQs; edit records as permitted.
- **Manager:** view all RFQs and filter by status or sales code. Manager edit/reassignment rights should be explicit in the role policy rather than inferred from visibility.
- **Salesperson:** view only RFQs assigned to their own configured sales code; claim an unclaimed RFQ for themselves; update permitted fields on their own RFQs.
- A salesperson must never be able to claim on behalf of another salesperson or change their own role/sales-code mapping through an RFQ request.
- Enforce these rules in the API on every request, not only by hiding UI controls.

### Authentication prerequisite and implementation status

The existing application authenticates Marketing API requests using a shared API key. A shared key cannot identify an individual employee or reliably distinguish administrator, manager and salesperson roles.

**Phase 1 work in progress:** a separate Sales Desk authentication surface now provides password-based sign-in, opaque server-side bearer sessions, session revocation, a current-user endpoint, administrator-only user listing/provisioning, and the three explicit roles. Passwords are stored as salted scrypt hashes; session tokens are stored as SHA-256 hashes and expire after 12 hours. Existing Marketing endpoints continue using the current shared-key mechanism.

Configure `RFQ_BOOTSTRAP_ADMIN_USERNAME` and `RFQ_BOOTSTRAP_ADMIN_PASSWORD` in the backend environment before the first startup to create the initial administrator. The password must be at least 14 characters. Bootstrap only runs when the Sales Desk user table is empty and does not reset existing accounts. Keep these values secret and remove them from deployment configuration after initial setup. For local recovery when an account already exists or bootstrap credentials were omitted, stop the backend and run `python -m app.sales_desk_admin` from the `backend` directory. This interactive local command creates or resets/promotes the chosen account to administrator and revokes its existing sessions; it is not available over HTTP.

The identity foundation is not production-complete until tests run in CI and the user-to-configured-sales-code relationship is enforced against the Phase 3 configuration table. Do not trust role, user ID or sales code supplied by the browser.

## RFQ data

Required fields:

- Immutable RFQ number, generated as `IMPYYMMDDNN` using the Africa/Johannesburg business date, for example `IMP26101901`.
- Media platform, customer name, contact number, email address, query information.
- Assigned sales code (nullable while unclaimed), claimed timestamp (nullable while unclaimed), received timestamp.
- Remarks, configurable status, document number (optional).
- Created/updated timestamps and audit history.

Use a database-enforced unique RFQ number and transaction-safe daily sequence generation. Concurrent RFQ creation must not issue duplicate references. A reference must never change after creation. Store timestamps in UTC and display them in the configured business timezone. Received time should be captured by the system for manually created records; future channel integrations may supply a provider-received timestamp while preserving the original ingestion timestamp.

## Configuration

Provide a Sales Desk configuration area for:
1. Media platforms: add, edit, reorder and deactivate.
2. Sales codes: code, display name, linked employee account, active/inactive.
3. RFQ statuses: label, order, active/inactive and an explicit open/closed classification used by dashboard totals.

Seed reasonable initial media options (Facebook, WhatsApp, Email, Telephone, Walk-in) and suggested statuses (New, In Progress, Awaiting Customer, Quotation Issued, Converted to Sale, Lost, Closed), but allow administrators to change them. Do not hard-delete options referenced by existing RFQs; deactivate them instead. Validate that newly assigned codes and newly selected options are active.

## RFQ workspace

- Default view: all unclaimed RFQs, oldest received first.
- Dashboard totals: unclaimed, claimed, received today and open. Counts must be calculated from persisted records and follow the viewer's access scope.
- Filters: status and sales code can be combined. Search by RFQ number, customer name and document number. Support sorting by received time and useful pagination.
- Create and edit RFQ details using validation and clear error messages.
- Detail view displays all fields, timestamps and assignment/status history.
- Claim action assigns the authenticated salesperson's configured sales code and atomically records the claimed timestamp.
- A conditional database update or transaction must ensure that two users cannot claim the same RFQ. The losing request receives a conflict response and refreshes the record.
- Only administrators may assign or reassign a sales code. Reassignment retains the original claim information in audit history; do not silently overwrite historical events.
- Preserve closed and historical records for search and reporting.

## Suggested API boundary

Implement endpoints under the existing `/api` namespace, with the existing API conventions and role-aware authorization dependencies:

- `GET /api/rfqs` with search, status, sales-code, unclaimed and pagination filters.
- `POST /api/rfqs` to create a record and generate its immutable number.
- `GET /api/rfqs/{rfq_id}` to read a record subject to access scope.
- `PATCH /api/rfqs/{rfq_id}` for permitted record updates.
- `POST /api/rfqs/{rfq_id}/claim` to claim for the authenticated salesperson only.
- `POST /api/rfqs/{rfq_id}/assign` for administrator-only assignment/reassignment.
- `GET /api/rfqs/dashboard` for scope-aware summary totals.
- `GET/POST/PATCH` endpoints under `/api/rfqs/config/platforms`, `/sales-codes` and `/statuses`, restricted to administrators.

Keep the API implementation in the existing FastAPI application and share its database connection, migration, validation, error and audit conventions. Endpoint names are proposed contracts and may be adjusted to match existing naming patterns during implementation.

## UI placement

Inside the existing Apps Dashboard, Sales Desk opens its own workspace navigation. For the initial release it contains:
- RFQs
- RFQ Configuration (administrator only)

Do not expose Marketing navigation items while the user is in the Apps Dashboard or Sales Desk. Preserve the existing Marketing workspace and its routes.

## Milestones and acceptance criteria

1. **Identity and permissions:** authenticated employee identity, administrator/manager/salesperson roles and salesperson-to-sales-code mapping; API tests prove cross-user access is denied.
2. **Persistence and numbering:** schema migration, RFQ model, validation, audit events, unique date-based reference and concurrency tests.
3. **Configuration:** manageable platforms, sales codes and statuses; historical references remain valid after deactivation.
4. **RFQ workspace:** unclaimed-first list, creation/detail/edit screens, combined filters, search, sorting and pagination.
5. **Claim/assignment:** salesperson can claim only for self; administrator alone can assign/reassign; atomic claim conflict protection and audit history.
6. **Dashboard:** persisted scope-aware totals for unclaimed, claimed, received today and open.
7. **Verification:** backend tests, frontend production build, role/access tests, migration tests, concurrent-claim tests and manual end-to-end checks before merge.

## Out of scope for this first release

Automatic ingestion from Facebook, WhatsApp, email or website forms; quotation generation; direct Evolve DMS writes; and other Sales Desk modules. These can be integrated later through supported interfaces without changing RFQ ownership rules.


## Delivery status

- [x] Phase 1 foundation: Sales Desk user/session schema, password login/logout, current-user endpoint, administrator-only user provisioning and role validation added on the feature branch.
- [x] Phase 1 code: Sales Desk sign-in is available in the frontend; salesperson accounts must reference an active configured sales-code record.
- [x] Phase 2 implementation: RFQ schema, unique daily reference allocation using an immediate SQLite write transaction, Johannesburg business-date numbering, record endpoints, and audit history.
- [ ] Verification: run the automated backend tests and frontend build, including concurrent RFQ creation tests. Code has been committed but is not yet verified by a CI run.
- [ ] Phase 3: configurable media platforms, sales codes and statuses.
- [ ] Phase 4: RFQ queue, filters, search, detail and editing.
- [ ] Phase 5: self-claiming, administrator assignment and concurrent-claim protection.
- [ ] Phase 6: live dashboard totals, permission tests, concurrency tests and regression verification.
