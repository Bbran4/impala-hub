Impala Hub
Internal operations and marketing platform for Impala Spares / Impala Holdings
Project status: Early development foundation
Document purpose: Product vision, scope, architecture, milestones, integration plan, and acceptance criteria for the full Impala Hub application.
1. Product vision
Impala Hub is intended to become a central, browser-based workspace for the company's marketing and operational workflows. It should reduce repetitive work across disconnected spreadsheets, Google Apps, Qlik dashboards, email inboxes, and other tools, while preserving the existing systems that are authoritative for their respective data.

The application should be built in manageable milestones. The first implementation focus is Marketing, because it is the user's immediate area of responsibility. Evolve DMS integration and the other operational modules will follow after the initial application foundation and marketing workflow have been proven.
Core principles
1. Evolve DMS remains the ERP and official source of truth for inventory, transactions, sales and gross-profit data.
2. Cartrack remains the fleet tracking source of truth. Impala Hub may present data available through supported integrations.
3. Shopify becomes the e-commerce platform as the company migrates away from PrestaShop. Evolve remains authoritative for official stock and ERP transactions unless a later, approved design explicitly states otherwise.
4. Affinity remains the design tool. Impala Hub manages campaign planning, assets, approvals, publishing workflow and records; it is not intended to replace Affinity.
5. Integrate through documented APIs, supported connectors, approved exports or vendor-supported interfaces. Do not write directly to Evolve's production database.
6. Build the application for shared company use, with employee accounts, role-based permissions, audit trails, secure secrets handling and backups before production deployment.
7. Start with read-only access to external operational data wherever practical. Any workflow that changes an external system must be explicitly designed, authorised, tested and auditable.
8. Clearly distinguish implemented, simulated, and planned features. Never present a simulated social post, transfer, or sync as a real completed action.
2. Current company systems and intended roles
System	Current / intended role in Impala Hub	Notes and dependencies
Evolve DMS (Automate)	ERP; official stock, sales, transaction and GP source	Current reporting connection is via an Automate-provided ODBC connector used by Qlik. Exact database engine, driver, supported views, access method and licence restrictions still need confirmation.
Qlik	Existing reporting and data extraction during transition	Currently extracts Evolve data hourly and supports sales/GP reporting and stock-to-buy/transfer analysis. Keep it running in parallel until replacement reports are reconciled.
Google Sheets / Google Apps	Existing manual stock workflow, RFQ tracking and returns tracking	Intended to be reduced or replaced gradually by Impala Hub once equivalent workflows are tested and accepted.
Facebook and Instagram	Marketing publishing and engagement	Requires official account access, Meta developer configuration, permissions, token handling and platform review where applicable.
WhatsApp Business Platform	Supported business messaging and, where available, recipient/group workflows	Contact messaging and publishing to existing groups are not interchangeable. Group functionality depends on supported Meta APIs and account eligibility; verify before promising it.
Affinity	Design, branding and creative production	Hub should organise campaign briefs, assets, approvals, captions and publishing records, not replace the design software.
Cartrack	Vehicle tracking and fleet data	API access, subscription, available fields and permissions must be confirmed before implementation.
PrestaShop → Shopify	Website / online store migration and future e-commerce integration	Shopify integration should be implemented against the actual store and supported APIs. Confirm SKU mapping and inventory ownership rules first.
Email	Sales RFQ mailbox and other operational correspondence	Integration depends on the provider, mailbox permissions and available APIs/IMAP support.
Website forms / social messages	Inbound sales enquiries	Channel access and message ingestion depend on the platform APIs and account permissions.


3. Application modules and complete feature scope
The six main modules below define the intended product scope. Modules should share one application shell, navigation, authentication system, notifications, audit history and integration-health view.
Module A: Marketing & Social Publishing
First implementation priority. Build this module first, then add real provider integrations after the editor and workflow are stable.
Dashboard / Feed
- Marketing overview with monthly summary cards for:
  - Published Posts
  - Scheduled
  - Needs Attention
  - Engagements
