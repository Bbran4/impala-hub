import { supabaseConfigured } from "../supabase";
import type { HubSession } from "./useSession";
export default function SignInPage({ session }: { session: HubSession }) {
  const {
    username,
    password,
    mfaCode,
    mfaChallengeId,
    setUsername,
    setPassword,
    setMfaCode,
    signIn,
    verifyMfaLogin,
  } = session;
  return (
    <>
      {" "}
      <section className="key-panel">
        <h2>Sign in to Impala Hub</h2>
        <p>
          Use your employee account to open the App Dashboard. Sessions are
          scoped to this browser tab.
        </p>
        {mfaChallengeId ? (
          <div className="mfa-form">
            <p className="hint">
              Enter the six-digit code from Google Authenticator to finish
              signing in.
            </p>
            <input
              inputMode="numeric"
              autoFocus
              aria-label="MFA verification code"
              placeholder="Verification code"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void verifyMfaLogin();
              }}
            />
            <button
              className="primary"
              disabled={!mfaCode.trim()}
              onClick={() => void verifyMfaLogin()}
            >
              Verify code
            </button>
          </div>
        ) : (
          <div className="inline-form">
            <input
              aria-label="Email"
              type="email"
              placeholder="Email address"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              type="password"
              aria-label="Password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void signIn();
              }}
            />
            <button
              className="primary"
              disabled={!supabaseConfigured}
              onClick={() => void signIn()}
            >
              Sign in
            </button>
            {!supabaseConfigured && (
              <p className="error" role="alert">
                Sign-in is unavailable because this deployment is not
                configured. Contact your administrator.
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
