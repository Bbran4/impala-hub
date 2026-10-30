import { supabase } from "./supabase";
import { legacyRequest, marketingRequest, jsonBody } from "./serviceTransport";
export type Integration = {
  provider: string;
  label?: string;
  note?: string;
  status: string;
  account_id?: string;
  account_name?: string;
  page_id?: string;
  page_name?: string;
  username?: string;
  followers_count?: number;
  last_synced_at?: string;
  last_checked_at?: string;
  last_success_at?: string;
  last_error?: string;
  diagnostic_note?: string;
  connection_source?: string;
  expires_at?: number;
  data_access_expires_at?: number;
  granted_permissions?: string[];
  missing_permissions?: string[];
  token_type?: string;
  token_warning?: string;
};
export type SyncResult = {
  status: string;
  detail?: string;
  items?: number;
  fetched?: number;
  metricsUnavailable?: number;
  metricsErrors?: string[];
  mediaUnavailable?: number;
  syncedAt?: string;
  audience?: number;
};
export type FacebookPage = { id: string; name: string; category?: string };
export const integrationsService = {
  async list(): Promise<Integration[]> {
    if (!supabase) return legacyRequest("/api/integrations");
    const result = await marketingRequest<{
      providers: Record<string, Omit<Integration, "provider">>;
    }>("/api/marketing/status", "Load provider connections");
    return ["facebook", "instagram"].map((provider) => ({
      provider,
      ...(result.providers?.[provider] || { status: "not_connected" }),
    }));
  },
  async sync(): Promise<{ facebook: SyncResult; instagram: SyncResult }> {
    if (!supabase)
      return legacyRequest("/api/integrations/sync", { method: "POST" });
    return {
      facebook: await marketingRequest(
        "/api/marketing/facebook/sync",
        "Facebook refresh",
        { method: "POST" },
      ),
      instagram: { status: "not_connected" },
    };
  },
  async facebookPages(): Promise<{
    pages: FacebookPage[];
    connected_page_id?: string;
  }> {
    return supabase
      ? marketingRequest("/api/marketing/facebook/pages", "Load Facebook Pages")
      : legacyRequest("/api/integrations/facebook/pages");
  },
  async connectFacebook(): Promise<{ url: string }> {
    const result = supabase
      ? await marketingRequest<{ url: string }>(
          "/api/marketing/facebook/oauth-url",
          "Facebook authorization",
          { method: "POST" },
        )
      : await legacyRequest<{ url: string }>(
          "/api/integrations/facebook/oauth-url",
          { method: "POST" },
        );
    if (typeof result.url !== "string")
      throw new Error(
        "Facebook authorization endpoint returned no authorization URL.",
      );
    return result;
  },
  async selectFacebookPage(
    pageId: string,
  ): Promise<{ page_id: string; page_name: string }> {
    return supabase
      ? marketingRequest(
          "/api/marketing/facebook/select-page",
          "Save Facebook Page",
          { method: "POST", ...jsonBody({ page_id: pageId }) },
        )
      : legacyRequest("/api/integrations/facebook/select-page", {
          method: "POST",
          ...jsonBody({ page_id: pageId }),
        });
  },
  async checkFacebook(): Promise<{ page_id: string; page_name: string }> {
    return supabase
      ? marketingRequest(
          "/api/marketing/facebook/connection",
          "Facebook connection check",
          { method: "POST" },
        )
      : legacyRequest("/api/integrations/facebook/check", { method: "POST" });
  },
  async disconnectFacebook(): Promise<void> {
    if (supabase)
      await marketingRequest(
        "/api/marketing/facebook/connection",
        "Facebook disconnect",
        { method: "DELETE" },
      );
    else
      await legacyRequest("/api/integrations/facebook/disconnect", {
        method: "POST",
      });
  },
  async connectInstagram(): Promise<{ url: string }> {
    if (supabase)
      throw new Error(
        "Instagram OAuth is the next provider migration and is not enabled yet.",
      );
    return legacyRequest("/api/integrations/instagram/oauth-url", {
      method: "POST",
    });
  },
  async checkInstagram(): Promise<{ username?: string; account_id: string }> {
    if (supabase)
      throw new Error("Instagram connection checks are not enabled yet.");
    return legacyRequest("/api/integrations/instagram/check", {
      method: "POST",
    });
  },
  async disconnectInstagram(): Promise<{ posts_removed: number }> {
    if (supabase) throw new Error("Instagram connections are not enabled yet.");
    return legacyRequest("/api/integrations/instagram/disconnect", {
      method: "POST",
    });
  },
};
