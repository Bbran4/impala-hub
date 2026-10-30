import { X } from "lucide-react";
import PostDetail from "../PostDetail";
import type { MarketingModel } from "./useMarketingWorkspace";
export default function PostDetailDialog({ model }: { model: MarketingModel }) {
  const {
    campaigns,
    detailId,
    view,
    setDetailId,
    setImageViewer,
    removePost,
    openEditor,
    reschedulePost,
    saveCampaign,
    selected,
    canMarketing,
    handleError,
    page,
  } = model;
  return (
    <>
      {(page === "Feed" || (page === "Posts" && view === "calendar")) &&
        detailId &&
        selected && (
          <div
            className="overlay feed-post-modal"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDetailId(null);
            }}
          >
            <div className="feed-post-modal-panel">
              <button
                className="icon-button feed-post-modal-close"
                aria-label="Close post details"
                onClick={() => setDetailId(null)}
              >
                <X size={20} />
              </button>
              <PostDetail
                post={selected}
                campaigns={campaigns}
                onBack={() => setDetailId(null)}
                onEdit={openEditor}
                onReschedule={reschedulePost}
                onDelete={removePost}
                onSaveCampaign={saveCampaign}
                onOpenImage={(images, index) =>
                  setImageViewer({ images, index })
                }
                onError={handleError}
                canEdit={
                  page === "Feed"
                    ? canMarketing("feed.edit")
                    : canMarketing("posts.edit")
                }
                canDelete={
                  page === "Feed"
                    ? canMarketing("feed.delete")
                    : canMarketing("posts.delete")
                }
                canAssignCampaign={
                  page === "Feed"
                    ? canMarketing("feed.assign_campaign")
                    : canMarketing("posts.assign_campaign")
                }
              />
            </div>
          </div>
        )}
    </>
  );
}
