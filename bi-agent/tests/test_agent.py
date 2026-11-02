"""
End-to-end tests for the Impala BI sync agent.

Uses a local Postgres playing both roles, plus SQLite:
  database "sb"   = Supabase: every migration in supabase/migrations on a local stand-in
                    for the platform (supabase/tests/local_stub)
  database "erp"  = the ERP, read over ODBC with a read-only login
  branches.db     = a second source (SQLite over ODBC)

Run:  python3 tests/test_agent.py   (rebuilds the test databases with tests/setup_local.sh first)
"""
import re
import subprocess
import sys
import textwrap
import urllib.parse
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
AGENT_PY = str(ROOT / "impala_bi_agent.py")
CONFIG = TESTS / "config.test.toml"
TABLES = TESTS / "tables.test.toml"
LOG = TESTS / "logs" / "test-agent.log"
PASSWORDS = ["Agt-77Qp#zW", "Rdr-9f2k!xQ"]

# fresh test databases every run
subprocess.run(["bash", str(TESTS / "setup_local.sh")], check=True, capture_output=True)

sb = psycopg.connect("dbname=sb user=postgres host=localhost", autocommit=True, row_factory=dict_row)
erp = psycopg.connect("dbname=erp user=postgres host=localhost", autocommit=True)
passed = 0
section_no = 0


def section(title):
    global section_no
    section_no += 1
    print(f"\n{section_no}. {title}")


def check(cond, msg):
    global passed
    if not cond:
        raise AssertionError(msg)
    passed += 1
    print(f"  ok  {msg}")


def agent(*args, config=CONFIG, stdin=""):
    r = subprocess.run([sys.executable, AGENT_PY, "--config", str(config), *args],
                       capture_output=True, text=True, input=stdin, cwd=ROOT)
    r.out = r.stdout + r.stderr
    return r


def q(sql, *args):
    return sb.execute(sql, args).fetchall()


def one(sql, *args):
    rows = q(sql, *args)
    return rows[0] if rows else None


def count(table):
    return one(f"select count(*) n from bi_data.{table}")["n"]


def runs():
    return one("select count(*) n from bi.sync_runs")["n"]


def job(table):
    return one("select * from bi.load_jobs where target_table = %s", table)


def write_tables(text):
    TABLES.write_text(textwrap.dedent(text))


BASE_TABLES = """
[defaults]
source = "erp"

[groups.sales]
description = "Invoices and lines"
interval_minutes = 15

[tables.stock_items]
description = "Stock master"
mode = "full"
interval_minutes = 60
sql = 'SELECT "ItemCode", "Description", "Cost Price", "Qty On Hand", "Active" FROM "StockItems"'

[tables.invoices]
group = "sales"
mode = "upsert"
keys = ["invoice_no"]
incremental_column = "modified_at"
watermark_type = "timestamp"
initial_watermark = "2026-01-01"
sql = "SELECT * FROM invoices WHERE modified_at >= {{watermark}}"

[tables.invoice_lines]
group = "sales"
mode = "upsert"
keys = ["invoice_no", "line_no"]
incremental_column = "modified_at"
watermark_type = "timestamp"
initial_watermark = "2026-01-01"
sql = "SELECT * FROM invoice_lines WHERE modified_at >= {{watermark}}"

[tables.grv]
mode = "full"
sql = "SELECT * FROM grv"

[tables.branches]
source = "branches"
mode = "append"
sql = "select code, name, region from branches"
"""

# ---------------------------------------------------------------------------
# reset Supabase side
sb.execute("drop schema bi_data cascade; create schema bi_data; "
           "grant usage, create on schema bi_data to bi_agent; grant usage on schema bi_data to service_role")
sb.execute("truncate bi.load_jobs, bi.load_groups, bi.sync_runs, bi.data_tables, bi.agent_requests, bi.agents, "
           "bi.audit_log restart identity cascade")
if LOG.exists():
    LOG.unlink()

# ===========================================================================
section("--validate catches mistakes, all at once")
write_tables("""
[defaults]
source = "erp"
[groups.empty_group]
interval_minutes = 5
[tables.Bad-Name]
sql = "SELECT 1"
[tables.no_keys]
mode = "upsert"
sql = "SELECT 1 AS a"
[tables.writer]
sql = "DELETE FROM grv"
[tables.locker]
sql = "SELECT * FROM grv FOR UPDATE"
[tables.typo]
sql = "SELECT 1"
interval_minuts = 5
[tables.wm]
mode = "upsert"
keys = ["a"]
incremental_column = "a"
watermark_type = "timestamp"
sql = "SELECT 1 AS a"
[tables.ghost_source]
source = "nope"
sql = "SELECT 1"
[tables.ok_replace]
sql = "SELECT REPLACE(grv_no, 'G', 'X') AS g FROM grv"
""")
r = agent("--validate")
check(r.returncode == 1, "validation fails")
for needle in ["Bad-Name", "upsert needs keys", "[tables.writer]: Only SELECT", "'FOR UPDATE'", "interval_minuts",
               "need {{watermark}} in the sql", "source 'nope'", "empty_group"]:
    check(needle in r.out, f"reports: {needle}")
check("ok_replace" not in r.out, "normal functions like REPLACE() are allowed")

write_tables(BASE_TABLES)
r = agent("--validate")
check(r.returncode == 0 and "5 table(s), 1 group(s)" in r.out, "valid tables file accepted")

# ===========================================================================
section("--test-table / --test-all run against the ERP and write nothing")
r = agent("--test-table", "grv")
check(r.returncode == 0 and "rows: 3" in r.out, "test-table shows row count")
check("grv_no" in r.out and "G1" in r.out, "shows columns and sample rows")
check(runs() == 0 and q("select * from bi.load_jobs") == [], "nothing written to Supabase")
check(one("select count(*) n from pg_tables where schemaname='bi_data'")["n"] == 0, "no tables created")
r = agent("--test-table", "invoice_lines", "--rows", "2")
check("next watermark would be: 2026-10-04 02:40:00" in r.out, "shows the watermark the load would store")
write_tables(BASE_TABLES.replace('mode = "full"\nsql = "SELECT * FROM grv"',
                                 'mode = "upsert"\nkeys = ["grv_no"]\nsql = "SELECT * FROM grv"'))
r = agent("--test-table", "grv")
check("1 duplicate key(s)" in r.out, "warns about duplicate keys")
write_tables(BASE_TABLES)
r = agent("--test-all")
check(r.returncode == 0 and "5 of 5 table(s) OK" in r.out, "test-all: every table OK")