- Summary cards are clickable and open the Posts view with the appropriate filter applied.
- Feed view for available social activity, subject to platform API access.
- Show useful post details such as channel, campaign, publication time, status and available engagement counts.
- Clearly indicate the reporting period and whether metrics are current, delayed or unavailable.
Posts
- Create, view, edit, duplicate and archive posts.
- Attach one or more images and preview them before publishing. Validate supported formats and file sizes; use durable object storage in hosted deployments.
- Caption/message editor with platform-specific validation and previews where practical.
- Associate a post with a campaign.
- Select one or more supported publishing channels.
- Facebook: select the Facebook Page and, if supported for the connected account and intended publishing method, up to three additional Facebook Groups. Do not assume that Page and Group publishing share identical permissions or API behaviour.
- Instagram: select the connected professional account and enforce its media/caption requirements.
- WhatsApp: select a recipient type, then choose a contact or an eligible group/destination. Contact messaging should be designed as a business message workflow, not automatically treated as a public social feed post. Group sending must remain disabled until supported API access and eligibility have been verified.
- Workflow actions should be explicit: Save as Draft, Schedule, and Publish when immediate publishing is supported. Avoid a freely editable status dropdown that could create impossible state combinations.
- Publication date and time, with a clear timezone. For Impala operations, use the configured business timezone (initially Africa/Johannesburg).
- Post lifecycle: Draft → Scheduled → Publishing → Published, with Failed / Needs Attention states and an option to retry when safe.
- Store the requested destination(s), intended schedule, author, timestamps, provider post IDs, publishing response and error details.
- Campaign post list: open a campaign and view all linked posts, with status and channel filters.
- Search and filters by date, channel, campaign, status and author.
- Export post lists and reporting where useful.
- Approval workflow for draft review before publishing, configurable by role.
Scheduling and publishing worker
- A background worker executes scheduled publishing jobs.
- Reliable retries with limits, backoff and clear error reporting.
- Idempotency protection to avoid accidental duplicate posts after a timeout or retry.
- Track each destination independently when a post targets multiple channels or groups.
- Record real provider responses and post IDs. A click on Publish must not be shown as success until the provider confirms success.
- Handle expired tokens, revoked permissions, rate limits, unsupported media, and provider outages.
- Keep a clear manual recovery path for failed jobs.
Campaigns
- Create, edit, archive and search campaigns.
- Campaign name, purpose/brief, dates, owner, target audience, notes and campaign status.
- Link multiple posts to a campaign and open the complete campaign post list.
- Track campaign content status and available engagement/performance metrics.
- Store campaign assets and links to original design files where practical.
- Support consistent naming and tagging for later reporting.
Channels and Configuration
- Keep Channels out of the permanent main navigation; manage them under Configuration.
- Separate concepts clearly:
  - Connected accounts: authorised Facebook Pages, Instagram professional accounts, and supported WhatsApp Business assets.
  - Channels/destinations: where content or messages are intended to go.
  - Streams/feed sources: activity or incoming updates that a platform permits the app to read.
