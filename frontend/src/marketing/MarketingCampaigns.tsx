import { Megaphone, Plus } from "lucide-react";
import type { MarketingModel } from "./useMarketingWorkspace";

export default function MarketingCampaigns({
  model,
}: {
  model: MarketingModel;
}) {
  const {
    campaigns,
    campaignPostCounts,
    editingCampaignId,
    setFilter,
    setCampaignFilter,
    setSearch,
    setCampaignModal,
    setEditingCampaignId,
    setCampaignName,
    setCampaignObjective,
    setCampaignStage,
    setCampaignType,
    setMonth,
    moveCampaign,
    openCampaignEditor,
    removeCampaign,
    canMarketing,
    setPage,
    campaignTypes,
  } = model;
  return (
    <>
      <>
        <div className="section-head">
          <div>
            <h2>Campaigns</h2>
            <p>Group related posts under a shared marketing objective.</p>
          </div>
          {canMarketing("campaigns.create") && (
            <button
              className="primary"
              onClick={() => {
                setEditingCampaignId(null);
                setCampaignName("");
                setCampaignObjective("");
                setCampaignStage("new");
                setCampaignType(campaignTypes[0] || "Tips");
                setCampaignModal(true);
              }}
            >
              <Plus size={16} /> New campaign
            </button>
          )}
        </div>
        <div className="campaign-board">
          {(
            [
              ["new", "New"],
              ["in_progress", "In Progress"],
              ["done", "Done"],
            ] as const
          ).map(([stage, label]) => (
            <section
              className="campaign-column"
              key={stage}
              onDragOver={(e) => {
                if (canMarketing("campaigns.change_status")) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!canMarketing("campaigns.change_status")) return;
                e.preventDefault();
                const id = e.dataTransfer.getData("text/campaign-id");
                if (id) void moveCampaign(id, stage);
              }}
            >
              <header className="campaign-column-head">
                <h3>{label}</h3>
                <span>
                  {campaigns.filter((c) => (c.stage || "new") === stage).length}
                </span>
              </header>
              {canMarketing("campaigns.create") &&
                (stage === "new" ||
                  canMarketing("campaigns.change_status")) && (
                  <button
                    className="campaign-quick-add"
                    onClick={() => {
                      setEditingCampaignId(null);
                      setCampaignName("");
                      setCampaignObjective("");
                      setCampaignStage(stage);
                      setCampaignType(campaignTypes[0] || "Tips");
                      setCampaignModal(true);
                    }}
                  >
                    <Plus size={14} /> Quick add
                  </button>
                )}
              {campaigns
                .filter((c) => (c.stage || "new") === stage)
                .map((c) => (
                  <div
                    className="campaign-card"
                    key={c.id}
                    draggable={canMarketing("campaigns.change_status")}
                    onDragStart={(e) => {
                      if (canMarketing("campaigns.change_status"))
                        e.dataTransfer.setData("text/campaign-id", c.id);
                    }}
                  >
                    <div className="campaign-icon">
                      <Megaphone size={20} />
                    </div>
                    <div className="campaign-card-heading">
                      <h3>{c.name}</h3>
                      <span className="status-badge">
                        {(c.stage || "new").replace("_", " ")}
                      </span>
                    </div>
                    <p>{c.objective || "No objective added yet."}</p>
                    <div className="campaign-footer">
                      {canMarketing("campaigns.edit") && (
                        <button
                          className="text-button"
                          onClick={() => openCampaignEditor(c)}
                        >
                          Edit
                        </button>
                      )}
                      {canMarketing("posts.view") && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setPage("Posts");
                            setSearch("");
                            setFilter("all");
                            setCampaignFilter(c.id);
                            setMonth(null);
                          }}
                        >
                          View posts →
                        </button>
                      )}
                      {canMarketing("campaigns.delete") &&
                        (campaignPostCounts[c.id] || 0) === 0 && (
                          <button
                            className="text-button danger"
                            onClick={() => void removeCampaign(c)}
                          >
                            Delete
                          </button>
                        )}
                    </div>
                  </div>
                ))}
            </section>
          ))}
          {campaigns.length === 0 && (
            <div className="empty">
              <Megaphone size={28} />
              <h3>No campaigns yet</h3>
              <p>Create a campaign to organise related posts.</p>
              {canMarketing("campaigns.create") && (
                <button
                  className="secondary"
                  onClick={() => setCampaignModal(true)}
                >
                  {editingCampaignId ? "Save changes" : "Create campaign"}
                </button>
              )}
            </div>
          )}
        </div>
      </>
    </>
  );
}