# ===========================================================================
section("--plan / --apply publishes tables.toml")
r = agent("--plan")
check("+ group sales" in r.out and "6 to add" in r.out, "plan lists 1 group + 5 tables to add")
r = agent("--apply", stdin="n\n")
check("Cancelled" in r.out and q("select * from bi.load_jobs") == [], "apply asks first; 'n' cancels")
r = agent("--apply", stdin="y\n")
check(r.returncode == 0 and len(q("select * from bi.load_jobs")) == 5, "apply creates 5 load jobs")
check(one("select count(*) n from bi.audit_log where action='add'")["n"] == 6, "audit log records each addition")
check(job("invoices")["definition_sha256"] and job("invoices")["managed_by"] == "test-agent", "jobs carry fingerprint + owner")
r = agent("--plan")
check("up to date" in r.out, "plan afterwards: nothing to do")

# ===========================================================================
section("Loading: full, upsert/incremental, append, and a group of tables")
r = agent("--once")
check(all(j["last_status"] == "success" for j in q("select last_status from bi.load_jobs")), "all jobs succeeded")
check(count("invoices") == 4000 and count("invoice_lines") == 12000, "group loaded both tables")
batch = q("select distinct batch_id from bi.sync_runs where group_name = 'sales'")
check(len(batch) == 1, "group tables share one batch (one transaction)")
check(one("select itemcode from bi_data.stock_items order by 1 limit 1")["itemcode"] == "BAT-100", "CHAR padding trimmed")
check(count("branches") == 2, "second source (SQLite) loaded")
check(one("select last_status from bi.load_groups where name='sales'")["last_status"] == "success", "group status recorded")

before = runs()
agent("--once")
check(runs() == before, "nothing re-runs before its schedule")

erp.execute("update invoice_lines set qty = 99, modified_at = timestamp '2026-10-27 10:00' where invoice_no = 1")
erp.execute("update invoices set total = 1, modified_at = timestamp '2026-10-27 10:00' where invoice_no = 1")
sb.execute("update bi.load_jobs set reload_requested = true where target_table = 'invoice_lines'")
agent("--once")
last = q("select target_table, row_count from bi.sync_runs where batch_id = "
         "(select batch_id from bi.sync_runs order by id desc limit 1)")
check({r["target_table"] for r in last} == {"invoices", "invoice_lines"}, "reloading one grouped table reloads its whole group")
check(all(r["row_count"] <= 10 for r in last), f"incremental: only changed rows read ({[r['row_count'] for r in last]})")
check(one("select qty from bi_data.invoice_lines where invoice_no=1 and line_no=1")["qty"] == 99, "changed line updated")
check(job("invoices")["watermark"].startswith("2026-10-27 10:00"), "watermark advanced")

# ===========================================================================
section("Group is all-or-nothing: one failing table rolls back the others")
erp.execute("update invoices set total = 555, modified_at = timestamp '2026-10-28 09:00' where invoice_no = 2")
erp.execute("revoke select on invoice_lines from erp_reader")
sb.execute("update bi.load_groups set reload_requested = true where name = 'sales'")
agent("--once")
erp.execute("grant select on invoice_lines to erp_reader")
inv, lines = job("invoices"), job("invoice_lines")
check(lines["last_status"] == "error" and "permission denied" in lines["last_error"], "failing table reports the source error")
check(inv["last_status"] == "error" and "same group failed" in inv["last_error"], "other table in the group marked not loaded")
check(one("select total from bi_data.invoices where invoice_no = 2")["total"] != 555, "invoices NOT half-updated")
check(inv["watermark"].startswith("2026-10-27"), "watermark unchanged after failure")
sb.execute("update bi.load_groups set reload_requested = true where name = 'sales'")
agent("--once")
check(one("select total from bi_data.invoices where invoice_no = 2")["total"] == 555, "after fixing: group loads")

# ===========================================================================
section("Changing a table: plan shows it, apply triggers a full reload")
write_tables(BASE_TABLES.replace('FROM "StockItems"\'', 'FROM "StockItems" WHERE "Active"\'')
             .replace('"Active" FROM', '"Active", 1 AS "Pack Size" FROM'))
r = agent("--plan")
check("~ table stock_items" in r.out and "query changed" in r.out and "reloaded in full" in r.out, "plan explains the change")
agent("--apply", "--yes")
check(job("stock_items")["full_reload_requested"], "full reload requested")
agent("--once")
check(count("stock_items") == 2, "reloaded with new query (inactive item gone)")
check(one("select pack_size from bi_data.stock_items limit 1")["pack_size"] == 1, "new column added automatically")
check(one("select count(*) n from bi.audit_log where action='change' and object_name='stock_items'")["n"] == 1, "change audited")

write_tables(BASE_TABLES.replace("interval_minutes = 15", "interval_minutes = 10"))
r = agent("--plan")
check("schedule: every 15 min -> every 10 min" in r.out and "reloaded" not in r.out.split("group sales")[1].split("table")[0],
      "schedule-only change doesn't force a reload")

# ===========================================================================
section("Removing a table: needs explicit confirmation, deletes data")
write_tables(BASE_TABLES.replace('[tables.grv]\nmode = "full"\nsql = "SELECT * FROM grv"\n', ""))
r = agent("--plan")
check("- table grv" in r.out and "DELETED" in r.out, "plan warns the data will be deleted")
r = agent("--apply", stdin="y\n")
check("Cancelled" in r.out and job("grv") is not None, "'y' is not enough to delete — still there")
r = agent("--apply", stdin="delete\n")
check(r.returncode == 0 and job("grv") is None, "typing 'delete' removes the job")
check(one("select count(*) n from pg_tables where schemaname='bi_data' and tablename='grv'")["n"] == 0, "data table dropped")
check(one("select count(*) n from bi.data_tables where table_name='grv'")["n"] == 0, "removed from catalogue")
check(one("select count(*) n from bi.audit_log where action='remove' and object_name='grv'")["n"] == 1, "removal audited")

# ===========================================================================
section("Security: the agent only runs what is in its local tables.toml")
write_tables(BASE_TABLES.replace('[tables.grv]\nmode = "full"\nsql = "SELECT * FROM grv"\n', ""))
agent("--apply", "--yes")
# someone with full database access swaps the query AND updates the fingerprint
fake_sql = "SELECT * FROM secret_payroll"
sb.execute("update bi.load_jobs set sql_query = %s, definition_sha256 = repeat('0', 64), reload_requested = true "
           "where target_table = 'stock_items'", (fake_sql,))
agent("--once")
j = job("stock_items")
check(j["last_status"] == "error" and "does not match tables.toml" in j["last_error"], "tampered job refused")
check(one("select count(*) n from pg_tables where schemaname='bi_data' and tablename='secret_payroll'")["n"] == 0
      and "salary" not in str(q("select * from bi.data_tables")), "no ERP data outside tables.toml was read")
