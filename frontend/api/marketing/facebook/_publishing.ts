import { decryptToken } from "../../_lib/metaCrypto.ts";
import { facebookGraphUrl } from "../../_lib/facebook.ts";
import crypto from "node:crypto";

export const facebookMediaId = (postId: string, url: string) =>
  `${postId}-${crypto.createHash("sha256").update(url.split("?")[0]).digest("hex").slice(0, 16)}`;

// A timeout is an unknown outcome: Facebook may already have accepted the post.
// Never automatically retry an ambiguous external side effect.
export async function publishClaimed(
  admin: any,
  post: any,
  connection: any,
  secret: string,
) {
  let dispatched = false;
  let rejected = false;
  try {
    if (!connection?.page_id || !connection.token_ciphertext)
      throw new Error("Facebook is not connected.");
    const media = Array.isArray(post.media) ? post.media : [];
    const photo = media.length === 1 && media[0]?.url;
    if (media.length > 1)
      throw new Error(
        "Multiple-image publishing is not supported. Use one image per post.",
      );
    const params: Record<string, string> = {
      access_token: decryptToken(connection.token_ciphertext, secret),
      message: post.caption || post.title || "",
    };
    if (photo) params.url = media[0].url;
    const endpoint = facebookGraphUrl(
      `${connection.page_id}/${photo ? "photos" : "feed"}`,
    );
    dispatched = true;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json();
    if (!response.ok || result.error || !result.id) {
      rejected = !!result.error && response.status < 500;
      throw new Error("Facebook did not confirm publication.");
    }
    // Photos return a photo id as well as the canonical Page post id.
    const facebookId = result.post_id || result.id;
    const saved = await admin
      .from("posts")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        provider_ids: { ...post.provider_ids, facebook: facebookId },
        last_error: null,
      })
      .eq("id", post.id)
      .in("status", ["publishing", "publish_unknown"])
      .select("id")
      .maybeSingle();
    if (saved.error || !saved.data)
      throw new Error(
        "Facebook accepted the post, but saving its receipt failed. Reconcile before retrying.",
      );
    return { id: post.id, status: "published", facebook_post_id: facebookId };
  } catch (error) {
    const status = dispatched && !rejected ? "publish_unknown" : "failed";
    const message =
      status === "publish_unknown"
        ? "Publication outcome is unknown. Check Facebook and reconcile this post before retrying."
        : (error as Error).message;
    const saved = await admin
      .from("posts")
      .update({ status, last_error: message })
      .eq("id", post.id)
      .eq("status", "publishing")
      .select("id")
      .maybeSingle();
    if (saved.error || !saved.data)
      throw new Error(
        "Could not persist the publishing outcome. Recovery will quarantine the unfinished attempt.",
      );
    return { id: post.id, status, detail: message };
  }
}

export async function claimPost(
  admin: any,
  id: string,
  statuses: string[],
  owner?: string,
  dueBefore?: string,
) {
  let query = admin
    .from("posts")
    .update({
      status: "publishing",
      publish_started_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", id)
    .in("status", statuses)
    .is("provider_ids->>facebook", null);
  if (owner) query = query.eq("created_by", owner);
  if (dueBefore) query = query.lte("publish_at", dueBefore);
  const result = await query.select("*").maybeSingle();
  if (result.error) throw new Error("Could not claim the post for publishing.");
  return result.data;
}
