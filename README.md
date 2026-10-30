# Impala Hub

Impala Hub is a React/TypeScript application hosted on Vercel, with Supabase authentication, PostgreSQL, Storage and database-enforced permissions. Privileged Marketing and Reporting operations run in Vercel functions under `frontend/api/`.

## Workspaces

- Marketing: campaigns, posts, Facebook connection/sync/publishing, paged history and insights.
- Sales Desk: transactional RFQs, assignments, invoice copies, configuration and Johannesburg-based analytics.
- Smart Stock Control: Parts Queries, manual stock imports, booking transfers and reordering.
- Returns & Claims: lifecycle validation, supplier outcomes, attachments, ageing and exports.
- Reporting: dashboards, reports and the separate on-premises sync agent in `bi-agent/`.
- Shared: employee sign-in/MFA, application settings, chat, channels and notifications.

Instagram, WhatsApp and several external integrations remain deferred; see each workspace roadmap for current coverage.

## Requirements and local development

Use Node.js 22 or newer. For local database tests, also install Docker and use the pinned Supabase CLI from `frontend/package.json`.

```powershell
cd frontend
npm ci
Copy-Item .env.example .env.local
# Set the Supabase browser values in .env.local.
npm run dev
```

Vite serves the UI and uses Supabase directly. Missing Supabase configuration shows a setup message and disables sign-in. There is no separate Python web server or local API fallback.

To exercise Vercel functions locally, link the existing Vercel project from `frontend/`, pull its Development settings, and use `npx vercel dev` instead of plain Vite. This does not deploy the application. See the [Vercel development documentation](https://vercel.com/docs/cli/dev) and [project-settings guidance](https://vercel.com/docs/cli/pull).

The Windows shortcuts `start-frontend.bat` and `start-all.bat` both start the UI. They do not start an API process.

## Configuration

Browser build values:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Set private server credentials in the Vercel project's environment settings. The Marketing functions require `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `META_APP_ID`, `META_APP_SECRET`, `META_TOKEN_ENCRYPTION_KEY`, `FACEBOOK_OAUTH_REDIRECT_URI` and the scheduler's `CRON_SECRET`. `FRONTEND_URL` controls the post-authorization destination. Never prefix private secrets with `VITE_`.

[Facebook setup](FACEBOOK_SETUP.md) describes the supported connection flow. The cron schedule in `frontend/vercel.json` controls scheduled publishing; the worker processes due posts when it runs, not continuously at every requested publication time.

## Verification

```powershell
cd frontend
npm test
npm run build
```

For isolated database checks, run the Supabase commands in [the deployment runbook](docs/DEPLOYMENT.md). GitHub Actions runs frontend checks, database tests and the Sales Desk concurrency check. Database tests must use a local stack, never production.

Vercel and Supabase have separate GitHub integrations. Keep both connected to the intended repository and branch, and verify deployment/migration results after a push. Applied migrations remain tracked by Supabase; retiring old application code requires no database migration.

## Documentation

- [Product scope](docs/PRODUCT_SCOPE.md)
- [Application structure and documentation-driven roadmaps](docs/APP_STRUCTURE.md)
- [Typed workspace services](docs/TYPED_SERVICES.md)
- [Deployment runbook](docs/DEPLOYMENT.md)
- [Marketing roadmap](docs/MARKETING_ROADMAP.md)
- [Sales Desk roadmap](docs/SALES_DESK_ROADMAP.md)
- [Smart Stock roadmap](docs/SMART_STOCK_CONTROL_ROADMAP.md)
- [Returns & Claims roadmap](docs/RETURNS_CLAIMS_ROADMAP.md)
- [Reporting agent](bi-agent/README.md)

## Legacy retirement

The former FastAPI application, its tests, Python web-server dependencies and API launcher have been removed. Workspace services support only Supabase and same-origin Vercel functions. Local SQLite files or uploaded evidence are not deleted by this code change. Historical investigations describe earlier revisions and remain evidence, not deployment instructions.
