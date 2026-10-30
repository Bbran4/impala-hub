import { HttpError } from "./http.ts";
import type { ServerEnvironment } from "./config.ts";
// One version policy for OAuth, Page checks, sync, insights and publishing.
export const DEFAULT_FACEBOOK_API_VERSION = "v22.0";
export function facebookApiVersion(env: ServerEnvironment = process.env) {
  const version = env.FACEBOOK_API_VERSION || DEFAULT_FACEBOOK_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version))
    throw new HttpError(503, "FACEBOOK_API_VERSION must use the format v22.0.");
  return version;
}
export function facebookGraphUrl(
  path: string,
  env: ServerEnvironment = process.env,
) {
  return `https://graph.facebook.com/${facebookApiVersion(env)}/${path.replace(/^\/+/, "")}`;
}
