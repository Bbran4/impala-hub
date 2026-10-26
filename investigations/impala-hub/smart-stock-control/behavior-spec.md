# Smart Stock Control: Step 1 Behavior Specification

## Status and intent

This is an evidence-derived behavior specification for preserving the current Smart Stock Control feature while preparing an independently testable Supabase/Vercel migration. It specifies current behavior unless a section is explicitly labelled **Required policy** or **Acceptance requirement**.

Evidence identifiers refer to `evidence.md` in this directory. Unknown business decisions are not silently converted into requirements.

## Feature boundary

In scope:

- Parts Query records and supplier quotes
- Stock Booking stock comparison, quantity entry and picking-list export
- Stock Reordering display, search, filters and sorting
- Stock location configuration
- Reordering threshold configuration
- Authentication and authorization behavior for these surfaces
- Import and export boundaries needed to preserve the current behavior

Out of scope for Step 1:

- Writing to Evolve or another external operational system
- Implementing Qlik, Google Sheets or Evolve connectivity
- Approval, supplier-response or supplier-history workflows that do not yet have agreed states
- Code, database migrations or deployment changes

## Required permission policy

This matrix supersedes the current UI-only behavior as the acceptance policy for a migration. Enforcement must occur at the data/API boundary, not only in the frontend.

| Capability | Administrator | Stock | Management | Salesperson | Other authenticated | Signed out |
|---|---:|---:|---:|---:|---:|---:|
| Open Smart Stock workspace | Allow | Allow | Allow | Deny | Deny | Deny |
| Read Parts Queries and supplier quotes | Allow | Allow | Allow | Deny | Deny | Deny |
| Create/edit/archive Parts Queries and quotes | Allow | Allow | Deny | Deny | Deny | Deny |
| Read Stock Booking and Reordering data | Allow | Allow | Allow | Deny | Deny | Deny |
| Enter Book quantities locally | Allow | Allow | View-only | Deny | Deny | Deny |
| Generate a new transfer export | Allow | Allow | Deny | Deny | Deny | Deny |
| Read prior export records | Allow | Allow | Allow | Deny | Deny | Deny |
| Create/edit/delete locations | Allow | Deny | Deny | Deny | Deny | Deny |
| Change shared mover thresholds | Allow | Deny | Deny | Deny | Deny | Deny |
| Start, validate, commit or roll back an import | Allow | Deny | Deny | Deny | Deny | Deny |
| Read import status and last-refresh metadata | Allow | Allow | Allow | Deny | Deny | Deny |

Required authorization conditions:

1. The user must have an active profile.
2. Administrator access is full within the feature boundary.
3. Stock access is operational: records, booking and export are allowed; configuration and import are denied.
4. Management access is read-only. A management user cannot create an export because that would create an auditable business action.
5. Salesperson, any unmatched role, inactive users and signed-out users are denied.
6. A denied direct table, REST or RPC request must remain denied even if the frontend route is manually entered.

Current implementation does not satisfy this policy. [E-01, E-08, E-10, E-12]

## Logical records and invariants

### Parts Query

A Parts Query contains:

- Stable identifier and human-readable reference
- Creation timestamp
- Part number and description
- Requested quantity greater than zero
- Optional active sales-code assignment
- Development status
- Workflow status: `In Progress`, `Submitted` or `Cancelled`
- Zero or more supplier quotes
- Actor and audit metadata in a migrated system

Supplier quote fields:

- Stable identifier and parent query identifier
- Supplier name
- Quantity greater than zero
- Optional cost greater than or equal to zero
- Optional MSRP greater than or equal to zero
- Notes

Current behavior permits any transition among workflow statuses and permits arbitrary non-empty development-status values. No additional transition restriction may be invented without a business decision. [E-02, E-08]

### Stock Booking item

A booking item contains franchise, part identifiers, unit size, branch and warehouse QOH/maxima, branch picking-slip quantities, and ER/PTA/warehouse bins. Values used for export must come from one identifiable stock snapshot in a migrated system. A replacement import must preserve bin fields. [E-03, E-08]

### Stock Reordering item

