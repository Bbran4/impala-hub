# Sales Desk Roadmap

Updated: 2026-10-29

## Current review

Implemented today:

- Impala Hub authentication with Google Authenticator MFA, tab-scoped sessions and logout.
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
- Send for Approval has document-number, attachment and closed-status guards. Administrator notification persistence and the approval decision queue are not connected yet.

## Improvement roadmap

### Dashboard data integrity

The Daily Sales and RFQ Performance tables currently contain temporary test data so the dashboard can be demonstrated. Before production use, both dashboards must be populated only from active user profiles with a configured sales code. Users without a sales code must not appear in either table. The temporary seed rows must be replaced by a live sales-data import or approved integration, with business-date and source timestamps retained for auditability.

1. Add a dedicated RFQ Kanban with drag-and-drop status changes.
2. Add bulk actions for assignment, claiming, status changes, and export.
3. Add saved filters and advanced search by customer, salesperson, source, status, and date.
4. Expand the notification bell beyond assigned RFQs entering In Progress to new/unclaimed RFQs, reassignment, overdue work, approval decisions, and SLA reminders.
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
| Workspace permissions | Salesperson visibility restricted to Sales Desk in the frontend; shared Supabase permission contract added | Enforce every workspace and endpoint server-side as migrations continue |
| RFQ creation | Implemented | Add templates and duplicate detection |
| RFQ editing | Implemented | Add field-level change permissions |
| RFQ claiming | Implemented | Add claim queues and workload limits |
| Unclaimed RFQs | Implemented | Add reminders and age indicators |
| RFQ statuses | Implemented and configurable | Add Kanban drag-and-drop |
| RFQ audit history | Implemented | Add export and audit filters |
| Attachments | Implemented with previews, downloads and deletion protection | Optional virus scanning |
| Sales Desk dashboard | Implemented | Add drill-downs and saved periods |
| RFQ analytics | Implemented | Add conversion funnel and cohort comparisons |
| Daily sales and RFQ performance membership | Temporary Supabase seed data | Restrict rows to active users with profile sales codes and replace test values with live sales data |
| Search/filtering | Basic filters | Add advanced filters and saved views |
| Send for approval | Partial; prerequisite checks implemented | Add administrator notification persistence, approval queue and decision tracking |
| Notifications | Shared Supabase notification centre, app channel, unread state, mark-read controls, and exact RFQ links implemented for assigned RFQs entering In Progress | Add approval, unclaimed, reassignment, overdue and SLA event producers |
| Bulk operations | Missing | Add multi-select actions |
| Export/reporting | Missing | Add CSV, XLSX, and print views |
| DMS integration | Deferred | Reconcile with Qlik when real external data work resumes |
| Personal consultant dashboard | Deferred | Requires live sales, GP, customer, and daily reporting data |


## Search

Sales Desk provides literal substring search across RFQ numbers, customers and document numbers. True wildcard-pattern syntax and advanced saved filters remain planned.
