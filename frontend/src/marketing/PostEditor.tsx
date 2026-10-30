import { ImagePlus, Send, Upload, X } from "lucide-react";
import { mediaSrc } from "../lib";
import type { MarketingModel } from "./useMarketingWorkspace";
const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (value?: string | null) => {
  if (!value) return "";
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export default function PostEditor({ model }: { model: MarketingModel }) {
  const {
    campaigns,
    editor,
    busy,
    setEditor,
    patchEditor,
    savePost,
    upload,
    channels,
    canSchedule,
    canMarketing,
    integrations,
    page,
  } = model;
  return (
    <>
      {editor && (
        <div
          className="overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditor(null);
          }}
        >
          <section
            className="editor"
            role="dialog"
            aria-modal="true"
            aria-label={editor.id ? "Edit post" : "Create post"}
          >
            <header className="editor-head">
              <div>
                <span className="eyebrow">CONTENT WORKFLOW</span>
                <h2>{editor.id ? "Edit post" : "Create post"}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close editor"
                onClick={() => setEditor(null)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="editor-body">
              <label id="lbl-channels">
                Channels <span>Choose where this post should appear</span>
              </label>
              <div
                className="channel-checks"
                role="group"
                aria-labelledby="lbl-channels"
              >
                {[
                  ["facebook", "Facebook"],
                  ["instagram", "Instagram"],
                ].map(([v, l]) => (
                  <label className="check-chip" key={v}>
                    <input
                      type="checkbox"
                      checked={channels.includes(v)}
                      onChange={(e) =>
                        patchEditor({
                          channels: e.target.checked
                            ? [...channels, v]
                            : channels.filter((x) => x !== v),
                        })
                      }
                    />
                    {l}
                  </label>
                ))}
              </div>

              <label htmlFor="post-title">Title</label>
              <input
                id="post-title"
                maxLength={160}
                placeholder="Internal title for this post"
                value={editor.title || ""}
                onChange={(e) => patchEditor({ title: e.target.value })}
              />

              <label htmlFor="post-caption">Caption / message</label>
              <textarea
                id="post-caption"
                rows={5}
                placeholder="Write the post caption here..."
                value={editor.caption || ""}
                onChange={(e) => patchEditor({ caption: e.target.value })}
              />

              <div className="editor-label-row">
                <label id="lbl-images">
                  Images{" "}
                  <span>
                    JPG, PNG, WEBP or GIF, max 15 MB each. Instagram needs at
                    least one.
                  </span>
                </label>
                <label className="upload-button">
                  <Upload size={16} /> Add images
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    multiple
                    onChange={(e) => void upload(e.target)}
                  />
                </label>
              </div>
              <div className="media-grid">
                {(editor.media || []).map((m, i) => (
                  <div className="media-thumb" key={m.id || m.url}>
                    <img src={mediaSrc(m)} alt={m.name} />
                    <button
                      aria-label={`Remove ${m.name}`}
                      onClick={() =>
                        patchEditor({
                          media: (editor.media || []).filter((_, j) => i !== j),
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                    <small>{m.name}</small>
                  </div>
                ))}
                {!(editor.media || []).length && (
                  <div className="media-empty">
                    <ImagePlus size={22} />
                    <span>No images attached</span>
                  </div>
                )}
              </div>

              <label htmlFor="post-campaign">Campaign</label>
              <select
                id="post-campaign"
                value={editor.campaign_id || ""}
                disabled={
                  !(page === "Feed"
                    ? canMarketing("feed.assign_campaign")
                    : canMarketing("posts.assign_campaign"))
                }
                onChange={(e) =>
                  patchEditor({ campaign_id: e.target.value || null })
                }
              >
                <option value="">No campaign</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <label htmlFor="post-when">
                Publication date and time{" "}
                <span>Required to schedule. Leave blank for a draft.</span>
              </label>
              <input
                id="post-when"
                type="datetime-local"
                value={toLocalInput(editor.publish_at)}
                onChange={(e) => patchEditor({ publish_at: e.target.value })}
              />
              <p className="hint">
                Scheduled posts are published to the connected Facebook Page by
                the publishing schedule configured for this deployment.
              </p>
            </div>
            <footer className="editor-foot">
              <button className="secondary" onClick={() => setEditor(null)}>
                Cancel
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void savePost("draft")}
              >
                Save as draft
              </button>
              <button
                className="secondary"
                disabled={
                  busy ||
                  !integrations.some(
                    (i) =>
                      i.provider === "facebook" && i.status === "connected",
                  )
                }
                onClick={() => void savePost("publish-now")}
                title="Publish this post to the connected Facebook Page now"
              >
                <Send size={15} /> Publish now
              </button>
              <button
                className="primary"
                disabled={busy || !canSchedule}
                title={canSchedule ? "" : "Choose a future date and time first"}
                onClick={() => void savePost("schedule")}
              >
                <Send size={15} />
                {busy ? "Saving..." : "Schedule post"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
