import { useEffect, useState } from "react";
import { campaignsService } from "../campaignsService";
import { integrationsService, type Integration } from "../integrationsService";
import type { PlatformCallbacks } from "../platform/types";
const OAUTH_REASONS: Record<string, string> = {
  no_pages_selected:
    "You did not tick any Page in the Facebook dialog. Click Connect Facebook again and select your Page.",
  no_pages:
    "Meta returned no Pages for this account. Check that you have a role on the Page and on the Meta app. If the Page is in a Business Portfolio, set FACEBOOK_REQUEST_BUSINESS_MANAGEMENT=true in backend/.env and restart the API.",
  missing_permissions:
    "Not all required permissions were granted. Connect again and accept every permission.",
  page_token_unavailable:
    "Meta listed the Page but gave no Page token. You may lack full control of the Page.",
  invalid_state: "The login session expired. Try again.",
  authorization_cancelled: "Authorization was cancelled.",
  missing_code: "Meta did not return an authorization code. Try again.",
  setup: "Facebook OAuth is not fully configured in backend/.env.",
  meta_request_failed:
    "A request to Meta failed. Check META_APP_ID and META_APP_SECRET in backend/.env.",
};

export function useMarketingConnections({
  enabled,
  sessionKey,
  canManageAccounts,
  page,
  setPage,
  setNotice,
  setError,
  handleError,
}: PlatformCallbacks & {
  enabled: boolean;
  sessionKey: string;
  canManageAccounts: boolean;
  page: string;
  handleError: (error: unknown) => void;
}) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [facebookPages, setFacebookPages] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [selectedFacebookPage, setSelectedFacebookPage] = useState("");
  const [campaignTypes, setCampaignTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function load() {
    if (!enabled) return;
    const [connections, types] = await Promise.all([
      integrationsService.list(),
      campaignsService.types(),
    ]);
    setIntegrations(connections);
    setCampaignTypes(types.map((type) => type.name));
  }
  async function loadFacebookPages() {
    try {
      const result = await integrationsService.facebookPages();
      setFacebookPages(result.pages || []);
      if (result.connected_page_id)
        setSelectedFacebookPage(result.connected_page_id);
      else if (result.pages?.length)
        setSelectedFacebookPage(result.pages[0].id);
    } catch (e) {
      handleError(e);
    }
  }
  async function connectInstagram() {
    setBusy(true);
    setError("");
    try {
      const result = await integrationsService.connectInstagram();
      window.location.assign(result.url);
    } catch (e) {
      handleError(e);
      setBusy(false);
    }
  }
  async function checkInstagramConnection() {
    setBusy(true);
    setError("");
    try {
      const r = await integrationsService.checkInstagram();
      setNotice(
        `Instagram connection verified for ${r.username ? "@" + r.username : r.account_id}.`,
      );
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  async function disconnectInstagram() {
    if (
      !window.confirm(
        "Disconnect the Instagram account saved through Connect Instagram?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const r = await integrationsService.disconnectInstagram();
      setNotice(
        `Instagram disconnected. ${r.posts_removed || 0} post(s) removed from the feed.`,
      );
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  async function connectFacebook() {
    setBusy(true);
    setError("");
    try {
      const result = await integrationsService.connectFacebook();
      window.location.assign(result.url);
    } catch (e) {
      handleError(e);
      setBusy(false);
    }
  }
  async function chooseFacebookPage() {
    if (!selectedFacebookPage) return;
    setBusy(true);
    setError("");
    try {
      const result =
        await integrationsService.selectFacebookPage(selectedFacebookPage);
      setNotice("Connected Facebook Page: " + result.page_name);
      setIntegrations((items) =>
        items.map((item) =>
          item.provider === "facebook"
            ? {
                ...item,
                status: "connected",
                account_name: result.page_name,
                page_name: result.page_name,
                page_id: result.page_id,
                diagnostic_note: "Facebook Page connection saved.",
              }
            : item,
        ),
      );
      setFacebookPages([]);
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  async function disconnectFacebook() {
    if (
      !window.confirm(
        "Disconnect the Facebook Page saved through Connect Facebook?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await integrationsService.disconnectFacebook();
      setNotice(
        "Saved Facebook connection removed. To also revoke Impala Hub at Meta, remove the app under Facebook Settings > Business Integrations.",
      );
      setFacebookPages([]);
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  async function checkFacebookConnection() {
    setBusy(true);
    setError("");
    try {
      const r = await integrationsService.checkFacebook();
      setNotice(
        `Facebook connection verified for ${r.page_name || r.page_id}.`,
      );
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (enabled) void load().catch(handleError);
    else {
      setIntegrations([]);
      setCampaignTypes([]);
    }
  }, [enabled, sessionKey]);
  useEffect(() => {
    if (
      enabled &&
      canManageAccounts &&
      (page === "Admin Settings" || page === "Marketing Accounts")
    )
      void loadFacebookPages();
  }, [enabled, canManageAccounts, page]);

  useEffect(() => {
    if (!enabled) return;
    const params = new URLSearchParams(window.location.search);
    const fb = params.get("facebook_oauth");
    const ig = params.get("instagram_oauth");
    const reason = params.get("reason") || "unknown";
    const detail = params.get("detail");
    if (fb || ig) {
      params.delete("facebook_oauth");
      params.delete("instagram_oauth");
      params.delete("reason");
      params.delete("detail");
      const query = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname +
          (query ? "?" + query : "") +
          window.location.hash,
      );
    }
    if (fb === "choose_page") {
      setPage("Marketing Accounts");
      setNotice(
        "Facebook authorized. Choose the Page you want Impala Hub to manage.",
      );
      void loadFacebookPages();
    } else if (fb === "error") {
      setPage("Marketing Accounts");
      setError(
        OAUTH_REASONS[reason] ??
          `Facebook authorization did not finish (${reason.replaceAll("_", " ")}).`,
      );
    }
    if (ig === "connected") {
      setPage("Marketing Accounts");
      setNotice("Instagram connected.");
    } else if (ig === "error") {
      setPage("Marketing Accounts");
      setError(
        `Instagram authorization did not finish: ${reason.replaceAll("_", " ")}.${detail ? " Meta said: " + detail : ""}`,
      );
    }
  }, [enabled, sessionKey]);

  return {
    integrations,
    facebookPages,
    selectedFacebookPage,
    campaignTypes,
    busy,
    setIntegrations,
    setSelectedFacebookPage,
    loadFacebookPages,
    connectInstagram,
    checkInstagramConnection,
    disconnectInstagram,
    connectFacebook,
    chooseFacebookPage,
    disconnectFacebook,
    checkFacebookConnection,
    load,
  };
}
export type MarketingConnections = ReturnType<typeof useMarketingConnections>;
