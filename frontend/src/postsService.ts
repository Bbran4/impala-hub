import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadPostPage,
  safeMarketingFilename,
  type PostFilters,
  type PostPage,
} from "./marketingPosts.ts";
import type {
  HistoryEntry,
  Media,
  Post,
  PostWriteStatus,
} from "./marketingTypes";
import { checkError, marketingRequest, resultData } from "./serviceTransport";
import { requireSupabase, supabase } from "./supabase";
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
> & {
  status: PostWriteStatus;
};
export type PostPatch = Partial<PostValues>;
export function createPostsService(client: SupabaseClient | null = supabase) {
  return {
    async list(filters: PostFilters = {}): Promise<PostPage> {
      const dbClient = requireSupabase(client);
      return loadPostPage(dbClient!, filters);
    },
    async detail(id: string): Promise<Post> {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient.from("posts").select("*").eq("id", id).single(),
      );
    },
    async create(values: PostValues): Promise<Post> {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient
          .rpc("save_marketing_post", { p_id: null, p_values: values })
          .single(),
      );
    },
    async update(id: string, values: PostPatch): Promise<Post> {
      const dbClient = requireSupabase(client);
      return resultData(
        await dbClient
          .rpc("save_marketing_post", { p_id: id, p_values: values })
          .single(),
      );
    },
    async remove(id: string): Promise<void> {
      const dbClient = requireSupabase(client);
      checkError(await dbClient.from("posts").delete().eq("id", id));
    },
    async history(id: string, before?: number): Promise<HistoryEntry[]> {
      const dbClient = requireSupabase(client);
      let query = dbClient
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
      requireSupabase(client);
      return marketingRequest(
        `/api/marketing/facebook/publish?post_id=${encodeURIComponent(id)}`,
        "Facebook publishing",
        { method: "POST" },
      );
    },
    async upload(file: File): Promise<Media> {
      const dbClient = requireSupabase(client);
      const { data, error } = await dbClient.auth.getSession();
      if (error || !data.session?.user)
        throw new Error("Sign in again to upload media.");
      const user = data.session.user;
      const path = `${user.id}/${crypto.randomUUID()}-${safeMarketingFilename(file.name)}`;
      checkError(
        await dbClient.storage.from("marketing-media").upload(path, file, {
          contentType: file.type || undefined,
          upsert: false,
        }),
      );
      return {
        id: path,
        name: file.name,
        url: dbClient.storage.from("marketing-media").getPublicUrl(path).data
          .publicUrl,
        content_type: file.type,
        size: file.size,
      };
    },
  };
}
export const postsService = createPostsService();