# swapping only the SQL text (keeping the fingerprint) does nothing either: the agent runs its local SQL
agent("--apply", "--yes")  # restores the real definition
sb.execute("update bi.load_jobs set sql_query = %s, reload_requested = true where target_table = 'stock_items'", (fake_sql,))
agent("--once")
check(job("stock_items")["last_status"] == "success" and count("stock_items") == 3, "agent ignored the SQL text in Supabase")
r = agent("--plan")
check("modified outside tables.toml" in r.out and "reloaded in full" not in r.out, "plan flags the edited copy and restores it")
agent("--apply", "--yes")

# edited locally but not applied: that table pauses, the others keep loading
write_tables(BASE_TABLES.replace('"Active" FROM', '"Active", 2 AS x FROM'))
sb.execute("update bi.load_jobs set reload_requested = true")
agent("--once")
check("does not match" in (job("stock_items")["last_error"] or ""), "unapplied local edit: table refuses to run")
check(job("branches")["last_status"] == "success", "other tables keep loading")
write_tables(BASE_TABLES.replace('[tables.grv]\nmode = "full"\nsql = "SELECT * FROM grv"\n', ""))
agent("--apply", "--yes")

# ===========================================================================
section("App controls (Impala Hub functions) reach the agent")
admin, reporter = uuid.uuid4(), uuid.uuid4()
sb.execute("insert into auth.users (id, email) values (%s, 'admin@test.invalid'), (%s, 'rep@test.invalid')", (admin, reporter))
sb.execute("insert into public.profile_roles values (%s, 'administrator'), (%s, 'reporting')", (admin, reporter))


def as_user(uid, statement, params=()):
    with psycopg.connect("dbname=sb user=postgres host=localhost", row_factory=dict_row, autocommit=True) as c:
        c.execute("set role authenticated")
        c.execute("select set_config('request.jwt.claims', %s, false)", (f'{{"sub":"{uid}","role":"authenticated"}}',))
        try:
            cur = c.execute(statement, params)
            return cur.fetchall() if cur.description else cur.rowcount
        except psycopg.Error as e:
            return e


status = as_user(admin, "select public.bi_load_status() as s")[0]["s"]
check(len(status["jobs"]) == 4 and status["agents"][0]["name"] == "test-agent", "administrator sees jobs and the agent heartbeat")
check(len(as_user(reporter, "select * from public.bi_data_tables()")) == 4, "reporting user sees the table catalogue")
check(isinstance(as_user(reporter, "select public.bi_request_reload('table','branches',false)"), psycopg.errors.InsufficientPrivilege),
      "reporting user cannot trigger reloads")

before = count("branches")
as_user(admin, "select public.bi_request_reload('table','branches',false)")
agent("--once")
check(count("branches") == before + 2, "'Reload now' from the app loads the table (append mode adds 2 rows)")
as_user(admin, "select public.bi_set_enabled('table','branches',false)")
sb.execute("update bi.load_jobs set interval_minutes = 1, last_run_at = now() - interval '5 minutes' where target_table='branches'")
agent("--once")
check(count("branches") == before + 2, "paused table is skipped by the schedule")
as_user(admin, "select public.bi_set_enabled('table','branches',true)")
agent("--once")
check(count("branches") == before + 4, "resumed table runs on schedule again")
sb.execute("update bi.load_jobs set interval_minutes = null where target_table='branches'")
as_user(admin, "select public.bi_request_reload('group','sales',true)")
agent("--once")
check(one("select trigger from bi.sync_runs where group_name='sales' order by id desc limit 1")["trigger"] == "full_reload",
      "'Reload everything' from the app fully reloads the group")
acts = [r["action"] for r in q("select action from bi.audit_log where actor_id is not null order by id")]
check(acts == ["reload_requested", "paused", "resumed", "full_reload_requested"], f"app actions audited with the user: {acts}")
check(isinstance(as_user(admin, "update bi.load_jobs set sql_query = 'SELECT * FROM secret_payroll'"), psycopg.errors.InsufficientPrivilege),
      "administrators cannot change queries from the app")

# ===========================================================================
section("Agent requests: only what each source allows")
req = as_user(admin, "select public.bi_test_connection('erp') as id")[0]["id"]
ids = []
for kind, src, payload in [("preview", "erp", '{"sql": "SELECT * FROM invoices"}'), ("list_tables", "erp", "{}"),
                           ("preview", "branches", '{"sql": "select * from branches"}'),
                           ("preview", "branches", '{"sql": "select 1; drop table branches"}')]:
    # the app cannot create these; simulate a request written straight into the database
    ids.append(one("insert into bi.agent_requests (kind, source_name, payload) values (%s, %s, %s) returning id",
                   kind, src, payload)["id"])
agent("--once")
tc = as_user(admin, "select public.bi_agent_request(%s) as r", (req,))[0]["r"]
check(tc["status"] == "done" and tc["result"]["ok"], "test connection from the app answered by the agent")
res = [one("select status, result, error from bi.agent_requests where id = %s", i) for i in ids]
check(res[0]["status"] == "error" and "switched off" in res[0]["error"], "ERP preview refused by default")
check(res[1]["status"] == "error" and "switched off" in res[1]["error"], "ERP table listing refused by default")
check(res[2]["status"] == "done" and len(res[2]["result"]["rows"]) == 2, "preview works where enabled (branches)")
check(res[3]["status"] == "error", "multi-statement preview rejected")
a = one("select * from bi.agents")
check(a["app_requests"]["erp"] == ["test_connection"], "agent publishes what each source allows")

# ===========================================================================
section("Security: encryption and secrets")
remote = TESTS / "remote.tmp.toml"
remote.write_text(CONFIG.read_text().replace("@localhost:5432/sb\"", "@db.example.com:5432/postgres\""))
r = agent("--validate", config=remote)
check(r.returncode == 2 and "must use an encrypted connection" in r.out, "remote Supabase without TLS refused")
remote.write_text(CONFIG.read_text().replace("@localhost:5432/sb\"", "@db.example.com:5432/postgres?sslmode=require\""))
r = agent("--validate", config=remote)
check(r.returncode == 0 and "certificate is not verified" in r.out, "sslmode=require accepted with a warning")
tls = TESTS / "tls.tmp.toml"
tls.write_text(CONFIG.read_text().replace(
    "@localhost:5432/sb\"",
    f"@pg.impala.test:5432/sb?sslmode=verify-full&sslrootcert={TESTS / 'tls' / 'ca.crt'}\""))
r = agent("--check", config=tls)
check("encrypted (TLS)" in r.out and "[FAIL]" not in r.out, "verify-full: encrypted and certificate checked")
wrong_ca = TESTS / "wrong_ca.tmp.crt"
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Evil CA",
                "-keyout", "/dev/null", "-out", str(wrong_ca)], capture_output=True)
tls.write_text(tls.read_text().replace(str(TESTS / "tls" / "ca.crt"), str(wrong_ca)))
r = agent("--check", config=tls)
check("[FAIL] Supabase" in r.out, "verify-full: server with an untrusted certificate refused")

