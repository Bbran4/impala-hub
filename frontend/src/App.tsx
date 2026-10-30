import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import ChatDock from "./ChatDock";
import ChannelsWorkspace from "./ChannelsWorkspace";
import type {
  NotificationChannel,
  UserNotification,
} from "./NotificationCentre";
import { useSession } from "./platform/useSession";
import { useAccount } from "./platform/useAccount";
import AppSidebar from "./platform/AppSidebar";
import WorkspaceHeader from "./platform/WorkspaceHeader";
import SignInPage from "./platform/SignInPage";
import AccountPage from "./platform/AccountPage";
import AppsDashboard from "./platform/AppsDashboard";
import {
  canOpenPage,
  marketingPages,
  pageContext,
} from "./platform/workspaceNavigation";
import { useMarketingConnections } from "./marketing/useMarketingConnections";
import { useMarketingWorkspace } from "./marketing/useMarketingWorkspace";
import MarketingWorkspace from "./workspaces/MarketingWorkspace";
import SalesDeskWorkspace from "./workspaces/SalesDeskWorkspace";
import StockWorkspace from "./workspaces/StockWorkspace";
import ReturnsWorkspace from "./workspaces/ReturnsWorkspace";
import ReportingWorkspace from "./workspaces/ReportingWorkspace";
import SettingsWorkspace from "./workspaces/SettingsWorkspace";

export default function App() {
  const [accessRevision, setAccessRevision] = useState(0);
  return (
    <HubApp
      key={accessRevision}
      initialPage={accessRevision ? "Account" : "Apps"}
      onAccessChanged={() => setAccessRevision((revision) => revision + 1)}
    />
  );
}

