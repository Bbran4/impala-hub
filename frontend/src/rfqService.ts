import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import {
  resultData,
  checkError,
  legacyRequest,
  jsonBody,
  AuthError,
  API,
  describeError,
} from "./serviceTransport";
import { createSalesDeskSessionCache } from "./salesDeskSession.ts";
import { loadRfqList } from "./recordLists.ts";
import { loadAllRows } from "./pagedRows.ts";
import { safeMarketingFilename } from "./marketingPosts.ts";
import { deleteRecordAttachment } from "./recordAttachments";
import type {
  Rfq,
  RawRfq,
  RfqList,
  RfqCreate,
  RfqValues,
  RfqAttachment,
  RfqAudit,
  RfqConfig,
  ConfigKind,
  ConfigPatch,
  ConfigOption,
  SalesDeskUser,
  RfqDashboard,
  RfqAnalytics,
  AnalyticsFilters,
} from "./rfqTypes";
export type * from "./rfqTypes";
const session = supabase ? createSalesDeskSessionCache(supabase) : null;
supabase?.auth.onAuthStateChange((event, value) =>
  session?.authChanged(event, value),
);
export const normalizeRfq = (row: RawRfq): Rfq => ({
  ...row,
  media_platform: row.media_platform?.name || null,
  status: row.status?.name || null,
  status_name: row.status?.name || null,
  status_is_closed: !!row.status?.is_closed,
  sales_code: row.sales_code?.code || null,
});
const configTables = {
  "media-platforms": "sales_desk_media_platforms",
  statuses: "sales_desk_statuses",
  "sales-codes": "sales_desk_sales_codes",
} as const;
export function createRfqService(
  token = "",
  client: SupabaseClient | null = supabase,
) {
  const cachedSession =
    client === supabase
      ? session
      : client
        ? createSalesDeskSessionCache(client)
        : null;
  const http = <T>(path: string, init?: RequestInit) =>
    legacyRequest<T>(`/api/sales-desk${path}`, init, token);
  const command = async (name: string, args: object): Promise<Rfq> => {
    if (!client) throw new Error("Supabase is not configured.");
    return resultData<Rfq>(await client.rpc(name, args));
  };
  const detail = async (id: string): Promise<Rfq> => {
    if (!client) return http(`/rfqs/${id}`);
    const row = resultData<RawRfq>(
      await client
        .from("sales_desk_rfqs")
        .select(
          "*,media_platform:sales_desk_media_platforms(name),status:sales_desk_statuses(name,is_closed),sales_code:sales_desk_sales_codes(code)",
        )
        .eq("id", id)
        .is("deleted_at", null)
        .single(),
    );
    const [history, attachments] = await Promise.all([
      loadAllRows<Omit<RfqAudit, "actor_name">>((from, to) =>
        client
          .from("sales_desk_rfq_audit")
          .select("id,action,changes,created_at,actor_user_id", {
            count: "exact",
          })
          .eq("rfq_id", id)
          .order("id")
          .range(from, to),
      ),
      loadAllRows<RfqAttachment>((from, to) =>
        client
          .from("sales_desk_rfq_attachments")
          .select(
            "id,original_name,storage_path,content_type,size,uploaded_by,created_at",
            { count: "exact" },
          )
          .eq("rfq_id", id)
          .order("created_at")
          .order("id")
          .range(from, to),
      ),
    ]);
    // Batch names rather than putting a potentially unbounded ID list in a URL.
    const ids = [
      ...new Set(
        [
          ...history.data.map((item) => item.actor_user_id),
          ...attachments.data.map((item) => item.uploaded_by),
        ].filter((id): id is string => !!id),
      ),
    ];
    const names = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const people = resultData<{ id: string; display_name: string }[]>(
        await client
          .from("profiles")
          .select("id,display_name")
          .in("id", ids.slice(offset, offset + 100)),
      );
      people.forEach((person) => names.set(person.id, person.display_name));
    }
    return {
      ...normalizeRfq(row),
      audit_history: history.data.map((item) => ({
        ...item,
        changes: item.changes || {},
        actor_name:
          item.changes?.actor_name ||
          names.get(item.actor_user_id || "") ||
          item.actor_user_id ||
          "Unknown",
      })),
      attachments: attachments.data.map((item) => ({
        ...item,
        uploaded_by_name: names.get(item.uploaded_by) || "Unknown",
      })),
    };
  };
  return {
    detail,
    async me(): Promise<SalesDeskUser> {
      return client ? cachedSession!.get() : http("/auth/me");
    },
    async list(): Promise<RfqList> {
      if (!client) return http("/rfqs");
      const rows = await loadRfqList(client);
      const items = (rows.data as RawRfq[]).map(normalizeRfq);
      return { items, total: rows.count, limit: items.length, offset: 0 };
    },
    async configuration(): Promise<RfqConfig> {
      return client
        ? resultData<RfqConfig>(await client.rpc("sales_desk_configuration"))
        : http("/config");
    },
    async create(values: RfqCreate): Promise<Rfq> {
      return client
        ? command("create_sales_desk_rfq", { p_values: values })
        : http("/rfqs", { method: "POST", ...jsonBody(values) });
    },
    async update(id: string, values: Partial<RfqValues>): Promise<Rfq> {
      return client
        ? command("update_sales_desk_rfq", { p_id: id, p_values: values })
        : http(`/rfqs/${id}`, { method: "PATCH", ...jsonBody(values) });
    },
    async claim(id: string): Promise<Rfq> {
      return client
        ? command("claim_sales_desk_rfq", { p_id: id })
        : http(`/rfqs/${id}/claim`, { method: "POST" });
    },
    async archive(id: string): Promise<void> {
      if (!client) {
        await http(`/rfqs/${id}`, { method: "DELETE" });
        return;
      }
      checkError(await client.rpc("archive_sales_desk_rfq", { p_id: id }));
    },
    async convertToInvoice(
      id: string,
    ): Promise<{ id: string; rfq_no: string }> {
      if (!client)
        return http(`/rfqs/${id}/convert-to-invoice`, { method: "POST" });
      return resultData(
        await client
          .rpc("convert_sales_desk_rfq_to_invoice", { source_id: id })
          .single(),
      );
    },
    async sendForApproval(id: string): Promise<void> {
      if (!client) {
        await http(`/rfqs/${id}/send-for-approval`, { method: "POST" });
        return;
      }
      throw new Error(
        "Approval requests are not enabled yet. No approval request has been sent.",
      );
    },
    async dashboard(): Promise<RfqDashboard> {
      return client
        ? resultData<RfqDashboard>(await client.rpc("sales_desk_dashboard"))
        : http("/dashboard");
    },
    async analytics(filters: AnalyticsFilters): Promise<RfqAnalytics> {
      if (!client)
        return http(
          "/analytics?" +
            new URLSearchParams(
              Object.entries(filters).map(([key, value]) => [
                key,
                String(value),
              ]),
            ),
        );
      return resultData(
        await client.rpc("sales_desk_analytics", {
          p_period: filters.period,
          p_year: filters.year,
          p_month: filters.month,
          p_week: filters.week,
        }),
      );
    },
    async addOption(
      kind: "media-platforms" | "statuses",
      values: ConfigPatch & { name: string },
    ): Promise<ConfigOption> {
      if (!client)
        return http(`/config/${kind}`, { method: "POST", ...jsonBody(values) });
      return resultData(
        await client
          .from(configTables[kind])
          .insert({
            name: values.name,
            ...(kind === "statuses"
              ? {
                  is_closed: !!values.is_closed,
                  metric_category: values.metric_category || "other",
                }
              : {}),
            sort_order: 999,
          })
          .select()
          .single(),
      );
    },
    async updateOption(
      kind: ConfigKind,
      id: string,
      values: ConfigPatch,
    ): Promise<void> {
      if (!client) {
        await http(`/config/${kind}/${id}`, {
          method: "PATCH",
          ...jsonBody(values),
        });
        return;
      }
      checkError(
        await client
          .from(configTables[kind])
          .update(values)
          .eq("id", id)
          .select()
          .single(),
      );
    },
    async removeOption(
      kind: "media-platforms" | "statuses",
      id: string,
    ): Promise<void> {
      if (!client) {
        await http(`/config/${kind}/${id}`, { method: "DELETE" });
        return;
      }
      const used = await client
        .from("sales_desk_rfqs")
        .select("id", { count: "exact", head: true })
        .eq(kind === "media-platforms" ? "media_platform_id" : "status_id", id);
      checkError(used);
      if ((used.count || 0) > 0)
        throw new Error(
          "This option is used by an existing RFQ. Deactivate it instead of deleting it.",
        );
      checkError(await client.from(configTables[kind]).delete().eq("id", id));
    },
    async reorder(
      kind: "media-platforms" | "statuses",
      ids: string[],
    ): Promise<void> {
      if (!client) {
        await http(`/config/${kind}/order`, {
          method: "PUT",
          ...jsonBody({ ids }),
        });
        return;
      }
      checkError(
        await client.rpc("reorder_sales_desk_config", {
          p_kind: kind,
          p_ids: ids,
        }),
      );
    },
    async uploadAttachment(id: string, file: File): Promise<Rfq> {
      if (!client) {
        const body = new FormData();
        body.append("file", file);
        return http(`/rfqs/${id}/attachments`, { method: "POST", body });
      }
      const { data } = await client.auth.getSession();
      if (!data.session?.user)
        throw new AuthError("Sign in again to attach files.");
      if (file.size > 15 * 1024 * 1024)
        throw new Error("Maximum attachment size is 15 MB.");
      const userId = data.session.user.id;
      const path = `${userId}/${id}/${crypto.randomUUID()}-${safeMarketingFilename(file.name)}`;
      checkError(
        await client.storage
          .from("sales-desk-attachments")
          .upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          }),
      );
      const row = await client
        .from("sales_desk_rfq_attachments")
        .insert({
          rfq_id: id,
          original_name: file.name,
          storage_path: path,
          content_type: file.type || "application/octet-stream",
          size: file.size,
          uploaded_by: userId,
        })
        .select()
        .single();
      if (row.error) {
        await client.storage.from("sales-desk-attachments").remove([path]);
        throw new Error(row.error.message);
      }
      return detail(id);
    },
    async attachmentUrl(
      id: string,
      attachment: RfqAttachment,
      inline: boolean,
    ): Promise<{ url: string; temporary: boolean }> {
      if (client) {
        const signed = await client.storage
          .from("sales-desk-attachments")
          .createSignedUrl(attachment.storage_path, 300);
        checkError(signed);
        if (!signed.data?.signedUrl)
          throw new Error("Could not create a file link.");
        return { url: signed.data.signedUrl, temporary: false };
      }
      const response = await fetch(
        `${API}/api/sales-desk/rfqs/${id}/attachments/${attachment.id}?inline=${inline}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(
          describeError(
            body && typeof body === "object" && "detail" in body
              ? body.detail
              : null,
            response.status,
          ),
        );
      }
      return {
        url: URL.createObjectURL(await response.blob()),
        temporary: true,
      };
    },
    async deleteAttachment(id: string, attachmentId: string): Promise<void> {
      if (!client) {
        await http(`/rfqs/${id}/attachments/${attachmentId}`, {
          method: "DELETE",
        });
        return;
      }
      await deleteRecordAttachment(client, "rfq", id, attachmentId);
    },
  };
}
export type RfqService = ReturnType<typeof createRfqService>;
