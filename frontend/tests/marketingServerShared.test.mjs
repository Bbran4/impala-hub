import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { requireMarketingSession, requireCron } from "../api/_lib/auth.ts";
import { serverSettings, missingSettings } from "../api/_lib/config.ts";
import { encryptToken, decryptToken } from "../api/_lib/metaCrypto.ts";
import {
  DEFAULT_FACEBOOK_API_VERSION,
  facebookApiVersion,
  facebookGraphUrl,
} from "../api/_lib/facebook.ts";
import { HttpError, withApiErrors } from "../api/_lib/http.ts";

const env = {
  SUPABASE_URL: "https://project.example",
  SUPABASE_PUBLISHABLE_KEY: "browser-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const request = {
  method: "POST",
  headers: { authorization: "Bearer employee-token" },
};
function fixture({
  allowed = [],
  workspace = true,
  settingsManager = false,
  errorOn,
  user = { id: "employee" },
  userError = null,
} = {}) {
  const created = [],
    checks = [];
  const auth = {
    auth: {
      async getUser(token) {
        assert.equal(token, "employee-token");
        return { data: { user }, error: userError };
      },
    },
    async rpc(name, args) {
      checks.push([name, args]);
      const permission = args?.required_permission;
      return {
        data:
          name === "can_access_workspace" ? workspace
            : name === "can_manage_marketing_accounts" ? settingsManager || allowed.includes("feed.manage_accounts")
            : name === "can_view_marketing_connections" ? settingsManager || workspace
            : allowed.includes(permission),
        error:
          errorOn && (errorOn === name || errorOn === permission)
            ? { message: "database failure" }
            : null,
      };
    },
  };
  const admin = { privileged: true };
  const factory = (url, key, options) => {
    created.push(key);
    assert.equal(url, env.SUPABASE_URL);
    assert.deepEqual(options.auth, {
      persistSession: false,
      autoRefreshToken: false,
    });
    if (key === env.SUPABASE_SERVICE_ROLE_KEY) {
      assert.equal(options.global, undefined);
      return admin;
    }
    assert.equal(key, env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(options.global.headers.Authorization, "Bearer employee-token");
    return auth;
  };
  return {
    created,
    checks,
    admin,
    dependencies: { env, createClient: factory },
  };
}
const status = (expected) => (error) =>
  error instanceof HttpError && error.status === expected;

test("missing configuration and missing/expired sessions cannot create privileged clients", async () => {
  const missing = fixture();
  await assert.rejects(
    requireMarketingSession(
      request,
      "workspace",
      {},
      { ...missing.dependencies, env: {} },
    ),
    status(503),
  );
  assert.deepEqual(missing.created, []);
  const unsigned = fixture();
  await assert.rejects(
    requireMarketingSession(
      { headers: {} },
      "workspace",
      {},
      unsigned.dependencies,
    ),
    status(401),
  );
  assert.deepEqual(unsigned.created, []);
  const expired = fixture({ user: null, userError: { message: "expired" } });
  await assert.rejects(
    requireMarketingSession(request, "workspace", {}, expired.dependencies),
    status(401),
  );
  assert.deepEqual(expired.created, ["browser-key"]);
  assert.deepEqual(expired.checks, []);
});

test("workspace access is checked with the employee JWT before service-role access", async () => {
  const allowed = fixture();
  const context = await requireMarketingSession(
    request,
    "workspace",
    {},
    allowed.dependencies,
  );
  assert.equal(context.user.id, "employee");
  assert.equal(context.admin, allowed.admin);
  assert.deepEqual(allowed.checks, [
    ["can_access_workspace", { workspace_name: "marketing" }],
  ]);
  assert.deepEqual(allowed.created, ["browser-key", "service-key"]);
  for (const failure of [
    { workspace: false },
    { errorOn: "can_access_workspace" },
  ]) {
    const denied = fixture(failure);
    await assert.rejects(
      requireMarketingSession(request, "workspace", {}, denied.dependencies),
      status(failure.errorOn ? 500 : 403),
    );
    assert.deepEqual(denied.created, ["browser-key"]);
  }
});

test("account-management and publication gates retain their distinct permission rules", async () => {
  const denied = fixture({ allowed: ["posts.edit"] });
  await assert.rejects(
    requireMarketingSession(request, "accounts", {}, denied.dependencies),
    status(403),
  );
  assert.deepEqual(denied.created, ["browser-key"]);
  const manager = fixture({ allowed: ["feed.manage_accounts"] });
  await requireMarketingSession(
    request,
    "accounts",
    { required: ["encryptionKey"] },
    manager.dependencies,
  );
  assert.deepEqual(manager.checks, [
    ["can_manage_marketing_accounts", undefined],
  ]);
  for (const permission of [
    "feed.create",
    "feed.edit",
    "posts.create",
    "posts.edit",
  ]) {
    const publisher = fixture({ allowed: [permission] });
    await requireMarketingSession(
      request,
      "publishing",
      {},
      publisher.dependencies,
    );
    assert.equal(publisher.checks.length, 4);
    assert.deepEqual(publisher.created, ["browser-key", "service-key"]);
  }
  const broken = fixture({ allowed: ["posts.edit"], errorOn: "feed.create" });
  await assert.rejects(
    requireMarketingSession(request, "publishing", {}, broken.dependencies),
    status(500),
  );
  assert.deepEqual(broken.created, ["browser-key"]);
});

test("scheduler authentication uses its own secret, not an employee session", () => {
  assert.doesNotThrow(() =>
    requireCron(
      { headers: { authorization: "Bearer scheduler-secret" } },
      { CRON_SECRET: "scheduler-secret" },
    ),
  );
  for (const config of [{}, { CRON_SECRET: "different" }])
    assert.throws(() => requireCron(request, config), status(401));
});

test("configuration aliases and missing-name diagnostics never expose credentials", () => {
  const settings = serverSettings({
    VITE_SUPABASE_URL: "alias-url",
    VITE_SUPABASE_PUBLISHABLE_KEY: "alias-key",
    SUPABASE_SERVICE_ROLE_KEY: "private-value",
  });
  assert.equal(settings.url, "alias-url");
  assert.equal(settings.publishableKey, "alias-key");
  assert.deepEqual(
    missingSettings(settings, [
      "url",
      "publishableKey",
      "serviceRoleKey",
      "appSecret",
    ]),
    ["META_APP_SECRET"],
  );
  assert.ok(
    !JSON.stringify(missingSettings(settings, ["appId", "appSecret"])).includes(
      "private-value",
    ),
  );
});

test("known errors preserve HTTP status while unexpected exception details stay private", async () => {
  const response = () => ({
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  });
  const denied = response();
  await withApiErrors(() => {
    throw new HttpError(403, "Permission required.");
  })({ headers: {} }, denied);
  assert.equal(denied.code, 403);
  assert.equal(denied.body.detail, "Permission required.");
  const failed = response();
  await withApiErrors(() => {
    throw new Error("access_token=private-secret");
  })({ headers: {} }, failed);
  assert.equal(failed.code, 500);
  assert.doesNotMatch(JSON.stringify(failed.body), /private-secret/);
});

test("shared encryption reads existing token frames and rejects tampering", () => {
  const key = Buffer.alloc(32, 7),
    iv = Buffer.alloc(12, 9);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update("existing-page-token", "utf8"),
    cipher.final(),
  ]);
  const frame = [iv, cipher.getAuthTag(), ciphertext]
    .map((value) => value.toString("base64"))
    .join(".");
  assert.equal(
    decryptToken(frame, env.META_TOKEN_ENCRYPTION_KEY),
    "existing-page-token",
  );
  const one = encryptToken("new-token-✓", env.META_TOKEN_ENCRYPTION_KEY),
    two = encryptToken("new-token-✓", env.META_TOKEN_ENCRYPTION_KEY);
  assert.notEqual(one, two);
  assert.equal(decryptToken(one, env.META_TOKEN_ENCRYPTION_KEY), "new-token-✓");
  const parts = one.split("."),
    changed = Buffer.from(parts[2], "base64");
  changed[0] ^= 1;
  parts[2] = changed.toString("base64");
  assert.throws(() =>
    decryptToken(parts.join("."), env.META_TOKEN_ENCRYPTION_KEY),
  );
  assert.throws(() =>
    decryptToken(one, Buffer.alloc(32, 8).toString("base64")),
  );
  assert.throws(() =>
    decryptToken("invalid-frame", env.META_TOKEN_ENCRYPTION_KEY),
  );
  assert.throws(() => encryptToken("token", "not-a-key"), /32-byte/);
});

