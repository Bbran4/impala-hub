import { Plus } from "lucide-react";
import type { HubAccount } from "./useAccount";
import { pageContext } from "./workspaceNavigation";
export default function WorkspaceHeader({
  page,
  account,
  onCreatePost,
}: {
  page: string;
  account: HubAccount;
  onCreatePost: () => void;
}) {
  const {
    isSalesDeskPage,
    isStockControlPage,
    isReturnsClaimsPage,
    isReportingPage,
    isAdminSettingsPage,
  } = pageContext(page);
  const { canMarketing } = account;
  return (
    <>
      {" "}
      <header className="topbar">
        <div>
          <div className="eyebrow">
            {page === "Account" || isAdminSettingsPage
              ? "IMPALA HUB"
              : `IMPALA SPARES / ${page === "Apps" ? "BUSINESS PLATFORM" : isSalesDeskPage ? "SALES DESK" : isStockControlPage ? "SMART STOCK CONTROL" : isReturnsClaimsPage ? "RETURNS & CLAIMS" : isReportingPage ? "REPORTING" : "MARKETING"}`}
          </div>
          <h1>
            {page === "Post"
              ? "Post details"
              : page === "Apps"
                ? "Apps Dashboard"
                : isAdminSettingsPage
                  ? "Settings"
                  : isStockControlPage
                    ? "Smart Stock Control"
                    : isReturnsClaimsPage
                      ? "Returns & Claims"
                      : isReportingPage
                        ? "Reporting"
                        : page}
          </h1>
          {isAdminSettingsPage && (
            <p className="topbar-subtitle">
              Manage application access and shared configuration.
            </p>
          )}
          {isSalesDeskPage && (
            <p className="topbar-subtitle">
              Review incoming enquiries, claim RFQs, and track sales follow-ups.
            </p>
          )}
          {page === "Stock Booking" && (
            <p className="topbar-subtitle">
              Compare branch stock and prepare Evolve location transfers.
            </p>
          )}
          {page === "Parts Query" && (
            <p className="topbar-subtitle">
              Manage parts queries and supplier quotes.
            </p>
          )}
        </div>
        {!isSalesDeskPage &&
          !isStockControlPage &&
          !isReturnsClaimsPage &&
          !isReportingPage &&
          !isAdminSettingsPage &&
          page !== "Apps" &&
          page !== "Account" &&
          page !== "Marketing Accounts" &&
          page !== "Campaigns" &&
          page !== "Roadmap" &&
          ((page === "Feed" && canMarketing("feed.create")) ||
            ((page === "Posts" || page === "Post") &&
              canMarketing("posts.create"))) && (
            <button
              className="primary"
              onClick={() => {
                onCreatePost();
              }}
            >
              <Plus size={17} /> Create post
            </button>
          )}
      </header>
    </>
  );
}
