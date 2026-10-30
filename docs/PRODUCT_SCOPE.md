# Product scope

The following product vision and scope describe intended business capabilities; use the workspace roadmaps for implementation status.

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