bad_pw = TESTS / "badpw.tmp.toml"
bad_pw.write_text(CONFIG.read_text().replace("Pwd=${ERP_PASSWORD}", "Pwd=Wrong-Pa55word!"))
agent("--check", config=bad_pw)
sb.execute("update bi.load_jobs set reload_requested = true")
agent("--once", config=bad_pw)
agent("--once")
log_text = LOG.read_text()
everything = log_text + str(q("select * from bi.sync_runs")) + str(q("select * from bi.load_jobs")) + \
    str(q("select * from bi.agent_requests")) + str(q("select * from bi.agents"))
check(not any(p in everything for p in PASSWORDS + ["Wrong-Pa55word!"]), "no password appears in logs or Supabase")
for f in TESTS.glob("*.tmp.*"):
    f.unlink()

# ===========================================================================
section("Reliability")
before = runs()
sb.execute("update bi.load_jobs set full_reload_requested = true where target_table='stock_items'")
erp.execute('revoke select on "StockItems" from erp_reader')
agent("--once")
n_after_fail = runs()
agent("--once")
check(runs() == n_after_fail, "failed full reload is not retried in a tight loop")
check(job("stock_items")["full_reload_requested"], "...but stays requested for a later retry")
erp.execute('grant select on "StockItems" to erp_reader')
sb.execute("update bi.load_jobs set last_run_at = now() - interval '10 minutes' where target_table='stock_items'")
agent("--once")
check(job("stock_items")["last_status"] == "success" and not job("stock_items")["full_reload_requested"], "retried later and succeeded")

jid = job("branches")["id"]
sb.execute("insert into bi.sync_runs (batch_id, job_id, target_table, agent_name, trigger) "
           "values (gen_random_uuid(), %s, 'branches', 'test-agent', 'manual')", (jid,))
sb.execute("update bi.load_jobs set last_status = 'running' where id = %s", (jid,))
agent("--once")
check(one("select count(*) n from bi.sync_runs where status='running'")["n"] == 0, "interrupted runs cleaned up on start")

r = agent("--run", "sales")
check(r.returncode == 0, "--run loads a group on demand")

other = TESTS / "other.tmp.toml"
other.write_text(CONFIG.read_text().replace('name = "test-agent"', 'name = "other-agent"'))
r = agent("--plan", config=other)
check(r.returncode == 1 and "already belongs to agent 'test-agent'" in r.out, "a second agent can't take over existing tables")
other.unlink()

r = agent("--check")
check("[OK]   Supabase matches tables.toml" in r.out, "--check confirms Supabase matches tables.toml")

# ===========================================================================
section("Connectors: web APIs and folders")
import http.server
import json as _json
import os
import shutil
import socketserver
import threading

SECRET_KEY = "Crr-5ecret-Key-81!"
os.environ["COURIER_KEY"] = SECRET_KEY


class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body.encode())

    def do_GET(self):
        if self.path == "/items.json":
            self.send(200, _json.dumps({"data": {"items": [
                {"code": "A1", "qty": 3, "price": 1.5, "when": "2026-10-01", "meta": {"zone": 4}, "tags": ["x"]},
                {"code": "B2", "qty": "7", "price": "2.25", "when": "2026-10-02", "meta": {"zone": 5}, "tags": []}]}}))
        elif self.path == "/secure.csv":
            if self.headers.get("Authorization") != f"Bearer {SECRET_KEY}":
                return self.send(401, "no")
            self.send(200, "branch;target\nCenturion;100,5\nPretoria;90\n", "text/csv")
        elif self.path == "/moved":
            self.send(302, "", extra={"Location": f"http://localhost:{PORT}/items.json"})
        else:
            self.send(404, "missing")


httpd = socketserver.TCPServer(("127.0.0.1", 0), Api)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

folder = TESTS / "conn.tmp"
shutil.rmtree(folder, ignore_errors=True)
folder.mkdir()
(folder / "targets 2025.csv").write_text("branch,target\nCenturion,1\n")
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Targets"
ws.append(["Branch", "Target", "Month"])
ws.append(["Centurion", 125000, __import__("datetime").date(2026, 10, 1)])
ws.append(["Pretoria", 90000.5, __import__("datetime").date(2026, 10, 1)])
wb.save(folder / "targets 2026.xlsx")
os.utime(folder / "targets 2025.csv", (1, 1))
(folder / "a.csv").write_text("x\n1\n")
(folder / "b.csv").write_text("x\n2\n3\n")

conn_cfg = TESTS / "connectors.tmp.toml"
conn_cfg.write_text(CONFIG.read_text() + textwrap.dedent(f"""
    [connectors]
    allow_hosts = ["127.0.0.1:{PORT}", "localhost:{PORT}"]
    [connectors.folders]
    budgets = '{folder}'
    [connectors.secrets]
    COURIER_KEY = "127.0.0.1:{PORT}"
"""))


def add_connector(name, kind, config, agent_name="test-agent"):
    sb.execute("insert into bi.connectors (name, kind, agent_name, config, reload_requested) values (%s, %s, %s, %s, true)",
               (name, kind, agent_name, _json.dumps(config)))


def con(name):
    return one("select * from bi.connectors where name = %s", name)


add_connector("web_items", "web", {"url": f"http://127.0.0.1:{PORT}/items.json", "records_path": "data.items"})
add_connector("web_secure", "web", {"url": f"http://127.0.0.1:{PORT}/secure.csv", "format": "csv",
                                    "headers": [{"name": "Authorization", "value": "Bearer ${COURIER_KEY}"}]})
add_connector("web_blocked", "web", {"url": f"http://127.0.0.2:{PORT}/items.json"})
add_connector("web_leak", "web", {"url": f"http://localhost:{PORT}/items.json",
                                  "headers": [{"name": "X-Key", "value": "${COURIER_KEY}"}]})
add_connector("web_erp_pw", "web", {"url": f"http://127.0.0.1:{PORT}/items.json",
                                    "headers": [{"name": "X-Key", "value": "${ERP_PASSWORD}"}]})
add_connector("web_moved", "web", {"url": f"http://127.0.0.1:{PORT}/moved"})
add_connector("folder_targets", "folder", {"folder": "budgets", "pattern": "targets *.*", "sheet": "Targets", "combine": "latest"})
add_connector("folder_all", "folder", {"folder": "budgets", "pattern": "?.csv", "combine": "all"})
add_connector("folder_other", "folder", {"folder": "elsewhere", "pattern": "*.csv"})

r = agent("--once", config=conn_cfg)
check(con("web_items")["last_status"] == "success", "a web connector loads JSON from an allowed host")
cols = {c["name"]: c["type"] for c in one("select columns from bi.data_tables where table_name='web_items'")["columns"]}
check(cols.get("qty") == "bigint" and cols.get("price") == "numeric" and cols.get("when") == "date" and cols.get("meta_zone") == "bigint",
      "JSON records are flattened and typed")
