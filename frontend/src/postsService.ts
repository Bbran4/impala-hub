import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import {
  resultData,
  checkError,
  legacyRequest,
  jsonBody,
  marketingRequest,
} from "./serviceTransport";
import {
  loadPostPage,
  safeMarketingFilename,
  type PostFilters,
  type PostPage,
} from "./marketingPosts.ts";
import type {
  Post,
  Media,
  HistoryEntry,
  PostWriteStatus,
} from "./marketingTypes";
export type PostValues = Pick<
  Post,
  | "title"
  | "caption"
  | "campaign_id"
  | "channels"
  | "media"
  | "publish_at"
  | "whatsapp_recipient_type"
  | "whatsapp_recipient_id"
  | "whatsapp_recipient_name"
> & { status: PostWriteStatus };
export type PostPatch = Partial<PostValues>;
export function createPostsService(client: SupabaseClient | null = supabase) {
  return {
    async list(filters: PostFilters = {}): Promise<PostPage> {
      if (client) return loadPostPage(client, filters);
      const params = new URLSearchParams(
        Object.entries(filters)
          .filter(([, value]) => value != null)
          .map(([key, value]) => [key, String(value)]),
      );
      const rows = await legacyRequest<Post[]>("/api/posts?" + params);
      return {
        items: rows,
        total: rows.length,
        offset: filters.offset || 0,
        limit: filters.limit || 50,
        summary: [],
      };
    },
    async detail(id: string): Promise<Post> {
      return client
        ? resultData(
            await client.from("posts").select("*").eq("id", id).single(),
          )
        : legacyRequest(`/api/posts/${id}`);
    },
    async create(values: PostValues): Promise<Post> {
      return client
        ? resultData(
            await client
              .rpc("save_marketing_post", { p_id: null, p_values: values })
              .single(),
          )
        : legacyRequest("/api/posts", { method: "POST", ...jsonBody(values) });
    },
    async update(id: string, values: PostPatch): Promise<Post> {
      return client
        ? resultData(
            await client
              .rpc("save_marketing_post", { p_id: id, p_values: values })
              .single(),
          )
        : legacyRequest(`/api/posts/${id}`, {
            method: "PATCH",
            ...jsonBody(values),
          });
    },
    async remove(id: string): Promise<void> {
      if (client) checkError(await client.from("posts").delete().eq("id", id));
      else await legacyRequest(`/api/posts/${id}`, { method: "DELETE" });
    },
    async history(id: string, before?: number): Promise<HistoryEntry[]> {
      if (!client)
        return legacyRequest(
          `/api/posts/${id}/history${before == null ? "" : `?before=${before}`}`,
        );
      let query = client
        .from("audit_log")
        .select("id,action,details,created_at")
        .eq("entity_type", "post")
        .eq("entity_id", id)
        .order("id", { ascending: false })
        .limit(50);
      if (before != null) query = query.lt("id", before);
      return resultData<HistoryEntry[]>(await query).map((item) => ({
        ...item,
        details: item.details || {},
      }));
    },
    async publish(id: string): Promise<unknown> {
      return client
        ? marketingRequest(
            `/api/marketing/facebook/publish?post_id=${encodeURIComponent(id)}`,
            "Facebook publishing",
            { method: "POST" },
          )
        : legacyRequest(`/api/posts/${id}/publish-now`, { method: "POST" });
    },
    async upload(file: File): Promise<Media> {
      if (!client) {
        const body = new FormData();
        body.append("file", file);
        return legacyRequest("/api/media", { method: "POST", body });
      }
      const { data, error } = await client.auth.getSession();
      if (error || !data.session?.user)
        throw new Error("Sign in again to upload media.");
      const user = data.session.user;
      const path = `${user.id}/${crypto.randomUUID()}-${safeMarketingFilename(file.name)}`;
      checkError(
        await client.storage
          .from("marketing-media")
          .upload(path, file, {
            contentType: file.type || undefined,
            upsert: false,
          }),
      );
      return {
        id: path,
        name: file.name,
        url: client.storage.from("marketing-media").getPublicUrl(path).data
          .publicUrl,
        content_type: file.type,
        size: file.size,
      };
    },
  };
}
export const postsService = createPostsService();
