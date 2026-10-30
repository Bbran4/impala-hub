import { withApiErrors, requireMethod } from "../../_lib/http.ts";
import {
  serverSettings,
  missingSettings,
  facebookSettings,
} from "../../_lib/config.ts";
export default withApiErrors((req, res) => {
  requireMethod(req, ["GET"]);
  const missing = missingSettings(serverSettings(), facebookSettings);
  return res.status(200).json({ configured: missing.length === 0, missing });
});
