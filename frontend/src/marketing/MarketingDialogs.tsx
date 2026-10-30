import CampaignEditor from "./CampaignEditor";
import PostDetailDialog from "./PostDetailDialog";
import PostEditor from "./PostEditor";
import PostImageViewer from "./PostImageViewer";
import type { MarketingModel } from "./useMarketingWorkspace";
export default function MarketingDialogs({ model }: { model: MarketingModel }) {
  return (
    <>
      <PostDetailDialog model={model} />
      <PostImageViewer model={model} />
      <PostEditor model={model} />
      <CampaignEditor model={model} />
    </>
  );
}
