import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import {
  resultData,
  checkError,
  legacyRequest,
  jsonBody,
  AuthError,
} from "./serviceTransport";
import { loadAllRows } from "./pagedRows.ts";
import { claimFileType } from "./returnsAttachments";
import { deleteRecordAttachment } from "./recordAttachments";
import {
  supplierWorkflowFields,
  prepareSupplierWorkflow,
} from "./returnsWorkflow";
import { safeMarketingFilename } from "./marketingPosts.ts";
import type {
  Claim,
  ClaimInput,
  ClaimAttachment,
  ClaimAudit,
} from "./returnsTypes";
export type * from "./returnsTypes";
const claimFields = [
  "date",
  "company",
  "rfc_book_number",
  "customer",
  "contact_person",
  "contact_number",
  "invoice_number",
  "invoice_date",
  "reason",
  "part_number",
  "description",
  "qty",
  "outcome_request",
  "returned_by",
  "received_by",
  "supplier_received",
  "comments",
  "status",
  "sla_days",
  "status_change_reason",
  ...supplierWorkflowFields,
] as const;
export function claimWriteValues(values: ClaimInput) {
  return {
    ...Object.fromEntries(
      claimFields
        .filter((field) => Object.hasOwn(values, field))
        .map((field) => [field, values[field]]),
    ),
    ...prepareSupplierWorkflow(values),
  };
}
export function createReturnsService(
  token = "",
  client: SupabaseClient | null = supabase,
) {
  const http = <T>(path: string, init?: RequestInit) =>
    legacyRequest<T>(`/api/returns-claims${path}`, init, token);
  // Authorization is enforced by the database policies and transactional triggers.
  const currentUser = async () => {
    if (!client) throw new Error("Supabase is not configured.");
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.user)
      throw new AuthError("Sign in again to open Returns & Claims.");
    return data.session.user;
  };
  return {
    async list(): Promise<Claim[]> {
      if (!client) return http("");
      return (
        await loadAllRows<Claim>((from, to) =>
          client
            .from("returns_claims")
            .select("*", { count: "exact" })
            .is("deleted_at", null)
            .order("date", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id")
            .range(from, to),
        )
      ).data;
    },
    async detail(id: string): Promise<Claim> {
      if (!client) return http(`/${id}`);
      const [record, attachments, audit, people] = await Promise.all([
        client
          .from("returns_claims")
          .select("*")
          .eq("id", id)
          .is("deleted_at", null)
          .single(),
        loadAllRows<ClaimAttachment>((from, to) =>
          client
            .from("returns_claim_attachments")
            .select(
              "id,original_name,storage_path,content_type,size,uploaded_by,created_at",
              { count: "exact" },
            )
            .eq("claim_id", id)
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
        loadAllRows<Omit<ClaimAudit, "actor_name">>((from, to) =>
          client
            .from("returns_claims_audit")
            .select("id,action,changes,actor_user_id,created_at", {
              count: "exact",
            })
            .eq("claim_id", id)
            .order("id", { ascending: false })
            .range(from, to),
        ),
        client.rpc("returns_claim_people", { target_claim_id: id }),
      ]);
      const names = new Map(
        resultData<{ id: string; display_name: string }[]>(people).map(
          (person) => [person.id, person.display_name],
        ),
      );
      return {
        ...resultData<Claim>(record),
        stored_attachments: attachments.data.map((item) => ({
          ...item,
          uploader_name: names.get(item.uploaded_by) || "Former employee",
        })),
        audit_history: audit.data.map((item) => ({
          ...item,
          actor_name: names.get(item.actor_user_id || "") || "Former employee",
          changes: item.changes || {},
        })),
      };
    },
    async create(values: ClaimInput): Promise<Claim> {
      if (!client) return http("", { method: "POST", ...jsonBody(values) });
      const user = await currentUser();
      return resultData(
        await client
          .from("returns_claims")
          .insert({
            ...claimWriteValues(values),
            created_by: user.id,
            updated_by: user.id,
          })
          .select()
          .single(),
      );
    },
    async update(id: string, values: ClaimInput): Promise<Claim> {
      if (!client)
        return http(`/${id}`, { method: "PATCH", ...jsonBody(values) });
      const user = await currentUser();
      return resultData(
        await client
          .from("returns_claims")
          .update({
            ...claimWriteValues(values),
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .select()
          .single(),
      );
    },
    async archive(id: string): Promise<void> {
      if (!client) {
        await http(`/${id}`, { method: "DELETE" });
        return;
      }
      const user = await currentUser();
      checkError(
        await client
          .from("returns_claims")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by: user.id,
            updated_by: user.id,
          })
          .eq("id", id)
          .is("deleted_at", null)
          .select("id")
          .single(),
      );
    },
    async uploadAttachment(id: string, file: File): Promise<ClaimAttachment> {
      if (!client) {
        const body = new FormData();
        body.append("file", file);
        return http(`/${id}/attachments`, { method: "POST", body });
      }
      const user = await currentUser(),
        contentType = claimFileType(file);
      const count = await client
        .from("returns_claim_attachments")
        .select("id", { count: "exact", head: true })
        .eq("claim_id", id);
      checkError(count);
      if ((count.count || 0) >= 10)
        throw new Error("A claim can have at most 10 attachments.");
      const path = `${user.id}/${id}/${crypto.randomUUID()}-${safeMarketingFilename(file.name)}`;
      checkError(
        await client.storage
          .from("returns-claim-attachments")
          .upload(path, file, { contentType }),
      );
      const row = await client
        .from("returns_claim_attachments")
        .insert({
          claim_id: id,
          original_name: file.name,
          storage_path: path,
          content_type: contentType,
          size: file.size,
          uploaded_by: user.id,
        })
        .select()
        .single();
      if (row.error) {
        await client.storage.from("returns-claim-attachments").remove([path]);
        throw new Error(row.error.message);
      }
      return resultData(row);
    },
    async attachmentUrl(
      attachment: ClaimAttachment,
      download = false,
    ): Promise<string> {
      if (!client) throw new Error("Stored attachments require Supabase.");
      const signed = await client.storage
        .from("returns-claim-attachments")
        .createSignedUrl(
          attachment.storage_path,
          300,
          download ? { download: attachment.original_name } : undefined,
        );
      checkError(signed);
      if (!signed.data?.signedUrl)
        throw new Error("Unable to open attachment.");
      return signed.data.signedUrl;
    },
    async deleteAttachment(id: string, attachmentId: string): Promise<void> {
      if (!client) {
        await http(`/${id}/attachments/${attachmentId}`, { method: "DELETE" });
        return;
      }
      await deleteRecordAttachment(client, "return", id, attachmentId);
    },
  };
}
