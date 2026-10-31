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