- Connect/disconnect accounts through supported OAuth flows.
- Display connection health, granted permissions, last sync and any required reauthorisation.
- Never ask employees to paste long-lived provider tokens into normal settings fields.
Marketing assets and approvals
- Central library for approved logos, product images, campaign imagery, reusable captions and brand resources.
- Organise assets by campaign, product/brand and type.
- Record asset owner, source, approval status and usage notes.
- Support approval/review states and a basic content calendar.
- Affinity remains the creative editor; the Hub stores or references exported assets and campaign metadata.
Marketing analytics
- Monthly and date-range summaries for published posts and available engagement metrics.
- Channel/campaign comparison only where the underlying provider exposes comparable data.
- Clearly label unavailable metrics; do not invent or estimate platform figures without identifying them as estimates.
Module B: Smart Stock Control
Replace the current Qlik-to-Google-Sheets replenishment workflow gradually, after data access and calculation rules are confirmed.
Data and reporting
- Read Evolve stock, sales, branch and transaction data through an approved connector or vendor-supported interface.
- Scheduled data refresh, initially targeting the existing hourly extraction cadence where practical and permitted.
- Show last successful refresh, data age, integration errors and row/data quality checks.
- Stock views by branch, SKU, description, vehicle brand and other available Evolve fields.
- Daily and monthly sales reporting.
- Sales and gross-profit reporting by vehicle brand and individual salesperson, subject to data availability and the official Evolve/Qlik definitions.
- Stock-to-buy and stock-to-transfer analysis.
- Filters, sorting, drill-down and CSV/Excel export where useful.
Replenishment and transfers
- Branch-level minimum and maximum stock settings, with permission-controlled changes and a change history.
- Calculate suggested replenishment quantities using agreed min/max and stock availability rules.
- Suggest branch-to-branch transfers where one branch has surplus and another has a shortage.
- Flag stock-outs, low stock, excess stock, unusual demand and incomplete data.
- Show the reason behind each recommendation and the input values used.
- Allow users to review, adjust, approve or reject recommendations.
- Export approved stock transfer lists in the official Evolve import format, once Automate supplies or confirms the specification.
- Do not write directly to Evolve's database. Any posting into Evolve should use an approved import process or supported API and require appropriate review.
Purchasing recommendations
- Suggest stock to purchase using agreed sales history, current stock, outstanding orders and replenishment rules where those data are available.
- Clearly distinguish suggestions from approved purchase orders.
- Do not create or send purchase orders to suppliers until a supported and approved workflow is designed.
Migration and reconciliation
- Run Qlik and Impala Hub reports side by side during rollout.
- Reconcile totals, GP calculations, date boundaries, branch mappings, returns, discounts and other accounting/reporting rules before replacing Qlik reports.
- Maintain a documented fallback to the existing Qlik/Sheets workflow until sign-off.
Module C: Sales Desk / RFQ CRM Planner
Centralise inbound sales requests from Facebook, WhatsApp, the website and the sales requests email account into a shared work queue.
- Unified inbox or queue for supported inbound sources.
- Capture customer/contact details, source channel, received time, message/request, attachments and relevant product/vehicle details.
- Assign a request to a salesperson or team.
- Status workflow such as New, Assigned, In Progress, Waiting for Customer, Quoted, Won, Lost and Closed; final values to be confirmed with the team.
- Priority, due date, reminders and follow-up tasks.
- Internal notes and activity history.
- Conversation history where the provider API and permissions allow it; otherwise link to the original channel or record the supported summary.
- Avoid duplicate requests where matching identifiers are available.
- Track response times, open workload, source volume, conversion and outcomes.
- Link RFQs to products/SKUs and, later, Evolve stock information where supported.
- Role-based visibility and protection for customer data.
- No assumption that all personal WhatsApp conversations can be imported; integration must respect business-account access and platform rules.
Module D: Returns & Damage Claims
Replace the current Google Apps returns tracker with a case-based workflow.
- Create a return/damage case with a unique reference.
- Capture customer/branch/supplier, SKU, quantity, dates, reason, description and relevant transaction references.
- Upload photographs, documents and supporting evidence.
- Link the case to the original Evolve invoice/transaction where supported by available identifiers.
- Status workflow, for example New, Under Review, Awaiting Information, Approved, Rejected, Supplier Claim, Resolved and Closed; final states to be agreed.
- Assign an owner and record internal notes, decisions, dates and next actions.
- Track supplier claim submissions, responses, credits/replacements and final outcomes.
- Notifications and overdue-case reporting.
- Search, filters, case history and exportable reports.
- Audit all approval and status changes.
- Keep Evolve as the transaction source of truth; Hub case records must not silently alter ERP transactions.
Module E: Fleet / Cartrack
Use Cartrack as the fleet tracking system and bring relevant permitted information into Impala Hub.
- Vehicle list and assigned driver/vehicle details where available and authorised.
- Vehicle location, trips, events and utilisation where the Cartrack API and subscription expose them.
- Date-range and vehicle filters.
- Show last update and stale/missing data indicators.
- Basic utilisation and operational summaries if supported by source data.
- Links to Cartrack for functions that should remain in its own platform.
- Read-only integration as the default.
- Confirm API access, permissions, pricing/subscription limitations, retention rules and allowed use before implementation.
Module F: Shopify / E-commerce Integration
Support the move from PrestaShop to Shopify and connect online commerce to the internal workflows.
- Secure Shopify app/API connection.
- SKU and product mapping between Shopify and Evolve.
- Product information and online catalogue sync for agreed fields.
- Inventory synchronisation rules that preserve Evolve as the official stock source unless a formally approved design changes this.
- Order import and order-status visibility.
- Fulfilment/shipping status synchronisation where supported.
- Handle cancellations, returns, partial fulfilments and sync conflicts explicitly.
- Webhook processing with signature verification, retries and idempotency.
- Sync health, last successful sync, errors and reconciliation reports.
- Avoid duplicate products/orders and document how mismatched SKUs are resolved.
- Do not enable automatic stock writes or order posting into Evolve until the supported method and business rules are confirmed.
4. Shared platform capabilities
These capabilities are required across modules, especially before the application is used company-wide.
- Employee accounts, login/logout and password/session security.
- Role-based access control, for example Administrator, Marketing, Sales, Stock, Returns/Claims, Fleet and Read-only/Management roles. Final roles and permissions must be agreed.
- Record ownership and approval permissions where relevant.
- Audit trail for important data changes, approvals, exports, publishing actions and integration events.
- Notifications and reminders, with configurable delivery channels where appropriate.
- Global search where it is useful and safe across modules.
- Integration status page showing connection health, last successful sync, failures and reauthorisation needs.
- Centralised logs with sensitive information and tokens redacted.
- Secure secret storage; OAuth state validation; encrypted provider tokens; least-privilege permissions; rate limiting and input validation.
- Database backups, restore testing, file/media backups and retention policy.
- Error monitoring and health checks.
- Configurable business timezone, initially Africa/Johannesburg.
- Responsive browser interface for desktop and mobile use where practical.
- Data retention, privacy, access and export rules appropriate to customer and employee information.
- Environment separation for local development, testing/staging and production.
- Automated tests for key workflows and integrations.
- Deployment documentation and a recovery/runbook.
5. Proposed technical architecture
The following is the current working direction, not an irreversible technology decision. Reassess if a clear technical constraint appears.
- Frontend: React + TypeScript using Vite.
- Backend API: Python + FastAPI.
- Development database: SQLite for the current local MVP.
- Production database: PostgreSQL for concurrent company users and durable application data.
- Background jobs: worker/queue for scheduled social publishing, recurring syncs, retries and notifications.
- Media storage: local uploads during development; durable object storage for hosted use.
- External integrations: provider APIs and supported connectors, isolated behind service modules/adapters.
- Authentication: current API-key mechanism is only for local development; production requires employee authentication and role-based permissions.
- Hosting: choose a secure hosting environment after integration, access, budget and operational requirements are confirmed. Do not expose the development server directly to the public internet.
Integration boundaries
- Evolve: approved ODBC read access or supported Automate interface; no direct production DB writes.
- Meta: official OAuth and supported Graph API endpoints/permissions.
- WhatsApp: supported WhatsApp Business Platform APIs only; verify contact and group capabilities separately.
- Cartrack: supported API/connector only.
- Shopify: supported Shopify APIs/webhooks.
- Email: provider-supported API or a carefully scoped IMAP integration, depending on the mailbox setup.
- Website forms: supported form/API/webhook integration.
External integrations should be implemented as replaceable adapters so a vendor change does not require rewriting the entire application.
6. Development milestones
Milestones are ordered by dependency and risk. Dates and effort estimates will be set after access requirements and technical unknowns are resolved.
Milestone 0: Product and integration discovery
Goal: confirm the constraints before building production integrations.
- Confirm the official Facebook Page, Instagram Professional account and WhatsApp Business setup.
- Confirm Meta app ownership, admin access, permissions and review requirements.
- Verify whether the intended WhatsApp contact and group workflows are supported for this business.
- Confirm the email provider and access method for the sales RFQ mailbox.
- Ask Automate whether the existing ODBC connection may be reused by a separate application, what database/driver it uses, which read-only views are available, how secure remote access is provided, and any licence/performance restrictions.
- Obtain the approved Evolve stock transfer import format.
- Confirm Cartrack API/subscription access and Shopify migration/API details.
- Identify current Qlik calculations and Google Sheets formulas that must be preserved.
Acceptance criteria: each integration has a documented access method, owner, permissions, known limitations and a test plan. Unknowns are recorded rather than assumed.
Milestone 1: Application foundation and Marketing MVP
Goal: stable local application for creating and managing marketing content without live publishing.
- React/TypeScript frontend and FastAPI backend.
- Persistent data model for posts, campaigns and media.
- Create/edit/list/archive posts and campaigns.
- Upload and preview images.
- Facebook group destination fields and WhatsApp contact/group destination selection using clearly marked sample data until real integrations are ready.
- Draft and schedule data model, publication date/time and business timezone.
- Campaign-to-post relationships and campaign post list.
- Search and filters, monthly dashboard cards and filtered navigation.
- Initial integration status and audit-log foundations.
- Basic API tests and setup documentation.
Acceptance criteria: data survives restart; image uploads validate format/size; campaign filters work; dates are stored consistently; sample/simulated actions are clearly labelled; no UI action claims a real post was published.
Milestone 2: Secure shared application foundation
Goal: prepare the app for multiple authorised employees.
- Employee authentication and role-based access.
- PostgreSQL migration and schema migrations.
- Secure configuration/secrets management.
- Audit trail, logs, health checks and integration status.
- Durable media storage, backups and restore test.
- Staging environment, HTTPS, deployment instructions and recovery plan.
Acceptance criteria: unauthorised users cannot access protected data/actions; role permissions are tested; secrets are not stored in source control; backup restoration is demonstrated before production use.
Milestone 3: Real Facebook and Instagram connections
Goal: connect approved Meta assets and publish supported content.
- Configure Meta developer app and OAuth flow.
- Discover and store authorised Pages and Instagram professional accounts.
- Securely store/refresh/revoke tokens as supported.
- Implement supported media publishing and destination-specific validation.
- Handle account permissions, rate limits, token expiry and provider errors.
- Save provider post IDs and confirmed publishing results.
- Add per-destination status and clear reconnect/retry actions.
Acceptance criteria: test posts publish to approved test/production destinations; provider responses are recorded; errors are visible; retry cannot accidentally create duplicates; required platform review is complete where applicable.
Milestone 4: Scheduling, approvals and marketing reporting
Goal: complete the daily marketing workflow.
- Background job worker for scheduled posts.
- Retries, backoff, idempotency and job monitoring.
- Draft review/approval workflow and permission checks.
- Content calendar, notifications and failed-post recovery.
- Fetch/display available post insights and engagement metrics.
- Monthly summaries and campaign reporting.
- Central marketing asset library and Affinity-export references.
Acceptance criteria: scheduled jobs run without the browser being open; failed jobs are visible; approvals are enforced; metrics are sourced from provider data and include reporting timestamps.
Milestone 5: WhatsApp Business messaging
Goal: add supported customer messaging workflows without assuming unsupported social publishing behaviour.
- Configure and verify the company's WhatsApp Business Platform setup.
- Implement supported contact selection and business messaging.
- Handle template requirements, consent/opt-in and relevant messaging-window rules.
- Investigate group functionality and account eligibility; implement only if supported for the actual account and use case.
- Record delivery/error status where exposed by the API.
Acceptance criteria: only eligible destinations can be selected; messages are sent through supported APIs; required consent/template rules are enforced; group functionality is explicitly enabled only after verified eligibility.
Milestone 6: Sales Desk / RFQ CRM Planner
Goal: centralise inbound requests and follow-up work.
- Confirm channels and mailbox permissions.
- Build unified RFQ queue, assignment, statuses, due dates and reminders.
- Integrate supported website forms, sales email, Facebook and WhatsApp sources.
- Conversation/history links where APIs permit.
- Customer/product details, internal notes and duplicate handling.
- Response-time, workload and conversion reporting.
Acceptance criteria: incoming test requests appear once, are assigned and tracked through closure; unavailable source history is clearly represented; staff access follows roles.
Milestone 7: Returns & Damage Claims
Goal: replace the existing Google Apps return tracker.
- Case creation, evidence upload and transaction references.
- Review/approval statuses and ownership.
- Supplier claims, credits/replacements and outcome tracking.
- Notifications, overdue reports, search and audit history.
- Evolve transaction linking through approved identifiers/interfaces.
Acceptance criteria: a sample case can be created, reviewed, approved/rejected, sent through a supplier-claim workflow and closed with evidence and a complete history.
Milestone 8: Smart Stock Control and Evolve reporting
Goal: replace the Qlik-to-Google-Sheets replenishment workflow after reconciliation.
- Establish approved read-only Evolve data access.
- Map branch, SKU, stock, sales, GP, returns and other required fields.
- Implement scheduled refresh and monitoring.
- Recreate daily/monthly sales, vehicle-brand, salesperson and GP reports.
- Implement branch min/max, stock recommendations, transfers and purchasing suggestions.
- Review/approve transfer lists and export in the official Evolve import format.
- Compare output against Qlik and current spreadsheets through an agreed parallel-run period.
Acceptance criteria: agreed totals and calculation rules reconcile within approved tolerances; stock recommendations can be explained; exports pass Evolve import validation; the business signs off before the old workflow is retired.
Milestone 9: Cartrack Fleet
Goal: provide a useful read-only fleet view in Impala Hub.
- Confirm API and subscription scope.
- Sync permitted vehicle, trip, location, event and utilisation data.
- Add vehicle/date filters, freshness indicators and summaries.
- Link out to Cartrack for functionality that remains in its system.
Acceptance criteria: displayed data matches the source for an agreed sample and time window; stale data is clearly marked; no unsupported control actions are presented.
Milestone 10: Shopify integration
Goal: connect the new online store with product, stock and order workflows.
- Confirm Shopify store, app/API access and migration plan.
- Map products/SKUs between Shopify and Evolve.
- Sync approved catalogue fields and inventory under agreed ownership rules.
- Import orders and track fulfilment/status changes.
- Implement webhooks, signature checks, retries, idempotency and reconciliation.
- Define handling for missing SKUs, cancellations, returns and conflicts.
Acceptance criteria: test product/order syncs are reconciled; duplicate events do not create duplicate records; inventory ownership is documented; production writes are explicitly approved and tested.
Milestone 11: Production readiness and rollout
Goal: roll out safely to staff and retire old workflows only when replacements are proven.
- Security review and permission review.
- Load/performance and integration-failure testing.
- Backup and restore rehearsal.
- Staff training and quick-start documentation.
- Module-by-module pilot and sign-off.
- Monitoring, support ownership and change/release process.
- Decommission Google Sheets/Apps and Qlik workflows only after each replacement is accepted and a fallback period is complete.
Acceptance criteria: owners sign off each module; support and recovery procedures are documented; critical workflows have monitored failures and tested recovery; legacy systems are not retired prematurely.
7. Current implementation status
This repository currently contains an early Marketing MVP foundation, not the complete Impala Hub product.
Capability	Status in current codebase
React + TypeScript frontend	Implemented as a local development UI
FastAPI backend	Implemented
SQLite persistence	Implemented for local development
Posts and campaigns CRUD	Implemented at a basic level
Post-to-campaign links and campaign filtering	Implemented at a basic level
Image upload endpoint	Implemented for development; production storage/security hardening remains
Draft/scheduled fields	Stored by the API; no automatic scheduler worker yet
Facebook/Instagram/WhatsApp live connections	Not implemented
Actual social publishing	Not implemented; do not treat UI actions as real publication
WhatsApp contact/group destinations	Placeholder fields/sample destinations only
Background jobs and retries	Not implemented
Employee login and role permissions	Not implemented; current API key is development-only
PostgreSQL and production deployment	Not implemented
Sales Desk / RFQ CRM	Planned
Returns & Damage Claims	Planned
Smart Stock Control / Evolve integration	Planned; depends on Automate approval and data mapping
Cartrack integration	Planned; depends on API access
Shopify integration	Planned; depends on store/API setup
Marketing asset approvals and complete analytics	Partially planned; live metrics depend on platform APIs


