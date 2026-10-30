import { Plus, Search } from "lucide-react";
import { startOfMonth } from "../lib";
import { POST_PAGE_SIZE } from "../marketingPosts";
import MonthNav from "../MonthNav";
import PostBoard from "../PostBoard";
import PostCalendar from "../PostCalendar";
import MarketingRefresh from "./MarketingRefresh";
import { PostList, PostPivot } from "./PostViews";
import type { MarketingModel } from "./useMarketingWorkspace";

export default function MarketingPosts({ model }: { model: MarketingModel }) {
  const {
    posts,
    postTotal,
    postPage,
    postSummary,
    postsLoading,
    campaigns,
    filter,
    campaignFilter,
    search,
    view,
    month,
    setPostPage,
    setFilter,
    setCampaignFilter,
    setSearch,
    setEditor,
    setDetailId,
    setView,
    setMonth,
    patchPost,
    removePost,
    openPost,
    openEditor,
    visiblePosts,
    filteredPosts,
    monthPosts,
    canMarketing,
    setError,
    campaignTypes,
    integrations,
  } = model;
  const marketingRefresh = <MarketingRefresh model={model} />;
  const emptyPost = model.newPostDefaults;
  return (
    <>
      <>
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input
              aria-label="Search posts"
              placeholder="Search titles, captions and campaigns"
              maxLength={200}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="view-toggle" role="group" aria-label="View">
            {(["list", "board", "calendar", "pivot"] as const).map((v) => (
              <button
                key={v}
                className={`secondary ${view === v ? "active" : ""}`}
                aria-pressed={view === v}
                onClick={() => {
                  setPostPage(0);
                  setView(v);
                }}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          {view === "list" && (
            <select
              aria-label="Filter by status"
              value={filter}
              onChange={(e) => {
                setPostPage(0);
                setFilter(e.target.value);
              }}
            >
              <option value="all">All posts</option>
              <option value="draft">Drafts</option>
              <option value="awaiting_approval">Awaiting approval</option>
              <option value="scheduled">Scheduled</option>
              <option value="published">Published</option>
              <option value="failed">Failed</option>
              <option value="engagements">Published / engagements</option>
            </select>
          )}
          <select
            aria-label="Filter by campaign"
            value={campaignFilter}
            onChange={(e) => {
              setPostPage(0);
              setCampaignFilter(e.target.value);
            }}
          >
            <option value="all">All campaigns</option>
            <option value="none">No campaign</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {integrations.some(
            (i) =>
              (i.provider === "facebook" || i.provider === "instagram") &&
              i.status === "connected",
          ) && marketingRefresh}
          {canMarketing("posts.create") && (
            <button className="primary" onClick={() => setEditor(emptyPost())}>
              <Plus size={16} /> New post
            </button>
          )}
        </div>
        <MonthNav
          month={view === "calendar" ? (month ?? startOfMonth()) : month}
          allowAll={view !== "calendar"}
          onChange={(value) => {
            setPostPage(0);
            setMonth(value);
          }}
          count={postTotal}
        />
        <div className="section-head" aria-live="polite">
          <span>
            {postsLoading
              ? "Loading posts..."
              : view === "pivot"
                ? `${postTotal} matching posts`
                : `Showing ${postTotal ? postPage * POST_PAGE_SIZE + 1 : 0} to ${Math.min(postPage * POST_PAGE_SIZE + posts.length, postTotal)} of ${postTotal} posts`}
          </span>
          {view !== "pivot" && (
            <div className="row-actions">
              <button
                className="secondary"
                disabled={postsLoading || postPage === 0}
                onClick={() => setPostPage((p) => p - 1)}
              >
                Previous
              </button>
              <button
                className="secondary"
                disabled={
                  postsLoading || (postPage + 1) * POST_PAGE_SIZE >= postTotal
                }
                onClick={() => setPostPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
        {view === "list" && (
          <PostList
            posts={visiblePosts}
            campaigns={campaigns}
            onEdit={openEditor}
            onOpen={openPost}
            onDelete={removePost}
            canEdit={canMarketing("posts.edit")}
            canDelete={canMarketing("posts.delete")}
          />
        )}
        {view === "board" && (
          <PostBoard
            posts={monthPosts}
            campaigns={campaigns}
            onOpen={openPost}
            onError={setError}
            canEdit={canMarketing("posts.edit")}
            onMove={(id, status) =>
              void patchPost(
                id,
                { status },
                `Post moved to ${status.replace(/_/g, " ")}.`,
              )
            }
          />
        )}
        {view === "pivot" && (
          <PostPivot summary={postSummary} campaignTypes={campaignTypes} />
        )}
        {view === "calendar" && (
          <PostCalendar
            posts={filteredPosts}
            month={month ?? startOfMonth()}
            onOpen={(id) => {
              setDetailId(id);
              setError("");
            }}
            onError={setError}
            canCreate={canMarketing("posts.create")}
            canEdit={canMarketing("posts.edit")}
            onChangeDate={(id, iso, message) =>
              void patchPost(id, { publish_at: iso }, message)
            }
            onCreate={(local) => {
              setEditor({ ...emptyPost(), publish_at: local });
              setError("");
            }}
          />
        )}
      </>
    </>
  );
}