check(one("select sum(qty) s from bi_data.web_items")["s"] == 10, "...with the right values")
check(con("web_secure")["last_status"] == "success" and str(one("select sum(target) s from bi_data.web_secure")["s"]) == "190.5",
      "a secret from .env is sent to its own host (CSV with ; and decimal commas)")
check("allow_hosts" in (con("web_blocked")["last_error"] or ""), "hosts that are not allowed are refused")
check("may only be sent to" in (con("web_leak")["last_error"] or ""), "a secret is never sent to another host")
check("not in [connectors.secrets]" in (con("web_erp_pw")["last_error"] or ""), "other .env values (e.g. the ERP password) cannot be sent")
check("redirects" in (con("web_moved")["last_error"] or ""), "redirects are not followed")
check(con("folder_targets")["last_status"] == "success" and one("select count(*) n from bi_data.folder_targets")["n"] == 2,
      "a folder connector loads the newest matching Excel file")
check(str(one("select sum(target) s from bi_data.folder_targets")["s"]) == "215000.5" and
      {c["name"]: c["type"] for c in one("select columns from bi.data_tables where table_name='folder_targets'")["columns"]}.get("month") == "date",
      "...with Excel numbers and dates typed")
check(one("select count(*) n, count(distinct source_file) f from bi_data.folder_all")["f"] == 2 and
      one("select count(*) n from bi_data.folder_all")["n"] == 3, "'all' combines every matching file with a source_file column")
check("not in [connectors.folders]" in (con("folder_other")["last_error"] or ""), "folders that are not allowed are refused")
opts = one("select connector_options from bi.agents where name='test-agent'")["connector_options"]
check(opts["folders"] == ["budgets"] and opts["secrets"] == {"COURIER_KEY": f"127.0.0.1:{PORT}"} and str(folder) not in str(opts),
      "the agent tells the app which hosts and folder names it allows (not the paths)")
check(SECRET_KEY not in LOG.read_text() + str(q("select * from bi.connectors")) + str(q("select * from bi.sync_runs")),
      "the secret never appears in logs or Supabase")
sb.execute("update bi.connectors set reload_requested = false")
n = runs()
agent("--once", config=conn_cfg)
check(runs() == n, "failed connectors are not retried in a tight loop")
r = agent("--run", "web_items", config=conn_cfg)
check(r.returncode == 0 and con("web_items")["last_status"] == "success", "--run loads a connector on demand")
r = agent("--once")
check(r.returncode == 0, "an agent without [connectors] still runs")
httpd.shutdown()
shutil.rmtree(folder, ignore_errors=True)
conn_cfg.unlink()

# ===========================================================================
section("Connectors: SharePoint/OneDrive (Microsoft Graph) and Google Sheets")
import base64 as _b64
import io as _io
from cryptography.hazmat.primitives import hashes as _hashes, serialization as _ser
from cryptography.hazmat.primitives.asymmetric import padding as _padding, rsa as _rsa

MS_SECRET = "Ms-Gr4ph-Secret-0x9!"
os.environ["MS_GRAPH_CLIENT_SECRET"] = MS_SECRET
TENANT, CLIENT = "11111111-2222-3333-4444-555555555555", "66666666-7777-8888-9999-000000000000"
_pk = _rsa.generate_private_key(public_exponent=65537, key_size=2048)
seen = {"graph_auth": set(), "download_auth": [], "sheet_auth": set(), "jwt_ok": False}


def _xlsx(rows, title="Budget"):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = title
    for r in rows:
        ws.append(r)
    buf = _io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


FILES = {
    "budget": _xlsx([["Branch", "Budget"], ["Centurion", 500000], ["Pretoria", 250000.5]]),
    "jan": b"branch,sales\nCenturion,10\n", "feb": b"branch,sales\nCenturion,20\nPretoria,5\n",
}


class Cloud(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else _json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)

    def item(self, name, key, modified):
        return {"id": key, "name": name, "size": len(FILES[key]), "file": {}, "lastModifiedDateTime": modified,
                "@microsoft.graph.downloadUrl": f"http://127.0.0.1:{CPORT}/dl/{key}"}

    def do_POST(self):
        body = urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
        if self.path == f"/{TENANT}/oauth2/v2.0/token":
            ok = body.get("client_secret") == [MS_SECRET] and body.get("client_id") == [CLIENT]
            return self.send(200, {"access_token": "ms-token-abc", "expires_in": 3600}) if ok else self.send(401, {"error": "invalid_client"})
        if self.path == "/token":
            head, claims, sig = body["assertion"][0].split(".")
            pad = lambda x: x + "=" * (-len(x) % 4)  # noqa: E731
            try:
                _pk.public_key().verify(_b64.urlsafe_b64decode(pad(sig)), f"{head}.{claims}".encode(), _padding.PKCS1v15(), _hashes.SHA256())
                c = _json.loads(_b64.urlsafe_b64decode(pad(claims)))
                seen["jwt_ok"] = c["scope"].endswith("spreadsheets.readonly") and c["iss"] == "reports@impala.iam.gserviceaccount.com"
            except Exception:
                return self.send(400, {"error": "invalid_grant"})
            return self.send(200, {"access_token": "g-token-xyz", "expires_in": 3600})
        self.send(404, {})

    def do_GET(self):
        path = urllib.parse.unquote(self.path)
        auth = self.headers.get("Authorization")
        if path.startswith("/dl/"):
            seen["download_auth"].append(auth)
            return self.send(200, FILES[path[4:]], "application/octet-stream")
        if path.startswith("/v1.0/"):
            seen["graph_auth"].add(auth)
            p = path[len("/v1.0"):]
            if p == "/sites/impala.sharepoint.com:/sites/Finance":
                return self.send(200, {"id": "site-1"})
            if p.startswith("/sites/site-1/drives"):
                return self.send(200, {"value": [{"id": "drv-docs", "name": "Documents"}, {"id": "drv-rep", "name": "Reports"}]})
            if p == "/drives/drv-docs/root:/Budgets/Budget 2026.xlsx":
                return self.send(200, self.item("Budget 2026.xlsx", "budget", "2026-10-01T00:00:00Z"))
            if p.startswith("/users/jaco@impala.co.za/drive/root:/Sales:/children"):
                return self.send(200, {"value": [self.item("sales jan.csv", "jan", "2026-01-31T00:00:00Z"),
                                                 self.item("sales feb.csv", "feb", "2026-02-28T00:00:00Z"),
                                                 {"id": "x", "name": "notes.docx", "file": {}}]})
            return self.send(404, {"error": {"code": "itemNotFound", "message": "The resource could not be found."}})
        if path.startswith("/v4/spreadsheets/"):
            seen["sheet_auth"].add(auth)
            if "SHARED_SHEET_ID_1234567890" in path and path.endswith("?fields=sheets.properties.title"):
                return self.send(200, {"sheets": [{"properties": {"title": "Targets"}}]})
            if "SHARED_SHEET_ID_1234567890/values/'Targets'" in path:
                return self.send(200, {"values": [["Branch", "Target", "Month"], ["Centurion", 125000, "2026-10-01"],
                                                  ["Pretoria", 90000.5, "2026-10-01"], [], ["Midrand"]]})
            return self.send(403, {"error": {"code": 403, "message": "The caller does not have permission"}})
        self.send(404, {})


