import { createClient } from "@supabase/supabase-js";
import { bearerToken, HttpError, type ApiRequest } from "./http.ts";
import {
  serverSettings,
  requireSettings,
  type Setting,
  type ServerEnvironment,
} from "./config.ts";
import {
  createAdminClient,
  createUserClient,
  type ServerClientFactory,
} from "./supabase.ts";
const permissions = {
  accounts: ["feed.manage_accounts"],
  publishing: ["feed.create", "feed.edit", "posts.create", "posts.edit"],
} as const;
export type MarketingAccess = "workspace" | keyof typeof permissions;
export async function requireMarketingSession<K extends Setting = never>(
  req: ApiRequest,
  access: MarketingAccess,
  options: { required?: readonly K[]; configurationMessage?: string } = {},
  dependencies: {
    env?: ServerEnvironment;
    createClient?: ServerClientFactory;
  } = {},
) {
  const settings = serverSettings(dependencies.env);
  const required: readonly ("url" | "publishableKey" | "serviceRoleKey" | K)[] =
    ["url", "publishableKey", "serviceRoleKey", ...(options.required || [])];
  requireSettings(
    settings,
    required,
    options.configurationMessage ||
      "Supabase server configuration is incomplete.",
  );
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "Authentication required.");
  const factory = dependencies.createClient || createClient;
  const auth = createUserClient(settings, token, factory);
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user)
    throw new HttpError(401, "Invalid or expired session.");
  if (access === "workspace") {
    const check = await auth.rpc("can_access_workspace", {
      workspace_name: "marketing",
    });
    if (check.error)
      throw new HttpError(500, "Could not verify Marketing workspace access.");
    if (check.data !== true)
      throw new HttpError(403, "Marketing access required.");
  } else {
    const checks = await Promise.all(
      permissions[access].map((permission) =>
        auth.rpc("has_marketing_permission", {
          required_permission: permission,
        }),
      ),
    );
    if (checks.some((check) => check.error))
      throw new HttpError(
        500,
        access === "accounts"
          ? "Could not verify Marketing account access."
          : "Could not verify Marketing publishing access.",
      );
    if (!checks.some((check) => check.data === true))
      throw new HttpError(
        403,
        access === "accounts"
          ? "Marketing account management permission required."
          : "Create or edit post permission required.",
      );
  }
  // Create the privileged client only after the employee's live permission check.
  return {
    auth,
    user: data.user,
    admin: createAdminClient(settings, factory),
    settings,
  };
}
export function requireCron(
  req: ApiRequest,
  env: ServerEnvironment = process.env,
) {
  if (!env.CRON_SECRET || bearerToken(req) !== env.CRON_SECRET)
    throw new HttpError(401, "Unauthorized scheduler request.");
}
