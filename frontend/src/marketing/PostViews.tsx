import {
  ClipboardList,
  Eye,
  Heart,
  ImagePlus,
  MessageCircle,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  EDITABLE,
  fmt,
  mediaSrc,
  metric,
  type Campaign,
  type Post,
} from "../lib";
import type { PostSummary } from "../marketingPosts";
export function PostPivot({
  summary,
  campaignTypes,
}: {
  summary: PostSummary[];
  campaignTypes: string[];
}) {
  const [selectedType, setSelectedType] = useState("all");
  const rows = summary.filter(
    (row) => selectedType === "all" || row.campaign_type === selectedType,
  );
  const totals = rows.reduce(
    (a, r) => ({
      label: "Total",
      posts: a.posts + Number(r.posts),
      likes: a.likes + Number(r.likes),
      comments: a.comments + Number(r.comments),
      shares: a.shares + Number(r.shares),
      clicks: a.clicks + Number(r.clicks),
    }),
    { label: "Total", posts: 0, likes: 0, comments: 0, shares: 0, clicks: 0 },
  );
  return (
    <div className="pivot-wrap">
      <div className="section-head">
        <div>
          <h2>Post insights</h2>
          <p>Grouped reporting for the current filters.</p>
        </div>
        <select
          aria-label="Campaign type"
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
        >
          <option value="all">All campaign types</option>
          {campaignTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
      <div className="pivot-table-wrap">
        <table className="pivot-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Posts</th>
              <th>Likes</th>
              <th>Comments</th>
              <th>Shares</th>
              <th>Clicks</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((r) => r.posts > 0)
              .map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td>{r.posts}</td>
                  <td>{r.likes}</td>
                  <td>{r.comments}</td>
                  <td>{r.shares}</td>
                  <td>{r.clicks}</td>
                </tr>
              ))}
            <tr className="pivot-total">
              <td>{totals.label}</td>
              <td>{totals.posts}</td>
              <td>{totals.likes}</td>
              <td>{totals.comments}</td>
              <td>{totals.shares}</td>
              <td>{totals.clicks}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PostList({
  posts,
  campaigns,
  onEdit,
  onOpen,
  onDelete,
  canEdit,
  canDelete,
  card = false,
  pageName,
  pageUrl,
}: {
  posts: Post[];
  campaigns: Campaign[];
  onEdit: (p: Post) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  canEdit: boolean;
  canDelete: boolean;
  card?: boolean;
  pageName?: string;
  pageUrl?: string;
}) {
  if (!posts.length) {
    return (
      <div className="empty">
        <ClipboardList size={28} />
        <h3>No posts to show</h3>
        <p>Create a draft to get your content calendar started.</p>
      </div>
    );
  }
  return (
    <div className={card ? "post-list feed-post-cards" : "post-list"}>
      {posts.map((p) => {
        const heading =
          p.title?.trim() || p.caption?.trim().slice(0, 110) || "Untitled post";
        return (
          <article
            className={card ? "post-row feed-post-card" : "post-row"}
            key={p.id}
          >
            {card ? (
              <>
                <div className="feed-post-top">
                  <a
                    href={p.provider_ids?.permalink || pageUrl || "#"}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      if (!p.provider_ids?.permalink && !pageUrl)
                        e.preventDefault();
                    }}
                  >
                    {pageName || "Social page"}
                  </a>
                  <time>
                    {fmt(p.published_at || p.publish_at, "Not posted")}
                  </time>
                </div>
                <p className="feed-card-caption" onClick={() => onOpen(p.id)}>
                  {p.caption || heading}
                </p>
                <div className="feed-card-images" onClick={() => onOpen(p.id)}>
                  {p.media.slice(0, 2).map((m, index) => (
                    <div
                      className="feed-card-image"
                      key={m.id || m.url}
                      onClick={() => onOpen(p.id)}
                    >
                      <img src={mediaSrc(m)} alt={m.name} />
                      {index === 1 && p.media.length > 2 && (
                        <span>+{p.media.length - 2}</span>
                      )}
                    </div>
                  ))}
                  {!p.media.length && (
                    <div className="feed-card-no-image">
                      <ImagePlus size={20} />
                    </div>
                  )}
                </div>
                <div className="feed-card-bottom">
                  <span>
                    <Heart size={14} /> {metric(p.likes)}
                  </span>
                  <span>
                    <MessageCircle size={14} /> {metric(p.comments)}
                  </span>
                  <span className="feed-card-views">
                    <Eye size={14} />{" "}
                    {metric(p.views ?? p.impressions ?? p.reach)}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div
                  className="post-preview"
                  style={{ cursor: "pointer" }}
                  onClick={() => onOpen(p.id)}
                >
                  {p.media?.[0] ? (
                    <img src={mediaSrc(p.media[0])} alt="" />
                  ) : (
                    <ImagePlus size={22} />
                  )}
                </div>
                <div
                  className="post-copy"
                  role="button"
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  onClick={() => onOpen(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(p.id);
                  }}
                >
                  <div className="post-meta">
                    <span className={`status ${p.status}`}>
                      {p.status.replace(/_/g, " ")}
                    </span>
                    <span>{p.channels.join(" · ") || "No channel"}</span>
                  </div>
                  <b>{heading}</b>
                  <small>
                    {campaigns.find((c) => c.id === p.campaign_id)?.name ||
                      "No campaign"}{" "}
                    ·{" "}
                    {p.published_at
                      ? `Posted ${fmt(p.published_at)}`
                      : fmt(p.publish_at)}
                  </small>
                  {p.status === "published" && (
                    <small>
                      Views {metric(p.views ?? p.impressions ?? p.reach)} ·
                      Reach {metric(p.reach)} · Likes {metric(p.likes)} ·
                      Comments {metric(p.comments)} · Shares {metric(p.shares)}
                      {p.metrics_refreshed_at
                        ? ` · updated ${fmt(p.metrics_refreshed_at)}`
                        : ""}
                    </small>
                  )}
                </div>
                <div className="row-actions">
                  <button className="secondary" onClick={() => onOpen(p.id)}>
                    View
                  </button>
                  {canEdit && EDITABLE.includes(p.status) && (
                    <button className="secondary" onClick={() => onEdit(p)}>
                      Edit
                    </button>
                  )}
                  {canDelete && (
                    <button
                      className="icon-button"
                      title="Delete local record (only after it is absent from Facebook)"
                      aria-label="Delete post"
                      onClick={() => onDelete(p.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}
