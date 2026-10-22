# Sales Desk Roadmap

Updated: 2026-10-21

## Current review

Implemented today:

- Impala Hub authentication with persistent sessions and logout.
- Administrator, manager, and salesperson roles.
- Sales-code assignment for sales consultants.
- Visibility rules for personal RFQs, team RFQs, and unclaimed RFQs.
- RFQ creation, editing, claiming, assignment, status changes, and audit history.
- Configurable media platforms, sales codes, and statuses.
- Attachments with download support and deletion protection.
- RFQ numbering and quotation-to-invoice conversion foundations.
- Sales Desk dashboard with team metrics.
- RFQ analytics with period filters and charts.
- Drag-and-drop ordering for configuration items.
- Send for Approval action on existing RFQs when the document number, attachment and Complete status requirements are met; RFQ administrators receive an approval notification.

## Improvement roadmap

1. Add a dedicated RFQ Kanban with drag-and-drop status changes.
2. Add bulk actions for assignment, claiming, status changes, and export.
3. Add saved filters and advanced search by customer, salesperson, source, status, and date.
4. Add notification bell for new/unclaimed RFQs, reassignment, overdue work, and status changes.
5. Add SLA timers, overdue indicators, and workload alerts.
6. Add CSV/XLSX export and printable RFQ reports.
7. Add dashboard drill-down from every metric to the matching RFQs.
8. Add validated ODBC/Evolve DMS reconciliation and Qlik comparison.
9. Add role administration and permission controls.
10. Add sales-consultant personal dashboards for sales, gross profit, customers, and conversion.

## Capability table

| Capability | Current Impala Hub status | Improvement |
|---|---|---|
| Sign-in and sessions | Implemented | Add session/device management |
| User accounts | Implemented | Add admin user management |
| Sales-code mapping | Implemented | Add reassignment history and validation |
| Role-based access | Basic administrator/manager/salesperson rules | Expand permissions by action |
| RFQ creation | Implemented | Add templates and duplicate detection |
| RFQ editing | Implemented | Add field-level change permissions |
| RFQ claiming | Implemented | Add claim queues and workload limits |
| Unclaimed RFQs | Implemented | Add reminders and age indicators |
| RFQ statuses | Implemented and configurable | Add Kanban drag-and-drop |
| RFQ audit history | Implemented | Add export and audit filters |
| Attachments | Implemented with no-delete protection | Add previews and virus scanning |
| Sales Desk dashboard | Implemented | Add drill-downs and saved periods |
| RFQ analytics | Implemented | Add conversion funnel and cohort comparisons |
| Search/filtering | Basic filters | Add advanced filters and saved views |
| Send for approval | Implemented with document, attachment and Complete-status guards | Add approval queue and decision tracking |
| Notifications | Approval notification persistence implemented | Add bell, unread count, and reminders |
| Bulk operations | Missing | Add multi-select actions |
| Export/reporting | Partial | Add CSV, XLSX, and print views |
| DMS integration | Planned | Reconcile with Qlik before production use |
| Personal consultant dashboard | Planned | Add sales, GP, customer, and daily reporting |


## Wildcard search

Sales Desk roadmap now includes wildcard search across RFQ numbers, customers, document numbers and other searchable RFQ fields.
