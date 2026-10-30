import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundled = await build({
  stdin: {
    contents: `
    export { default as RoadmapPage, RoadmapContent } from './src/roadmaps/RoadmapPage.tsx'
    export { roadmapDocuments } from './src/roadmaps/roadmapDocuments.ts'
    export { roadmapStatus } from './src/roadmaps/roadmapStatus.ts'
    export { pageContext, canOpenPage } from './src/platform/workspaceNavigation.ts'
    export { default as MarketingPostDetail } from './src/marketing/MarketingPostDetail.tsx'
    export { default as MarketingPosts } from './src/marketing/MarketingPosts.tsx'
    export { default as MarketingDialogs } from './src/marketing/MarketingDialogs.tsx'
    export { default as AppSidebar } from './src/platform/AppSidebar.tsx'
    export { default as ColorPicker } from './src/ColorPicker.tsx'
    export { default as AccountPage } from './src/platform/AccountPage.tsx'
    export { default as SignInPage } from './src/platform/SignInPage.tsx'
  `,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  mainFields: ["module", "main"],
  target: "es2022",
  jsx: "automatic",
  define: { "import.meta.env": "{}" },
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "test-browser-imports",
      setup(builder) {
        // Render with the same React instance as react-dom/server.
        builder.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, (args) => ({
          path: import.meta.resolve(args.path),
          external: true,
        }));
        builder.onResolve({ filter: /\.md\?raw$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: "roadmap-document",
        }));
        builder.onLoad(
          { filter: /.*/, namespace: "roadmap-document" },
          (args) => ({
            contents: readFileSync(args.path, "utf8"),
            loader: "text",
          }),
        );
      },
    },
  ],
});
const bundleFile = path.join(
  tmpdir(),
  `impala-workspace-test-${randomUUID()}.mjs`,
);
writeFileSync(bundleFile, bundled.outputFiles[0].text);
let ui;
try {
  ui = await import(pathToFileURL(bundleFile).href);
} finally {
  unlinkSync(bundleFile);
}
const render = (Component, props) =>
  renderToStaticMarkup(createElement(Component, props));
const no = () => {};

function account(overrides = {}) {
  return {
    isAdministrator: false,
    canAccessMarketing: false,
    canAccessSalesDesk: false,
    canAccessStock: false,
    canAccessReturns: false,
    canAccessReporting: false,
    canMarketing: () => false,
    reportingAccess: {
      admin: false,
      builder: false,
      catalogue: false,
      apps: 0,
    },
    profile: {
      first_name: "Employee",
      email: "employee@example.com",
      sales_code: "",
    },
    loadProfile: no,
    ...overrides,
  };
}

test("roadmap pages render the exact repository documents, including tables and priorities", () => {
  const files = {
    marketing: "MARKETING_ROADMAP.md",
    sales: "SALES_DESK_ROADMAP.md",
    stock: "SMART_STOCK_CONTROL_ROADMAP.md",
    returns: "RETURNS_CLAIMS_ROADMAP.md",
  };
  for (const [name, file] of Object.entries(files)) {
    const source = readFileSync(path.join(root, "..", "docs", file), "utf8");
    assert.equal(ui.roadmapDocuments[name], source);
    const html = render(ui.RoadmapPage, { document: name });
    assert.match(html, /roadmap-table/);
    assert.match(html, /<th>/);
    assert.match(html, /<ol>|<ul>/);
    assert.match(html, /Filter table rows by status/);
    // A documentation edit flows through the renderer, with no matching UI row to update.
    assert.match(
      render(ui.RoadmapContent, {
        markdown: source + "\n\nDocumentation-only example change.",
      }),
      /Documentation-only example change/,
    );
  }
});

test("status filters handle different document table layouts and preserve unclassified prose", () => {
  const markdown = `# Roadmap\n\nPriorities stay visible.\n\n| Capability | Current Impala Hub status | Improvement |\n|---|---|---|\n| Ready row | Implemented with previews | More tests |\n| Later row | Correctly deferred | Integration |\n| Missing row | Not implemented | Build it |\n| Descriptive row | Basic filters | Saved filters |\n`;
  const html = render(ui.RoadmapContent, { markdown, status: "Missing" });
  assert.match(html, /Missing row/);
  assert.doesNotMatch(html, /Ready row|Later row|Descriptive row/);
  assert.match(html, /Priorities stay visible/);
  const all = render(ui.RoadmapContent, { markdown });
  assert.match(all, /Descriptive row/);
  assert.match(all, /data-roadmap-status="Implemented"/);
  assert.equal(ui.roadmapStatus("Correctly deferred"), "Deferred");
  assert.equal(ui.roadmapStatus("Not implemented"), "Missing");
  assert.equal(ui.roadmapStatus("Basic filters"), null);
  assert.doesNotThrow(() =>
    render(ui.RoadmapContent, {
      markdown: "| A | Status |\n|---|---|\n| Short row |",
      status: "Planned",
    }),
  );
});

