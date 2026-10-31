import {
  BookMarked,
  BookOpen,
  ClipboardList,
  CloudDownload,
  Database,
  Gauge,
  History,
  LayoutDashboard,
  Map,
  Megaphone,
  MessageCircle,
  Network,
  PackageCheck,
  ServerCog,
  Settings,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";
import NotificationCentre, {
  type NotificationChannel,
  type UserNotification,
} from "../NotificationCentre";
import type { HubAccount } from "./useAccount";
import { pageContext } from "./workspaceNavigation";
export default function AppSidebar({
  page,
  sessionKey: key,
  account,
  connected,
  notificationChannels,
  onNavigate,
  openNotificationTarget,
  setError,
  openChat,
  disconnectKey,
}: {
  page: string;
  sessionKey: string;
  account: HubAccount;
  connected: boolean;
  notificationChannels: NotificationChannel[];
  onNavigate: (page: string) => void;
  openNotificationTarget: (notification: UserNotification) => void;
  setError: (message: string) => void;
  openChat: () => void;
  disconnectKey: () => Promise<void>;
}) {
  const {
    isSalesDeskPage,
    isStockControlPage,
    isReturnsClaimsPage,
    isReportingPage,
    isPlatformPage,
  } = pageContext(page);
  const {
    profile,
    isAdministrator,
    isAdministratorAccount,
    canMarketing,
    reportingAccess,
    loadProfile,
  } = account;
  return (
    <>
      {" "}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">I</div>
          <div>
            <b>IMPALA HUB</b>
            {!isPlatformPage && (
              <small>
                {isSalesDeskPage
                  ? "Sales Desk workspace"
                  : isStockControlPage
                    ? "Smart Stock Control workspace"
                    : isReturnsClaimsPage
                      ? "Returns & Claims workspace"
                      : isReportingPage
                        ? "Reporting workspace"
                        : "Marketing workspace"}
              </small>
            )}
          </div>
        </div>
        <button
          className={`nav-item app-home-link ${page === "Apps" ? "active" : ""}`}
          onClick={() => onNavigate("Apps")}
        >
          <LayoutDashboard size={18} /> Apps Dashboard
        </button>
        {isPlatformPage && (
          <div className="sidebar-bottom">
            {key && (
              <div className="communication-buttons">
                <button
                  className="communication-button"
                  aria-label="Open chat"
                  title="Chat"
                  onClick={() => openChat()}
                >
                  <MessageCircle size={17} />
                </button>
                <NotificationCentre
                  enabled
                  channels={notificationChannels}
                  onNavigate={openNotificationTarget}
                  onError={setError}
                />
                {(isAdministratorAccount || isAdministrator) && (
                  <button
                    className="communication-button"
                    aria-label="Open settings"
                    title="Settings"
                    onClick={() => onNavigate("Admin Settings")}
                  >
                    <Settings size={17} />
                  </button>
                )}
              </div>
            )}
            <div className="connection-dot" /> <span>Workspace session</span>
            <button
              className="account-link"
              onClick={() => {
                onNavigate("Account");
                void loadProfile();
              }}
            >
              <span className="account-full">
                {profile.sales_code ? `${profile.sales_code} - ` : ""}
                {profile.first_name || profile.email || "My account"}
                {connected ? " · Connected" : ""}
              </span>
              <span className="account-mobile">
                {profile.sales_code || profile.first_name || "Account"}
              </span>
            </button>
            {key && (
              <button
                className="text-button"
                onClick={() => {
                  void disconnectKey();
                }}
              >
                Log out
              </button>
            )}
          </div>
        )}
        {!isPlatformPage && (
          <>
            <div className="nav-label">WORKSPACE</div>
            {(isSalesDeskPage
              ? ([
                  ["RFQs", ClipboardList],
                  ["RFQ Roadmap", Map],
                ] as const)
              : isStockControlPage
                ? ([
                    ["Stock Booking", PackageCheck],
                    ["Stock Reordering", PackageCheck],
                    ["Parts Query", ClipboardList],
                    ...(isAdministrator
                      ? [["Stock Data Import", Upload] as const]
                      : []),
                    ["Stock Control Roadmap", Map],
                  ] as const)
                : isReturnsClaimsPage
                  ? ([
                      ["Returns & Claims", ClipboardList],
                      ["Returns & Claims Roadmap", Map],
                    ] as const)
                  : isReportingPage
                    ? ([
                        ["Dashboards", LayoutDashboard],
                        ...(isAdministrator || reportingAccess.catalogue
                          ? [
                              ["Data", Database] as const,
                              ["Data Model", Network] as const,
                            ]
                          : []),
                        ...(isAdministrator
                          ? [
                              ["Data Connections", CloudDownload] as const,
                              ["Data Loads", ServerCog] as const,
                              ["Run History", History] as const,
                              ["Audit Log", ShieldCheck] as const,
                            ]
                          : []),
                        ...(isAdministrator ||
                        reportingAccess.catalogue ||
                        reportingAccess.builder
                          ? [["Data Quality", Gauge] as const]
                          : []),
                        ...(isAdministrator || reportingAccess.builder
                          ? [
                              ["Usage", Users] as const,
                              ["Master Items", BookMarked] as const,
                            ]
                          : []),
                        ["Function Reference", BookOpen],
                        ["Reporting Roadmap", Map],
                      ] as const)
                    : ([
                        ...(canMarketing("feed.view")
                          ? [["Feed", LayoutDashboard] as const]
                          : []),
                        ...(canMarketing("posts.view")
                          ? [["Posts", ClipboardList] as const]
                          : []),
                        ...(canMarketing("campaigns.view")
                          ? [["Campaigns", Megaphone] as const]
                          : []),
                        ["Roadmap", Map] as const,
                      ] as const)
            ).map(([label, Icon]) => (
              <button
                key={label}
                className={`nav-item ${page === label || (label === "Posts" && page === "Post") ? "active" : ""}`}
                onClick={() => {
                  onNavigate(label);
                }}
              >
                <Icon size={18} />
                {label}
              </button>
            ))}
            <div className="sidebar-bottom">
              {key && (
                <div className="communication-buttons">
                  <button
                    className="communication-button"
                    aria-label="Open chat"
                    title="Chat"
                    onClick={() => openChat()}
                  >
                    <MessageCircle size={17} />
                  </button>
                  <NotificationCentre
                    enabled
                    channels={notificationChannels}
                    onNavigate={openNotificationTarget}
                    onError={setError}
                  />
                  {(isAdministratorAccount || isAdministrator) && (
                    <button
                      className="communication-button"
                      aria-label="Open settings"
                      title="Settings"
                      onClick={() => onNavigate("Admin Settings")}
                    >
                      <Settings size={17} />
                    </button>
                  )}
                </div>
              )}
              <div className="connection-dot" /> <span>Workspace session</span>
              <button
                className="account-link"
                onClick={() => {
                  onNavigate("Account");
                  void loadProfile();
                }}
              >
                <span className="account-full">
                  {profile.sales_code ? `${profile.sales_code} - ` : ""}
                  {profile.first_name || profile.email || "My account"}
                  {connected ? " · Connected" : ""}
                </span>
                <span className="account-mobile">
                  {profile.sales_code || profile.first_name || "Account"}
                </span>
              </button>
              {key && (
                <button
                  className="text-button"
                  onClick={() => {
                    void disconnectKey();
                  }}
                >
                  Log out
                </button>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
