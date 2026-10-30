import { withApiErrors, requireMethod } from "../../_lib/http.ts";
import {
  serverSettings,
  requireSettings,
  missingSettings,
} from "../../_lib/config.ts";
import { createAdminClient } from "../../_lib/supabase.ts";
import { encryptToken } from "../../_lib/metaCrypto.ts";
import { facebookGraphUrl } from "../../_lib/facebook.ts";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["GET"]);
  const settings = serverSettings();
  const frontend =
    settings.frontendUrl || "https://impala-hub-marketing.vercel.app";
  const redirect = (reason: string) =>
    res.redirect(
      `${frontend}/?facebook_oauth=error&reason=${encodeURIComponent(reason)}`,
    );
  const { code, state, error } = req.query || {};
  if (error) return redirect("authorization_cancelled");
  if (!code || !state) return redirect("missing_code");
  const required = [
    "url",
    "serviceRoleKey",
    "appId",
    "appSecret",
    "redirectUri",
    "encryptionKey",
  ] as const;
  if (missingSettings(settings, required).length)
    return redirect("server_configuration");
  requireSettings(settings, required);
  const { appId, appSecret, redirectUri, encryptionKey } = settings;
  const admin = createAdminClient(settings);
  const { data: stateRow } = await admin
    .from("oauth_states")
    .select("owner_id")
    .eq("state", state)
    .eq("provider", "facebook")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!stateRow) return redirect("invalid_state");
  await admin.from("oauth_states").delete().eq("state", state);
  try {
    const tokenUrl = new URL(facebookGraphUrl("oauth/access_token"));
    tokenUrl.search = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code: String(code),
    }).toString();
    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token)
      return redirect("token_exchange_failed");
    const pagesResponse = await fetch(
      facebookGraphUrl(
        `me/accounts?fields=id,name,access_token,tasks&access_token=${encodeURIComponent(tokenData.access_token)}`,
      ),
    );
    const pagesData = await pagesResponse.json();
    const pages = (pagesData.data || [])
      .filter((page: any) => page.id && page.name && page.access_token)
      .map((page: any) => ({
        id: page.id,
        name: page.name,
        tasks: page.tasks || [],
        token: encryptToken(page.access_token, encryptionKey),
      }));
    if (!pages.length) return redirect("page_token_unavailable");
    await admin
      .from("oauth_page_choices")
      .upsert({
        owner_id: stateRow.owner_id,
        provider: "facebook",
        pages,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
    return res.redirect(`${frontend}/?facebook_oauth=choose_page`);
  } catch {
    return redirect("oauth_failed");
  }
});
