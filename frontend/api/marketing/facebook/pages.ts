import { withApiErrors, requireMethod } from "../../_lib/http.ts";
import { requireMarketingSession } from "../../_lib/auth.ts";
export default withApiErrors(async (req, res) => {
  requireMethod(req, ["GET"]);
  const { admin, user } = await requireMarketingSession(req, "accounts", {
    required: [],
    configurationMessage:
      "Facebook connection storage is not configured in Vercel.",
  });
  const { data, error } = await admin
    .from("oauth_page_choices")
    .select("pages,expires_at")
    .eq("owner_id", user.id)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error)
    return res
      .status(500)
      .json({ detail: "Could not load the available Facebook Pages." });
  const pages = (data?.pages || []).map((page: any) => ({
    id: page.id,
    name: page.name,
    tasks: page.tasks || [],
  }));
  return res.status(200).json({ pages });
});
