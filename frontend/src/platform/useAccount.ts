import { useEffect, useState } from "react";
import type { MarketingPermission } from "../marketingPermissions";
import { clearRfqSession } from "../rfqService";
import { supabase } from "../supabase";
export function useAccount(
  sessionKey: string,
  setNotice: (message: string) => void,
  setError: (message: string) => void,
  handleError: (error: unknown) => void,
  onAccessChanged: () => void,
) {
  const [profile, setProfile] = useState({
    first_name: "",
    surname: "",
    email: "",
    avatar_url: "",
    sales_code: "",
  });
  const [profileBusy, setProfileBusy] = useState(false);
  const [isAdministratorAccount, setIsAdministratorAccount] = useState(false);
  const [normalUserView, setNormalUserView] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const [isAdministrator, setIsAdministrator] = useState(false);
  const [assignedRoles, setAssignedRoles] = useState<string[]>([]);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [marketingPermissions, setMarketingPermissions] = useState<
    MarketingPermission[]
  >([]);
  const [reportingAccess, setReportingAccess] = useState({
    admin: false,
    builder: false,
    catalogue: false,
    apps: 0,
  });
  const [mfaCode, setMfaCode] = useState("");
  const [mfaQr, setMfaQr] = useState("");
  const [mfaSecret, setMfaSecret] = useState("");
  const [mfaSetupFactorId, setMfaSetupFactorId] = useState("");
  const [mfaSetupChallengeId, setMfaSetupChallengeId] = useState("");
  const [mfaEnabled, setMfaEnabled] = useState(false);
  async function loadProfile() {
    if (!supabase) return;
    const user = (await supabase.auth.getUser()).data.user;
    if (!user) {
      setProfileLoaded(true);
      return;
    }
    const { data } = await supabase
      .from("profiles")
      .select("first_name,surname,email,avatar_url,sales_code")
      .eq("id", user.id)
      .maybeSingle();
    const access = await supabase.rpc("my_account_access");
    if (access.error || !access.data)
      throw new Error(
        access.error?.message || "Unable to load account access.",
      );
    const roleIds: string[] = access.data.roles || [];
    setIsAdministratorAccount(access.data.is_administrator_account === true);
    setNormalUserView(access.data.normal_user_view === true);
    setIsAdministrator(roleIds.includes("administrator"));
    setAssignedRoles(roleIds);
    clearRfqSession();
    const permissions = await supabase.rpc("my_marketing_permissions");
    setMarketingPermissions((permissions.data || []) as MarketingPermission[]);
    const factors = await supabase.auth.mfa.listFactors();
    setMfaEnabled(
      Boolean(
        factors.data?.all?.some(
          (factor) =>
            factor.factor_type === "totp" && factor.status === "verified",
        ),
      ),
    );
    void supabase.rpc("bi_my_access").then(({ data }) => {
      if (data) setReportingAccess(data);
    });
    setProfile({
      first_name: data?.first_name || user.user_metadata?.first_name || "",
      surname: data?.surname || user.user_metadata?.surname || "",
      email: user.email || data?.email || "",
      avatar_url: data?.avatar_url || "",
      sales_code: data?.sales_code || "",
    });
    setProfileLoaded(true);
  }
  async function changeNormalUserView(enabled: boolean) {
    if (!supabase || viewBusy) return;
    setViewBusy(true);
    setError("");
    try {
      const result = await supabase.rpc("set_my_normal_user_view", {
        p_enabled: enabled,
      });
      if (result.error) throw new Error(result.error.message);
      // Remount the workspace to discard privileged rows, open editors and
      // cached session metadata without losing the in-memory sign-in session.
      clearRfqSession();
      onAccessChanged();
    } catch (error) {
      handleError(error);
    } finally {
      setViewBusy(false);
    }
  }
  async function saveProfile() {
    if (!supabase) return;
    setProfileBusy(true);
    setError("");
    try {
      const user = (await supabase.auth.getUser()).data.user;
      if (!user) throw new Error("Your session has expired. Sign in again.");
      const salesCode = profile.sales_code.trim().toUpperCase();
      const { error: updateError } = await supabase
        .from("profiles")
        .update({
          first_name: profile.first_name.trim(),
          surname: profile.surname.trim(),
          display_name:
            `${profile.first_name.trim()} ${profile.surname.trim()}`.trim(),
          avatar_url: profile.avatar_url || null,
          sales_code: salesCode || null,
        })
        .eq("id", user.id);
      if (updateError) throw new Error(updateError.message);
      setNotice("Profile saved.");
    } catch (e) {
      handleError(e);
    } finally {
      setProfileBusy(false);
    }
  }
  async function uploadAvatar(file: File) {
    if (!supabase) return;
    const user = (await supabase.auth.getUser()).data.user;
    if (!user) return;
    setProfileBusy(true);
    setError("");
    try {
      const path = `${user.id}/avatar-${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("profile-avatars")
        .upload(path, file, { upsert: false, contentType: file.type });
      if (uploadError) throw new Error(uploadError.message);
      const { data } = supabase.storage
        .from("profile-avatars")
        .getPublicUrl(path);
      setProfile((current) => ({ ...current, avatar_url: data.publicUrl }));
      setNotice("Profile picture uploaded. Click Save profile to keep it.");
    } catch (e) {
      handleError(e);
    } finally {
      setProfileBusy(false);
    }
  }
  async function sendPasswordReset() {
    if (!supabase || !profile.email) return;
    setProfileBusy(true);
    setError("");
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        profile.email,
        { redirectTo: window.location.origin },
      );
      if (resetError) throw new Error(resetError.message);
      setNotice("A password reset link was sent to your email address.");
    } catch (e) {
      handleError(e);
    } finally {
      setProfileBusy(false);
    }
  }
  async function startMfaEnrollment() {
    if (!supabase) return;
    setProfileBusy(true);
    setError("");
    try {
      const existing = await supabase.auth.mfa.listFactors();
      const current = existing.data?.all?.find(
        (factor) => factor.factor_type === "totp",
      );
      if (current?.status === "verified") {
        setMfaEnabled(true);
        setNotice("Authenticator-app MFA is already enabled for this account.");
        return;
      }
      if (current?.status === "unverified")
        await supabase.auth.mfa.unenroll({ factorId: current.id });
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Impala Hub",
      });
      if (enrollError) throw new Error(enrollError.message);
      setMfaSetupFactorId(data.id);
      setMfaQr(data.totp?.qr_code || "");
      setMfaSecret(data.totp?.secret || "");
      setNotice(
        "Scan the QR code with Google Authenticator, then enter the six-digit code.",
      );
    } catch (e) {
      handleError(e);
    } finally {
      setProfileBusy(false);
    }
  }
  async function verifyMfaEnrollment() {
    if (!supabase || !mfaSetupFactorId) return;
    setProfileBusy(true);
    setError("");
    try {
      const challenge = await supabase.auth.mfa.challenge({
        factorId: mfaSetupFactorId,
      });
      if (challenge.error) throw new Error(challenge.error.message);
      setMfaSetupChallengeId(challenge.data.id);
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaSetupFactorId,
        challengeId: challenge.data.id,
        code: mfaCode.trim(),
      });
      if (verifyError) throw new Error(verifyError.message);
      setMfaCode("");
      setMfaQr("");
      setMfaSecret("");
      setMfaSetupFactorId("");
      setMfaSetupChallengeId("");
      setMfaEnabled(true);
      setNotice("Authenticator-app MFA is enabled for your account.");
    } catch (e) {
      handleError(e);
    } finally {
      setProfileBusy(false);
    }
  }

  useEffect(() => {
    if (sessionKey) void loadProfile().catch(handleError);
    else {
      setAssignedRoles([]);
      setMarketingPermissions([]);
      setIsAdministrator(false);
      setIsAdministratorAccount(false);
      setNormalUserView(false);
      setReportingAccess({
        admin: false,
        builder: false,
        catalogue: false,
        apps: 0,
      });
      setProfileLoaded(false);
    }
  }, [sessionKey]);
  const canAccessMarketing =
    isAdministrator ||
    assignedRoles.includes("marketing") ||
    assignedRoles.includes("management");
  const canMarketing = (permission: MarketingPermission) =>
    isAdministrator || marketingPermissions.includes(permission);
  const canAccessSalesDesk =
    isAdministrator ||
    assignedRoles.includes("sales") ||
    assignedRoles.includes("sales_manager") ||
    assignedRoles.includes("management");
  const canAccessReturns =
    isAdministrator ||
    assignedRoles.includes("returns") ||
    assignedRoles.includes("management");
  const canAccessStock =
    isAdministrator ||
    assignedRoles.includes("stock") ||
    assignedRoles.includes("management");
  const canAccessReporting =
    isAdministrator ||
    assignedRoles.includes("reporting") ||
    assignedRoles.includes("management") ||
    assignedRoles.includes("report_builder") ||
    reportingAccess.apps > 0;

  return {
    profile,
    profileBusy,
    isAdministrator,
    isAdministratorAccount,
    normalUserView,
    viewBusy,
    changeNormalUserView,
    assignedRoles,
    profileLoaded,
    marketingPermissions,
    reportingAccess,
    mfaCode,
    mfaQr,
    mfaSecret,
    mfaSetupFactorId,
    mfaSetupChallengeId,
    mfaEnabled,
    setProfile,
    setMfaCode,
    loadProfile,
    saveProfile,
    uploadAvatar,
    sendPasswordReset,
    startMfaEnrollment,
    verifyMfaEnrollment,
    canAccessMarketing,
    canMarketing,
    canAccessSalesDesk,
    canAccessReturns,
    canAccessStock,
    canAccessReporting,
  };
}
export type HubAccount = ReturnType<typeof useAccount>;
