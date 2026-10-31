import { facebookMediaId } from "./_publishing.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoredFacebookMedia } from "../../_lib/facebookTypes.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
function trusted(url: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !["fbcdn.net", "fbsbx.com"].some(
      (host) =>
        parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error("Unsupported Facebook image host.");
}

async function imageBytes(url: string, signal?: AbortSignal) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    trusted(url);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([
        AbortSignal.timeout(15_000),
        ...(signal ? [signal] : []),
      ]),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get("location");
      if (!target) throw new Error("Missing image redirect.");
      await response.body?.cancel();
      url = new URL(target, url).href;
      continue;
    }
    const type = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (
      !response.ok ||
      !extensions[type] ||
      Number(response.headers.get("content-length") || 0) > MAX_BYTES ||
      !response.body
    )
      throw new Error("Unsupported or oversized Facebook image.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_BYTES)
          throw new Error("Facebook image exceeds 10 MB.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return { data: Buffer.concat(chunks), type, ext: extensions[type] };
  }
  throw new Error("Too many image redirects.");
}

// Persist only our own durable URLs. Provider URLs exist only during this request.
export async function copyFacebookMedia(
  admin: SupabaseClient,
  postId: string,
  urls: string[],
  existing: unknown[] = [],
  signal?: AbortSignal,
) {
  const bucket = admin.storage.from("marketing-media");
  const root = bucket.getPublicUrl("").data.publicUrl;
  const retained = existing.filter(
    (m): m is StoredFacebookMedia =>
      typeof m === "object" &&
      m !== null &&
      "url" in m &&
      typeof m.url === "string" &&
      m.url.startsWith(root),
  );
  const media: StoredFacebookMedia[] = [];
  let unavailable = 0;
  for (const url of [...new Set(urls)].slice(0, 10)) {
    signal?.throwIfAborted();
    try {
      trusted(url);
      const id = facebookMediaId(postId, url).replace(/[^a-zA-Z0-9_-]/g, "_");
      const prefix = `facebook/${postId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const cached = await bucket.list(prefix, { search: id, limit: 10 });
      const found = cached.error
        ? undefined
        : cached.data?.find(
            (entry) =>
              entry.name.startsWith(`${id}.`) &&
              Object.values(extensions).some(
                (ext) => entry.name === `${id}.${ext}`,
              ),
          );
      let name = found?.name;
      if (!name) {
        const image = await imageBytes(url, signal);
        name = `${id}.${image.ext}`;
        const saved = await bucket.upload(`${prefix}/${name}`, image.data, {
          contentType: image.type,
          upsert: true,
        });
        if (saved.error) throw saved.error;
      }
      const storagePath = `${prefix}/${name}`;
      media.push({
        id,
        name: "Facebook image",
        url: bucket.getPublicUrl(storagePath).data.publicUrl,
        storage_path: storagePath,
      });
    } catch {
      signal?.throwIfAborted();
      unavailable++;
    }
  }
  return { media: media.length ? media : retained, unavailable };
}
