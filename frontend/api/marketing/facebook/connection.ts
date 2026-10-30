import { withApiErrors, requireMethod } from "../../_lib/http.ts";
import { requireMarketingSession } from "../../_lib/auth.ts";
import { decryptToken } from "../../_lib/metaCrypto.ts";
import { facebookGraphUrl } from "../../_lib/facebook.ts";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["POST", "DELETE"]);
  const { admin, settings } = await requireMarketingSession(req, "accounts", {
    required: ["encryptionKey"],
    configurationMessage:
      "Facebook connection server configuration is incomplete.",
  });
  const { data: connection, error: loadError } = await admin
    .from("provider_connections")
    .select("*")
    .eq("provider", "facebook")
    .eq("is_workspace_connection", true)
    .maybeSingle();
  if (loadError)
    return res
      .status(500)
      .json({ detail: "Could not load the shared Facebook connection." });
  if (req.method === "DELETE") {
    const { error: deleteError } = await admin
      .from("provider_connections")
      .delete()
      .eq("provider", "facebook")
      .eq("is_workspace_connection", true);
    if (deleteError)
      return res.status(500).json({ detail: "Could not disconnect Facebook." });
    return res.status(200).json({ disconnected: true });
  }
  if (!connection?.page_id || !connection.token_ciphertext)
    return res
      .status(409)
      .json({ detail: "Facebook is not connected. Connect Facebook first." });
  const pageToken = decryptToken(
    connection.token_ciphertext,
    settings.encryptionKey,
  );
  const response = await fetch(
    facebookGraphUrl(
      `${encodeURIComponent(connection.page_id)}?fields=id,name&access_token=${encodeURIComponent(pageToken)}`,
    ),
  );
  const result = await response.json();
  if (!response.ok || !result.id) {
    const { error: saveError } = await admin
      .from("provider_connections")
      .update({
        status: "error",
        last_error: "Facebook rejected the Page token.",
        last_checked_at: new Date().toISOString(),
      })
      .eq("id", connection.id);
    if (saveError)
      return res
        .status(500)
        .json({
          detail:
            "Facebook rejected the token and its status could not be saved.",
        });
    return res
      .status(502)
      .json({
        detail: "Facebook rejected the saved Page token. Reconnect Facebook.",
      });
  }
  const { error: saveError } = await admin
    .from("provider_connections")
    .update({
      status: "connected",
      page_name: result.name || connection.page_name,
      account_name: result.name || connection.account_name,
      last_checked_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", connection.id);
  if (saveError)
    return res
      .status(500)
      .json({
        detail:
          "Facebook passed the live check, but the result could not be saved.",
      });
  return res
    .status(200)
    .json({ page_id: result.id, page_name: result.name, status: "connected" });
});
