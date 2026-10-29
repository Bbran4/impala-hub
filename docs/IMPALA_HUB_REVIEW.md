# Impala Hub Workspace Review

Updated: 2026-10-29

This review covers Marketing, Sales Desk, Returns & Claims, Smart Stock Control, Chat and Channels. Reporting is intentionally excluded from this review.

## Current position

- Authentication: Supabase email/password login, Google Authenticator TOTP MFA, tab-scoped sessions and automatic sign-out when the browser session ends.
- Permissions: administrator controls, application visibility, roles and user-level permission foundations are implemented. Detailed per-workspace permission expansion remains a separate workstream.
- Marketing: Facebook connection, feed synchronization, post creation, image media, campaigns, publishing foundations and metrics are implemented. Instagram publishing/insights and provider-specific social conversations remain deferred.
- Sales Desk: RFQ lifecycle, assignment, claiming, configuration, attachments, audit history, invoice numbering foundations, dashboards and permissions are implemented. Approval queues, live sales data, bulk actions, exports and advanced SLA automation remain planned or deferred.
- Returns & Claims: lifecycle validation, supplier outcomes, attachments, audit history, SLA ageing, filtering and CSV/XLSX reporting are implemented. Wildcard search and production smoke verification remain planned.
- Smart Stock Control: Parts Query, stock booking, reordering, configuration, manual CSV/XLSX imports, versioned staging and exports are implemented. ERP/Qlik/ODBC ingestion, supplier workflows and recommendations remain deferred or planned.
- Chat and Channels: direct chat, unread/read state, presence, private attachments, channels, channel membership, leave-channel actions and docked conversations are implemented.

## Recommended user-experience improvements

### Entire Hub

1. Add a global command/search palette for users, RFQs, claims, posts and stock records.
2. Add a consistent activity timeline and notification deep links across every workspace.
3. Add saved views and filters per user, with administrator-managed default views.
4. Add clear empty, loading, retry and offline states instead of generic errors.
5. Add session/device management, MFA recovery-factor guidance and an administrator recovery process.
6. Add consistent keyboard shortcuts, focus states and mobile navigation behavior.

### Marketing

1. Add campaign-aware search, saved filters and bulk post actions.
2. Add a media library with reusable assets, image compression and upload progress.
3. Add publishing previews for each network and a failed-publish retry queue.
4. Add approval workflows and notifications for draft, scheduled and failed posts.
5. Resume Instagram only after the Facebook workflow is covered by end-to-end tests.

### Sales Desk

1. Add an RFQ Kanban with workload, age and SLA indicators.
2. Add duplicate-RFQ detection and reusable RFQ templates.
3. Add bulk assignment, claiming, status changes and export.
4. Add approval queues with explicit decisions, reasons and notifications.
5. Replace dashboard seed data with audited live sales-source data.

### Returns & Claims

1. Add wildcard search only after confirming the desired syntax and performance limits.
2. Add a claim timeline showing every status, supplier outcome and attachment event.
3. Add overdue queues and notification reminders for claim owners and managers.
4. Add supplier performance summaries once enough production history exists.

### Smart Stock Control

1. Add a clear import dry-run report with row-level errors and downloadable diagnostics.
2. Add stock freshness indicators and source timestamps to every quantity.
3. Add supplier quote workflows, approval and price-history comparisons.
4. Add reorder recommendations only after the ERP source of truth is selected.
5. Add branch transfer status tracking from prepared export through confirmed receipt.

### Chat and Channels

1. Add channel descriptions, ownership and administrator moderation.
2. Add unread counts and notification preferences per channel.
3. Add message search, reply/thread support and message deletion/edit rules.
4. Add reliable attachment retry, preview failure diagnostics and attachment expiry policy.
5. Add presence freshness and a clear offline/reconnecting indicator.
