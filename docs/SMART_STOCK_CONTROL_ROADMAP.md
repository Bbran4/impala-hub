# Smart Stock Control Roadmap

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

## Acceptance direction

A Parts Query can be created without a supplier, then updated with one or more suppliers as quotes arrive. Supplier cost comparisons use cost divided by quantity.

Stock Booking acceptance direction:

- A user selects a warehouse From location and an ER or PTA vehicle To location.
- Changing the To vehicle clears all Book quantities and selects the matching supply sort.
- The export carries franchise, source/destination locations, source/destination bins, transfer quantity and comments.
- Location descriptions are display-only and are never included in exported location values.


## Wildcard search

Wildcard search is available across part numbers, descriptions, suppliers and sales codes.
