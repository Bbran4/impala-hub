import { X } from "lucide-react";
import type { MarketingModel } from "./useMarketingWorkspace";
export default function CampaignEditor({ model }: { model: MarketingModel }) {
  const {
    campaignModal,
    editingCampaignId,
    campaignName,
    campaignObjective,
    campaignType,
    setCampaignModal,
    setCampaignName,
    setCampaignObjective,
    setCampaignType,
    createCampaign,
    campaignTypes,
  } = model;
  return (
    <>
      {campaignModal && (
        <div
          className="overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCampaignModal(false);
          }}
        >
          <section
            className="small-modal"
            role="dialog"
            aria-modal="true"
            aria-label="New campaign"
          >
            <header className="editor-head">
              <h2>{editingCampaignId ? "Edit campaign" : "New campaign"}</h2>
              <button
                className="icon-button"
                aria-label="Close"
                onClick={() => setCampaignModal(false)}
              >
                <X size={20} />
              </button>
            </header>
            <label htmlFor="campaign-name">Campaign name</label>
            <input
              id="campaign-name"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="e.g. Spring maintenance campaign"
            />
            <label htmlFor="campaign-type">Campaign type</label>
            <select
              id="campaign-type"
              value={campaignType}
              onChange={(e) => setCampaignType(e.target.value)}
            >
              {campaignTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <label htmlFor="campaign-objective">Objective</label>
            <textarea
              id="campaign-objective"
              value={campaignObjective}
              onChange={(e) => setCampaignObjective(e.target.value)}
              placeholder="What should this campaign achieve?"
              rows={3}
            />
            <footer className="editor-foot">
              <button
                className="secondary"
                onClick={() => setCampaignModal(false)}
              >
                Cancel
              </button>
              <button className="primary" onClick={() => void createCampaign()}>
                {editingCampaignId ? "Save changes" : "Create campaign"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
