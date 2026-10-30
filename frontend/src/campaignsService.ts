import { loadAllRows } from "./pagedRows.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import {
  resultData,
  checkError,
  legacyRequest,
  jsonBody,
} from "./serviceTransport";
import { loadMarketingCampaigns } from "./recordLists.ts";
import type { Campaign } from "./marketingTypes";
export type CampaignValues = Omit<Campaign, "id">;
export function createCampaignsService(
  client: SupabaseClient | null = supabase,
) {
  const userId = async () => {
    const { data, error } = await client!.auth.getSession();
    if (error || !data.session?.user)
      throw new Error("Sign in again to create a campaign.");
    return data.session.user.id;
  };
  return {
    async list(): Promise<Campaign[]> {
      return client
        ? ((await loadMarketingCampaigns(client)).data as Campaign[])
        : legacyRequest("/api/campaigns");
    },
    async options(): Promise<Campaign[]> {
      if (!client) return legacyRequest("/api/campaigns");
      return (
        await loadAllRows<Campaign>((from, to) =>
          client
            .rpc("my_marketing_campaign_options", {}, { count: "exact" })
            .order("id")
            .range(from, to),
        )
      ).data;
    },
    async postCounts(): Promise<{ campaign_id: string; post_count: number }[]> {
      if (!client) return [];
      return (
        await loadAllRows<{ campaign_id: string; post_count: number }>(
          (from, to) =>
            client
              .rpc("my_marketing_campaign_post_counts", {}, { count: "exact" })
              .order("campaign_id")
              .range(from, to),
        )
      ).data;
    },
    async create(values: CampaignValues): Promise<Campaign> {
      return client
        ? resultData(
            await client
              .from("campaigns")
              .insert({ ...values, owner_id: await userId() })
              .select()
              .single(),
          )
        : legacyRequest("/api/campaigns", {
            method: "POST",
            ...jsonBody(values),
          });
    },
    async update(
      id: string,
      values: Partial<CampaignValues>,
    ): Promise<Campaign> {
      return client
        ? resultData(
            await client
              .from("campaigns")
              .update(values)
              .eq("id", id)
              .select()
              .single(),
          )
        : legacyRequest(`/api/campaigns/${id}`, {
            method: "PATCH",
            ...jsonBody(values),
          });
    },
    async remove(id: string): Promise<void> {
      if (client)
        checkError(await client.from("campaigns").delete().eq("id", id));
      else await legacyRequest(`/api/campaigns/${id}`, { method: "DELETE" });
    },
    async types(): Promise<{ name: string; position: number }[]> {
      return client
        ? resultData(
            await client
              .from("campaign_types")
              .select("name,position")
              .order("position"),
          )
        : legacyRequest("/api/campaign-types");
    },
    async addType(name: string): Promise<void> {
      if (client)
        checkError(
          await client
            .from("campaign_types")
            .insert({ name, position: 999 })
            .select()
            .single(),
        );
      else
        await legacyRequest("/api/campaign-types", {
          method: "POST",
          ...jsonBody({ name }),
        });
    },
    async removeType(name: string): Promise<void> {
      if (client)
        checkError(
          await client.from("campaign_types").delete().eq("name", name),
        );
      else
        await legacyRequest("/api/campaign-types/" + encodeURIComponent(name), {
          method: "DELETE",
        });
    },
    async reorderTypes(names: string[]): Promise<void> {
      if (client)
        checkError(
          await client.rpc("admin_reorder_campaign_types", { p_names: names }),
        );
      else
        await legacyRequest("/api/campaign-types/order", {
          method: "PUT",
          ...jsonBody({ names }),
        });
    },
  };
}
export const campaignsService = createCampaignsService();
