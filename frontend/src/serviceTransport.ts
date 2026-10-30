import { requireSupabase } from "./supabase";
import { AuthError, readSupabaseToken } from "./sessionToken.ts";
export { AuthError };
export const KEY_STORAGE = "impala_session_token";
try {
  localStorage.removeItem(KEY_STORAGE);
} catch {
  /* Storage may be unavailable. */
}
export const getKey = () => sessionStorage.getItem(KEY_STORAGE) || "";

export type ServiceResult = {
  data: unknown;
  error: { message: string } | null;
};
// Supabase JSON RPCs are untyped at the wire boundary. Keep that assertion here,
// and expose concrete domain contracts to services and their callers.
export function resultData<T>(result: ServiceResult): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data == null) throw new Error("The server returned no data.");
  return result.data as T;
}
export function checkError(result: { error: { message: string } | null }) {
  if (result.error) throw new Error(result.error.message);
}
export const jsonBody = (body: object): RequestInit => ({
  body: JSON.stringify(body),
});
export async function marketingRequest<T>(
  path: string,
  action: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set(
    "Authorization",
    `Bearer ${await readSupabaseToken(requireSupabase())}`,
  );
  if (options.body) headers.set("Content-Type", "application/json");
  const { readMarketingResponse } = await import("./marketingResponse.ts");
  return (await readMarketingResponse(
    await fetch(path, { ...options, headers }),
    action,
  )) as T;
}
