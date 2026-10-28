# Impala BI sync agent (Reporting data loader)

Part of the Impala Hub **Reporting** workspace (the Qlik Sense replacement): gets data from **any SQL source**
(the ERP, or any other database with an ODBC driver) into Supabase, the way Qlik's load script does.

```
 Impala network                                   Cloud
┌───────────────────────────────────┐        ┌─────────────────────────────────────┐
│ ERP / other SQL databases          │        │ Supabase                             │
│        ▲  ODBC, read-only login    │        │                                      │
│        │                           │  TLS   │  bi.load_groups / bi.load_jobs       │
│  Impala BI agent ──────────────────┼───────►│  bi_data.*   ← the loaded tables      │
│   tables.toml  ← what to load      │ (out-  │  bi.data_tables → Realtime → app      │
│   config.toml  ← connections       │ bound  │  bi.audit_log, bi.sync_runs           │
│   .env         ← passwords         │  only) │                                      │
└───────────────────────────────────┘        └─────────────────────────────────────┘
```

- **`tables.toml`** on the agent machine lists every table to load: its SQL, how to load it,
  and how often. It's the equivalent of a Qlik load script. Add, change or remove tables by
  editing this file.
- **Groups** load several tables together in one transaction (e.g. invoices + invoice lines), so
  dashboards never see one updated without the other.
- **`--plan` / `--apply`** publishes changes to Supabase, showing exactly what will be added,
  changed or deleted first.
- **Test commands** run your queries against the ERP and show the results without writing anything.

## What's in here

| Path | What it is |
|---|---|
| `supabase/migrations/0046_bi_reporting.sql` | Reporting role, schemas `bi` + `bi_data`, the `bi_agent` role, and the role-checked `public.bi_*` functions the app uses |
| `supabase/tests/bi_reporting.test.sql` | pgTAP tests for access and controls (run by CI with the other database tests) |
| `frontend/src/Reporting.tsx`, `reportingData.ts` | Reporting workspace: Data, Data Loads, Run History, Audit Log, Roadmap |
| `bi-agent/impala_bi_agent.py` | The sync agent (this folder) |
| `bi-agent/tables.example.toml` | Example tables file, with every option explained |
| `bi-agent/config.example.toml` | Connections: Supabase + ODBC sources |
| `bi-agent/setup.bat`, `run_agent.bat`, `install_task.ps1` | Windows install helpers |
| `bi-agent/tests/` | End-to-end tests of the agent against every migration |

---

## Managing tables

Every change follows the same five steps:

```
1. edit tables.toml
2. run_agent.bat --validate              check for mistakes (no connections)
3. run_agent.bat --test-table invoices   run the query against the ERP, see the result (writes nothing)
4. run_agent.bat --plan                  see exactly what will change in Supabase
5. run_agent.bat --apply                 make the change (asks for confirmation)
```

The running agent picks up applied changes within a few seconds. Restarting it isn't needed.

### Defining a table

```toml
[tables.stock_items]
description = "Stock master"
mode = "full"                 # replace the whole table every run
interval_minutes = 60
sql = '''
SELECT ItemCode AS item_code, Description AS description, CostPrice AS cost_price, QtyOnHand AS qty_on_hand
FROM   StockMaster
'''
```

| Setting | Meaning |
|---|---|
| `mode` | `full`: replace the table each run (master data). `upsert`: insert new rows and update changed ones, matched on `keys` (big transaction tables). `append`: add rows each run (daily snapshots). |
| `keys` | Columns that identify a row, for `upsert`, e.g. `["invoice_no", "line_no"]` |
| `interval_minutes` | Schedule. Leave out for manual-only. Tables in a group use the group's schedule. |
| `group` | Load together with the other tables in this group |
| `incremental_column`, `watermark_type`, `initial_watermark` | Incremental loads: only read rows changed since the last run. Put `{{watermark}}` in the `WHERE`, e.g. `WHERE ModifiedDate >= {{watermark}}` |
| `source` | Which `[sources.*]` in config.toml (default from `[defaults]`) |

