# Application structure and roadmap documents

`frontend/src/App.tsx` owns the selected page, shared messages and navigation from notifications. It composes the platform and workspace entry points; it contains no roadmap rows, Marketing forms or workspace data queries.

- `platform/`: sign-in/session state, account/security settings, Apps Dashboard, sidebar, headings and workspace access checks.
- `workspaces/`: entry components for Marketing, Sales Desk, Smart Stock, Returns & Claims, application settings and the existing Reporting component. Reporting implementation and its roadmap remain unchanged.
- `marketing/`: separate Feed, Posts, Campaigns and Accounts views; post/campaign editors, detail/image dialogs; Marketing data and shared provider-connection hooks. These keep using the typed services and transactional database commands.
- `roadmaps/`: one shared Markdown renderer and an explicit allowlist of roadmap source documents.

The four roadmap pages render these files directly through Vite's raw imports:

- `docs/MARKETING_ROADMAP.md`
- `docs/SALES_DESK_ROADMAP.md`
- `docs/SMART_STOCK_CONTROL_ROADMAP.md`
- `docs/RETURNS_CLAIMS_ROADMAP.md`

Edit the Markdown document and deploy to update its page. There is no second table or priority list to maintain in React. Tables, headings, lists and inline code render from the source. Raw HTML is skipped, and Markdown links use the renderer's safe URL handling. The roadmap renderer and documents load as a separate chunk when a roadmap is opened.

Status filters apply to tables with a `Status` or `Current Impala Hub status` column. They recognize explicit Implemented, Partial, Planned, Deferred, Missing and Retired labels, including `Not implemented` and `Correctly deferred`. Descriptive prose is not assigned a guessed status; it remains visible under All statuses. Narrative sections and tables without status columns remain visible. The default view includes all content from the document.

The Vite development server allows the repository root so it can resolve these explicitly imported files outside `frontend/`. Other documentation is not bundled. No database migration is required.

Validation includes rendering the actual documents, documentation-only edits, status filtering, safe Markdown handling, workspace permissions, navigation, and the extracted Marketing list/detail/dialog components. Existing sign-in/MFA and notification flows keep their prior operations; no live credentials are needed for the automated rendering tests.
