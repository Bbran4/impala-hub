import { ExternalLink, MessageCircle, Settings, Users } from "lucide-react";
import MarketingRefresh from "./MarketingRefresh";
import { PostList } from "./PostViews";
import type { MarketingModel } from "./useMarketingWorkspace";

export default function MarketingFeed({ model }: { model: MarketingModel }) {
  const {
    posts,
    campaigns,
    setFilter,
    setView,
    setMonth,
    removePost,
    openPost,
    openEditor,
    canMarketing,
    isAdministrator,
    setPage,
    integrations,
  } = model;
  const marketingRefresh = <MarketingRefresh model={model} />;
  return (
    <>
      <>
        <div className="feed-head">
          <div>
            <h2>Connected social accounts</h2>
            <p>
              Review Facebook and Instagram activity, engagement and provider
              health in one feed.
            </p>
          </div>
          <div className="feed-actions">
            {marketingRefresh}
            {canMarketing("feed.manage_accounts") && (
              <button
                className="primary"
                onClick={() =>
                  setPage(
                    isAdministrator ? "Admin Settings" : "Marketing Accounts",
                  )
                }
              >
                <Settings size={16} /> Manage accounts
              </button>
            )}
          </div>
        </div>
        <div className="feed-streams feed-network-cards">
          {integrations
            .filter(
              (i) =>
                (i.provider === "facebook" || i.provider === "instagram") &&
                i.status === "connected",
            )
            .map((i) => {
              const providerPosts = posts
                .filter((p) => p.channels.includes(i.provider))
                .sort(
                  (a, b) =>
                    new Date(
                      b.published_at || b.publish_at || b.created_at || 0,
                    ).getTime() -
                    new Date(
                      a.published_at || a.publish_at || a.created_at || 0,
                    ).getTime(),
                )
                .slice(0, 25);
              const engagement = providerPosts.reduce(
                (n, p) =>
                  n +
                  (p.likes ?? 0) +
                  (p.reactions ?? 0) +
                  (p.saves ?? 0) +
                  (p.comments ?? 0) +
                  (p.shares ?? 0) +
                  (p.clicks ?? 0),
                0,
              );
              const recent = providerPosts
                .slice(0, Math.max(1, Math.ceil(providerPosts.length / 2)))
                .reduce(
                  (n, p) =>
                    n +
                    (p.likes ?? 0) +
                    (p.comments ?? 0) +
                    (p.shares ?? 0) +
                    (p.clicks ?? 0),
                  0,
                );
              const older = providerPosts
                .slice(Math.max(1, Math.ceil(providerPosts.length / 2)))
                .reduce(
                  (n, p) =>
                    n +
                    (p.likes ?? 0) +
                    (p.comments ?? 0) +
                    (p.shares ?? 0) +
                    (p.clicks ?? 0),
                  0,
                );
              const change = older ? ((recent - older) / older) * 100 : 0;
              return (
                <div className="feed-stream-card" key={i.provider}>
                  <div className="feed-network-head">
                    <div className={`feed-provider-icon ${i.provider}`}>
                      {i.provider === "facebook" ? "f" : "◎"}
                    </div>
                    <div className="feed-network-title">
                      <strong>
                        {i.account_name || i.page_name || i.label}
                      </strong>
                      <a
                        href={
                          i.provider === "facebook"
                            ? `https://www.facebook.com/${i.page_id || ""}`
                            : `https://www.instagram.com/${i.username || ""}`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        Insights <ExternalLink size={11} />
                      </a>
                    </div>
                  </div>
                  <div className="feed-network-metrics">
                    <span title="Audience Number of followers of your channel">
                      <Users size={15} />
                      <strong>{i.followers_count ?? "—"}</strong>
                    </span>
                    <span title="Engagement Number of times people engaged with your posts (likes, comments, shares, clicks, and other reported interactions)">
                      <MessageCircle size={15} />
                      <strong>{engagement}</strong>
                      <em className={change >= 0 ? "metric-up" : "metric-down"}>
                        {change >= 0 ? "+" : ""}
                        {change.toFixed(1)}%
                      </em>
                    </span>
                  </div>
                </div>
              );
            })}
        </div>
        <div className="feed-summary">
          <div>
            <span>Posts in feed</span>
            <strong>{posts.length}</strong>
          </div>
          <div>
            <span>Likes</span>
            <strong>{posts.reduce((n, p) => n + (p.likes ?? 0), 0)}</strong>
          </div>
          <div>
            <span>Comments</span>
            <strong>{posts.reduce((n, p) => n + (p.comments ?? 0), 0)}</strong>
          </div>
          <div>
            <span>Shares</span>
            <strong>{posts.reduce((n, p) => n + (p.shares ?? 0), 0)}</strong>
          </div>
          <div>
            <span>Views</span>
            <strong>
              {posts.reduce(
                (n, p) => n + (p.views ?? p.impressions ?? p.reach ?? 0),
                0,
              )}
            </strong>
          </div>
        </div>{" "}
        <div className="feed-post-columns">
          {integrations
            .filter(
              (i) =>
                (i.provider === "facebook" || i.provider === "instagram") &&
                i.status === "connected",
            )
            .map((i) => {
              const providerPosts = posts
                .filter((p) => p.channels.includes(i.provider))
                .sort(
                  (a, b) =>
                    new Date(
                      b.published_at || b.publish_at || b.created_at || 0,
                    ).getTime() -
                    new Date(
                      a.published_at || a.publish_at || a.created_at || 0,
                    ).getTime(),
                )
                .slice(0, 25);
              return (
                <section className="feed-post-column" key={i.provider}>
                  <h3>{i.account_name || i.page_name || i.label}</h3>
                  <PostList
                    posts={providerPosts}
                    campaigns={campaigns}
                    onEdit={openEditor}
                    onOpen={openPost}
                    onDelete={removePost}
                    canEdit={canMarketing("feed.edit")}
                    canDelete={canMarketing("feed.delete")}
                    card
                    pageName={i.account_name || i.page_name || i.label}
                    pageUrl={
                      i.provider === "facebook"
                        ? `https://www.facebook.com/${i.page_id || ""}`
                        : `https://www.instagram.com/${i.username || ""}`
                    }
                  />
                </section>
              );
            })}
        </div>
        <div className="section-head">
          <div>
            <h2>Feed</h2>
            <p>
              Posts from connected social accounts, ordered by publication or
              schedule date.
            </p>
          </div>
          <button
            className="text-button"
            onClick={() => {
              setPage("Posts");
              setView("list");
              setMonth(null);
              setFilter("all");
            }}
          >
            Open post manager →
          </button>
        </div>
      </>
    </>
  );
}
