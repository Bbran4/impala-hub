import { BarChart3,ClipboardList,Megaphone } from "lucide-react";
import type { HubAccount } from "./useAccount";
export default function AppsDashboard({
  account,
  onNavigate,
  setError,
  setNotice,
}: {
  account: HubAccount;
  onNavigate: (page: string) => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}) {
  const {
    canMarketing,
    canAccessMarketing,
    canAccessSalesDesk,
    canAccessReturns,
    canAccessStock,
    canAccessReporting,
  } = account;
  return (
    <>
      {" "}
      <section className="apps-dashboard">
        <div className="apps-intro">
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h2>Welcome to Impala Hub</h2>
          <p>
            Choose an application to get started. More tools will appear here as
            they become available.
          </p>
        </div>
        <div className="apps-section-heading">
          <div>
            <h2>Your apps</h2>
            <p>One home for Impala's business workflows.</p>
          </div>
          <span>
            {
              [
                canAccessMarketing,
                canAccessSalesDesk,
                canAccessReturns,
                canAccessStock,
                canAccessReporting,
              ].filter(Boolean).length
            }{" "}
            available
          </span>
        </div>
        <div className="app-cards">
          {canAccessMarketing && (
            <button
              className="app-card app-card-available"
              onClick={() => {
                onNavigate(
                  canMarketing("feed.view")
                    ? "Feed"
                    : canMarketing("posts.view")
                      ? "Posts"
                      : canMarketing("campaigns.view")
                        ? "Campaigns"
                        : "Roadmap",
                );
              }}
            >
              <div className="app-card-icon">
                <Megaphone size={25} />
              </div>
              <div className="app-card-copy">
                <h3>Marketing</h3>
                <p>
                  Plan campaigns, organise content, and manage social
                  publishing.
                </p>
              </div>
              <div className="app-card-footer">
                <span className="app-status-dot" /> Available{" "}
                <span className="app-card-open">
                  Open app <span aria-hidden="true">→</span>
                </span>
              </div>
            </button>
          )}
          {canAccessSalesDesk && (
            <button
              className="app-card app-card-available"
              onClick={() => {
                onNavigate("RFQs");
                setError("");
                setNotice("");
              }}
            >
              <div className="app-card-icon">
                <ClipboardList size={25} />
              </div>
              <div className="app-card-copy">
                <h3>Sales Desk</h3>
                <p>Customer enquiries, RFQs, and sales follow-ups.</p>
              </div>
              <div className="app-card-footer">
                <span className="app-status-dot" /> Available{" "}
                <span className="app-card-open">
                  Open app <span aria-hidden="true">→</span>
                </span>
              </div>
            </button>
          )}
          {[
            {
              title: "Fleet Management",
              description: "Fleet visibility and vehicle activity.",
            },
            {
              title: "E-commerce",
              description: "Shopify orders, catalogue, and integration health.",
            },
          ].map((item) => (
            <div
              className="app-card app-card-disabled"
              key={item.title}
              aria-disabled="true"
            >
              <div className="app-card-icon">
                <ClipboardList size={25} />
              </div>
              <div className="app-card-copy">
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </div>
              <div className="app-card-footer">
                <span className="app-status-dot app-status-planned" /> Planned{" "}
                <span className="app-card-lock">Coming later</span>
              </div>
            </div>
          ))}
          {canAccessReturns && (
            <button
              className="app-card app-card-available"
              onClick={() => {
                onNavigate("Returns & Claims");
                setError("");
                setNotice("");
              }}
            >
              <div className="app-card-icon">
                <ClipboardList size={25} />
              </div>
              <div className="app-card-copy">
                <h3>Returns &amp; Claims</h3>
                <p>Track returns, damage claims, and supplier outcomes.</p>
              </div>
              <div className="app-card-footer">
                <span className="app-status-dot" /> Available{" "}
                <span className="app-card-open">
                  Open app <span aria-hidden="true">→</span>
                </span>
              </div>
            </button>
          )}
          {canAccessStock && (
            <button
              className="app-card app-card-available"
              onClick={() => {
                onNavigate("Stock Booking");
                setError("");
                setNotice("");
              }}
            >
              <div className="app-card-icon">
                <ClipboardList size={25} />
              </div>
              <div className="app-card-copy">
                <h3>Smart Stock Control</h3>
                <p>
                  Compare stock, book branch transfers, and manage Parts
                  Queries.
                </p>
              </div>
              <div className="app-card-footer">
                <span className="app-status-dot" /> Available{" "}
                <span className="app-card-open">
                  Open app <span aria-hidden="true">→</span>
                </span>
              </div>
            </button>
          )}
          {canAccessReporting && (
            <button
              className="app-card app-card-available"
              onClick={() => {
                onNavigate("Dashboards");
                setError("");
                setNotice("");
              }}
            >
              <div className="app-card-icon">
                <BarChart3 size={25} />
              </div>
              <div className="app-card-copy">
                <h3>Reporting</h3>
                <p>ERP data, reports and dashboards, replacing Qlik Sense.</p>
              </div>
              <div className="app-card-footer">
                <span className="app-status-dot" /> Available{" "}
                <span className="app-card-open">
                  Open app <span aria-hidden="true">→</span>
                </span>
              </div>
            </button>
          )}
        </div>
      </section>
    </>
  );
}
