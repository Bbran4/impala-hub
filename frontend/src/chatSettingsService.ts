import { requireSupabase } from "./supabase";
export const chatPermissionLabels = {
  create_channels: "Create channels",
  invite_users: "Invite people to channels",
  remove_members: "Remove channel members",
  delete_channels: "Delete joined channels",
} as const;
export type ChatPermissions = Record<
  keyof typeof chatPermissionLabels,
  boolean
>;
export type ChatClientSettings = {
  permissions: ChatPermissions;
  colors: Record<string, string>;
};
export type ChatUserSettings = {
  profile_id: string;
  display_name: string;
  email: string;
  name_color: string | null;
  is_administrator: boolean;
  permissions: ChatPermissions;
};
export const noChatPermissions: ChatPermissions = {
  create_channels: false,
  invite_users: false,
  remove_members: false,
  delete_channels: false,
};
export const emptyChatSettings: ChatClientSettings = {
  permissions: noChatPermissions,
  colors: {},
};

export async function loadChatClientSettings(): Promise<ChatClientSettings> {
  const result = await requireSupabase().rpc("chat_client_settings");
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Chat settings are unavailable.");
  return result.data as ChatClientSettings;
}
export async function loadChatSettings(): Promise<ChatUserSettings[]> {
  const result = await requireSupabase().rpc("admin_chat_settings");
  if (result.error) throw new Error(result.error.message);
  return result.data as ChatUserSettings[];
}
export async function saveChatSettings(user: ChatUserSettings): Promise<void> {
  const result = await requireSupabase().rpc("admin_save_chat_user_settings", {
    p_profile_id: user.profile_id,
    p_name_color: user.name_color,
    p_permissions: user.permissions,
  });
  if (result.error) throw new Error(result.error.message);
}