A reordering item contains part identifiers and alternatives, branch and warehouse QOH/safety values, global safety, order quantities, sales measures, lead time, gauge, supplier, last cost and supplier type. The migration may normalize or derive fields internally, but displayed and exported results must remain reproducible from retained inputs. [E-04, E-08]

### Location

A location has a unique non-empty code/name, optional display description, optional vehicle name, optional supply mapping of blank/ER/PTA, and a six-digit hexadecimal color. At least two locations must remain configured under current behavior. [E-05, E-08]

### Shared thresholds

The slow threshold and A/B threshold must be centrally stored for a migrated multi-user system. Only administrators may change them; stock and management users may read them. Current browser-local values default to `2` and `10`. [E-04, E-05]

## Current formulas

### Branch supply

For branch `b`:

```text
supply_b = max(0, max_b - qoh_b - on_picking_slip_b)
```

Example:

```text
max_er = 10
qoh_er = 4
on_picking_slip_er = 2
supply_er = max(0, 10 - 4 - 2) = 4
```

If `max_er=3`, `qoh_er=4` and `on_picking_slip_er=2`, the result is `0`, not `-3`. [E-03]

### Supplier unit cost

```text
unit_cost = cost / max(1, quote_quantity)
```

Quotes with non-finite calculated values are excluded. Every quote tied for the minimum finite unit cost is eligible for cheapest highlighting. [E-02]

Example:

```text
Supplier A: cost 300, quantity 3 → unit cost 100
Supplier B: cost 120, quantity 1 → unit cost 120
Expected cheapest supplier: A
```

### Reordering supply percentage

When `global_safety` is non-zero:

```text
supply_percent = (qoh_er + qoh_pta + qoh_wh) / global_safety * 100
```

Example: `(10 + 15 + 25) / 100 * 100 = 50.0%`.

Current behavior returns `0.0%` when `global_safety` is zero. This behavior must be preserved only until the unknown semantic meaning is resolved; the acceptance suite must make the chosen zero-denominator display explicit. [E-04]

### Mover filters

```text
Slow Movers: avg_sales <= slow_threshold
A&B Movers: avg_sales >= ab_threshold
Supply 25% or less: supply_percent <= 25
Supply 50% or less: supply_percent <= 50
```

Boundary values are included. [E-04, E-05]

## State transitions

### Authentication and workspace access

```text
signed out
  -- successful active administrator/stock/management sign-in --> workspace eligible
  -- successful but unauthorized-role sign-in ----------------> workspace denied

workspace eligible
  -- session expires, sign-out, profile deactivation ----------> signed out/denied
```

The frontend must not display protected Smart Stock data while authorization is unresolved.

### Parts Query lifecycle

Current allowed behavior:

```text
create → In Progress | Submitted | Cancelled
In Progress ↔ Submitted
In Progress ↔ Cancelled
Submitted ↔ Cancelled
any state → hard delete (current implementation)
```

The migrated acceptance target should replace hard deletion with archival so that actor and history remain available, but archive/reopen permissions beyond the supplied role matrix require confirmation. Supplier quotes may be added at creation or replaced later. [E-02, E-08, E-13]

### Booking interaction

```text
no destination
  -- choose ERBAKKIE --> clear entered quantities; select ER supply sort
  -- choose PTABAKKIE --> clear entered quantities; select PTA supply sort

destination selected
  -- change destination --> clear all entered quantities; select new branch sort
  -- export succeeds ----> download file; clear quantities; retain locations/comment
  -- export fails --------> retain quantities and selections; show error
```

[E-03]

### Snapshot import

Current backend behavior is one transaction:

```text
submitted replacement rows → delete current rows → insert submitted rows → commit
database/validation failure → rollback transaction
```

Acceptance requirement for migration:

```text
received → validating → rejected
                     \→ validated → committing → committed
                                             \→ failed (previous snapshot remains active)
```

Only an administrator may initiate or commit this transition. Every terminal state must retain actor/job, source, timestamps, checksum, row counts and validation messages.

## Input/output behavior

### Parts Query create example

Input:

```json
{
  "part_number": "ABC-123",
  "description": "Brake pad set",
  "qty": 4,
  "sales_code_id": null,
  "development_status": "New",
  "status": "In Progress",
  "suppliers": []
}
```

