# Smart Stock Control Roadmap

## Current workspace

- Parts Query records with generated date/time and editable part details.
- Multiple suppliers per query, with quantity, cost, MSRP and notes.
- Supplier comparison and cheapest unit-cost calculation.
- Sales-code assignment using active Sales Desk codes.
- Development Status and workflow Status fields.
- Search, filters, side-panel creation, editing, supplier management and deletion.

## Next priorities

| Priority | Capability | Outcome | Status |
|---|---|---|---|
| 1 | Supplier response workflow | Track quote requests and responses | Planned |
| 2 | Stock and availability checks | Compare supplier quotes with inventory | Planned |
| 3 | Approval workflow | Approve queries and supplier selections | Planned |
| 4 | Supplier history | Reuse supplier performance and pricing history | Planned |
| 5 | Reorder recommendations | Turn approved queries into stock actions | Planned |
| 6 | Reporting and exports | Analyze costs, savings and response times | Planned |

## Acceptance direction

A Parts Query can be created without a supplier, then updated with one or more suppliers as quotes arrive. Supplier cost comparisons use cost divided by quantity.


## Wildcard search

Wildcard search is available across part numbers, descriptions, suppliers and sales codes.
