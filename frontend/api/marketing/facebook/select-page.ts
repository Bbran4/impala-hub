import { withApiErrors, requireMethod } from "../../_lib/http.ts";
import { requireMarketingSession } from "../../_lib/auth.ts";
import { decryptToken } from "../../_lib/metaCrypto.ts";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["POST"]);
  const { admin, user, settings } = await requireMarketingSession(
    req,
    "accounts",
    {
      required: ["encryptionKey"],
      configurationMessage:
        "Facebook connection storage is not configured in Vercel.",
    },
  );
  const encryptionKey = settings.encryptionKey;
  const { page_id } = req.body || {};
  if (!page_id)
    return res.status(400).json({ detail: "Choose a Facebook Page." });
  const { data: choices } = await admin
    .from("oauth_page_choices")
    .select("pages")
    .eq("owner_id", user.id)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  const page = (choices?.pages || []).find(
    (item: any) => item.id === String(page_id),
  );
  if (!page)
    return res
      .status(400)
      .json({
        detail:
          "That Facebook Page selection has expired. Connect Facebook again.",
      });
  try {
    const pageToken = decryptToken(page.token, encryptionKey);
    const now = new Date().toISOString();
    const connection = {
      page_id: page.id,
      page_name: page.name,
      account_name: page.name,
      token_ciphertext: page.token,
      scopes: page.tasks || [],
      status: "connected",
      last_checked_at: now,
      last_success_at: now,
      last_error: null,
      is_workspace_connection: true,
    };
    const { data: shared } = await admin
      .from("provider_connections")
      .select("id")
      .eq("provider", "facebook")
      .eq("is_workspace_connection", true)
      .maybeSingle();
    let error;
    if (shared?.id) {
      error = (
        await admin
          .from("provider_connections")
          .update(connection)
          .eq("id", shared.id)
      ).error;
    } else {
      const { data: owned } = await admin
        .from("provider_connections")
        .select("id")
        .eq("provider", "facebook")
        .eq("owner_id", user.id)
        .maybeSingle();
      if (owned?.id)
        error = (
          await admin
            .from("provider_connections")
            .update(connection)
            .eq("id", owned.id)
        ).error;
      else
        error = (
          await admin
            .from("provider_connections")
            .insert({ ...connection, provider: "facebook", owner_id: user.id })
        ).error;
    }
    if (error)
      return res
        .status(500)
        .json({ detail: "Could not save the Facebook Page connection." });
    await admin.from("oauth_page_choices").delete().eq("owner_id", user.id);
    void pageToken;
    return res
      .status(200)
      .json({
        provider: "facebook",
        status: "connected",
        page_id: page.id,
        page_name: page.name,
      });
  } catch {
    return res
      .status(500)
      .json({ detail: "Could not protect the Facebook Page token." });
  }
});