test("every Graph operation has one default and one validated environment override", () => {
  assert.equal(facebookApiVersion({}), DEFAULT_FACEBOOK_API_VERSION);
  assert.equal(
    facebookGraphUrl("/me/accounts", { FACEBOOK_API_VERSION: "v23.0" }),
    "https://graph.facebook.com/v23.0/me/accounts",
  );
  assert.throws(
    () =>
      facebookGraphUrl("me", {
        FACEBOOK_API_VERSION: "https://unexpected.example",
      }),
    status(503),
  );
  const root = fileURLToPath(new URL("../api/marketing/", import.meta.url));
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : entry.name.endsWith(".ts")
          ? [path.join(dir, entry.name)]
          : [],
    );
  for (const file of files(root))
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /graph\.facebook\.com|process\.env\.FACEBOOK_API_VERSION|function decrypt\(|createDecipheriv|createCipheriv|createClient\(/,
      path.relative(root, file),
    );
});

test("normal-view settings authority allows connection configuration without publishing or syncing", async () => {
  const admin = fixture({ workspace: false, settingsManager: true });
  for (const policy of ['accounts', 'connections']) await requireMarketingSession(request, policy, {}, admin.dependencies);
  for (const policy of ['workspace', 'publishing']) await assert.rejects(requireMarketingSession(request, policy, {}, admin.dependencies), status(403));
  const broken = fixture({ settingsManager: true, errorOn: 'can_manage_marketing_accounts' });
  await assert.rejects(requireMarketingSession(request, 'accounts', {}, broken.dependencies), status(500));
  assert.deepEqual(broken.created, ['browser-key']);
});