function HubApp({
  initialPage,
  onAccessChanged,
}: {
  initialPage: string;
  onAccessChanged: () => void;
}) {
  const [page, setPage] = useState(initialPage);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [notificationRfqId, setNotificationRfqId] = useState<string | null>(
    null,
  );
  const [chatOpenRequest, setChatOpenRequest] = useState(0);
  const session = useSession({ setPage, setNotice, setError });
  const account = useAccount(
    session.key,
    setNotice,
    setError,
    session.handleError,
    onAccessChanged,
  );
  const { key } = session;
  const {
    isAdministrator,
    profileLoaded,
    canAccessMarketing,
    canAccessSalesDesk,
    canAccessReturns,
    canAccessStock,
    canAccessReporting,
    canMarketing,
    marketingPermissions,
  } = account;
  const context = pageContext(page);
  const isMarketingPage = marketingPages.includes(page);
  const connections = useMarketingConnections({
    enabled: Boolean(key) && canAccessMarketing,
    sessionKey: key,
    page,
    canManageAccounts: isAdministrator || canMarketing("feed.manage_accounts"),
    setPage,
    setNotice,
    setError,
    handleError: session.handleError,
  });
  const marketing = useMarketingWorkspace({
    enabled: Boolean(key) && canAccessMarketing && isMarketingPage,
    sessionKey: key,
    page,
    connections,
    permissions: marketingPermissions,
    canMarketing,
    isAdministrator,
    setPage,
    setNotice,
    setError,
    handleError: session.handleError,
  });
  const notificationChannels: NotificationChannel[] = [
    ...(canAccessMarketing ? ["marketing" as const] : []),
    ...(canAccessSalesDesk ? ["sales_desk" as const] : []),
    ...(canAccessReturns ? ["returns_claims" as const] : []),
    ...(canAccessStock ? ["stock_control" as const] : []),
    ...(canAccessReporting ? ["reporting" as const] : []),
  ];
  useEffect(() => {
    if (!profileLoaded) return;
    if (
      ["Configuration", "Stock Control Configuration"].includes(page) &&
      isAdministrator
    ) {
      setPage("Admin Settings");
      return;
    }
    if (!canOpenPage(page, account)) setPage("Apps");
  }, [
    page,
    profileLoaded,
    isAdministrator,
    canAccessMarketing,
    canAccessSalesDesk,
    canAccessStock,
    canAccessReturns,
    marketingPermissions,
  ]);
  const navigate = (target: string) => {
    marketing.resetFilters();
    setPage(target);
  };
  function openNotificationTarget(notification: UserNotification) {
    setError("");
    setNotice("");
    if (notification.channel === "sales_desk" && canAccessSalesDesk) {
      setNotificationRfqId(notification.target_record_id);
      setPage("RFQs");
      return;
    }
    if (notification.channel === "marketing" && canAccessMarketing) {
      if (notification.target_record_id)
        marketing.setDetailId(notification.target_record_id);
      setPage(
        notification.target_page === "Post" && notification.target_record_id
          ? "Post"
          : notification.target_page || "Feed",
      );
      return;
    }
    if (notification.channel === "returns_claims" && canAccessReturns) {
      setPage("Returns & Claims");
      return;
    }
    if (notification.channel === "stock_control" && canAccessStock) {
      setPage(notification.target_page || "Stock Booking");
      return;
    }
    if (notification.channel === "reporting" && canAccessReporting) {
      const meta = notification.metadata || {};
      if (typeof meta.app_id === "string") {
        const detail = {
          app: meta.app_id,
          sheet: typeof meta.sheet_id === "string" ? meta.sheet_id : null,
          object: typeof meta.object_id === "string" ? meta.object_id : null,
        };
        try {
          sessionStorage.setItem("bi-open-app", detail.app);
          if (detail.sheet)
            sessionStorage.setItem("bi-open-sheet", detail.sheet);
          if (detail.object)
            sessionStorage.setItem("bi-open-object", detail.object);
        } catch {
          /* storage unavailable */
        }
        window.dispatchEvent(new CustomEvent("bi-open", { detail }));
      }
      setPage(notification.target_page || "Dashboards");
      return;
    }
    if (notification.channel === "system") {
      setPage(notification.target_page || "Apps");
      return;
    }
    setPage("Apps");
    setError(
      "You do not have access to the application linked to this notification.",
    );
  }

  const workspaceProps = { page, token: key, setNotice, setError };
  const allowed = canOpenPage(page, account);
  return (
    <div className="shell">
      <AppSidebar
        page={page}
        sessionKey={key}
        account={account}
        connected={connections.integrations.some(
          (item) => item.status === "connected",
        )}
        notificationChannels={notificationChannels}
        onNavigate={navigate}
        openNotificationTarget={openNotificationTarget}
        setError={setError}
        openChat={() => setChatOpenRequest((value) => value + 1)}
        disconnectKey={session.disconnectKey}
      />
      <main className="main">
        <WorkspaceHeader
          page={page}
          account={account}
          onCreatePost={marketing.openNewPost}
        />
        {notice && (
          <div className="notice">
            <CheckCircle2 size={17} />
            {notice}
            <button aria-label="Dismiss message" onClick={() => setNotice("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {error && (
          <div className="error">
            <CircleAlert size={17} />
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {key &&
          connections.integrations
            .filter(
              (item) => item.provider === "facebook" && item.token_warning,
            )
            .map((item) => (
              <div className="warning" key="fb-token">
                <CircleAlert size={17} />
                {item.token_warning}
                {!context.isAdminSettingsPage && isAdministrator && (
                  <button
                    className="secondary"
                    onClick={() => setPage("Admin Settings")}
                  >
                    Go to Settings
                  </button>
                )}
              </div>
            ))}
        {!key ? (
          <SignInPage session={session} />
        ) : (
          <>
            {page === "Account" && <AccountPage account={account} />}
            {page === "Apps" && (
              <AppsDashboard
                account={account}
                onNavigate={navigate}
                setNotice={setNotice}
                setError={setError}
              />
            )}
            {page === "Channels" && (
              <ChannelsWorkspace setNotice={setNotice} setError={setError} />
            )}
            {allowed && context.isAdminSettingsPage && (
              <SettingsWorkspace
                token={key}
                connections={connections}
                setNotice={setNotice}
                setError={setError}
                handleError={session.handleError}
              />
            )}
            {context.isReportingPage && (
              <ReportingWorkspace
                {...workspaceProps}
                canAccess={canAccessReporting}
                isAdministrator={isAdministrator}
                canBuild={isAdministrator || account.reportingAccess.builder}
              />
            )}
            {allowed && context.isSalesDeskPage && (
              <SalesDeskWorkspace
                {...workspaceProps}
                openRfqId={notificationRfqId}
                onOpenRfqHandled={() => setNotificationRfqId(null)}
              />
            )}
            {allowed && context.isStockControlPage && (
              <StockWorkspace {...workspaceProps} />
            )}
            {allowed && context.isReturnsClaimsPage && (
              <ReturnsWorkspace {...workspaceProps} />
            )}
            {allowed && isMarketingPage && (
              <MarketingWorkspace model={marketing} />
            )}
          </>
        )}
      </main>
      <ChatDock
        enabled={Boolean(key)}
        openRequest={chatOpenRequest}
        onError={setError}
        onOpenChannels={() => setPage("Channels")}
      />
    </div>
  );
}
