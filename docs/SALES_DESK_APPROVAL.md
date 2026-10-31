# RFQ approval and app roles

Migrations 0125 and 0127 are delivered through the connected Supabase GitHub
integration alongside the frontend deployment.

Consultants may change only status, document number and remarks on RFQs assigned
to their own active sales code. Attachments use the existing checked upload and
deletion commands. Customer/contact/query details, media platform, assignment,
received date and claimed date are manager-only. Direct browser table updates and
forged approval fields remain blocked.

To request approval, save a quotation with a completed status category, a document
number and an uploaded attachment. **Send for Approval** notifies every active
Sales Manager with both view and approval permissions. Requests are idempotent.
If nobody qualifies, the command reports an error and leaves the RFQ unchanged.
Managers can use the notification or the **Approval** filter in the RFQ list.

Managers can approve or return the RFQ for changes. Returning requires a note.
The consultant receives the decision, and the request alerts are marked read for
the other managers. Approval confirms the RFQ only; it does not create an invoice.
The existing manual invoice-conversion command remains separate.

Changing RFQ business fields or adding/removing attachments invalidates a pending
or approved request. A new revision must be submitted. Reviews lock the parent row
and compare its current revision; stale, repeated and self-approval attempts fail.
Notifications, RFQ state and attributed audit events share the same transaction.

App Settings now offers a per-user app-role selector. Sales Desk has **Sales
consultant** and **Sales Manager**. Other apps expose only their corresponding app
roles. Switching roles replaces only the selected app's direct roles; it preserves
other apps and inherited platform roles. Administrator/Management cannot be
granted through this selector. Active administrators retain settings authority in
normal user view and can set their own app roles. Changes are audited atomically.

Approval permissions appear in the existing editable role/user permission
settings. All commands evaluate current database permissions. Role labels and
capabilities cached by an already-open Sales Desk session refresh on a full app
reload; cached values never authorize a database write.

Regression tests cover restricted fields, date preservation, ownership, uploaded
evidence, manager eligibility, notification deduplication, stale/self reviews,
approval invalidation, no automatic invoices, audit/notification rollback, scoped
role changes, inherited access and normal-view administrator recovery.


Consultants see **Send for Approval** on their assigned RFQs even while requirements are missing. The approval panel explains whether they need a completed status, document number, uploaded document or request permission. They can change the status, document number and remarks and press **Send for Approval** directly. Their changes, approval request, audit and manager notifications commit together; if validation fails none of those changes are saved. Regular **Save changes** remains available for edits that are not ready for approval.


Status setup uses **Outcome category**, which controls approvals and completion dates as well as analytics. Choosing **Completed** automatically makes the status closed. Migration 0137 classifies legacy statuses named exactly Complete or Completed when they were previously unclassified; explicitly configured dropped/scrapped/other outcomes are not inferred from names during RFQ processing. Other custom completion statuses must have their outcome category set to Completed.


The approval button follows the status currently selected in the unsaved form. Selecting a Completed outcome enables it immediately; selecting another outcome disables it again. Send for Approval saves the pending edits and submits the approval request in one database transaction. Missing document numbers or uploaded documents are shown as validation messages when submitting; they do not keep a Completed RFQ's button disabled.