Column names are cleaned for Supabase: `Cost Price` becomes `cost_price`, `InvoiceNo` becomes `invoiceno`.
Use `AS` to choose your own. New columns in a query are added automatically.

### What `--plan` looks like

```
Changes to apply:

  ~ table stock_items
        query changed -> table is reloaded in full on the next cycle
  + table goods_received
        upsert from 'erp', every 30 min
        loads on the agent's next cycle
  - table old_report
        load job removed and bi_data.old_report with 12,345 rows DELETED

  1 to add, 1 to change, 1 to remove
```

Removing a table deletes its data in Supabase, so `--apply` makes you type `delete`.
Changing a table's query, mode or keys reloads it in full. Changing only its schedule or
description doesn't.

### Other commands

| Command | |
|---|---|
| `run_agent.bat --test-all` | Test every table against the ERP (writes nothing) |
| `run_agent.bat --check` | Test Supabase + every source; confirms Supabase matches tables.toml |
| `run_agent.bat --run sales` | Load one table or group now |
| `run_agent.bat --once` | Do all due work once, then exit |

In the app, **Reporting → Data Loads** (administrators) has **Reload**, **Full** (reload everything) and **Pause / Resume**
for every table and group, the agent's online status and a **Test connection** button. Each click is recorded in the
audit log with the user's name. The same actions in the Supabase SQL editor:

```sql
update bi.load_jobs   set reload_requested = true      where target_table = 'stock_items';
update bi.load_groups set full_reload_requested = true where name = 'sales';
update bi.load_groups set enabled = false              where name = 'sales';
```

**Who sees what in the app**

| Role | Reporting workspace |
|---|---|
| `administrator` | Everything: Data, Data Loads (controls), Run History, Audit Log |
| `management`, `reporting` | Data (loaded tables, columns, row counts, freshness) and the roadmap |
| everyone else | No Reporting card |

Give someone access in the SQL editor:
```sql
insert into public.profile_roles (profile_id, role_id)
select id, 'reporting' from public.profiles where email = 'someone@impalaspares.co.za';
```

---

## Security

This moves ERP data out of the building, so it's locked down in layers.

**Nobody can make the agent read something you didn't approve**
- The agent only runs queries that are in `tables.toml` on its own machine. Every job in Supabase
  carries a SHA-256 fingerprint of its definition. If what's in Supabase doesn't match the local
  file, that table doesn't run. This holds even against someone with full access to the Supabase database.
- Browsers have no access to the `bi` and `bi_data` schemas at all. The app works only through the
  `public.bi_*` functions, which check the user's role. Administrators can trigger reloads and
  pause/resume. Nothing in the app can change a query, a source or what is loaded.
- Interactive requests from the app (browse ERP tables, preview queries) are **off by default** per
  source. Only `test_connection` is allowed until you switch more on in `config.toml`.
- Every query must be a single plain `SELECT`. Writes, multiple statements, `SELECT INTO`,
  `FOR UPDATE`, `xp_`/`sp_` procedures, `OPENROWSET` and similar are rejected.

**The data in transit and at rest**
- The connection to Supabase must be encrypted. The agent refuses to start otherwise.
  `sslmode=verify-full` (the default in config.example.toml) also checks Supabase's certificate,
  so the connection can't be intercepted.
- The agent only makes outbound connections. No ports are opened into the Impala network.
- Loaded tables in `bi_data` can't be read by app users directly. Dashboards will read them through
  permission-checked functions (next parts), which is where per-dashboard access is enforced.
- The agent logs in to Supabase as `bi_agent`, which can only touch `bi` and `bi_data`, nothing else
  in Impala Hub (no profiles, claims, stock or sales data).

**Secrets and access**
- Passwords live only in `.env` on the agent machine. `install_task.ps1` locks the agent folder so
  only Administrators and the agent itself can read it. Passwords are masked in all logs.
- Every add/change/remove (from the agent) and every reload/pause (from the app) is recorded in
  `bi.audit_log` with who did it.

