export type SupplierWorkflow = {
  supplier_name?: string | null;
  supplier_response?: string | null;
  supplier_response_on?: string | null;
  credit_received_on?: string | null;
  credit_reference?: string | null;
  credit_amount?: number | string | null;
  replacement_received_on?: string | null;
  replacement_reference?: string | null;
  replacement_qty?: number | string | null;
  handover_method?: string | null;
  handover_status?: string | null;
  handover_scheduled_on?: string | null;
  handover_completed_on?: string | null;
  handover_contact?: string | null;
  handover_notes?: string | null;
};
export type ClaimValues = SupplierWorkflow & {
  date: string;
  company: string;
  rfc_book_number: string;
  customer: string;
  contact_person: string;
  contact_number: string;
  invoice_number: string;
  invoice_date: string;
  reason: string;
  part_number: string;
  description: string;
  qty: number | string;
  outcome_request: string | null;
  returned_by: string;
  received_by: string;
  supplier_received: string;
  comments: string;
  status: string;
  sla_days: number | string;
  status_change_reason: string;
};
export type ClaimAttachment = {
  id: string;
  original_name: string;
  storage_path: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  uploader_name?: string;
  created_at: string;
};
export type ClaimAudit = {
  id: number;
  action: string;
  actor_user_id: string | null;
  actor_name: string;
  created_at: string;
  changes: {
    file?: string;
    changed?: string[];
    from?: string | number;
    to?: string | number;
    reason?: string;
  } & Record<string, unknown>;
};
export type PendingClaimAttachment = {
  name: string;
  size: number;
  type: string;
  file?: File;
  data_url?: string;
};
export type Claim = Omit<
  ClaimValues,
  "qty" | "sla_days" | "credit_amount" | "replacement_qty"
> & {
  qty: number;
  sla_days: number;
  credit_amount: number | null;
  replacement_qty: number | null;
  id: string;
  claim_no: string;
  updated_at: string;
  closed_at: string | null;
  stored_attachments?: ClaimAttachment[];
  audit_history?: ClaimAudit[];
  attachments?: PendingClaimAttachment[];
};
export type ClaimForm = ClaimValues &
  Partial<
    Pick<
      Claim,
      | "id"
      | "claim_no"
      | "updated_at"
      | "closed_at"
      | "stored_attachments"
      | "audit_history"
      | "attachments"
    >
  >;
export type ClaimInput = ClaimValues & {
  attachments?: PendingClaimAttachment[];
};
export type ClaimField = {
  [K in keyof ClaimValues]: ClaimValues[K] extends
    | string
    | number
    | null
    | undefined
    ? K
    : never;
}[keyof ClaimValues] &
  string;
export function describeFieldChange(value: unknown) {
  const change =
    value && typeof value === "object"
      ? (value as { from?: unknown; to?: unknown })
      : {};
  return `${String(change.from ?? "—")} → ${String(change.to ?? "—")}`;
}
