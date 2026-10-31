import { REPORTING_PAGES } from "../Reporting";
import type { HubAccount } from "./useAccount";
export const salesPages = ["RFQs", "RFQ Roadmap"];
export const stockPages = [
  "Parts Query",
  "Stock Booking",
  "Stock Reordering",
  "Stock Data Import",
  "Stock Control Roadmap",
];
export const returnsPages = ["Returns & Claims", "Returns & Claims Roadmap"];
export const marketingPages = [
  "Feed",
  "Posts",
  "Post",
  "Campaigns",
  "Marketing Accounts",
  "Roadmap",
];
export function pageContext(page: string) {
  const isSalesDeskPage = salesPages.includes(page);
  const isStockControlPage = stockPages.includes(page);
  const isReturnsClaimsPage = returnsPages.includes(page);
  const isReportingPage = (REPORTING_PAGES as readonly string[]).includes(page);
  const isAdminSettingsPage = page === "Admin Settings";
  const isPlatformPage = [
    "Apps",
    "Account",
    "Channels",
    "Admin Settings",
  ].includes(page);
  return {
    isSalesDeskPage,
    isStockControlPage,
    isReturnsClaimsPage,
    isReportingPage,
    isAdminSettingsPage,
    isPlatformPage,
  };
}
export function canOpenPage(page: string, access: HubAccount) {
  if (
    ["Admin Settings", "Configuration", "Stock Control Configuration"].includes(
      page,
    )
  )
    return Boolean(access.isAdministratorAccount || access.isAdministrator);
  if (page === "Stock Data Import" && !access.isAdministrator) return false;
  if (salesPages.includes(page)) return access.canAccessSalesDesk;
  if (stockPages.includes(page)) return access.canAccessStock;
  if (returnsPages.includes(page)) return access.canAccessReturns;
  if (marketingPages.includes(page)) {
    if (!access.canAccessMarketing) return false;
    if (page === "Feed") return access.canMarketing("feed.view");
    if (page === "Posts" || page === "Post")
      return access.canMarketing("posts.view");
    if (page === "Campaigns") return access.canMarketing("campaigns.view");
    if (page === "Marketing Accounts")
      return access.canMarketing("feed.manage_accounts");
  }
  return true;
}
