import { Settings } from "lucide-react";
import type { MarketingModel } from "./useMarketingWorkspace";

export default function MarketingAccounts({
  model,
}: {
  model: MarketingModel;
}) {
  const { busy, integrations } = model;
  const {
    facebookPages,
    selectedFacebookPage,
    setSelectedFacebookPage,
    connectInstagram,
    checkInstagramConnection,
    disconnectInstagram,
    connectFacebook,
    chooseFacebookPage,
    disconnectFacebook,
    checkFacebookConnection,
  } = model.connections;
  return (
    <>
      <>
        <div className="section-head">
          <div>
            <h2>Connected channels</h2>
            <p>Facebook Page connection health and account identity.</p>
          </div>
        </div>
        <div className="integration-list">
          {integrations
            .filter(
              (i) => i.provider === "facebook" || i.provider === "instagram",
            )
            .map((i) => (
              <div className="integration" key={i.provider}>
                <div className={`provider-icon ${i.provider}`}>
                  {i.provider === "facebook"
                    ? "f"
                    : i.provider === "instagram"
                      ? "◎"
                      : "◉"}
                </div>
                <div className="integration-info">
                  <b>{i.label}</b>
                  <p>
                    {i.note ||
                      (i.status === "connected"
                        ? "Live Page identity check passed."
                        : "Official account connection is not configured.")}
                  </p>
                  {i.provider === "facebook" && i.page_id && (
                    <p>
                      <strong>Page ID:</strong> {i.page_id}
                    </p>
                  )}
                  {i.provider === "instagram" && i.account_id && (
                    <p>
                      <strong>Account ID:</strong> {i.account_id}
                    </p>
                  )}
                  {i.provider === "instagram" && i.username && (
                    <p>
                      <strong>Username:</strong> @{i.username}
                    </p>
                  )}
                  {i.provider === "instagram" && i.last_checked_at && (
                    <p>
                      <strong>Last checked:</strong>{" "}
                      {new Date(i.last_checked_at).toLocaleString()}
                    </p>
                  )}
                  {i.provider === "instagram" && i.last_success_at && (
                    <p>
                      <strong>Last successful check:</strong>{" "}
                      {new Date(i.last_success_at).toLocaleString()}
                    </p>
                  )}
                  {i.provider === "instagram" && i.token_type && (
                    <p>
                      <strong>Token type:</strong> {i.token_type}
                    </p>
                  )}
                  {i.provider === "instagram" && i.expires_at && (
                    <p>
                      <strong>Token expires:</strong>{" "}
                      {new Date(i.expires_at * 1000).toLocaleString()}
                    </p>
                  )}
                  {i.provider === "instagram" && i.data_access_expires_at && (
                    <p>
                      <strong>Data access expires:</strong>{" "}
                      {new Date(
                        i.data_access_expires_at * 1000,
                      ).toLocaleString()}
                    </p>
                  )}
                  {i.provider === "instagram" &&
                    !!i.granted_permissions?.length && (
                      <p>
                        <strong>Granted permissions:</strong>{" "}
                        {i.granted_permissions?.join(", ")}
                      </p>
                    )}
                  {i.provider === "instagram" && i.connection_source && (
                    <p>
                      <strong>Connection method:</strong>{" "}
                      {i.connection_source === "oauth"
                        ? "Meta OAuth"
                        : i.connection_source}
                    </p>
                  )}
                  {i.provider === "facebook" && i.last_checked_at && (
                    <p>
                      <strong>Last checked:</strong>{" "}
                      {new Date(i.last_checked_at).toLocaleString()}
                    </p>
                  )}
                  {i.provider === "facebook" && i.last_success_at && (
                    <p>
                      <strong>Last successful check:</strong>{" "}
                      {new Date(i.last_success_at).toLocaleString()}
                    </p>
                  )}
                  {i.provider === "facebook" && i.token_type && (
                    <p>
                      <strong>Token type:</strong> {i.token_type}
                    </p>
                  )}
                  {i.provider === "facebook" && i.expires_at && (
                    <p>
                      <strong>Token expires:</strong>{" "}
                      {new Date(i.expires_at * 1000).toLocaleString()}
                    </p>
                  )}
                  {i.provider === "facebook" && i.data_access_expires_at && (
                    <p>
                      <strong>Data access expires:</strong>{" "}
                      {new Date(
                        i.data_access_expires_at * 1000,
                      ).toLocaleString()}
                    </p>
                  )}
                  {i.provider === "facebook" &&
                    i.status === "connected" &&
                    !i.expires_at && (
                      <p>
                        Page token does not expire. Reconnect when data access
                        expires.
                      </p>
                    )}
                  {i.provider === "facebook" &&
                    !!i.granted_permissions?.length && (
                      <p>
                        <strong>Granted permissions:</strong>{" "}
                        {i.granted_permissions?.join(", ")}
                      </p>
                    )}
                  {i.provider === "facebook" &&
                    !!i.missing_permissions?.length && (
                      <p>
                        <strong>Missing permissions:</strong>{" "}
                        {i.missing_permissions?.join(", ")}
                      </p>
                    )}
                  {i.provider === "facebook" && i.diagnostic_note && (
                    <p>{i.diagnostic_note}</p>
                  )}
                  {i.provider === "facebook" && i.token_warning && (
                    <p className="token-warning">
                      <strong>Token warning:</strong> {i.token_warning}
                    </p>
                  )}
                  {i.provider === "facebook" && i.connection_source && (
                    <p>
                      <strong>Connection method:</strong>{" "}
                      {i.connection_source === "oauth"
                        ? "Meta OAuth"
                        : "Backend environment token"}
                    </p>
                  )}
                </div>
                <span className="status-badge">
                  {i.status === "connected"
                    ? `Connected${i.account_name ? `: ${i.account_name}` : ""}`
                    : i.status === "warning"
                      ? "Permission warning"
                      : i.status === "error"
                        ? "Connection error"
                        : "Not connected"}
                </span>
                {i.provider === "facebook" ? (
                  <div className="integration-actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void connectFacebook()}
                    >
                      {busy
                        ? "Working..."
                        : i.status === "connected"
                          ? "Reconnect Facebook"
                          : "Connect Facebook"}
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || i.status === "not_connected"}
                      onClick={() => void checkFacebookConnection()}
                    >
                      {busy ? "Checking..." : "Check connection"}
                    </button>
                    {i.status !== "not_connected" && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void disconnectFacebook()}
                      >
                        Disconnect
                      </button>
                    )}
                    {facebookPages.length > 0 && (
                      <div className="facebook-page-picker">
                        <label htmlFor="facebook-page-select">
                          Choose a Facebook Page
                        </label>
                        <select
                          id="facebook-page-select"
                          value={selectedFacebookPage}
                          onChange={(e) =>
                            setSelectedFacebookPage(e.target.value)
                          }
                        >
                          {facebookPages.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.id})
                            </option>
                          ))}
                        </select>
                        <button
                          className="secondary"
                          disabled={busy || !selectedFacebookPage}
                          onClick={() => void chooseFacebookPage()}
                        >
                          Use this Page
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="integration-actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void connectInstagram()}
                    >
                      {busy
                        ? "Working..."
                        : i.status === "connected"
                          ? "Reconnect Instagram"
                          : "Connect Instagram"}
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || i.status !== "connected"}
                      onClick={() => void checkInstagramConnection()}
                    >
                      {busy ? "Checking..." : "Check connection"}
                    </button>
                    {i.status === "connected" && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void disconnectInstagram()}
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
        </div>
        <div className="security-note">
          <Settings size={20} />
          <div>
            <b>Connection management</b>
            <p>
              Connect Facebook to authorize through Meta, then select the Page
              Impala Hub should manage. Page access tokens are encrypted before
              being stored by the backend. Keep your Meta app secret and
              encryption key private in backend/.env.
            </p>
          </div>
        </div>
      </>
    </>
  );
}
