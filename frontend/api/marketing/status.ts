import { withApiErrors, requireMethod } from "../_lib/http.ts";
import { requireMarketingSession } from "../_lib/auth.ts";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["GET"]);
  const { admin, settings } = await requireMarketingSession(req, "workspace");
  const { data: connections, error: connectionError } = await admin
    .from("provider_connections")
    .select(
      "provider,status,account_name,page_id,page_name,followers_count,last_checked_at,last_success_at,last_synced_at,last_error",
    )
    .eq("is_workspace_connection", true);
  if (connectionError)
    return res
      .status(500)
      .json({ detail: "Could not load shared provider connections." });
  const connected = new Map(
    (connections || []).map((connection: any) => [
      connection.provider,
      connection,
    ]),
  );
  return res.status(200).json({
    authenticated: true,
    providers: {
      facebook: connected.get("facebook") || { status: "not_connected" },
      instagram: connected.get("instagram") || { status: "not_connected" },
    },
    publishing: false,
    metaConfigured: Boolean(settings.appId && settings.appSecret),
    message:
      "Provider connection storage is ready. OAuth and publishing are not enabled yet.",
  });
});
