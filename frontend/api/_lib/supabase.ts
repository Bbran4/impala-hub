import { createClient } from "@supabase/supabase-js";
import {
  serverSettings,
  requireSettings,
  type ServerSettings,
} from "./config.ts";
export type ServerClientFactory = typeof createClient;
const authOptions = { persistSession: false, autoRefreshToken: false } as const;
export function createAdminClient(
  settings: ServerSettings = serverSettings(),
  factory: ServerClientFactory = createClient,
) {
  requireSettings(
    settings,
    ["url", "serviceRoleKey"],
    "Supabase server configuration is incomplete.",
  );
  return factory(settings.url, settings.serviceRoleKey, { auth: authOptions });
}
export function createUserClient(
  settings: ServerSettings,
  token: string,
  factory: ServerClientFactory = createClient,
) {
  requireSettings(
    settings,
    ["url", "publishableKey"],
    "Supabase server configuration is incomplete.",
  );
  return factory(settings.url, settings.publishableKey, {
    auth: authOptions,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
