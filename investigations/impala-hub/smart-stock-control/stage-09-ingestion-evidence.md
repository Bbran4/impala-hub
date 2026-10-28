# Smart Stock Control: Stage 9 Ingestion Evidence

## Scope

This record covers the automated Google Sheets ingestion prototype prepared on 2026-10-27 on branch `supabase-migration`. It is retained as historical implementation evidence; no private workbook contents or credentials were captured.

**Retirement notice (2026-10-28):** the prototype was intentionally removed from the deployable frontend and Vercel functions. Migration `0045_retire_google_stock_ingestion.sql` disables sources and revokes execution grants while preserving database history. The artifact hashes below describe the retired prototype and do not describe current deployable files.

## Provenance

| Artifact | SHA-256 | Evidence |
|---|---|---|
| `supabase/migrations/0044_stock_ingestion_sources.sql` | `0470829ED6FAF9A7D72F7550648DCE68F64EA21CB8AFDEF40A05456145E4F443` | Private source configuration, RLS, run lifecycle, service-only import wrappers and audit events |
| `frontend/server/stock/ingestion/googleSheets.ts` | `E73C259DB0D4941434DB1992FDE4BE100CA056B144002911887EA362E20F4271` | Read-only Google Sheets extraction and retry behavior |
| `frontend/server/stock/ingestion/sourceAdapters.ts` | `5A7B4FAAC19ADA6F58377DF39677DAC7D473177792F19631C18BB0D6B513C46C` | Replaceable provider adapter boundary |
| `frontend/server/stock/ingestion/safeError.ts` | `A62B2BD4D3FEBCCD9B4FF65C0D5ECAB21D7A48DB8CB29B8AE892435BD000D963` | Bounded provider diagnostic sanitization |
| `frontend/api/stock/ingestion/sync.ts` | `A379E2DA0D61CCBC11AA3279F5731D662137DC653654F51FDD6FF8DB7EFD7E87` | Manual/cron authorization, staging, validation, no-change and failure handling |
| `frontend/src/googleSheetsStock.ts` | `8F59C8F464BE1967C63498AFCF8130CFF0DF04A5E065F342CC9C6C7BE8B4708B` | Header mapping, formula rejection, canonical validation and checksum generation |
| `frontend/src/stockIngestion.ts` | `DE7EE32FF3A85E3250D2110878BB5EF130DF9E2387EEFFA5DAC6D70696FD2360` | Browser-side administrator RPC and sync client |
| `frontend/src/StockImport.tsx` | `5A261CEE65B4182A36E9D5DFF819F76ACFE799FE20CF87E958A4A953EAFA462C` | Source setup, manual sync and run-history interface |
| `frontend/vercel.json` | `745F983BF84E78784DC3E042E54B2FF02A3B7B586A08E2C014E1C6CC557D3417` | Daily ingestion schedule |
| `frontend/tests/stockGoogleSheets.test.mjs` | `D5037161589570D7E1F162E473957B0729497E098A3D88CF39C9FC8A4CB512B2` | Mapping, formula, checksum, spreadsheet-ID and secret-redaction tests |

## Observations

1. Google credentials and the Supabase service-role key are read only inside the Vercel function; source configuration stores only the spreadsheet ID and tab names.
2. The Google adapter requests the read-only Sheets scope, reads Booking and Reordering ranges, and obtains both formatted values and formulas.
3. Formula cells, unrecognized required headers, duplicate normalized headers, invalid values, duplicate item keys and configured size limits fail before a batch can be activated.
4. Extracted rows pass through the existing Stage 5 canonical import functions and database validation. Successful automation ends in `validated`, not `active`.
5. A deterministic checksum prevents duplicate batches for unchanged completed extracts. New batches are uniquely bound to their run; creation is idempotent and validation plus run completion commits atomically.
6. Database RLS limits source and run-history reads to administrators. Browser users cannot claim or finish runs or call the service import wrappers.
7. Manual sync requires an authenticated active administrator. Scheduled sync requires Vercel's bearer `CRON_SECRET` and retains the configured active administrator as the actor.
8. One source cannot have concurrent runs. Runs older than 30 minutes are failed and their partial run-owned batch is rejected before a new claim is accepted.
9. Source changes, imports and validations retain actor-attributed audit evidence; stored failure messages are bounded and redact credential-like values.
10. The frontend suite passed 58 tests, the API files passed standalone TypeScript checking, and the production frontend build succeeded. A linked Supabase dry run identified only migration `0044` as pending.
11. Only executable handlers remain under `frontend/api`; reusable server modules live under `frontend/server`. This keeps the Vercel deployment at the Hobby limit of 12 functions instead of packaging helpers as extra functions.

## Inferences

1. Qlik or an ERP/ODBC extractor can be added behind the provider registry if it returns the same canonical Booking/Reordering envelope; snapshot and activation logic should not need replacement.
2. A scheduled run will safely stop if the source's configured administrator becomes inactive or loses administrator access.
3. The separate activation step prevents a malformed or unexpectedly changed upstream sheet from silently replacing live stock.

## Unknowns and limitations

1. End-to-end access to the user's private Sheet has not been exercised because the Google service account and Vercel secrets are not available in this workspace.
2. The pgTAP database suite could not run locally because Docker or Podman is not installed. The migration is recognized by the linked-project dry run but has not been applied by this work.
3. Production row volume, Google API latency and Vercel execution duration have not yet been measured with the real workbook.
4. The authoritative future Qlik/ERP interface, ODBC driver environment and extraction cadence remain undecided.

