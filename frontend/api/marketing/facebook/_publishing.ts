import { decryptToken } from "../../_lib/metaCrypto.ts";
import { facebookGraphUrl } from "../../_lib/facebook.ts";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FacebookPublishPost,
  FacebookConnection,
} from "../../_lib/facebookTypes.ts";
import {
  facebookPostMedia,
  MAX_POST_IMAGES,
} from "../../../src/facebookPostMedia.ts";

const REQUEST_TIMEOUT = 20_000;
const RECEIPT_RESERVE = 10_000;

export function publishingBudget(media: unknown): number {
  // Invalid legacy drafts fail validation without contacting Facebook.
  const count = Array.isArray(media)
    ? Math.min(media.length, MAX_POST_IMAGES)
    : 0;
  return (count > 1 ? count + 1 : 1) * REQUEST_TIMEOUT + RECEIPT_RESERVE;
}

export const facebookMediaId = (postId: string, url: string) =>
  `${postId}-${crypto.createHash("sha256").update(url.split("?")[0]).digest("hex").slice(0, 16)}`;

// A timeout is an unknown outcome: Facebook may already have accepted the post.
// Never automatically retry an ambiguous external side effect.
export async function publishClaimed(
  admin: SupabaseClient,
  post: FacebookPublishPost,
  connection: FacebookConnection | null,
  secret: string,
  deadline = Date.now() + 260_000,
) {
  let dispatched = false;
  let rejected = false;
  try {
    if (!connection?.page_id || !connection.token_ciphertext)
      throw new Error("Facebook is not connected.");
    const media = facebookPostMedia(post.media ?? []);
    const photo = media.length === 1 && media[0]?.url;
    const params: Record<string, unknown> = {
      access_token: decryptToken(connection.token_ciphertext, secret),
      message: post.caption || post.title || "",
    };
    // These uploads cannot publish a Page story. Only the final feed call can.
    // Do not delete staging assets after an ambiguous final call: the live post
    // may already reference them. Temporary, unpublished assets are safe to abandon.
    if (media.length > 1) {
      const attached: { media_fbid: string }[] = [];
      for (const [index, image] of media.entries()) {
        if (Date.now() + REQUEST_TIMEOUT + RECEIPT_RESERVE > deadline)
          throw new Error(
            "Image uploads exceeded the publishing time limit. No post was published. Try again.",
          );
        let uploaded: { id?: string; error?: unknown };
        try {
          const response = await fetch(
            facebookGraphUrl(`${connection.page_id}/photos`),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                access_token: params.access_token,
                url: image.url,
                published: false,
                temporary: true,
              }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            },
          );
          uploaded = await response.json();
          if (
            !response.ok ||
            uploaded.error ||
            typeof uploaded.id !== "string" ||
            !uploaded.id
          )
            throw new Error("Upload was not confirmed");
        } catch {
          throw new Error(
            `Facebook could not prepare image ${index + 1}. No post was published. Check the image and try again.`,
          );
        }
        attached.push({ media_fbid: uploaded.id });
      }
      params.attached_media = attached;
    }
    if (photo) params.url = media[0].url;
    const endpoint = facebookGraphUrl(
      `${connection.page_id}/${photo ? "photos" : "feed"}`,
    );
    if (Date.now() + REQUEST_TIMEOUT + RECEIPT_RESERVE > deadline)
      throw new Error(
        "Image uploads exceeded the publishing time limit. No post was published. Try again.",
      );
    dispatched = true;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
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
  admin: SupabaseClient,
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
