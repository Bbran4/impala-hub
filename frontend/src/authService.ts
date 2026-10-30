import { requireSupabase } from "./supabase";
export const authService = {
  async signOut(): Promise<void> {
    const { error } = await requireSupabase().auth.signOut();
    if (error) throw new Error(error.message);
  },
};