cloud = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Cloud)
CPORT = cloud.server_address[1]
threading.Thread(target=cloud.serve_forever, daemon=True).start()
key_file = TESTS / "gkey.tmp.json"
key_file.write_text(_json.dumps({"type": "service_account", "client_email": "reports@impala.iam.gserviceaccount.com",
                                 "token_uri": f"http://127.0.0.1:{CPORT}/token",
                                 "private_key": _pk.private_bytes(_ser.Encoding.PEM, _ser.PrivateFormat.PKCS8, _ser.NoEncryption()).decode()}))
cloud_cfg = TESTS / "cloud.tmp.toml"
cloud_cfg.write_text(CONFIG.read_text() + textwrap.dedent(f"""
    [connectors.sharepoint]
    finance = {{ site = "impala.sharepoint.com:/sites/Finance", library = "Documents", folder = "Budgets" }}
    jaco = {{ onedrive = "jaco@impala.co.za" }}
    [connectors.microsoft]
    tenant_id = "{TENANT}"
    client_id = "{CLIENT}"
    login_url = "http://127.0.0.1:{CPORT}"
    graph_url = "http://127.0.0.1:{CPORT}"
    [connectors.google]
    key_file = '{key_file}'
    sheets_url = "http://127.0.0.1:{CPORT}"
"""))
add_connector("sp_budget", "sharepoint", {"location": "finance", "path": "Budget 2026.xlsx", "sheet": "Budget"})
add_connector("sp_sales", "sharepoint", {"location": "jaco", "path": "Sales/sales *.csv", "combine": "all"})
add_connector("sp_latest", "sharepoint", {"location": "jaco", "path": "Sales/sales *.csv"})
add_connector("sp_other", "sharepoint", {"location": "hr", "path": "salaries.xlsx"})
add_connector("sp_escape", "sharepoint", {"location": "finance", "path": "../Salaries/pay.xlsx"})
add_connector("sp_missing", "sharepoint", {"location": "finance", "path": "Nope.xlsx"})
add_connector("gs_targets", "gsheet", {"spreadsheet_id": "SHARED_SHEET_ID_1234567890"})
add_connector("gs_private", "gsheet", {"spreadsheet_id": "PRIVATE_SHEET_ID_0987654321", "sheet": "Data"})

r = agent("--once", config=cloud_cfg)
check(con("sp_budget")["last_status"] == "success" and str(one("select sum(budget) s from bi_data.sp_budget")["s"]) == "750000.5",
      "SharePoint: an Excel file in a library folder is loaded (site, library and folder from config.toml)")
check(one("select count(*) n, count(distinct source_file) f from bi_data.sp_sales")["n"] == 3 and
      one("select count(distinct source_file) f from bi_data.sp_sales")["f"] == 2, "OneDrive: a wildcard combines all matching files")
check(one("select sum(sales) s from bi_data.sp_latest")["s"] == 25, "...or takes the newest one")
check("not in [connectors.sharepoint]" in (con("sp_other")["last_error"] or ""), "SharePoint locations that are not in config.toml are refused")
check("Invalid file path" in (con("sp_escape")["last_error"] or ""), "paths cannot leave the configured folder")
check("404" in (con("sp_missing")["last_error"] or ""), "a missing file gives a readable error")
check(seen["graph_auth"] == {"Bearer ms-token-abc"} and set(seen["download_auth"]) == {None},
      "Graph calls use the app token; the token is never sent to the download link")
check(con("gs_targets")["last_status"] == "success" and str(one("select sum(target) s from bi_data.gs_targets")["s"]) == "215000.5"
      and one("select count(*) n from bi_data.gs_targets")["n"] == 3, "Google Sheets: the first tab is loaded (blank rows skipped)")
cols = {c["name"]: c["type"] for c in one("select columns from bi.data_tables where table_name='gs_targets'")["columns"]}
check(cols.get("month") == "date" and cols.get("target") == "numeric", "...and typed")
check(seen["jwt_ok"] and seen["sheet_auth"] == {"Bearer g-token-xyz"}, "the service account signs in with a signed JWT (read-only scope)")
check("Share the sheet (Viewer) with reports@impala.iam.gserviceaccount.com" in (con("gs_private")["last_error"] or ""),
      "a sheet not shared with the service account says who to share it with")
opts = one("select connector_options from bi.agents where name='test-agent'")["connector_options"]
check(opts.get("sharepoint", {}).get("finance") == "/sites/Finance · Documents / Budgets" and opts.get("microsoft") is True
      and opts.get("google") == "reports@impala.iam.gserviceaccount.com", "the agent tells the app its locations and the Google account")
everything = LOG.read_text() + str(q("select * from bi.connectors")) + str(q("select * from bi.sync_runs")) + str(opts)
check(MS_SECRET not in everything and "ms-token-abc" not in everything and "g-token-xyz" not in everything and "PRIVATE KEY" not in everything,
      "the client secret, tokens and private key never appear in logs or Supabase")
bad_cfg = TESTS / "cloud.bad.tmp.toml"
bad_cfg.write_text(CONFIG.read_text() + f'\n[connectors.microsoft]\ntenant_id = "{TENANT}"\nclient_id = "{CLIENT}"\ngraph_url = "https://evil.example.com"\n')
r = agent("--validate", config=bad_cfg)
check(r.returncode != 0 and "only be changed for local tests" in r.out, "the Microsoft and Google addresses cannot be changed")
bad_cfg.unlink()
cloud.shutdown()
key_file.unlink()
cloud_cfg.unlink()

# ===========================================================================
section("Table picker (--ui): browse the source, save tables.toml, publish")
import urllib.request as _ur
import urllib.error as _ue

ui_tables = TESTS / "ui_tables.tmp.toml"
ui_tables.write_text("")
ui_cfg = TESTS / "ui.tmp.toml"
ui_cfg.write_text(CONFIG.read_text().replace('name = "test-agent"', 'name = "ui-agent"')
                  .replace('tables_file = "tables.test.toml"', f'tables_file = "{ui_tables.name}"'))
