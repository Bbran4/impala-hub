import type { HubAccount } from "./useAccount";
const qrImageSource = (value: string) =>
  value.startsWith("data:")
    ? value
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`;
export default function AccountPage({ account }: { account: HubAccount }) {
  const {
    profile,
    profileBusy,
    isAdministratorAccount,
    normalUserView,
    viewBusy,
    changeNormalUserView,
    mfaCode,
    mfaQr,
    mfaSecret,
    mfaSetupFactorId,
    mfaEnabled,
    setProfile,
    setMfaCode,
    saveProfile,
    uploadAvatar,
    sendPasswordReset,
    startMfaEnrollment,
    verifyMfaEnrollment,
  } = account;
  return (
    <>
      {" "}
      <section className="account-page">
        <div className="section-head">
          <div>
            <span className="eyebrow">YOUR ACCOUNT</span>
            <h2>Profile and security</h2>
            <p>Manage your personal details and sign-in security.</p>
          </div>
        </div>
        <div className="account-card">
          <div className="avatar-panel">
            {profile.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt="Profile"
                className="profile-avatar"
              />
            ) : (
              <div className="profile-avatar profile-avatar-empty">
                {(profile.first_name || profile.email || "?")
                  .slice(0, 1)
                  .toUpperCase()}
              </div>
            )}
            <label className="secondary avatar-upload">
              Change picture
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={profileBusy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadAvatar(file);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <div className="account-fields">
            <label>
              First name
              <input
                value={profile.first_name}
                onChange={(e) =>
                  setProfile({ ...profile, first_name: e.target.value })
                }
              />
            </label>
            <label>
              Surname
              <input
                value={profile.surname}
                onChange={(e) =>
                  setProfile({ ...profile, surname: e.target.value })
                }
              />
            </label>
            <label>
              Sales code
              <input
                value={profile.sales_code}
                placeholder="e.g. BB01"
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    sales_code: e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, ""),
                  })
                }
              />
            </label>
            <label>
              Email address
              <input value={profile.email} disabled />
            </label>
            <div className="password-reset">
              <div>
                <b>Password</b>
                <p>Your password is changed through a secure email link.</p>
              </div>
              <button
                className="secondary"
                disabled={profileBusy}
                onClick={() => void sendPasswordReset()}
              >
                Send reset link
              </button>
            </div>
            <div className="mfa-settings">
              <div>
                <b>Authenticator-app two-factor authentication</b>
                <p>
                  {mfaEnabled
                    ? "Enabled. Login requires a six-digit Google Authenticator code."
                    : "Scan the QR code with Google Authenticator, then enter its six-digit code."}
                </p>
              </div>
              {mfaSetupFactorId ? (
                <div className="mfa-enrolment">
                  <img
                    className="mfa-qr"
                    alt="Authenticator setup QR code"
                    src={qrImageSource(mfaQr)}
                  />
                  <small>
                    Manual setup key: <code>{mfaSecret}</code>
                  </small>
                  <div className="mfa-inline">
                    <input
                      inputMode="numeric"
                      aria-label="Authenticator verification code"
                      placeholder="Six-digit code"
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value)}
                    />
                    <button
                      className="secondary"
                      disabled={profileBusy || !mfaCode.trim()}
                      onClick={() => void verifyMfaEnrollment()}
                    >
                      Enable MFA
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="secondary"
                  disabled={profileBusy || mfaEnabled}
                  onClick={() => void startMfaEnrollment()}
                >
                  {mfaEnabled ? "MFA enabled" : "Set up MFA"}
                </button>
              )}
            </div>
            {isAdministratorAccount && (
              <div className="account-view-settings">
                <label>
                  <input
                    type="checkbox"
                    checked={normalUserView}
                    disabled={viewBusy}
                    onChange={(event) =>
                      void changeNormalUserView(event.target.checked)
                    }
                  />
                  <span>
                    <b>Use normal user view</b>
                    <small>
                      See the apps and data allowed by your assigned roles and
                      permissions, without administrator access. Untick this box
                      to restore administrator access.
                    </small>
                  </span>
                </label>
                {viewBusy && <p role="status">Updating your view…</p>}
              </div>
            )}
            <div className="account-actions">
              <button
                className="primary"
                disabled={profileBusy}
                onClick={() => void saveProfile()}
              >
                Save profile
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
