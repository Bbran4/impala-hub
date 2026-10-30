import { supabase } from "./supabase";
import { legacyRequest } from "./serviceTransport";
export const authService = {
  async signOut(): Promise<void> {
    if (supabase) {
      await supabase.auth.signOut();
      return;
    }
    // Always allow local sign-out even if the old backend is unavailable.
    await legacyRequest<void>("/api/sales-desk/auth/logout", {
      method: "POST",
    }).catch(() => undefined);
  },
};
