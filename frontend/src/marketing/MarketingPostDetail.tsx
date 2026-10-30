import { ClipboardList } from "lucide-react";
import PostDetail from "../PostDetail";
import type { MarketingModel } from "./useMarketingWorkspace";

export default function MarketingPostDetail({
  model,
}: {
  model: MarketingModel;
}) {
  const {
    campaigns,
    setImageViewer,
    removePost,
    openEditor,
    reschedulePost,
    saveCampaign,
    selected,
    canMarketing,
    setPage,
    handleError,
  } = model;
  return (
    <>
      {selected ? (
        <PostDetail
          post={selected}
          campaigns={campaigns}
          onBack={() => setPage("Posts")}
          onEdit={openEditor}
          onReschedule={reschedulePost}
          onDelete={removePost}
          onSaveCampaign={saveCampaign}
          onOpenImage={(images, index) => setImageViewer({ images, index })}
          onError={handleError}
          canEdit={canMarketing("posts.edit")}
          canDelete={canMarketing("posts.delete")}
          canAssignCampaign={canMarketing("posts.assign_campaign")}
        />
      ) : (
        <div className="empty">
          <ClipboardList size={28} />
          <h3>Post not found</h3>
          <button className="secondary" onClick={() => setPage("Posts")}>
            Back to posts
          </button>
        </div>
      )}
    </>
  );
}