test("Markdown remains text and safe links, with no executable HTML or javascript links", () => {
  const html = render(ui.RoadmapContent, {
    markdown:
      "# Roadmap\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n`<img onerror=alert(1)>`",
  });
  assert.doesNotMatch(html, /<script|href="javascript:|<img onerror/);
  assert.match(html, /&lt;img onerror/);
});

test("workspace routing preserves permissions and administrator-only configuration", () => {
  const salesperson = account({ canAccessSalesDesk: true });
  assert.equal(ui.canOpenPage("RFQs", salesperson), true);
  assert.equal(ui.canOpenPage("RFQ Roadmap", salesperson), true);
  for (const page of [
    "Feed",
    "Posts",
    "Campaigns",
    "Marketing Accounts",
    "Roadmap",
    "Stock Booking",
    "Stock Control Roadmap",
    "Returns & Claims",
    "Admin Settings",
    "Stock Data Import",
  ])
    assert.equal(ui.canOpenPage(page, salesperson), false, page);
  const marketing = account({
    canAccessMarketing: true,
    canMarketing: (permission) => permission === "posts.view",
  });
  assert.equal(ui.canOpenPage("Posts", marketing), true);
  assert.equal(ui.canOpenPage("Post", marketing), true);
  assert.equal(ui.canOpenPage("Feed", marketing), false);
  assert.equal(ui.canOpenPage("Marketing Accounts", marketing), false);
  assert.equal(
    ui.canOpenPage(
      "Stock Data Import",
      account({ isAdministrator: true, canAccessStock: true }),
    ),
    true,
  );
  assert.equal(
    ui.pageContext("Stock Control Roadmap").isStockControlPage,
    true,
  );
  assert.equal(ui.pageContext("Reporting Roadmap").isReportingPage, true);
});

test("Sales Desk navigation exposes only its workspace and global controls", () => {
  const html = render(ui.AppSidebar, {
    page: "RFQs",
    sessionKey: "session",
    account: account({ canAccessSalesDesk: true }),
    connected: false,
    notificationChannels: ["sales_desk"],
    onNavigate: no,
    openNotificationTarget: no,
    setError: no,
    openChat: no,
    disconnectKey: async () => {},
  });
  assert.match(html, /RFQ Roadmap/);
  assert.match(html, /Apps Dashboard/);
  assert.doesNotMatch(html, /Stock Booking|Open settings|>Feed</);
});

test("the extracted post details and paged list render real conditional content", () => {
  const html = render(ui.MarketingPostDetail, {
    model: {
      campaigns: [],
      selected: null,
      canMarketing: () => false,
      setPage: no,
    },
  });
  assert.match(html, /Post not found/);
  assert.doesNotMatch(html, /selected \? \(/);
  const model = {
    posts: [],
    postTotal: 8,
    postPage: 0,
    postsLoading: false,
    postSummary: [],
    campaigns: [],
    filter: "all",
    campaignFilter: "all",
    search: "",
    view: "list",
    month: null,
    canMarketing: () => false,
    integrations: [],
    campaignTypes: [],
    visiblePosts: [],
    setMonth: no,
    setSearch: no,
    setView: no,
    setPostPage: no,
    setFilter: no,
    setCampaignFilter: no,
  };
  assert.match(render(ui.MarketingPosts, { model }), /of 8 posts/);
  assert.equal(
    render(ui.MarketingDialogs, {
      model: {
        page: "Posts",
        view: "list",
        editor: null,
        campaignModal: false,
        imageViewer: null,
      },
    }),
    "",
  );
});

test("an unconfigured deployment offers no alternate sign-in backend", () => {
  const html = render(ui.SignInPage, {
    session: {
      username: "",
      password: "",
      mfaCode: "",
      mfaChallengeId: "",
      setUsername: no,
      setPassword: no,
      setMfaCode: no,
      signIn: no,
      verifyMfaLogin: no,
    },
  });
  assert.match(html, /deployment is not configured/);
  assert.match(html, /type="email"/);
  assert.match(html, /<button[^>]*disabled/);
  assert.doesNotMatch(html, /Username|data migration|127\.0\.0\.1/);
});


test("only administrator accounts see the normal-view checkbox, including while previewing", () => {
  const admin = account({ isAdministratorAccount: true, normalUserView: false, profileBusy: false });
  const html = render(ui.AccountPage, { account: admin });
  assert.match(html, /Use normal user view/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  const preview = render(ui.AccountPage, { account: { ...admin, normalUserView: true, isAdministrator: false } });
  assert.match(preview, /type="checkbox"[^>]*checked/);
  assert.match(preview, /Untick this box to restore administrator access/);
  assert.doesNotMatch(render(ui.AccountPage, { account: account() }), /Use normal user view|type="checkbox"/);
});

test("normal-view navigation uses assigned roles instead of administrator controls", () => {
  const preview = account({ isAdministratorAccount: true, normalUserView: true, canAccessStock: true });
  assert.equal(ui.canOpenPage("Stock Booking", preview), true);
  assert.equal(ui.canOpenPage("RFQs", preview), false);
  assert.equal(ui.canOpenPage("Admin Settings", preview), false);
  const html = render(ui.AppSidebar, {
    page: "Stock Booking", sessionKey: "session", account: preview, connected: false,
    notificationChannels: ["stock_control"], onNavigate: no, openNotificationTarget: no,
    setError: no, openChat: no, disconnectKey: async () => {},
  });
  assert.match(html, /Stock Booking/);
  assert.doesNotMatch(html, /Stock Data Import|Open settings/);
});


test("shared colour controls show a wheel, RGB values and editable hex", () => {
  const html = render(ui.ColorPicker, { label: 'Milestone colour', value: '#234e70', onChange: no });
  assert.match(html, /type="color"/);
  assert.match(html, /Milestone colour: hex/);
  assert.match(html, /value="#234e70"/);
  for (const channel of ['R','G','B']) assert.match(html, new RegExp('Milestone colour: '+channel));
  for (const value of [35,78,112]) assert.match(html, new RegExp('value="'+value+'"'));
});
