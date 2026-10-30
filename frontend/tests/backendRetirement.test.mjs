import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (name) => readFileSync(path.join(root, name), "utf8");
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(path.join(dir, entry.name))
      : /\.(ts|tsx)$/.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
  );
}

test("application source has no configurable API origin or legacy endpoint fallback", () => {
  const forbidden =
    /VITE_API_URL|legacyRequest|(?:127\.0\.0\.1|localhost):8000|backend[\\/]\.env|\/api\/(?:sales-desk|returns-claims|parts-queries|stock-booking|stock-reordering|integrations)\b/;
  for (const file of sources(path.join(root, "frontend/src")))
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      forbidden,
      path.relative(root, file),
    );
  assert.doesNotMatch(read("frontend/.env.example"), /VITE_API_URL|:8000/);
});

test("retired web-server sources, unused stock screens and API launcher are absent", () => {
  for (const name of [
    "backend/app/main.py",
    "backend/requirements.txt",
    "backend/tests/test_api.py",
    "start-api.bat",
    "frontend/src/StockBooking.tsx",
    "frontend/src/StockReordering.tsx",
  ])
    assert.equal(existsSync(path.join(root, name)), false, name);
  const workflow = read(".github/workflows/ci.yml");
  assert.doesNotMatch(
    workflow,
    /backend-tests|working-directory:\s*backend|requirements\.txt|pytest/,
  );
  assert.match(workflow, /supabase test db/);
  assert.match(workflow, /test_sales_desk_concurrency\.py/);
  assert.ok(
    existsSync(path.join(root, "bi-agent/requirements.txt")),
    "The supported Reporting agent remains",
  );
  assert.doesNotMatch(read("start-all.bat"), /start-api|:8000/);
});