ui = subprocess.Popen([sys.executable, AGENT_PY, "--config", str(ui_cfg), "--ui", "--no-browser"],
                      cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
line = ui.stdout.readline()
m = re.search(r"http://127\.0\.0\.1:(\d+)/#(\S+)", line)
check(m is not None, "--ui prints its local address with a one-time code")
UI_PORT, UI_TOKEN = int(m.group(1)), m.group(2)


def ui_call(route, body=None, token=None, host=None, origin=None):
    req = _ur.Request(f"http://127.0.0.1:{UI_PORT}/api/{route}", data=_json.dumps(body or {}).encode(), method="POST",
                      headers={"Content-Type": "application/json", "X-Agent-Token": UI_TOKEN if token is None else token})
    if host:
        req.add_header("Host", host)
    if origin:
        req.add_header("Origin", origin)
    try:
        with _ur.urlopen(req, timeout=120) as r:
            return r.status, _json.loads(r.read())
    except _ue.HTTPError as e:
        raw = e.read()
        try:
            return e.code, _json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw.decode()}


check(ui_call("state", token="wrong")[0] == 401, "requests without the code are refused")
check(ui_call("state", host="evil.example.com")[0] == 403, "requests for another host name are refused (DNS rebinding)")
check(ui_call("state", origin="https://evil.example.com")[0] == 403, "requests from other web sites are refused")
code, st = ui_call("state")
check(code == 200 and [s["name"] for s in st["sources"]] == ["erp", "branches"] and st["agent"] == "ui-agent",
      "the page sees the agent and its sources")
code, tl = ui_call("tables", {"source": "erp"})
check(code == 200 and "StockItems" in [t["name"] for t in tl["tables"]] and "PostgreSQL" in tl["dbms"],
      "it lists the source's tables over ODBC")
code, cols = ui_call("columns", {"source": "erp", "schema": "public", "table": "StockItems"})
by = {c["name"]: c for c in cols["columns"]}
check(code == 200 and cols["primary_key"] == ["ItemCode"] and by["ItemCode"]["target"] == "item_code"
      and by["Cost Price"]["target"] == "cost_price" and cols["from"] == '"public"."StockItems"',
      "it shows columns, the primary key and clean names (ItemCode -> item_code)")
code, icols = ui_call("columns", {"source": "erp", "schema": "public", "table": "invoices"})
check({c["name"]: c["watermark_type"] for c in icols["columns"]}.get("modified_at") == "timestamp",
      "date/time columns are offered as 'changed since' columns")
check(ui_call("count", {"source": "erp", "from": cols["from"]})[1].get("rows") == 3, "it counts rows")
gen = 'SELECT "ItemCode" AS item_code, "Cost Price" AS cost_price, "Qty On Hand" AS qty_on_hand FROM "public"."StockItems"'
code, pv = ui_call("preview", {"source": "erp", "sql": gen, "limit": 2})
check(code == 200 and [c["name"] for c in pv["columns"]] == ["item_code", "cost_price", "qty_on_hand"] and len(pv["rows"]) == 2,
      "it previews the generated query")
code, bad = ui_call("preview", {"source": "erp", "sql": 'DELETE FROM "StockItems"'})
check(code == 400 and "SELECT" in bad["error"], "a query that changes data is refused")
code, bad = ui_call("preview", {"source": "erp", "sql": "SELECT * FROM secret_payroll"})
check(code == 400 and "permission denied" in bad["error"].lower(), "the read-only login still limits what can be read")
inv_sql = 'SELECT "invoice_no" AS invoice_no, "total" AS total, "modified_at" AS modified_at\nFROM   "public"."invoices"\nWHERE  "modified_at" >= {{watermark}}'
doc = {"defaults": {"source": "erp"}, "groups": {"ui_sales": {"description": "Picker test", "interval_minutes": 15}},
       "tables": {"ui_stock": {"description": "Stock from the picker", "source": "erp", "mode": "upsert", "keys": ["item_code"],
                               "interval_minutes": "60", "sql": gen},
                  "ui_invoices": {"source": "erp", "mode": "upsert", "keys": ["invoice_no"], "group": "ui_sales",
                                  "incremental_column": "modified_at", "watermark_type": "timestamp", "initial_watermark": "2026-01-01",
                                  "sql": inv_sql}}}
code, t = ui_call("test", {"name": "ui_invoices", "table": doc["tables"]["ui_invoices"], "defaults": doc["defaults"]})
check(code == 200 and t["ok"] and "next watermark would be" in t["output"] and "nothing was written" in t["output"],
      "the full test runs like --test-table")
bad_doc = _json.loads(_json.dumps(doc))
bad_doc["tables"]["ui_stock"]["keys"] = []
code, r = ui_call("save", {"doc": bad_doc, "expected_mtime": st["mtime"]})
check(code == 200 and not r["saved"] and "upsert needs keys" in r["problem"] and ui_tables.read_text() == "",
      "an invalid definition is not saved (the file is untouched)")
code, r = ui_call("save", {"doc": doc, "expected_mtime": st["mtime"]})
check(code == 200 and r["saved"] and r["backup"] and agent("--validate", config=ui_cfg).returncode == 0,
      "saving writes a valid tables.toml and keeps a backup")
check("WHERE  \"modified_at\" >= {{watermark}}" in ui_tables.read_text(), "...with the SQL as readable multi-line text")
code, r = ui_call("save", {"doc": doc, "expected_mtime": st["mtime"]})
check(not r["saved"] and "changed outside" in r["problem"], "a file changed since the page loaded is not overwritten")
code, plan = ui_call("plan")
kinds = sorted(f"{c['kind']}:{c['object_type']}:{c['name']}" for c in plan["changes"])
check(kinds == ["add:group:ui_sales", "add:table:ui_invoices", "add:table:ui_stock"], "Publish shows the plan")
code, r = ui_call("apply", {"changes": kinds[:1]})
check(not r["applied"] and job("ui_stock") is None, "a plan that no longer matches is not applied")
code, r = ui_call("apply", {"changes": kinds})
check(r["applied"] and job("ui_stock")["key_columns"] == ["item_code"] and job("ui_invoices")["group_name"] == "ui_sales",
      "applying creates the load jobs, exactly as --apply")
r = agent("--once", config=ui_cfg)
check(count("ui_stock") == 3 and count("ui_invoices") > 0, "the agent loads the picked tables")
code, st2 = ui_call("state")
del doc["tables"]["ui_stock"]
code, r = ui_call("save", {"doc": doc, "expected_mtime": st2["mtime"]})
code, plan = ui_call("plan")
kinds = sorted(f"{c['kind']}:{c['object_type']}:{c['name']}" for c in plan["changes"])
code, r = ui_call("apply", {"changes": kinds})
check(not r["applied"] and "delete" in r["errors"][0] and job("ui_stock") is not None, "removing a table needs 'delete' typed")
code, r = ui_call("apply", {"changes": kinds, "confirm": "delete"})
check(r["applied"] and job("ui_stock") is None, "...then it is removed")
everything = str(st) + str(tl) + str(cols) + str(pv) + str(t) + ui_cfg.read_text()
check(all(pw not in everything for pw in PASSWORDS), "no password appears in what the page receives")
ui.terminate()
ui.wait(10)
for f in TESTS.glob("ui_tables.tmp.toml*"):
    f.unlink()
