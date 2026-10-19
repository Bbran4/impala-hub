# Impala Hub Marketing MVP (foundation)

This is the first server-backed version of the Impala Hub Marketing workspace. It replaces browser-only demo data with a FastAPI API, SQLite persistence for local development, and server-side image uploads. It includes post and campaign CRUD, post-to-campaign relationships, draft/scheduled states, Facebook group selection fields, WhatsApp contact/group destination fields, an integration status screen, and an audit log.

## Important limits

- **This is a development foundation, not ready to expose to the public internet.** It currently uses a single API key, not individual employee accounts, roles, or a full production authentication system. Run it on your own computer or a trusted development network only.
- Facebook, Instagram and WhatsApp are **not connected**. The UI intentionally refuses to publish immediately. Scheduling stores the intended date/time, but a background worker is not included yet, so it will not automatically publish at that time.
- WhatsApp recipients/groups are sample placeholders. WhatsApp Cloud API messaging is not the same as publishing a social feed post. Support for existing WhatsApp groups depends on Meta's API availability and account eligibility; do not assume the group feature is available until verified.
- The local database is SQLite for easy development. For a hosted, multi-user company deployment, move to PostgreSQL, add employee login/roles, encrypted token storage, CSRF/state protections around OAuth, rate limiting, backups, audit review, and monitoring.

## Requirements

- Python 3.11+
- Node.js 20+

## Run locally

### 1. Start the API

```bash
cd backend
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env  # Windows; on macOS/Linux use: cp .env.example .env
```

Edit `backend/.env` and set `APP_API_KEY` to a long random secret. Then start the API:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The API docs are at `http://127.0.0.1:8000/docs`. The health endpoint is `http://127.0.0.1:8000/api/health`.

### 2. Start the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173` and enter the same API key configured in `backend/.env`. The key is held in session storage for that browser tab/session and is not a substitute for proper employee authentication.

## API endpoints

- `GET /api/health`
- `GET /api/posts?status=draft&campaign_id=...`
- `POST /api/posts`
- `PATCH /api/posts/{id}`
- `DELETE /api/posts/{id}`
- `GET /api/campaigns`
- `POST /api/campaigns`
- `PATCH /api/campaigns/{id}`
- `POST /api/media` (JPG, PNG, WEBP, GIF; max size set by `MAX_UPLOAD_MB`)
- `GET /api/integrations`

All API routes except health require `Authorization: Bearer <APP_API_KEY>`.

## Recommended implementation sequence

1. Confirm the official Impala Facebook Page, Instagram Professional account, and WhatsApp Business Platform setup.
2. Create/configure the Meta developer app and verify the needed permissions and review requirements.
3. Implement server-side OAuth, token encryption/rotation, account discovery, and real Facebook/Instagram publishing.
4. Add a reliable job queue/worker for scheduled posts, retries, idempotency, provider errors and status updates.
5. Assess WhatsApp contact messaging and group API eligibility separately.
6. Add employee login, role-based permissions, PostgreSQL, cloud object storage, HTTPS, monitoring and backups before company-wide deployment.

## Security notes

Never commit `.env`, provider tokens, secrets, customer lists, or production media to source control. Do not open the development server to the internet. Production deployment needs HTTPS, real user authentication, secure OAuth state handling, encrypted credentials, and reviewed access controls.