The prototype and early MVP may contain mock or sample destinations. Sample records must not be mistaken for actual company account data.
8. Development setup
Requirements
- Python 3.11 or later
- Node.js 20 or later
Run the backend locally
cd backend
python -m venv .venv
Windows PowerShell:
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
Edit backend/.env and set APP_API_KEY to a long random development secret. Then run:
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
API documentation: http://127.0.0.1:8000/docs
Health endpoint: http://127.0.0.1:8000/api/health
Run the frontend locally
Open a second terminal:
cd frontend
npm install
npm run dev
Open http://127.0.0.1:5173 and enter the same API key configured in the backend. The current key handling is for local development only and is not employee authentication.
Current API surface
- GET /api/health
- GET /api/posts?status=draft&campaign_id=...
- POST /api/posts
- PATCH /api/posts/{id}
- DELETE /api/posts/{id}
- GET /api/campaigns
- POST /api/campaigns
- PATCH /api/campaigns/{id}
- POST /api/media
- GET /api/integrations
All API routes except health require Authorization: Bearer <APP_API_KEY> in the current development foundation.
9. Definition of done for any module
A module should not be considered complete merely because its screens exist. Before sign-off it should have:
- Agreed requirements and a named business owner.
- Tested happy paths and important failure paths.
- Role/permission checks appropriate to its data and actions.
- Clear validation and useful error messages.
- Audit records for material changes and external actions.
- Integration freshness/health indicators when external data is involved.
- Tests for critical logic and documented setup/configuration.
- Export, reconciliation or recovery procedures where relevant.
- User acceptance testing against real, authorised test data.
- A documented decision on which legacy workflow can safely be retired, if any.
10. Security, privacy and operational safeguards
- Do not commit .env files, API keys, OAuth tokens, passwords, customer data or production media to source control.
- Do not expose the current development server or API key directly to the public internet.
- Use HTTPS, employee authentication, role-based permissions and secure secret storage before company-wide deployment.
- Use least-privilege API scopes and verify OAuth state and redirect URIs.
- Validate file type and size; scan uploads where appropriate; keep uploaded files out of executable paths.
- Redact credentials and sensitive personal data from logs.
- Apply appropriate access, retention and deletion rules to customer communications, vehicle data, media and employee records.
- Confirm platform terms, API permissions, messaging consent and relevant legal requirements before activating integrations.
- Test backups and restores; a backup that has never been restored is not a proven recovery plan.
- Keep a clear separation between test and production accounts/data.
- Avoid direct database writes to Evolve. Use supported imports/APIs and approvals for any change to an external system.
11. Decisions and open questions
Track these items as explicit project decisions instead of making assumptions in code.
- [ ] Automate approval and details for reuse of the ODBC connection outside Qlik.
- [ ] Confirm the database engine, driver, secure connection method and supported read-only views for Evolve.
- [ ] Obtain and test the official Evolve stock transfer import format.
- [ ] Document Qlik GP and sales calculation rules for reconciliation.
- [ ] Confirm Meta app ownership, authorised assets, permissions and review requirements.
- [ ] Confirm whether intended Facebook Group publishing is supported for the connected account and API.
- [ ] Confirm WhatsApp Business Platform setup, contact messaging rules and any eligible group capability.
- [ ] Confirm email provider and secure access to the sales RFQ mailbox.
- [ ] Confirm website form and social inbox API access.
- [ ] Confirm Cartrack API availability, subscription scope and costs.
- [ ] Confirm Shopify store, migration timing, SKU mapping and stock ownership rules.
- [ ] Agree employee roles, approval chain, data retention and audit requirements.
- [ ] Select production hosting, domain, storage, backup and monitoring approach.
- [ ] Agree rollout order and acceptance owners for each module.
12. Immediate next actions
1. Continue validating the Marketing MVP locally and refine the editor workflow.
2. Complete the Meta account/access discovery before implementing live publishing.
3. Build the production-grade authentication, database and job-processing foundation before using live credentials or relying on automatic publishing.
4. Keep WhatsApp group publishing explicitly gated until API support and account eligibility are verified.
5. Start the Evolve/Automate discovery in parallel, but do not begin replacing Qlik/Sheets stock calculations until the access method and reconciliation rules are known.
6. Maintain this README as the project's source of truth: update feature status, decisions, milestone acceptance and known limitations as development progresses.

