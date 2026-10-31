export const CONSULTANT_FIELDS = [
  "status_id",
  "document_number",
  "remarks",
] as const;
export const consultantCanEdit = (field: string) =>
  CONSULTANT_FIELDS.some((allowed) => allowed === field);
export const approvalLabel = (state?: string) =>
  ({
    not_requested: "Not requested",
    pending: "Awaiting manager approval",
    approved: "Approved",
    changes_requested: "Changes requested",
  })[state || "not_requested"] || "Not requested";


export function approvalBlockReason(input: {
  hasPermission: boolean; isQuotation: boolean; isCompleted: boolean;
  documentNumber: string; hasAttachment: boolean; approvalState?: string; dirty: boolean;
}): string | null {
  if (!input.hasPermission) return 'Your role needs Request RFQ approval permission in Sales Desk settings.';
  if (!input.isQuotation) return 'Only quotations can be sent for approval.';
  if (!input.dirty && input.approvalState === 'pending') return 'This RFQ is already waiting for manager approval.';
  if (!input.dirty && input.approvalState === 'approved') return 'This RFQ is already approved.';
  if (!input.isCompleted) return 'Choose a completed status before sending for approval.';
  if (!input.documentNumber.trim()) return 'Enter a document number before sending for approval.';
  if (!input.hasAttachment) return 'Upload a document before sending for approval.';
  return null;
}
