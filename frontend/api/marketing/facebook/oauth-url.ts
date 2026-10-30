import { withApiErrors, requireMethod } from "../../_lib/http.ts";
import { requireMarketingSession } from "../../_lib/auth.ts";
import crypto from "node:crypto";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["POST"]);
  const { admin, user, settings } = await requireMarketingSession(
    req,
    "accounts",
    {
      required: ["appId", "redirectUri"],
      configurationMessage:
        "Facebook OAuth server configuration is incomplete.",
    },
  );
  const appId = settings.appId,
    redirectUri = settings.redirectUri;
  const state = crypto.randomBytes(32).toString("base64url");
  const { error } = await admin
    .from("oauth_states")
    .insert({
      state,
      provider: "facebook",
      owner_id: user.id,
      redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
  if (error)
    return res
      .status(500)
      .json({
        detail: `Could not create Facebook OAuth state. Apply the latest Supabase migration and retry. (${error.code || "database error"})`,
      });
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope:
      "ads_management,ads_read,business_management,pages_manage_engagement,pages_manage_metadata,pages_manage_posts,pages_messaging,pages_read_engagement,pages_read_user_content,pages_show_list,read_insights,instagram_basic,instagram_content_publish,instagram_manage_comments,instagram_manage_contents,instagram_manage_engagement,instagram_manage_insights,instagram_manage_messages",
  });
  return res
    .status(200)
    .json({
      url: `https://www.facebook.com/dialog/oauth?${params.toString()}`,
    });
});
