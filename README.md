# Impala Hub Marketing MVP (foundation)

A server-backed first version of the Impala Hub Marketing workspace: a FastAPI API, SQLite persistence for local development, and server-side image uploads. It includes post and campaign CRUD, posts grouped under campaigns, draft / awaiting approval / scheduled states, Facebook group selection, an integration status screen and an audit log.

## Important limits

- **Development foundation only. Do not expose it to the internet.** It uses a single shared API key, not employee accounts or roles. Run it on your own computer or a trusted development network.
- Facebook, Instagram and WhatsApp are **not connected**. The UI cannot publish immediately. Scheduling only stores the intended date and time; no background worker exists yet, so nothing is published automatically. The `published` and `failed` statuses are reserved for that future worker and the API rejects them from clients.
- Engagement figures (clicks, likes, comments, shares) and `published_at` exist in the database but stay `NULL` ("not available") until a platform is connected. They are never shown as 0.
- Facebook groups and WhatsApp contacts/groups in the editor are **samples** and are labelled as such. WhatsApp support will be built after Facebook and Instagram work.
- **Unauthenticated URLs:** `GET /uploads/*` (images must load in `<img>` tags) and the API docs at `/docs` do not need the key. Don't upload anything confidential.
- Before a hosted, multi-user deployment: PostgreSQL, employee login and roles, encrypted token storage, OAuth state/CSRF protection, rate limiting, HTTPS, backups and monitoring.

## Requirements

- Python 3.11+
- Node.js 20+

## Run locally

### 1. Start the API

All backend commands must be run **from inside the `backend` folder** (`.env` and the data/upload paths are resolved relative to it).

```bash
cd backend
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env    # Windows; on macOS/Linux: cp .env.example .env
```

If PowerShell refuses to run `Activate.ps1`, run this once in that window and retry:

```powershell
Set-ExecutionPolicy -Scope Process RemoteSigned
```

Generate a secret and paste it into `backend/.env` as `APP_API_KEY`:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

The API answers `503` until `APP_API_KEY` is set to something other than the placeholder and is at least 24 characters. Then start it:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

API docs: `http://127.0.0.1:8000/docs`. Health check: `http://127.0.0.1:8000/api/health`.

The SQLite database is created and migrated automatically on startup (schema version is tracked with `PRAGMA user_version`). An older database is upgraded in place; legacy `needs_attention` posts become drafts.

### 2. Start the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173` and enter the same API key. The key is kept in session storage for that tab only. If the key is rejected you are returned to the key screen; use **Change API key** in the sidebar to switch keys.

If the API is not at `http://127.0.0.1:8000`, create `frontend/.env.local` containing `VITE_API_URL=http://your-host:port` (and add that origin to the CORS list in `backend/app/main.py`).

### 3. Run the tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest
```

Tests use a temporary database and upload folder, so they work on Windows, macOS and Linux and never touch your real data.

## API endpoints

All routes except `GET /api/health` need `Authorization: Bearer <APP_API_KEY>`.

- `GET /api/health`
- `GET /api/posts?status=draft&campaign_id=...` (status: draft, awaiting_approval, scheduled, published, failed)
- `POST /api/posts`
- `PATCH /api/posts/{id}` (partial update; published posts return 409)
- `DELETE /api/posts/{id}`
- `GET /api/campaigns`, `POST /api/campaigns`, `PATCH /api/campaigns/{id}` (partial update)
- `POST /api/media` (JPG, PNG, WEBP, GIF; limit set by `MAX_UPLOAD_MB`)
- `GET /api/integrations`
- `GET /api/audit?limit=100` (newest first)

Rules enforced by the API: clients may only set `draft`, `awaiting_approval` or `scheduled`; scheduled posts need a date and at least one channel; Instagram posts need an image to be scheduled; media must come from `/api/media`; at most 3 Facebook groups; campaign end date must not precede its start date. `publish_at` is stored in UTC.

## Formatting

`npm run format` runs Prettier over `frontend/src`. Run it once on `style.css` too (`npx prettier --write src/style.css`) to expand the minified rules.

## Recommended implementation sequence

1. Confirm the Impala Facebook Page and Instagram Professional account, then create and configure the Meta developer app.
2. Server-side OAuth, token encryption and rotation, account discovery, and real Facebook/Instagram publishing.
3. A job queue/worker for scheduled posts with retries, idempotency and status updates (this is what sets `published`, `failed`, `published_at` and the metrics).
4. Post detail view, calendar/board views, Channels and Streams.
5. WhatsApp contact messaging and group eligibility.
6. Employee login, roles, PostgreSQL, cloud object storage, HTTPS, monitoring and backups.

## Security notes

Never commit `.env`, provider tokens, secrets, customer lists or production media. Do not open the development server to the internet.