# Impala Hub Marketing MVP (foundation)

A server-backed first version of the Impala Hub Marketing workspace: a FastAPI API, SQLite persistence for local development, and server-side image uploads. It includes post and campaign CRUD, posts grouped under campaigns, draft / awaiting approval / scheduled states, Facebook group selection, an integration status screen and an audit log.

## Important limits

- **Development foundation only. Do not expose it to the internet.** It uses a single shared API key, not employee accounts or roles. Run it on your own computer or a trusted development network.
- Facebook, Instagram and WhatsApp are **not connected**. The UI cannot publish immediately. Scheduling only stores the intended date and time; no background worker exists yet, so nothing is published automatically. The `published` and `failed` statuses are reserved for that future worker and the API rejects them from clients.
- Engagement figures (clicks, likes, comments, shares) and `published_at` exist in the database but stay `NULL` ("not available") until a platform is connected. They are never shown as 0.
- Facebook groups and WhatsApp contacts/groups in the editor are **samples** and are labelled as such. WhatsApp support will be built after Facebook and Instagram work.
- **Unauthenticated URLs:** `GET /uploads/*` (images must load in `<img>` tags) and the API docs at `/docs` do not need the key. Don't upload anything confidential.
- Before a hosted, multi-user deployment: PostgreSQL, employee login and roles, encrypted token storage, OAuth state/CSRF protection, rate limiting, HTTPS, backups and monitoring.

