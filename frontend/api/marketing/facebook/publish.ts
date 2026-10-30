import { withApiErrors, requireMethod } from "../../_lib/http.ts";
import { requireMarketingSession } from "../../_lib/auth.ts";
import { claimPost, publishClaimed } from "./_publishing.js";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["POST"]);
  const { admin, user, settings } = await requireMarketingSession(
    req,
    "publishing",
    {
      required: ["encryptionKey"],
      configurationMessage:
        "Facebook publishing server configuration is incomplete.",
    },
  );
  const encryptionKey = settings.encryptionKey;
  const postId = String(req.query?.post_id || "");
  const [{ data: post }, { data: connection }] = await Promise.all([
    admin
      .from("posts")
      .select("*")
      .eq("id", postId)
      .eq("created_by", user.id)
      .maybeSingle(),
    admin
      .from("provider_connections")
      .select("*")
      .eq("provider", "facebook")
      .eq("is_workspace_connection", true)
      .maybeSingle(),
  ]);
  if (!post) return res.status(404).json({ detail: "Post not found." });
  if (!connection?.page_id || !connection.token_ciphertext)
    return res
      .status(409)
      .json({ detail: "Facebook is not connected. Connect Facebook first." });
  try {
    const claimed = await claimPost(
      admin,
      post.id,
      ["draft", "awaiting_approval", "failed", "scheduled"],
      user.id,
    );
    if (!claimed)
      return res
        .status(409)
        .json({
          detail:
            "This post is already published, publishing, or awaiting reconciliation.",
        });
    const outcome = await publishClaimed(
      admin,
      claimed,
      connection,
      encryptionKey,
    );
    return res.status(outcome.status === "published" ? 200 : 502).json(outcome);
  } catch {
    return res
      .status(500)
      .json({
        detail:
          "Could not persist the publishing attempt. Do not retry until its status has been checked.",
      });
  }
});
