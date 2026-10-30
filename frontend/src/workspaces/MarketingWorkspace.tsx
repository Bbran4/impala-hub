import MarketingAccounts from "../marketing/MarketingAccounts";
import MarketingCampaigns from "../marketing/MarketingCampaigns";
import MarketingDialogs from "../marketing/MarketingDialogs";
import MarketingFeed from "../marketing/MarketingFeed";
import MarketingPostDetail from "../marketing/MarketingPostDetail";
import MarketingPosts from "../marketing/MarketingPosts";
import type { MarketingModel } from "../marketing/useMarketingWorkspace";
import RoadmapPage from "./WorkspaceRoadmap";
export default function MarketingWorkspace({
  model,
}: {
  model: MarketingModel;
}) {
  return (
    <>
      {model.page === "Feed" && <MarketingFeed model={model} />}
      {model.page === "Posts" && <MarketingPosts model={model} />}
      {model.page === "Campaigns" && <MarketingCampaigns model={model} />}
      {model.page === "Post" && <MarketingPostDetail model={model} />}
      {model.page === "Marketing Accounts" && (
        <MarketingAccounts model={model} />
      )}
      {model.page === "Roadmap" && <RoadmapPage document="marketing" />}
      <MarketingDialogs model={model} />
    </>
  );
}