Expected behavior:

- Administrator or stock user: create one query with zero supplier children and a creation audit event.
- Management or denied actor: no row or audit event is created.
- Missing part number, missing description or `qty <= 0`: reject the complete operation.

### Supplier comparison example

Input quotes:

```json
[
  {"supplier":"A","qty":3,"cost":300,"msrp":450,"notes":""},
  {"supplier":"B","qty":1,"cost":120,"msrp":170,"notes":""}
]
```

Expected output: A has unit cost `100.00`, B has `120.00`, and A is cheapest.

### Stock Booking export example

Input:

```json
[
  {
    "franchise": "generic",
    "part_number": "33215",
    "from_location": "10",
    "from_bin_location": "s3-04-25",
    "to_location": "ERBAKKIE",
    "to_bin_location": "er14",
    "transfer_qty": 2,
    "remarks": "Branch replenishment"
  }
]
```

Expected logical CSV:

```csv
Franchise,Part Number,From Location,From Bin Location,To Location,To Bin Location,Transfer Qty,Remarks
generic,33215,10,s3-04-25,ERBAKKIE,er14,2,Branch replenishment
```

Current encoding is UTF-8 with BOM. For an ER destination at local time 2026-10-26 14:05, the browser filename is `20261026ER1405.csv`. Location descriptions must not replace location codes. [E-03, E-08, E-13]

## Search, filter and sort behavior

1. Parts Query wildcard-style free text is implemented as case-insensitive substring matching over query ID, part number, description, sales code, development status, workflow status, supplier names and supplier notes. Development/workflow dropdown filters require equality. [E-02]
2. Stock Booking search is case-insensitive substring matching over part number and description. Default order is part number. ER/PTA supply sorts exclude zero-supply rows and sort descending. [E-03]
3. Stock Reordering server search covers part number, description, supplier and four alternative numbers. Supplier type is an equality filter ignoring case. [E-04, E-08]
4. Reordering column sorting compares string representations using numeric-aware locale comparison. A migration must test numeric columns explicitly before claiming exact sorting parity. [E-04]
5. An empty result displays an empty-state message rather than an error. [E-02, E-03, E-04]

## Validation, errors and edge cases

### Authorization

- Missing, expired or invalid session: deny without returning feature rows.
- Active but unauthorized role: deny direct and UI requests.
- A denied mutation must not create data, audit events, import artifacts or export batches.

### Parts Query

- Reject empty part number or description.
- Reject parent or supplier quantities less than one.
- Reject negative cost or MSRP.
- Reject assignment to an inactive/nonexistent sales code.
- Permit creation with no suppliers.
- Supplier replacement must be atomic: an invalid submitted supplier must leave the previous complete supplier set unchanged.
- Concurrent human-reference creation must not produce duplicates.
- Missing query or supplier identifiers return a not-found outcome without mutating another parent.

### Locations and configuration

- Reject blank or duplicate location names.
- Accept supply mapping only as blank, `er` or `pta`.
- Accept colors only in `#RRGGBB` form.
- Preserve the current minimum of two configured locations unless the business changes that rule.
- Stock and management actors must be denied all configuration mutations under the required matrix.

### Booking and export

- Reject missing or identical From/To locations.
- Reject destinations outside the configured ERBAKKIE/PTABAKKIE policy.
- Reject blank comments and an empty selected-row set.
- Reject zero, negative, fractional where integer is required, or over-available transfer quantities.
- Reject unknown part/location/bin combinations rather than trusting browser-supplied labels.
- Escape and quote CSV fields according to the approved Evolve format; text beginning with spreadsheet formula markers must not become an executable formula if the file may be opened in spreadsheet software.
- A generation failure must retain the user's quantities and must not record a successful export.
- A retry must have an explicit idempotency rule so one user action cannot create duplicate transfer batches.

### Imports

- Reject missing required columns, duplicate row identifiers, invalid numeric values, unsupported locations and malformed source timestamps.
- Detect and require explicit administrator confirmation for material row-count reductions; the exact threshold is unknown.
- A rejected or failed import must leave the prior active snapshot unchanged.
- Booking and reordering rows from different source snapshots must not be silently combined.

