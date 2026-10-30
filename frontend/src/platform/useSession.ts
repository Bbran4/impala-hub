import { useEffect, useState } from "react";
import { authService } from "../authService";
import {
  API as apiBaseUrl,
  AuthError,
  getKey,
  KEY_STORAGE,
} from "../serviceTransport";
import { supabase, supabaseConfigured } from "../supabase";
import type { PlatformCallbacks } from "./types";
export function useSession({
  setNotice,
  setError,
  setPage,
}: PlatformCallbacks) {
  const [key, setKey] = useState(getKey());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaFactorId, setMfaFactorId] = useState("");
  const [mfaChallengeId, setMfaChallengeId] = useState("");
  useEffect(() => {
    if (!supabaseConfigured || !supabase) return;
    localStorage.removeItem(KEY_STORAGE);
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted && !data.session) {
        sessionStorage.removeItem(KEY_STORAGE);
        setKey("");
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!mounted) return;
        if (!session) {
          sessionStorage.removeItem(KEY_STORAGE);
          setKey("");
        }
      },
    );
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  function handleError(e: unknown) {
    const message = (e as Error).message;
    if (e instanceof AuthError) {
      localStorage.removeItem(KEY_STORAGE);
      sessionStorage.removeItem(KEY_STORAGE);
      setKey("");
    }
    setError(message);
  }
  async function signIn() {
    setError("");
    if (supabaseConfigured && supabase) {
      const { data, error: authError } = await supabase.auth.signInWithPassword(
        { email: username.trim(), password },
      );
      if (authError) {
        setError(authError.message);
        return;
      }
      if (!data.session) {
        setError(
          "Supabase did not create a session. Confirm the user email before signing in.",
        );
        return;
      }
      const assurance =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (
        assurance.data?.currentLevel === "aal1" &&
        assurance.data?.nextLevel === "aal2"
      ) {
        const factors = await supabase.auth.mfa.listFactors();
        const factor = factors.data?.all?.find(
          (item) => item.factor_type === "totp" && item.status === "verified",
        );
        if (!factor) {
          await supabase.auth.signOut();
          setError(
            "Your account requires MFA, but no verified authenticator factor is available. Contact an administrator.",
          );
          return;
        }
        const challenge = await supabase.auth.mfa.challenge({
          factorId: factor.id,
        });
        if (challenge.error) {
          await supabase.auth.signOut();
          setError(challenge.error.message);
          return;
        }
        setMfaFactorId(factor.id);
        setMfaChallengeId(challenge.data.id);
        setNotice("Enter the six-digit code from Google Authenticator.");
        return;
      }
      sessionStorage.setItem(KEY_STORAGE, data.session.access_token);
      setKey(data.session.access_token);
      setPassword("");
      setPage("Apps");
      setNotice(
        "Signed in with Supabase. Workspace data migration is the next step.",
      );
      return;
    }
    try {
      const response = await fetch(`${apiBaseUrl}/api/sales-desk/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "Sign-in failed");
      sessionStorage.setItem(KEY_STORAGE, body.access_token);
      setKey(body.access_token);
      setPassword("");
      setPage("Apps");
      setNotice("Signed in successfully.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function verifyMfaLogin() {
    if (!supabase || !mfaFactorId || !mfaChallengeId) return;
    setError("");
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: mfaFactorId,
      challengeId: mfaChallengeId,
      code: mfaCode.trim(),
    });
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    const session = (await supabase.auth.getSession()).data.session;
    if (session) sessionStorage.setItem(KEY_STORAGE, session.access_token);
    setMfaCode("");
    setMfaFactorId("");
    setMfaChallengeId("");
    setPassword("");
    setPage("Apps");
    setNotice("Signed in with MFA.");
    setKey(session?.access_token || "");
  }
  async function disconnectKey() {
    await authService.signOut();
    localStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(KEY_STORAGE);
    setKey("");
    setNotice("");
    window.location.reload();
  }

  return {
    key,
    username,
    password,
    mfaCode,
    mfaFactorId,
    mfaChallengeId,
    setUsername,
    setPassword,
    setMfaCode,
    signIn,
    verifyMfaLogin,
    disconnectKey,
    handleError,
  };
}
export type HubSession = ReturnType<typeof useSession>;
