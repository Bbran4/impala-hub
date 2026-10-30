import { supabase } from "./supabase";
import { AuthError, readSupabaseToken } from "./sessionToken.ts";
export { AuthError };
export const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
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
export function describeError(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((value: unknown) => {
        if (!value || typeof value !== "object") return "Invalid value";
        const item = value as { loc?: unknown; msg?: unknown };
        const field = Array.isArray(item.loc)
          ? item.loc.filter((part) => part !== "body").join(".")
          : "";
        const message =
          typeof item.msg === "string" ? item.msg : "Invalid value";
        return field ? `${field}: ${message}` : message;
      })
      .join("; ");
  return `Request failed (${status})`;
}
// Actual HTTP transport only: no URL parsing, routing or automatic mutation retries.
export async function legacyRequest<T>(
  path: string,
  options: RequestInit = {},
  token = getKey(),
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...options, headers });
  } catch {
    throw new Error(
      `Cannot reach the Impala Hub API at ${API}. Check the backend connection.`,
    );
  }
  if (response.status === 401) {
    sessionStorage.removeItem(KEY_STORAGE);
    throw new AuthError(
      "Your session expired or is no longer valid. Sign in again.",
    );
  }
  const body: unknown =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      describeError(
        body && typeof body === "object" && "detail" in body
          ? body.detail
          : null,
        response.status,
      ),
    );
  return body as T;
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
  headers.set("Authorization", `Bearer ${await readSupabaseToken(supabase)}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const { readMarketingResponse } = await import("./marketingResponse.ts");
  return (await readMarketingResponse(
    await fetch(path, { ...options, headers }),
    action,
  )) as T;
}