ui_cfg.unlink()

# ===========================================================================
section("Passwords with special characters in the Supabase address")
odd = "P%41ss@w/rd#1:x?"
sb.execute(f"alter role bi_agent password '{odd}'")
os.environ["BI_AGENT_DB_PASSWORD"] = odd
r = agent("--check")
check("[OK]   Supabase: connected as bi_agent" in r.out, "a password with % @ / # : ? works in db_url (it is percent-encoded)")
check(odd not in r.out and "P%2541ss" not in r.out, "...and is not shown, plain or encoded")
sb.execute(f"alter role bi_agent password '{PASSWORDS[0]}'")
os.environ["BI_AGENT_DB_PASSWORD"] = PASSWORDS[0]

# ===========================================================================
section("--once explains when there is nothing to load")
sb.execute("update bi.load_groups set last_status = 'error', last_run_at = now(), reload_requested = false, full_reload_requested = false where managed_by = 'test-agent'")
sb.execute("update bi.load_jobs set reload_requested = false, full_reload_requested = false, last_run_at = now() where managed_by = 'test-agent'")
sb.execute("update bi.connectors set reload_requested = false, last_run_at = now()")
r = agent("--once")
log = LOG.read_text()
check("Nothing to load right now." in log, "--once says when nothing is due")
check("last load failed; retried 5 min after the failure (use --run sales to load it now)" in log, "...and why: a failed group waits before retrying")
check("next load at" in log, "...or when the next scheduled load is")

# ===========================================================================
section("Large data: reports keep working while tables are reloaded; link columns indexed")
import time as _time
write_tables(BASE_TABLES.replace('[tables.grv]\nmode = "full"\nsql = "SELECT * FROM grv"\n', ""))
agent("--apply", "--yes")
sb.execute("update bi.load_groups set last_status = null, reload_requested = true where name = 'sales'")
agent("--run", "sales")
key_before = one("select indexname from pg_indexes where schemaname='bi_data' and tablename='invoices' and indexname like '%%bi_key'")
lines_before = count("invoice_lines")
# a report is busy reading invoices when a full reload of the group finishes
reader = psycopg.connect("dbname=sb user=postgres host=localhost")
reader.execute("select count(*) from bi_data.invoices").fetchone()
sb.execute("update bi.load_jobs set full_reload_requested = true where group_name = 'sales'")
loader = subprocess.Popen([sys.executable, AGENT_PY, "--config", str(CONFIG), "--run", "sales"], cwd=ROOT,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
_time.sleep(6)
probe = psycopg.connect("dbname=sb user=postgres host=localhost", autocommit=True)
probe.execute("set statement_timeout = '8s'")
t0 = _time.monotonic()
n_during = probe.execute("select count(*) from bi_data.invoice_lines").fetchone()[0]
waited = _time.monotonic() - t0
check(n_during == lines_before and waited < 4,
      f"while the reload waits to swap, other reports still get the old data quickly ({waited:.1f}s)")
check(loader.poll() is None, "...and the reload waits for the busy report instead of breaking it")
reader.commit()
reader.close()
check(loader.wait(120) == 0, "when the report is done the new data is swapped in")
run = one("select status, trigger from bi.sync_runs where group_name='sales' order by id desc limit 1")
check(run["status"] == "success" and run["trigger"] == "full_reload" and count("invoice_lines") == lines_before,
      "the full reload completed with all rows")
key_after = one("select indexname, indexdef from pg_indexes where schemaname='bi_data' and tablename='invoices' and indexname like '%%bi_key'")
check(key_after and key_after["indexname"] == key_before["indexname"] and "UNIQUE" in key_after["indexdef"],
      "the swapped-in table keeps its key index (same name)")
check(one("select has_table_privilege('service_role', 'bi_data.invoices', 'select') as ok")["ok"],
      "...and its rights for the Hub")
check(not q("select 1 from pg_tables where schemaname='bi_data' and tablename like '%%__bi_new'"), "no replacement tables are left behind")
check(one("select last_analyze from pg_stat_user_tables where schemaname='bi_data' and relname='invoices'")["last_analyze"] is not None,
      "statistics are fresh after the load")
# link columns from an app's data model are indexed
sb.execute("insert into bi.apps(id,name) values ('9b000000-0000-0000-0000-000000000001','Agent test app')")
sb.execute("""insert into bi.app_tables(app_id,alias,table_name,parent_alias,join_pairs,position) values
  ('9b000000-0000-0000-0000-000000000001','lines','invoice_lines',null,'[]',0),
  ('9b000000-0000-0000-0000-000000000001','items','stock_items','lines','[["itemcode","item_code"]]',1)""")
agent("--once")
idx = {r["indexdef"] for r in q("select indexdef from pg_indexes where schemaname='bi_data' and indexname like '%%bi_link'")}
check(any("invoice_lines" in d and "(item_code)" in d for d in idx) and any("stock_items" in d and "(itemcode)" in d for d in idx),
      "columns apps link tables on get an index (both sides)")
check(one("select count(*) n from pg_index x join pg_class c on c.oid = x.indexrelid where c.relname like '%%bi_link' and not x.indisvalid")["n"] == 0,
      "...built without blocking (valid, concurrently)")
sb.execute("update bi.load_jobs set full_reload_requested = true where target_table = 'stock_items'")
agent("--run", "stock_items")
check(any("stock_items" in r["indexdef"] and "(itemcode)" in r["indexdef"]
          for r in q("select indexdef from pg_indexes where schemaname='bi_data' and indexname like '%%bi_link'")),
      "a full reload keeps the link index")
sb.execute("delete from bi.apps where id = '9b000000-0000-0000-0000-000000000001'")

section("A tables.toml name that is already a Data Connection")
saved_tables = TABLES.read_text()
sb.execute("insert into bi.connectors (name, kind, config) values ('hub_clash', 'upload', '{}')")
TABLES.write_text(saved_tables + '\n[tables.hub_clash]\nmode = "full"\nsql = "SELECT * FROM grv"\n')
r = agent("--plan")
check("'hub_clash' is already a upload connection" in r.out and job("hub_clash") is None,
      "refused with a clear message, nothing loaded")
TABLES.write_text(saved_tables)
sb.execute("delete from bi.connectors where name = 'hub_clash'")

print(f"\nAll {passed} checks passed")