**Your part**
1. **ERP login:** create one that can only `SELECT`, and only from the tables in `tables.toml`.
   This is the most important control. Everything else is a second layer.
2. **Supabase:** turn on MFA for everyone with dashboard access, keep the `service_role` key on the
   server only, and turn on "Enforce SSL" under Database settings.
3. Keep `isolation = "read_committed"`, or use `"read_uncommitted"` (like `NOLOCK`) if loads
   should never wait for or block ERP users.

---

## Testing before going live

Three stages, each safe to repeat:

**Stage 1: queries against the real ERP, nothing written.**
On the agent machine: `run_agent.bat --validate` then `run_agent.bat --test-all`.
You see row counts, columns, sample rows, duplicate keys and the watermark each table would get.

**Stage 2: a test Supabase project.**
Use a separate Supabase project (or a Supabase branch) with all Impala Hub migrations applied, and
point a copy of the config at it:
```
run_agent.bat --config config.test.toml --check
run_agent.bat --config config.test.toml --apply
run_agent.bat --config config.test.toml --once
```
Look at the loaded tables in the test project's Table Editor (schema `bi_data`). Try changing and
removing tables, and the Reload / Full / Pause buttons in Reporting → Data Loads of a preview deployment.

**Stage 3: production.** Same steps against the real project, then `install_task.ps1`.

**Automated tests (developers)**
- `supabase/tests/bi_reporting.test.sql` runs with the rest of the pgTAP suite (`supabase test db`, and in CI).
- `npm --prefix frontend test` includes `tests/reportingData.test.mjs`.
- The agent's end-to-end suite (85 checks: load modes, groups rolling back together, plan/apply/remove,
  tampering attempts, the app controls, TLS certificate checks, no passwords in logs) needs Linux or WSL with
  PostgreSQL 15+, pgTAP and unixODBC with the PostgreSQL and SQLite ODBC drivers:
  `python3 bi-agent/tests/test_agent.py`. It builds its own throwaway databases by applying every migration
  in `supabase/migrations` to a plain PostgreSQL server (`supabase/tests/local_stub/`).

---

## Setup (production)

### Supabase (once)

1. Apply migration `0046_bi_reporting.sql` the usual way (`supabase db push`, see docs/DEPLOYMENT.md).
2. Enable the agent's login, by hand in the SQL editor so the password never goes into git:
   ```sql
   alter role bi_agent with login password 'a-long-random-password';
   ```
3. Give Reporting access to the people who need it (`reporting` role, see above). Administrators and
   management have it already.
4. Copy the **Session pooler** connection string (Dashboard → Connect) and download the
   **SSL certificate** (Project Settings → Database → SSL configuration).

### The agent (Windows machine that can reach the ERP)

Needs Python 3.11+, the ODBC driver for the ERP's database (the same one Qlik uses), and
outbound access to Supabase on port 5432.

1. Copy the `bi-agent` folder to e.g. `C:\ImpalaBI\bi-agent`, put the SSL certificate in it, run `setup.bat`.
2. Edit `config.toml` (Supabase string with user `bi_agent.<project-ref>`, ODBC source),
   `.env` (passwords) and `tables.toml` (your tables).
3. `run_agent.bat --validate`, `--test-all`, `--check`, `--plan`, `--apply`.
4. Keep `tables.toml`, `config.toml` and `.env` on the agent machine only: the repository is public, and they
   describe the ERP. Back them up somewhere private.
5. Install permanently (Administrator PowerShell): `powershell -ExecutionPolicy Bypass -File install_task.ps1`.
   It runs as SYSTEM, so a DSN must be a **System DSN**.

Logs: `logs\agent.log`. Run history: `select * from bi.sync_runs order by id desc limit 50;`

## Next parts

1. ~~Data loader~~ ✅
2. ~~Reporting workspace: load status, reload/pause, run history, audit log~~ ✅
3. Datasets + report builder (tables, pivots, calculations, charts)
4. Dashboards + per-dashboard access (groups)
5. Scheduled emails
