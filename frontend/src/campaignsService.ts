import type { SupabaseClient } from "@supabase/supabase-js";
import type { Campaign } from "./marketingTypes";
import { loadAllRows } from "./pagedRows.ts";
import { loadMarketingCampaigns } from "./recordLists.ts";
import { checkError, resultData } from "./serviceTransport";
import { requireSupabase, supabase } from "./supabase";
export type CampaignValues = Omit<Campaign, "id">;
export function createCampaignsService(
  client: SupabaseClient | null = supabase,
) {
  const userId = async () => {
    const dbClient = requireSupabase(client);
    const { data, error } = await dbClient!.auth.getSession();
    if (error || !data.session?.user)
      throw new Error("Sign in again to create a campaign.");
    return data.session.user.id;
  };
  return {
    async list(): Promise<Campaign[]> {
      const dbClient = requireSupabase(client);
      return (await loadMarketingCampaigns(dbClient)).data as Campaign[];
    },
    async options(): Promise<Campaign[]> {
      const dbClient = requireSupabase(client);
      return (
        await loadAllRows<Campaign>((from, to) =>
          dbClient
            .rpc("my_marketing_campaign_options", {}, { count: "exact" })
            .order("id")
            .range(from, to),
        )
      ).data;
    },
    async postCounts(): Promise<
      {
        campaign_id: string;
        post_count: number;
      }[]
    > {
      const dbClient = requireSupabase(client);
      return (
        await loadAllRows<{
          campaign_id: string;
          post_count: number;
        }>((from, to) =>
          dbClient
            .rpc("my_marketing_campaign_post_counts", {}, { count: "exact" })
            .order("campaign_id")
            .range(from, to),
        )
      ).data;
    },
    async create(values: CampaignValues): Promise<Campaign> {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient
          .from("campaigns")
          .insert({ ...values, owner_id: await userId() })
          .select()
          .single(),
      );
    },
    async update(
      id: string,
      values: Partial<CampaignValues>,
    ): Promise<Campaign> {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient
          .from("campaigns")
          .update(values)
          .eq("id", id)
          .select()
          .single(),
      );
    },
    async remove(id: string): Promise<void> {
      const dbClient = requireSupabase(client);
      checkError(await dbClient.from("campaigns").delete().eq("id", id));
    },
    async types(): Promise<
      {
        name: string;
        position: number;
      }[]
    > {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient
          .from("campaign_types")
          .select("name,position")
          .order("position"),
      );
    },
    async addType(name: string): Promise<void> {
      const dbClient = requireSupabase(client);
      checkError(
        await dbClient
          .from("campaign_types")
          .insert({ name, position: 999 })
          .select()
          .single(),
      );
    },
    async removeType(name: string): Promise<void> {
      const dbClient = requireSupabase(client);
      checkError(
        await dbClient.from("campaign_types").delete().eq("name", name),
      );
    },
    async reorderTypes(names: string[]): Promise<void> {
      const dbClient = requireSupabase(client);
      checkError(
        await dbClient.rpc("admin_reorder_campaign_types", { p_names: names }),
      );
    },
  };
}
export const campaignsService = createCampaignsService();
