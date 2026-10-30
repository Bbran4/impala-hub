import { HttpError } from "./http.ts";
export type ServerEnvironment = Record<string, string | undefined>;
export const settingNames = {
  url: ["SUPABASE_URL", "VITE_SUPABASE_URL"],
  publishableKey: ["SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY"],
  serviceRoleKey: ["SUPABASE_SERVICE_ROLE_KEY"],
  encryptionKey: ["META_TOKEN_ENCRYPTION_KEY"],
  appId: ["META_APP_ID"],
  appSecret: ["META_APP_SECRET"],
  redirectUri: ["FACEBOOK_OAUTH_REDIRECT_URI"],
  frontendUrl: ["FRONTEND_URL"],
} as const;
export type Setting = keyof typeof settingNames;
export type ServerSettings = { [K in Setting]?: string };
export type RequiredSettings<K extends Setting> = { [P in K]-?: string };
export function serverSettings(
  env: ServerEnvironment = process.env,
): ServerSettings {
  return Object.fromEntries(
    Object.entries(settingNames).map(([key, names]) => [
      key,
      names.map((name) => env[name]).find(Boolean),
    ]),
  );
}
export function missingSettings(
  settings: ServerSettings,
  required: readonly Setting[],
) {
  return required
    .filter((key) => !settings[key])
    .map((key) => settingNames[key][0]);
}
export function requireSettings<K extends Setting>(
  settings: ServerSettings,
  required: readonly K[],
  detail = "Server configuration is incomplete.",
): asserts settings is ServerSettings & RequiredSettings<K> {
  const missing = missingSettings(settings, required);
  if (missing.length)
    throw new HttpError(503, `${detail} Missing: ${missing.join(", ")}`);
}
export const facebookSettings = [
  "url",
  "publishableKey",
  "serviceRoleKey",
  "appId",
  "appSecret",
  "encryptionKey",
  "redirectUri",
] as const;
