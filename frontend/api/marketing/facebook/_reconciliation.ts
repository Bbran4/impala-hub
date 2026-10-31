import { HttpError } from "../../_lib/http.ts";
import { facebookGraphUrl } from "../../_lib/facebook.ts";
import type {
  FacebookGraphPost,
  FacebookGraphRead,
} from "../../_lib/facebookTypes.ts";

export type VerifiedFacebookPost = {
  id: string;
  permalink: string;
  published_at: string;
  message: string;
};
export type ReviewContext = {
  pageId: string;
  token: string;
  caption: string;
  startedAt?: string | null;
};
const messageText = (value: string) => value.replace(/\r\n/g, "\n").trim();

export function facebookPostReference(value: string, pageId: string): string {
  let id = value.trim();
  if (id.startsWith("https://")) {
    const url = new URL(id);
    if (
      !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(
        url.hostname,
      )
    )
      throw new HttpError(400, "Use a Facebook post link or post ID.");
    id =
      url.searchParams.get("story_fbid") ||
      url.pathname.match(/\/posts\/(\d+)/)?.[1] ||
      url.pathname.replace(/^\/+|\/+$/g, "");
  }
  if (/^\d+$/.test(id)) id = `${pageId}_${id}`;
  if (!/^\d+_\d+$/.test(id) || !id.startsWith(`${pageId}_`))
    throw new HttpError(
      400,
      "Use the post ID from this connected Facebook Page, or find matching posts below.",
    );
  return id;
}

export function verifiedFacebookPost(
  value: FacebookGraphPost,
  context: ReviewContext,
): VerifiedFacebookPost {
  const id = String(value.id || "");
  const time = Date.parse(value.created_time || "");
  const start = context.startedAt ? Date.parse(context.startedAt) : null;
  if (
    !/^\d+_\d+$/.test(id) ||
    !id.startsWith(`${context.pageId}_`) ||
    String(value.from?.id) !== context.pageId
  )
    throw new HttpError(
      409,
      "This Facebook post does not belong to the connected Page.",
    );
  if (
    !Number.isFinite(time) ||
    time > Date.now() + 120_000 ||
    (start !== null &&
      (!Number.isFinite(start) ||
        time < start - 120_000 ||
        time > start + 600_000))
  )
    throw new HttpError(
      409,
      "This Facebook post is outside the publishing attempt time.",
    );
  if (messageText(String(value.message || "")) !== messageText(context.caption))
    throw new HttpError(
      409,
      "The Facebook post content does not match this publishing attempt.",
    );
  return {
    id,
    permalink: `https://www.facebook.com/${id}`,
    published_at: new Date(time).toISOString(),
    message: String(value.message || ""),
  };
}

async function graphRead(
  path: string,
  context: ReviewContext,
  fetcher: typeof fetch,
): Promise<FacebookGraphRead> {
  try {
    const response = await fetcher(
      facebookGraphUrl(
        path +
          (path.includes("?") ? "&" : "?") +
          `access_token=${encodeURIComponent(context.token)}`,
      ),
      { signal: AbortSignal.timeout(20_000) },
    );
    const result = await response.json();
    if (!response.ok || result.error)
      throw new HttpError(
        502,
        "Facebook could not verify this publication. Nothing has been changed.",
      );
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      502,
      "Facebook could not be reached to verify publication. Nothing has been changed.",
    );
  }
}
const fields = "id,from{id},message,created_time,permalink_url";
export async function verifyFacebookPublication(
  reference: string,
  context: ReviewContext,
  fetcher: typeof fetch = fetch,
) {
  const id = facebookPostReference(reference, context.pageId);
  return verifiedFacebookPost(
    await graphRead(
      `${id}?fields=${encodeURIComponent(fields)}`,
      context,
      fetcher,
    ),
    context,
  );
}
export async function findFacebookPublications(
  context: ReviewContext,
  fetcher: typeof fetch = fetch,
) {
  const start = context.startedAt ? Date.parse(context.startedAt) : null;
  const range =
    start !== null && Number.isFinite(start)
      ? `&since=${Math.floor((start - 120_000) / 1000)}&until=${Math.floor((start + 600_000) / 1000)}`
      : "";
  const result = await graphRead(
    `${context.pageId}/published_posts?fields=${encodeURIComponent(fields)}&limit=100${range}`,
    context,
    fetcher,
  );
  const matches: VerifiedFacebookPost[] = [];
  for (const post of result.data || []) {
    try {
      matches.push(verifiedFacebookPost(post, context));
    } catch {
      /* Different content/Page/attempt is not a candidate. */
    }
  }
  return { matches, more: Boolean(result.paging?.next) };
}
