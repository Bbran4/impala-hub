import { withApiErrors, requireMethod, HttpError } from "../../_lib/http.ts";
import { requireMarketingSession } from "../../_lib/auth.ts";
import { createAdminClient } from "../../_lib/supabase.ts";
import { decryptToken } from "../../_lib/metaCrypto.ts";
import { syncFacebookPage, SYNC_WORK_MS } from "./_sync.ts";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["POST"]);
  const { user, settings } = await requireMarketingSession(req, "refresh", {
    required: ["encryptionKey"],
    configurationMessage: "Facebook sync server configuration is incomplete.",
  });
  const signal = AbortSignal.timeout(SYNC_WORK_MS);
  const admin = createAdminClient(settings, undefined, signal);
  try {
    const { data: connection, error } = await admin
      .from("provider_connections")
      .select("*")
      .eq("provider", "facebook")
      .eq("is_workspace_connection", true)
      .maybeSingle();
    if (error)
      throw new HttpError(500, "Could not load the Facebook connection.");
    if (!connection?.page_id || !connection.token_ciphertext)
      return res.status(409).json({ detail: "Facebook is not connected." });
    const token = decryptToken(
      connection.token_ciphertext,
      settings.encryptionKey,
    );
    const result = await syncFacebookPage(
      admin,
      user.id,
      connection,
      token,
      signal,
    );
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return res
      .status(502)
      .json({
        detail:
          "Facebook sync failed. Check post statuses before refreshing again.",
      });
  }
});
