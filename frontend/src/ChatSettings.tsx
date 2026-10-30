import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import ColorPicker from "./ColorPicker";
import { chatNameColor } from "./colorValues";
import {
  chatPermissionLabels,
  loadChatSettings,
  saveChatSettings,
  type ChatUserSettings,
} from "./chatSettingsService";

export default function ChatSettings({
  setNotice,
  setError,
}: {
  setNotice: (message: string) => void;
  setError: (message: string) => void;
}) {
  const [users, setUsers] = useState<ChatUserSettings[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<ChatUserSettings | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void loadChatSettings()
      .then((rows) => {
        if (active) {
          setUsers(rows);
          setSelectedId(rows[0]?.profile_id || "");
        }
      })
      .catch((error: Error) => setError(error.message))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [setError]);
  useEffect(() => {
    setDraft(users.find((user) => user.profile_id === selectedId) || null);
  }, [selectedId, users]);
  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      await saveChatSettings(draft);
      setUsers((rows) =>
        rows.map((row) => (row.profile_id === draft.profile_id ? draft : row)),
      );
      setNotice("Chat permissions and name colour saved.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="admin-settings-heading">
        <div className="admin-settings-app-icon">
          <MessageCircle size={24} />
        </div>
        <div>
          <span className="eyebrow">APPLICATION SETTINGS</span>
          <h2>Chat and channels</h2>
          <p>Manage channel permissions and employee name colours.</p>
        </div>
      </div>
      <section className="admin-settings-panel chat-settings-panel">
        <div className="section-head">
          <div>
            <h2>User settings</h2>
            <p>
              Channel permissions apply to channels the user belongs to.
              Administrator accounts retain full permissions while administrator
              view is enabled.
            </p>
          </div>
        </div>
        <label>
          Find an employee
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or email"
          />
        </label>
        {loading ? (
          <p>Loading chat settings…</p>
        ) : (
          <label>
            Employee
            <select
              disabled={busy}
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="" disabled>
                Select an employee
              </option>
              {users
                .filter(
                  (u) =>
                    u.profile_id === selectedId ||
                    `${u.display_name} ${u.email}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                )
                .map((user) => (
                  <option key={user.profile_id} value={user.profile_id}>
                    {user.display_name || user.email}
                  </option>
                ))}
            </select>
          </label>
        )}
        {draft && (
          <>
            <div className="chat-settings-permissions">
              {(
                Object.keys(chatPermissionLabels) as Array<
                  keyof typeof chatPermissionLabels
                >
              ).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={draft.permissions[key]}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        permissions: {
                          ...draft.permissions,
                          [key]: event.target.checked,
                        },
                      })
                    }
                  />
                  {chatPermissionLabels[key]}
                </label>
              ))}
            </div>
            <div className="chat-settings-color">
              <div>
                <b>Name colour</b>
                <p>
                  Preview:{" "}
                  <strong
                    style={{
                      color: chatNameColor(
                        draft.profile_id,
                        draft.name_color
                          ? { [draft.profile_id]: draft.name_color }
                          : {},
                      ),
                    }}
                  >
                    {draft.display_name || draft.email}
                  </strong>
                </p>
              </div>
              <ColorPicker
                label="Chat name colour"
                value={draft.name_color || chatNameColor(draft.profile_id)}
                disabled={busy}
                onChange={(color) => setDraft({ ...draft, name_color: color })}
              />
              <button
                className="secondary"
                disabled={busy || !draft.name_color}
                onClick={() => setDraft({ ...draft, name_color: null })}
              >
                Use automatic colour
              </button>
            </div>
            <div className="chat-settings-save">
              <span>
                {draft.is_administrator
                  ? "These permissions apply when this administrator uses normal user view."
                  : "Changes are shared across the app."}
              </span>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save chat settings"}
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
