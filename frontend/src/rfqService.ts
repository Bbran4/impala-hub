import type { SupabaseClient } from "@supabase/supabase-js";
import { safeMarketingFilename } from "./marketingPosts.ts";
import { loadAllRows } from "./pagedRows.ts";
import { deleteRecordAttachment } from "./recordAttachments";
import { loadRfqList } from "./recordLists.ts";
import type {
  AnalyticsFilters,
  ConfigKind,
  ConfigOption,
  ConfigPatch,
  RawRfq,
  Rfq,
  RfqAnalytics,
  RfqAttachment,
  RfqAudit,
  RfqConfig,
  RfqCreate,
  RfqDashboard,
  RfqList,
  RfqValues,
  SalesDeskUser,
} from "./rfqTypes";
import { createSalesDeskSessionCache } from "./salesDeskSession.ts";
import { AuthError, checkError, resultData } from "./serviceTransport";
import { requireSupabase, supabase } from "./supabase";
export type * from "./rfqTypes";
const session = supabase ? createSalesDeskSessionCache(supabase) : null;
supabase?.auth.onAuthStateChange((event, value) =>
  session?.authChanged(event, value),
);
export const clearRfqSession = () => session?.clear();
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
export function createRfqService(client: SupabaseClient | null = supabase) {
  const cachedSession =
    client === supabase
      ? session
      : client
        ? createSalesDeskSessionCache(client)
        : null;
  const command = async (name: string, args: object): Promise<Rfq> => {
    const dbClient = requireSupabase(client);
    return resultData<Rfq>(await dbClient.rpc(name, args));
  };
  const detail = async (id: string): Promise<Rfq> => {
    const dbClient = requireSupabase(client);
    const row = resultData<RawRfq>(
      await dbClient
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
        dbClient
          .from("sales_desk_rfq_audit")
          .select("id,action,changes,created_at,actor_user_id", {
            count: "exact",
          })
          .eq("rfq_id", id)
          .order("id")
          .range(from, to),
      ),
      loadAllRows<RfqAttachment>((from, to) =>
        dbClient
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
      const people = resultData<
        {
          id: string;
          display_name: string;
        }[]
      >(
        await dbClient
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
      requireSupabase(client);
      return cachedSession!.get();
    },
    async list(): Promise<RfqList> {
      const dbClient = requireSupabase(client);
      const rows = await loadRfqList(dbClient);
      const items = (rows.data as RawRfq[]).map(normalizeRfq);
      return { items, total: rows.count, limit: items.length, offset: 0 };
    },
    async configuration(): Promise<RfqConfig> {
      const dbClient = requireSupabase(client);
      return resultData<RfqConfig>(
        await dbClient.rpc("sales_desk_configuration"),
      );
    },
    async create(values: RfqCreate): Promise<Rfq> {
      requireSupabase(client);
      return command("create_sales_desk_rfq", { p_values: values });
    },
    async update(id: string, values: Partial<RfqValues>): Promise<Rfq> {
      requireSupabase(client);
      return command("update_sales_desk_rfq", { p_id: id, p_values: values });
    },
    async claim(id: string): Promise<Rfq> {
      requireSupabase(client);
      return command("claim_sales_desk_rfq", { p_id: id });
    },
    async archive(id: string): Promise<void> {
      const dbClient = requireSupabase(client);
      checkError(await dbClient.rpc("archive_sales_desk_rfq", { p_id: id }));
    },
    async convertToInvoice(id: string): Promise<{
      id: string;
      rfq_no: string;
    }> {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient
          .rpc("convert_sales_desk_rfq_to_invoice", { source_id: id })
          .single(),
      );
    },
    async sendForApproval(id: string): Promise<void> {
      requireSupabase(client);
      throw new Error(
        "Approval requests are not enabled yet. No approval request has been sent.",
      );
    },
    async dashboard(): Promise<RfqDashboard> {
      const dbClient = requireSupabase(client);
      return resultData<RfqDashboard>(
        await dbClient.rpc("sales_desk_dashboard"),
      );
    },
    async analytics(filters: AnalyticsFilters): Promise<RfqAnalytics> {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient.rpc("sales_desk_analytics", {
          p_period: filters.period,
          p_year: filters.year,
          p_month: filters.month,
          p_week: filters.week,
        }),
      );
    },
    async addOption(
      kind: "media-platforms" | "statuses",
      values: ConfigPatch & {
        name: string;
      },
    ): Promise<ConfigOption> {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient
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
      const dbClient = requireSupabase(client);
      checkError(
        await dbClient
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
      const dbClient = requireSupabase(client);
      const used = await dbClient
        .from("sales_desk_rfqs")
        .select("id", { count: "exact", head: true })
        .eq(kind === "media-platforms" ? "media_platform_id" : "status_id", id);
      checkError(used);
      if ((used.count || 0) > 0)
        throw new Error(
          "This option is used by an existing RFQ. Deactivate it instead of deleting it.",
        );
      checkError(await dbClient.from(configTables[kind]).delete().eq("id", id));
    },
    async reorder(
      kind: "media-platforms" | "statuses",
      ids: string[],
    ): Promise<void> {
      const dbClient = requireSupabase(client);
      checkError(
        await dbClient.rpc("reorder_sales_desk_config", {
          p_kind: kind,
          p_ids: ids,
        }),
      );
    },
    async uploadAttachment(id: string, file: File): Promise<Rfq> {
      const dbClient = requireSupabase(client);
      const { data } = await dbClient.auth.getSession();
      if (!data.session?.user)
        throw new AuthError("Sign in again to attach files.");
      if (file.size > 15 * 1024 * 1024)
        throw new Error("Maximum attachment size is 15 MB.");
      const userId = data.session.user.id;
      const path = `${userId}/${id}/${crypto.randomUUID()}-${safeMarketingFilename(file.name)}`;
      checkError(
        await dbClient.storage
          .from("sales-desk-attachments")
          .upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          }),
      );
      const row = await dbClient
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
        await dbClient.storage.from("sales-desk-attachments").remove([path]);
        throw new Error(row.error.message);
      }
      return detail(id);
    },
    async attachmentUrl(attachment: RfqAttachment): Promise<string> {
      const dbClient = requireSupabase(client);
      const signed = await dbClient!.storage
        .from("sales-desk-attachments")
        .createSignedUrl(attachment.storage_path, 300);
      checkError(signed);
      if (!signed.data?.signedUrl)
        throw new Error("Could not create a file link.");
      return signed.data.signedUrl;
    },
    async deleteAttachment(id: string, attachmentId: string): Promise<void> {
      const dbClient = requireSupabase(client);
      await deleteRecordAttachment(dbClient, "rfq", id, attachmentId);
    },
  };
}
export type RfqService = ReturnType<typeof createRfqService>;
