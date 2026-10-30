import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

test("compiled Marketing handlers resolve their JavaScript dependencies and start", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = mkdtempSync(path.join(root, ".marketing-server-test-"));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(root, "node_modules/typescript/bin/tsc"),
        "--project",
        path.join(root, "tsconfig.server-test.json"),
        "--outDir",
        output,
      ],
      { cwd: root, stdio: "pipe" },
    );
    const handlers = [
      "status",
      "facebook/sync",
      "facebook/publish",
      "facebook/publish-due",
      "facebook/callback",
      "facebook/connection",
      "facebook/config",
      "facebook/oauth-url",
      "facebook/pages",
      "facebook/select-page",
    ];
    for (const name of handlers) {
      const entry = path.join(output, "api/marketing", `${name}.js`);
      const { default: handler } = await import(pathToFileURL(entry).href);
      let code;
      const response = {
        status(value) {
          code = value;
          return this;
        },
        json() {
          return this;
        },
      };
      await handler({ method: "PATCH", headers: {} }, response);
      assert.equal(code, 405, `${name} starts and rejects unsupported methods`);
    }
    assert.match(
      readFileSync(path.join(output, "api/marketing/facebook/sync.js"), "utf8"),
      /from ['"]\.\/_media\.js['"]/,
    );
    // Exercise every employee endpoint's missing-token path with configured server settings.
    const values = {
      SUPABASE_URL: "https://project.example",
      SUPABASE_PUBLISHABLE_KEY: "public-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
      META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      META_APP_ID: "test-app",
      META_APP_SECRET: "test-secret",
      FACEBOOK_OAUTH_REDIRECT_URI:
        "https://app.example/api/marketing/facebook/callback",
    };
    const previous = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, values);
      for (const [name, method] of [
        ["status", "GET"],
        ["facebook/sync", "POST"],
        ["facebook/publish", "POST"],
        ["facebook/connection", "POST"],
        ["facebook/connection", "DELETE"],
        ["facebook/oauth-url", "POST"],
        ["facebook/pages", "GET"],
        ["facebook/select-page", "POST"],
      ]) {
        const { default: handler } = await import(
          pathToFileURL(path.join(output, "api/marketing", `${name}.js`)).href
        );
        let code;
        const response = {
          status(value) {
            code = value;
            return this;
          },
          json() {
            return this;
          },
        };
        await handler({ method, headers: {} }, response);
        assert.equal(code, 401, `${name} requires a bearer session`);
      }
      const { default: callback } = await import(
        pathToFileURL(path.join(output, "api/marketing/facebook/callback.js"))
          .href
      );
      let destination;
      await callback(
        { method: "GET", headers: {}, query: {} },
        {
          redirect(url) {
            destination = url;
          },
        },
      );
      assert.match(destination, /reason=missing_code/);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