## Requirements

- Python 3.11+
- Node.js 20+

## Run locally

### 1. Start the API

All backend commands must be run **from inside the `backend` folder** (`.env` and the data/upload paths are resolved relative to it).

```bash
cd backend
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env    # Windows; on macOS/Linux: cp .env.example .env
```

If PowerShell refuses to run `Activate.ps1`, run this once in that window and retry:

```powershell
Set-ExecutionPolicy -Scope Process RemoteSigned
```

Generate a secret and paste it into `backend/.env` as `APP_API_KEY`:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

The API answers `503` until `APP_API_KEY` is set to something other than the placeholder and is at least 24 characters. Then start it:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

API docs: `http://127.0.0.1:8000/docs`. Health check: `http://127.0.0.1:8000/api/health`.

The SQLite database is created and migrated automatically on startup (schema version is tracked with `PRAGMA user_version`). An older database is upgraded in place; legacy `needs_attention` posts become drafts.

### 2. Start the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173` and enter the same API key. The key is kept in session storage for that tab only. If the key is rejected you are returned to the key screen; use **Change API key** in the sidebar to switch keys.

If the API is not at `http://127.0.0.1:8000`, create `frontend/.env.local` containing `VITE_API_URL=http://your-host:port` (and add that origin to the CORS list in `backend/app/main.py`).

