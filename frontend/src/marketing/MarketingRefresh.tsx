import type { MarketingModel } from "./useMarketingWorkspace";
export default function MarketingRefresh({ model }: { model: MarketingModel }) {
  const updated = model.integrations.find(
    (item) => item.provider === "facebook",
  )?.last_synced_at;
  return (
    <div className="marketing-refresh">
      <button
        className="secondary"
        disabled={model.busy}
        onClick={() => void model.syncAll()}
      >
        Refresh
      </button>
      <span
        className="marketing-last-update"
        title="Last successful Facebook refresh, in Johannesburg time"
      >
        Last update:{" "}
        {updated ? (
          <time dateTime={updated}>
            {new Intl.DateTimeFormat("en-ZA", {
              timeZone: "Africa/Johannesburg",
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            }).format(new Date(updated))}{" "}
            SAST
          </time>
        ) : (
          "Not recorded yet"
        )}
      </span>
    </div>
  );
}