### Formula edges

- Negative branch supply clamps to zero.
- Threshold boundary values are included.
- Tied cheapest finite supplier unit costs may all be highlighted.
- The zero-global-safety presentation requires a business decision; tests must prevent an unnoticed semantic change.

## Acceptance criteria and examples

### AC-01: Role enforcement

For each actor in the permission matrix, exercise the UI route and direct data/RPC calls. Observed results must exactly match every Allow/Deny cell. Inactive profiles are denied regardless of assigned roles.

### AC-02: Parts Query atomic creation

Given the create example above, an administrator and stock user each can create a query. Each successful transaction creates one parent, the submitted children and one actor-attributed audit event. A management request and a request containing `qty=0` create nothing.

### AC-03: Supplier replacement rollback

Given an existing query with suppliers A and B, submit a replacement containing valid A and invalid quantity-zero C. The operation is rejected and both original A and B remain unchanged.

### AC-04: Status compatibility

Create one query in each current workflow status and transition each to both other statuses. Until an approval workflow is agreed, every transition succeeds for administrator/stock actors and is audited; management and denied actors cannot transition records.

### AC-05: Supply calculation

The formula examples in this specification produce `4` and `0` respectively in UI and independently executed test logic.

### AC-06: Reordering calculations and boundaries

- QOH `10/15/25`, global safety `100` displays `50.0%`.
- Average sales exactly equal to the slow threshold appears in Slow Movers.
- Average sales exactly equal to the A/B threshold appears in A/B Movers.
- A supply value exactly `25%` appears under both the 25%-or-less and 50%-or-less filters.

### AC-07: Destination transition

Enter Book quantities, select ERBAKKIE, then change to PTABAKKIE. All quantities become empty/zero and PTA supply sorting becomes active. No export record is created by this UI-only transition.

### AC-08: Canonical export

The export example produces the specified column order, values, encoding and filename rule. Description text does not enter location-code fields. The saved export record identifies actor, snapshot, lines, output checksum and creation time.

### AC-09: Export rejection

Each of these independently produces no file and no successful export record: same From/To, blank comment, no selected rows, quantity zero, quantity above permitted availability, unknown part, unknown location, mismatched bin and unauthorized actor.

### AC-10: Import isolation

Load a valid baseline snapshot. Attempt an import with a duplicate part key halfway through its rows. The import is marked rejected/failed with diagnostics, and every baseline query result remains byte-for-byte equivalent to the pre-import active snapshot.

### AC-11: Bin preservation

Import a row with ER, PTA and warehouse bins, promote it, then retrieve it for booking and export. All three bin values match the source; none becomes an empty default.

### AC-12: Shared configuration

An administrator changes the slow threshold from `2` to `3`. A new session for a stock user and a management user reads `3`; neither can update it. A salesperson cannot read it through the Smart Stock data boundary.

### AC-13: Search parity

Seed a query whose supplier note contains a unique mixed-case token. Case-insensitive Parts Query search finds it. Seed a reordering row where the token appears only in `alt_4`; server search finds it. Searches returning no rows show the expected empty state.

### AC-14: Audit and provenance

Create, edit and archive a Parts Query; change suppliers; commit an import; generate an export; and change shared configuration. Every permitted material event records the authenticated actor or server job, timestamp, action and meaningful changed-field/source details. Browser clients cannot forge actor fields or directly insert audit events.

### AC-15: Automated verification gate

CI includes feature-specific database policy tests, RPC/transaction tests, formula and export tests, frontend route/permission tests and a production frontend build. A feature remains Implemented rather than Verified until this suite and the authorized Evolve-format acceptance check pass.

## Open decisions blocking a final migration contract

1. Confirm the official source schema and supported method for Qlik/Google Sheets/Evolve reads.
2. Obtain the official Evolve import format and validation process.
3. Decide how zero `global_safety` is displayed and filtered.
4. Decide whether `cost` is a total quote cost or already a unit cost.
5. Define approval, rejection, reopening and archival states.
6. Define material import row-count thresholds and reconciliation tolerances.
7. Define storage and retention requirements for source files and generated exports.
8. Define expected row volumes and response/export performance targets.