### 3. Run the tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest
```

Tests use a temporary database and upload folder, so they work on Windows, macOS and Linux and never touch your real data.

## API endpoints

All routes except `GET /api/health` need `Authorization: Bearer <APP_API_KEY>`.

- `GET /api/health`
- `GET /api/posts?status=draft&campaign_id=...` (status: draft, awaiting_approval, scheduled, published, failed)
- `POST /api/posts`
- `GET /api/posts/{id}/history` (audit entries for one post, newest first)
- `PATCH /api/posts/{id}` (partial update; see post lifecycle below)
- `DELETE /api/posts/{id}` (published posts return 409)
- `GET /api/campaigns`, `POST /api/campaigns`, `PATCH /api/campaigns/{id}` (partial update)
- `POST /api/media` (JPG, PNG, WEBP, GIF; limit set by `MAX_UPLOAD_MB`)
- `GET /api/integrations`
- `GET /api/audit?limit=100` (newest first)

Rules enforced by the API: clients may only set `draft`, `awaiting_approval` or `scheduled`; scheduled posts need a future date and at least one channel; Instagram posts need an image to be scheduled; media must come from `/api/media`; at most 3 Facebook groups; campaign end date must not precede its start date. `publish_at` is stored in UTC.

## Post lifecycle

| Status | Edit content | Change campaign | Delete |
| --- | --- | --- | --- |
| draft, awaiting approval, failed | yes | yes | yes |
| scheduled | no | yes | yes |
| published | no | yes | no |

The API enforces this (a blocked edit returns 409), not just the screen. Clicking a post in any list opens its detail view: content, schedule and publication dates, performance figures ("—" when unavailable), campaign, and a history of changes.

## Views

The Posts page has three views. Search and the campaign filter apply to all of them.

- **List**: the full register, with the status filter.
- **Board**: one column per status. Drag a draft, awaiting-approval or failed post into Draft, Awaiting approval or Scheduled (or use the "Move to..." menu on the card). Moving to Scheduled needs a future date and at least one channel. Scheduled and published cards cannot be moved.
- **Calendar**: a Monday-first month grid. Drag a draft or awaiting-approval post to a day to plan its date (its status does not change); posts without a date wait in the Unscheduled tray. The "+" on a day starts a new post for that date. Scheduled and published posts appear on their dates but are locked.

## Formatting

`npm run format` runs Prettier over `frontend/src`. Run it once on `style.css` too (`npx prettier --write src/style.css`) to expand the minified rules.

## Recommended implementation sequence

1. Confirm the Impala Facebook Page and Instagram Professional account, then create and configure the Meta developer app.
2. Server-side OAuth, token encryption and rotation, account discovery, and real Facebook/Instagram publishing.
3. A job queue/worker for scheduled posts with retries, idempotency and status updates (this is what sets `published`, `failed`, `published_at` and the metrics).
4. Post detail view, calendar/board views, Channels and Streams.
5. WhatsApp contact messaging and group eligibility.
6. Employee login, roles, PostgreSQL, cloud object storage, HTTPS, monitoring and backups.

## Security notes

Never commit `.env`, provider tokens, secrets, customer lists or production media. Do not open the development server to the internet.


## Marketing workflow update (October 2026)

The current implementation is being updated in `feature/marketing-workflow-metrics`.

- Facebook Group posting has been removed from the editor and API model. Existing databases migrate away from the deprecated group field.
- The Feed engagement card now totals synced Facebook likes, comments and shares for the current month, using the publication date for published posts.
- Failed posts have a **Reschedule** action that reopens their content with a suggested time 15 minutes ahead. Review the post and confirm the new schedule before it is queued, to reduce the risk of duplicate publishing.
- **Publish now** queues a Facebook-only post through the backend worker. The UI reports that a request was queued, not that Facebook has already confirmed publication.
- The OAuth permission request now includes Meta's `read_insights` permission. Existing connections need to reconnect and grant it before insights data can be read.
- Reach and impressions columns have been added to the database, but syncing and displaying those metrics still needs to be completed and verified against the connected Meta Page.
- Paid-ad reporting is a separate follow-up: it requires access to the relevant ad account and the appropriate Marketing API permissions (typically including `ads_read`). Paid delivery metrics must not be added to organic post engagement totals.

These changes have not been validated against a live Meta account. Run the backend test suite and frontend build before merging, then verify publishing and permissions with an authorised test Page.
