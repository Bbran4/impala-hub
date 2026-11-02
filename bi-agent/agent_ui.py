"""
Impala BI agent — table picker (run_agent.bat --ui)

A small web page served by the agent on THIS machine only (127.0.0.1), for choosing what to load from the
ODBC sources without writing tables.toml by hand:

  * browse the tables and views of each source, see their columns and primary keys, count rows
  * tick columns, choose the load mode, keys, incremental column and schedule (or write the SQL yourself)
  * preview rows and run the same full test as --test-table
  * save tables.toml (checked first; the previous file is kept as a backup), then publish to Supabase
    (the same plan / apply as --plan and --apply)

Nothing here is reachable from the network or from the Hub: the server listens on 127.0.0.1, every request must
carry the random token in the address it opens, and requests from other web sites are refused. The guarantee of
the agent stays the same: it only ever runs queries that are in tables.toml on this machine.

This module is loaded by impala_bi_agent.py; it does not import it (the agent passes itself in as `A`).
"""

from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import os
import re
import secrets
import shutil
import tomllib
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MAX_BODY = 5 * 1024 * 1024
BACKUPS_KEPT = 10


# =============================================================================
# tables.toml: reading the raw definitions and writing them back
# =============================================================================

def read_tables_doc(path: str) -> dict:
    """The raw [defaults], [groups] and [tables] of tables.toml (as the user wrote them)."""
    p = Path(path)
    if not p.exists():
        return {"defaults": {}, "groups": {}, "tables": {}}
    with open(p, "rb") as f:
        raw = tomllib.load(f)
    return {"defaults": raw.get("defaults") or {}, "groups": raw.get("groups") or {}, "tables": raw.get("tables") or {}}


def _toml_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    # a TOML basic string uses the same escapes as JSON
    return json.dumps(str(v), ensure_ascii=False)


def _toml_sql(sql: str) -> str:
    sql = sql.strip("\n")
    if "'''" not in sql and not re.search(r"[\x00-\x08\x0b-\x1f\x7f]", sql.replace("\r\n", "\n")):
        return "'''\n" + sql.replace("\r\n", "\n") + "\n'''"
    return _toml_value(sql)


TABLE_ORDER = ["description", "source", "group", "mode", "keys", "incremental_column", "watermark_type",
               "initial_watermark", "interval_minutes"]


def render_tables_doc(doc: dict, agent_name: str) -> str:
    out = [
        "# =============================================================================",
        "# Impala BI — tables.toml",
        "#",
        f"# Written by the agent's table picker (run_agent.bat --ui) for agent '{agent_name}'",
        f"# on {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}. You can still edit it by hand; the previous",
        "# version is kept as tables.toml.<date>.bak next to it.",
        "#",
        "# After any change: run_agent.bat --validate, --plan, --apply (or Publish in the picker).",
        "# =============================================================================",
        "",
    ]
    defaults = {k: v for k, v in (doc.get("defaults") or {}).items() if v not in (None, "")}
    if defaults:
        out.append("[defaults]")
        out += [f"{k} = {_toml_value(v)}" for k, v in defaults.items()]
        out.append("")
    for name, g in sorted((doc.get("groups") or {}).items()):
        out.append(f"[groups.{name}]")
        for k in ("description", "interval_minutes"):
            if g.get(k) not in (None, ""):
                out.append(f"{k} = {_toml_value(g[k])}")
        out.append("")
    for name, t in (doc.get("tables") or {}).items():
        out.append(f"[tables.{name}]")
        for k in TABLE_ORDER:
            v = t.get(k)
            if v in (None, "", []):
                continue
            out.append(f"{k} = {_toml_value(v)}")
        out.append(f"sql = {_toml_sql(str(t.get('sql') or ''))}")
        out.append("")
    return "\n".join(out)


def clean_doc(doc: dict) -> dict:
    """Only the settings tables.toml knows, in the shapes it expects (the page sends plain JSON)."""
    def table(t: dict) -> dict:
        out: dict[str, Any] = {}
        for k in TABLE_ORDER + ["sql"]:
            v = t.get(k)
            if k == "keys":
                v = [str(x) for x in (v or []) if str(x).strip()]
            elif k == "interval_minutes":
                v = int(v) if v not in (None, "") else None
            elif v is not None:
                v = str(v)
            out[k] = v
        if out.get("mode") == "full":
            out["keys"] = out["keys"] or []
        return out

    groups = {}
    for name, g in (doc.get("groups") or {}).items():
        groups[str(name)] = {"description": (g or {}).get("description") or None,
                             "interval_minutes": int(g["interval_minutes"]) if (g or {}).get("interval_minutes") not in (None, "") else None}
    return {"defaults": {k: str(v) for k, v in (doc.get("defaults") or {}).items() if k in ("source", "mode") and v},
            "groups": groups,
            "tables": {str(n): table(t or {}) for n, t in (doc.get("tables") or {}).items()}}


# =============================================================================
# Turning a picked table into SQL
# =============================================================================

def snake_name(raw: str, sanitize) -> str:
    """ItemCode -> item_code, 'Cost Price' -> cost_price (then the agent's own clean-up)."""
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(raw))
    s = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", "_", s)
    return sanitize(s)


def quoter(dbms: str, quote_char: str):
    sqlserver = "sql server" in dbms.lower()

    def q(name: str) -> str:
        # always quoted: keeps the exact case (PostgreSQL and Oracle fold unquoted names) and allows
        # names that are reserved words, such as Order or Group
        if sqlserver:
            return "[" + name.replace("]", "]]") + "]"
        qc = (quote_char or '"').strip() or '"'
        return qc + name.replace(qc, qc + qc) + qc
    return q


def watermark_type_for(type_name: str, dbms: str) -> str | None:
    t = (type_name or "").lower()
    if "sql server" in dbms.lower() and t in ("timestamp", "rowversion"):
        return None  # SQL Server's timestamp is a row version, not a date
    if "timestamp" in t or "datetime" in t or ("date" in t and "time" in t):
        return "timestamp"
    if t.startswith("date"):
        return "date"
    if "int" in t or t in ("serial", "bigserial", "counter", "autoincrement"):
        return "integer"
    if t in ("numeric", "decimal", "number", "money", "smallmoney"):
        return "numeric"
    return None


# =============================================================================
# The server
# =============================================================================

class PickerApp:
    def __init__(self, A, cfg: dict):
        self.A = A
        self.cfg = cfg
        self.agent = A.Agent(cfg)
        self.lock = threading.Lock()
        self.token = secrets.token_urlsafe(24)
        self._dbms: dict[str, tuple[str, str]] = {}

    # --- helpers -----------------------------------------------------------------

    def source(self, name: str):
        if name not in self.agent.sources:
            raise self.A.AgentError(f"No source '{name}' in config.toml")
        return self.agent.sources[name]

    def dbms(self, name: str, conn=None) -> tuple[str, str]:
        if name not in self._dbms:
            own = conn is None
            conn = conn or self.source(name).connect()
            try:
                import pyodbc
                self._dbms[name] = (str(conn.getinfo(pyodbc.SQL_DBMS_NAME) or ""), str(conn.getinfo(pyodbc.SQL_IDENTIFIER_QUOTE_CHAR) or '"'))
            finally:
                if own:
                    conn.close()
        return self._dbms[name]

    # --- API ---------------------------------------------------------------------

    def state(self, _: dict) -> dict:
        path = self.cfg["agent"]["tables_file"]
        problem = None
        try:
            doc = read_tables_doc(path)
        except tomllib.TOMLDecodeError as e:
            return {"error": f"tables.toml is not valid TOML: {e}"}
        try:
            if Path(path).exists():
                self.A.load_tables(path, self.cfg)
        except self.A.AgentError as e:
            problem = str(e)
        return {"agent": self.cfg["agent"]["name"], "version": self.A.VERSION, "tables_file": path,
                "sources": [{"name": n, "read_only_guard": bool(s["read_only_guard"])} for n, s in self.cfg["sources"].items()],
                "default_source": (doc["defaults"] or {}).get("source") or next(iter(self.cfg["sources"])),
                "doc": doc, "problem": problem, "watermark_types": list(self.A.DEFAULT_WATERMARKS)}

    def list_tables(self, p: dict) -> dict:
        source = self.source(p.get("source", ""))
        conn = source.connect()
        try:
            dbms, _ = self.dbms(source.name, conn)
            out = []
            for t in conn.cursor().tables():
                if t.table_type in ("TABLE", "VIEW", "SYNONYM"):
                    if (t.table_schem or "").lower() in ("information_schema", "pg_catalog", "sys", "mysql", "performance_schema"):
                        continue
                    out.append({"catalog": t.table_cat, "schema": t.table_schem, "name": t.table_name, "type": t.table_type})
                    if len(out) >= 20000:
                        break
        finally:
            conn.close()
        out.sort(key=lambda t: ((t["schema"] or "").lower(), t["name"].lower()))
        return {"dbms": dbms, "tables": out, "truncated": len(out) >= 20000}

    def columns(self, p: dict) -> dict:
        source = self.source(p.get("source", ""))
        table, schema, catalog = p.get("table") or "", p.get("schema") or None, p.get("catalog") or None
        conn = source.connect()
        try:
            dbms, qc = self.dbms(source.name, conn)
            cols = [{"name": c.column_name, "type": c.type_name, "size": c.column_size, "nullable": bool(c.nullable)}
                    for c in conn.cursor().columns(table=table, schema=schema, catalog=catalog)]
            try:
                pk = [r.column_name for r in sorted(conn.cursor().primaryKeys(table=table, schema=schema, catalog=catalog),
                                                    key=lambda r: r.key_seq or 0)]
            except Exception:
                pk = []  # not every driver knows primary keys
        finally:
            conn.close()
        if not cols:
            raise self.A.AgentError(f"No columns found for {table} (check the name, or the login's rights)")
        q = quoter(dbms, qc)
        targets = self.A.unique_column_names([snake_name(c["name"], self.A.sanitize_identifier) for c in cols])
        for c, t in zip(cols, targets):
            c["target"] = t
            c["expr"] = q(c["name"])
            c["watermark_type"] = watermark_type_for(c["type"], dbms)
        from_name = ".".join(q(x) for x in [schema, table] if x)
        return {"dbms": dbms, "columns": cols, "primary_key": pk, "from": from_name,
                "suggested_name": snake_name(table, self.A.sanitize_identifier)}

    def count(self, p: dict) -> dict:
        source = self.source(p.get("source", ""))
        frm = p.get("from") or ""
        conn = source.connect()
        try:
            cur = source.execute(conn, f"SELECT COUNT(*) FROM {frm}", [])
            n = cur.fetchone()[0]
            cur.close()
        finally:
            conn.close()
        return {"rows": int(n)}

    def preview(self, p: dict) -> dict:
        source = self.source(p.get("source", ""))
        payload = {"sql": p.get("sql") or "", "limit": int(p.get("limit") or 50),
                   "watermark_type": p.get("watermark_type") or None, "watermark": p.get("watermark") or None}
        return self.agent.handle_request("preview", source, payload)

    def _table_def(self, name: str, t: dict, defaults: dict):
        A = self.A
        doc = {"defaults": defaults, "groups": {}, "tables": {name: t}}
        tmp = Path(self.cfg["agent"]["tables_file"]).with_suffix(".picker-test.toml")
        try:
            body = render_tables_doc(clean_doc(doc), self.cfg["agent"]["name"])
            # a test only needs the table itself: drop its group (the group may not exist yet)
            body = re.sub(r'^group = .*$', "", body, flags=re.M)
            tmp.write_text(body, encoding="utf-8")
            tf = A.load_tables(str(tmp), self.cfg)
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()
        return tf.tables[name]

    def test(self, p: dict) -> dict:
        name = str(p.get("name") or "")
        t = self._table_def(name, p.get("table") or {}, p.get("defaults") or {})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ok = self.agent.test_table(t, sample_rows=5, watermark=p.get("watermark") or None)
        return {"ok": ok, "output": self.A.redact(buf.getvalue())}

    def check_doc(self, p: dict) -> dict:
        doc = clean_doc(p.get("doc") or {})
        # a group that has no tables yet is fine while picking (saving still needs every group to be used)
        used = {t.get("group") for t in doc["tables"].values()}
        doc["groups"] = {n: g for n, g in doc["groups"].items() if n in used}
        return {"problem": self._validate(doc)}

    def _validate(self, doc: dict) -> str | None:
        path = Path(self.cfg["agent"]["tables_file"])
        tmp = path.with_suffix(".picker-check.toml")
        try:
            tmp.write_text(render_tables_doc(doc, self.cfg["agent"]["name"]), encoding="utf-8")
            self.A.load_tables(str(tmp), self.cfg)
            return None
        except self.A.AgentError as e:
            return str(e).replace(tmp.name, path.name)
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()

    def save(self, p: dict) -> dict:
        doc = clean_doc(p.get("doc") or {})
        problem = self._validate(doc)
        if problem:
            return {"saved": False, "problem": problem}
        path = Path(self.cfg["agent"]["tables_file"])
        backup = None
        if path.exists():
            if p.get("expected_mtime") and abs(path.stat().st_mtime - float(p["expected_mtime"])) > 0.001:
                return {"saved": False, "problem": "tables.toml was changed outside the picker since it was opened. "
                                                   "Reload the page to see the changes (yours are not saved)."}
            backup = path.with_name(f"{path.name}.{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}.bak")
            shutil.copy2(path, backup)
            olds = sorted(path.parent.glob(f"{path.name}.*.bak"))
            for old in olds[:-BACKUPS_KEPT]:
                with contextlib.suppress(OSError):
                    old.unlink()
        tmp = path.with_suffix(".picker-new.toml")
        tmp.write_text(render_tables_doc(doc, self.cfg["agent"]["name"]), encoding="utf-8")
        os.replace(tmp, path)
        return {"saved": True, "backup": backup.name if backup else None, "mtime": path.stat().st_mtime}

    def mtime(self) -> float | None:
        path = Path(self.cfg["agent"]["tables_file"])
        return path.stat().st_mtime if path.exists() else None

    def plan(self, _: dict) -> dict:
        A = self.A
        tf = A.load_tables(self.cfg["agent"]["tables_file"], self.cfg)
        conn = A.pg_connect(self.cfg)
        try:
            changes, errors = A.compute_plan(conn, tf, self.cfg["agent"]["name"])
        finally:
            conn.close()
        return {"errors": errors, "changes": [{"kind": c.kind, "object_type": c.object_type, "name": c.name,
                                                "details": c.details} for c in changes]}

    def apply(self, p: dict) -> dict:
        A = self.A
        tf = A.load_tables(self.cfg["agent"]["tables_file"], self.cfg)
        conn = A.pg_connect(self.cfg)
        try:
            changes, errors = A.compute_plan(conn, tf, self.cfg["agent"]["name"])
            if errors:
                return {"applied": False, "errors": errors}
            seen = sorted(f"{c.kind}:{c.object_type}:{c.name}" for c in changes)
            if seen != sorted(p.get("changes") or []):
                return {"applied": False, "errors": ["Something changed since the plan was shown. Look at the plan again."]}
            removals = [c for c in changes if c.kind == "remove" and c.object_type == "table"]
            if removals and str(p.get("confirm") or "").strip().lower() != "delete":
                return {"applied": False, "errors": ["Type delete to confirm removing tables and their data."]}
            if changes:
                A.apply_plan(conn, tf, changes, self.cfg["agent"]["name"])
        finally:
            conn.close()
        return {"applied": True, "count": len(changes)}

    ROUTES = {"state": state, "tables": list_tables, "columns": columns, "count": count, "preview": preview,
              "test": test, "check": check_doc, "save": save, "plan": plan, "apply": apply}


def make_handler(app: PickerApp, port_ref: dict):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ImpalaBIAgentUI"

        def log_message(self, *a):
            pass

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _host_ok(self) -> bool:
            # refuse DNS-rebinding tricks: only our own address
            return self.headers.get("Host", "") in (f"127.0.0.1:{port_ref['port']}", f"localhost:{port_ref['port']}")

        def do_GET(self):
            if not self._host_ok():
                return self._send(403, b"Forbidden", "text/plain")
            if self.path.split("?")[0] in ("/", "/index.html"):
                return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            self._send(404, b"Not found", "text/plain")

        def do_POST(self):
            if not self._host_ok():
                return self._send(403, b"Forbidden", "text/plain")
            origin = self.headers.get("Origin")
            if origin and origin not in (f"http://127.0.0.1:{port_ref['port']}", f"http://localhost:{port_ref['port']}"):
                return self._send(403, b"Forbidden", "text/plain")
            if not secrets.compare_digest(self.headers.get("X-Agent-Token", ""), app.token):
                return self._send(401, b'{"error":"Open the address the agent printed (with its #code)."}', "application/json")
            route = self.path.removeprefix("/api/")
            fn = PickerApp.ROUTES.get(route)
            if not self.path.startswith("/api/") or fn is None:
                return self._send(404, b'{"error":"Not found"}', "application/json")
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._send(413, b'{"error":"Too large"}', "application/json")
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                if route in ("save", "apply"):
                    with app.lock:
                        result = fn(app, payload)
                else:
                    result = fn(app, payload)
                if route in ("state", "save"):
                    result["mtime"] = app.mtime()
                body, code = json.dumps(result, default=str).encode("utf-8"), 200
            except app.A.AgentError as e:
                body, code = json.dumps({"error": app.A.redact(str(e))}).encode("utf-8"), 400
            except Exception as e:  # anything unexpected: say what, never a stack trace with secrets
                body, code = json.dumps({"error": app.A.redact(app.A.short_error(e))}).encode("utf-8"), 500
            self._send(code, body, "application/json")
    return Handler


def serve(A, cfg: dict, port: int = 0, open_browser: bool = True) -> int:
    app = PickerApp(A, cfg)
    port_ref = {"port": port}
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app, port_ref))
    port_ref["port"] = httpd.server_address[1]
    url = f"http://127.0.0.1:{port_ref['port']}/#{app.token}"
    print(f"Table picker for agent '{cfg['agent']['name']}': {url}", flush=True)
    print("Only this computer can open it. Close this window (or press Ctrl+C) to stop.", flush=True)
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        app.agent.wh.close()
    return 0


# =============================================================================
# The page
# =============================================================================

PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Impala BI agent – tables</title>
<style>
:root{--ink:#1e3a50;--muted:#6b7c8a;--line:#e1e7ec;--bg:#f4f6f8;--card:#fff;--accent:#e7b94f;--accent-soft:#fff6e0;--blue:#2c6e9b;--ok:#2e9e6a;--bad:#c2413b}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:#16324a;color:#fff}
header .mark{width:30px;height:30px;border-radius:8px;background:var(--accent);color:#16324a;display:grid;place-items:center;font-weight:800}
header b{font-size:15px}header small{color:#b9c8d4}header .grow{flex:1}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink);padding:7px 12px}
button.primary{background:#16324a;border-color:#16324a;color:#fff;font-weight:600}button.primary:hover{background:#1f4565}
button.danger{color:var(--bad)}button:disabled{opacity:.5;cursor:default}button.link{border:0;background:none;color:var(--blue);padding:2px 4px}
header button{background:var(--accent);border-color:var(--accent);color:#16324a;font-weight:700}
input,select,textarea{font:inherit;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 9px;background:#fff;width:100%}
textarea{font:12.5px/1.5 ui-monospace,Consolas,monospace;min-height:140px;resize:vertical}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--muted)}
.check{flex-direction:row;align-items:center;gap:6px;font-weight:500;color:var(--ink);font-size:13px}.check input{width:auto}
nav{display:flex;gap:4px;padding:0 20px;background:#fff;border-bottom:1px solid var(--line)}
nav button{border:0;border-bottom:3px solid transparent;border-radius:0;padding:12px 14px;font-weight:600;color:var(--muted)}
nav button.on{color:var(--ink);border-color:var(--accent)}
main{padding:16px 20px;max-width:1500px;margin:0 auto}
.banner{margin:12px 20px 0;padding:10px 14px;border-radius:10px;font-size:13px;white-space:pre-wrap}
.banner.bad{background:#fdecea;color:#8f2b25}.banner.ok{background:#e8f6ee;color:#1d6b46}.banner.warn{background:var(--accent-soft);color:#6b4d00}
.cols{display:grid;grid-template-columns:340px 1fr;gap:16px;align-items:start}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card h3{margin:0 0 10px;font-size:15px}.muted{color:var(--muted)}.small{font-size:12px}
.list{max-height:calc(100vh - 260px);overflow:auto;margin-top:8px;border-top:1px solid var(--line)}
.list button{display:flex;width:100%;text-align:left;border:0;border-bottom:1px solid #f0f3f5;border-radius:0;padding:7px 6px;gap:6px;align-items:baseline}
.list button:hover{background:#f6f9fb}.list button.on{background:var(--accent-soft)}
.list small{color:var(--muted)}.tag{font-size:10px;font-weight:700;padding:1px 6px;border-radius:9px;background:#e8eef3;color:var(--muted)}
.tag.in{background:#e8f6ee;color:var(--ok)}.tag.pk{background:var(--accent-soft);color:#8a6200}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:12px}
.colgrid{max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}th,td{padding:5px 8px;border-bottom:1px solid #f0f3f5;text-align:left;font-size:13px;vertical-align:middle}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:#f8fafb;position:sticky;top:0}
td input[type=text]{padding:3px 6px;font-size:12.5px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.right{margin-left:auto}
.hint{font-size:12px;color:var(--muted);margin:6px 0}
pre{background:#0f2433;color:#d7e3ec;padding:12px;border-radius:10px;overflow:auto;font-size:12px;max-height:340px;white-space:pre-wrap}
.preview{max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px;margin-top:10px}
.preview td{white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.mode{border:1px solid var(--line);border-radius:10px;padding:8px 10px;cursor:pointer;font-size:12.5px;color:var(--muted)}
.mode b{display:block;color:var(--ink);font-size:13px}.mode.on{border-color:var(--accent);background:var(--accent-soft)}
.change{padding:8px 0;border-bottom:1px solid #f0f3f5}.change b{font-family:ui-monospace,Consolas,monospace}
.k-add{color:var(--ok)}.k-change{color:#8a6200}.k-remove{color:var(--bad)}
.empty{padding:30px;text-align:center;color:var(--muted)}
dialog{border:0;border-radius:14px;padding:0;max-width:760px;width:92vw;box-shadow:0 20px 60px #0b203040}
dialog .head{padding:14px 18px;border-bottom:1px solid var(--line);font-weight:700}dialog .body{padding:14px 18px;max-height:60vh;overflow:auto}
dialog .foot{padding:12px 18px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;align-items:center}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-left:6px}
@media(max-width:900px){.cols{grid-template-columns:1fr}.modes{grid-template-columns:1fr}}
</style></head><body>
<header><div class="mark">I</div><div><b>Impala BI agent</b> <small id="who"></small><br><small id="file"></small></div><div class="grow"></div>
<button id="publishBtn" title="Compare tables.toml with Supabase and apply">Publish to Supabase</button></header>
<nav><button data-tab="browse" class="on">Add tables</button><button data-tab="list">Tables to load <span id="count"></span></button><button data-tab="groups">Groups</button></nav>
<div id="banner"></div>
<main id="main"></main>
<dialog id="dlg"><div class="head" id="dlgHead"></div><div class="body" id="dlgBody"></div><div class="foot" id="dlgFoot"></div></dialog>
<script>
const TOKEN=location.hash.slice(1)
const $=s=>document.querySelector(s)
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
async function api(route,body={}){
  const r=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Agent-Token':TOKEN},body:JSON.stringify(body)})
  const data=await r.json().catch(()=>({error:'The agent did not answer'}))
  if(!r.ok||data.error)throw new Error(data.error||('HTTP '+r.status))
  return data
}
let S={doc:{defaults:{},groups:{},tables:{}},saved:'',tab:'browse',source:'',tables:{},search:'',picked:null,edit:null,preview:null,test:null,mtime:null}
const dirty=()=>JSON.stringify(S.doc)!==S.saved
function banner(text,kind='bad'){$('#banner').innerHTML=text?`<div class="banner ${kind}">${esc(text)}</div>`:''}
async function load(){
  try{
    const st=await api('state')
    if(st.error){banner(st.error);return}
    S.info=st;S.doc=st.doc;S.saved=JSON.stringify(st.doc);S.mtime=st.mtime;S.source=S.source||st.default_source
    $('#who').textContent=`· ${st.agent} · ${st.version}`;$('#file').textContent=st.tables_file
    if(st.problem)banner('tables.toml has problems (fix them here, or in the file):\n'+st.problem,'warn')
    render()
  }catch(e){banner(e.message)}
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{S.tab=b.dataset.tab;render()})
window.addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue=''}})

// removing a focused input fires its change event in the middle of a render: finish that render first
let rendering=false,again=false
function render(){
  if(rendering){again=true;return}
  rendering=true
  try{draw()}finally{rendering=false}
  if(again){again=false;render()}
}
function draw(){
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.tab===S.tab))
  const n=Object.keys(S.doc.tables).length;$('#count').innerHTML=`(${n})${dirty()?'<span class="dot" title="Not saved"></span>':''}`
  const m=$('#main')
  if(S.tab==='browse')m.innerHTML=browseView()
  else if(S.tab==='list')m.innerHTML=listView()
  else m.innerHTML=groupsView()
  bind()
}

// ---------------------------------------------------------------- Add tables
function browseView(){
  const srcs=S.info.sources.map(s=>`<option ${s.name===S.source?'selected':''}>${esc(s.name)}</option>`).join('')
  const list=S.tables[S.source]
  const needle=S.search.toLowerCase()
  const inFile=new Set(Object.values(S.doc.tables).map(t=>(t.sql||'').toLowerCase()))
  const shown=(list?.tables||[]).filter(t=>!needle||`${t.schema||''}.${t.name}`.toLowerCase().includes(needle)).slice(0,800)
  return `<div class="cols"><div class="card"><h3>Source</h3>
    <div class="row"><select id="src">${srcs}</select><button id="loadTables">${list?'Refresh':'Show tables'}</button></div>
    ${list?`<input id="search" placeholder="Find a table or view…" value="${esc(S.search)}" style="margin-top:8px">
    <div class="small muted" style="margin-top:6px">${esc(list.dbms)} · ${list.tables.length.toLocaleString()} tables and views${list.truncated?' (first 20,000)':''}</div>
    <div class="list">${shown.map((t,i)=>{const key=JSON.stringify([t.catalog,t.schema,t.name]);const used=[...inFile].some(sql=>sql.includes(t.name.toLowerCase()))
      return `<button data-pick='${esc(key)}' class="${S.picked===key?'on':''}"><span>${t.schema?`<small>${esc(t.schema)}.</small>`:''}${esc(t.name)}</span>${t.type==='VIEW'?'<span class="tag">view</span>':''}${used?'<span class="tag in">in use</span>':''}</button>`}).join('')}
      ${shown.length===800?'<div class="small muted" style="padding:8px">Showing 800 — type to narrow down.</div>':''}</div>`
    :'<p class="hint">Lists the tables and views the source login can read.</p>'}
  </div><div>${S.edit?editorView():'<div class="card empty">Choose a table on the left to load it, or <button class="link" id="blank">write a query yourself</button>.</div>'}</div></div>`
}

function newEdit(name,src,cols,info){
  const pk=info?.primary_key||[]
  return {isNew:true,origName:null,name,source:src,description:'',hand:!cols,from:info?.from||'',cols:cols||[],sel:new Set((cols||[]).map(c=>c.name)),
    targets:Object.fromEntries((cols||[]).map(c=>[c.name,c.target])),mode:pk.length?'upsert':'full',
    keys:pk.map(n=>(cols||[]).find(c=>c.name===n)?.target).filter(Boolean),inc:'',wmType:'',initWm:'',
    sched:'interval',interval:'60',group:'',sql:'',pk,rows:null}
}
function generatedSql(e){
  const picked=e.cols.filter(c=>e.sel.has(c.name))
  const lines=picked.map(c=>{const t=e.targets[c.name];return `${c.expr} AS ${t}`})
  let sql=`SELECT ${lines.join(',\n       ')}\nFROM   ${e.from}`
  if(e.inc){const c=e.cols.find(x=>e.targets[x.name]===e.inc);if(c)sql+=`\nWHERE  ${c.expr} >= {{watermark}}`}
  return sql
}
const sqlOf=e=>e.hand?e.sql:generatedSql(e)
function editorView(){
  const e=S.edit
  const picked=e.cols.filter(c=>e.sel.has(c.name))
  const targets=e.hand?[]:picked.map(c=>e.targets[c.name])
  const incOpts=e.hand?[]:picked.filter(c=>c.watermark_type)
  const groups=Object.keys(S.doc.groups)
  const exists=!e.isNew||S.doc.tables[e.name]
  return `<div class="card"><div class="row"><h3 style="margin:0">${e.isNew?'Load':'Edit'} ${esc(e.from||e.name||'a query')}</h3>
    ${e.from?`<span class="small muted">source ${esc(e.source)}</span><button class="link" id="countRows">${e.rows==null?'Count rows':e.rows.toLocaleString()+' rows'}</button>`:''}
    <button class="link right" id="closeEdit">Close</button></div>
  <div class="grid" style="margin-top:10px">
    <label>Table name in Supabase<input id="tname" value="${esc(e.name)}" placeholder="e.g. stock_items"></label>
    <label>Description<input id="tdesc" value="${esc(e.description)}" placeholder="What it holds"></label>
    ${e.hand?`<label>Source<select id="tsrc">${S.info.sources.map(s=>`<option ${s.name===e.source?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>`:''}
  </div>
  ${e.hand?'':`<div class="row"><b class="small">Columns</b><span class="small muted">${picked.length} of ${e.cols.length}</span>
      <button class="link" id="allCols">All</button><button class="link" id="noCols">None</button>
      <button class="link right" id="toHand">Write the SQL myself</button></div>
    <div class="colgrid"><table><thead><tr><th></th><th>Column in the ERP</th><th>Type</th><th>Name in Supabase</th></tr></thead><tbody>
    ${e.cols.map((c,i)=>`<tr><td><input type="checkbox" data-col="${i}" ${e.sel.has(c.name)?'checked':''}></td>
      <td>${esc(c.name)} ${e.pk.includes(c.name)?'<span class="tag pk">key</span>':''}</td><td class="small muted">${esc(c.type)}${c.size&&/char/i.test(c.type)?'('+c.size+')':''}</td>
      <td><input type="text" data-target="${i}" value="${esc(e.targets[c.name])}" ${e.sel.has(c.name)?'':'disabled'}></td></tr>`).join('')}
    </tbody></table></div>`}
  <h3 style="margin-top:16px">How to load</h3>
  <div class="modes">
    <div class="mode ${e.mode==='full'?'on':''}" data-mode="full"><b>Replace everything</b>Reads the whole table every time. Best for master data and small or medium tables (stock items, customers, suppliers).</div>
    <div class="mode ${e.mode==='upsert'?'on':''}" data-mode="upsert"><b>Add and update</b>Matches rows on key columns: new rows are added, changed rows updated. With a "changed since" column only new and changed rows are read (invoices, orders).</div>
    <div class="mode ${e.mode==='append'?'on':''}" data-mode="append"><b>Add only</b>Adds the rows read each time and never changes them (logs, daily snapshots).</div>
  </div>
  <div class="grid" style="margin-top:10px">
    ${e.mode==='upsert'?`<label>Key columns (unique per row)${e.hand?`<input id="keysTxt" value="${esc(e.keys.join(', '))}" placeholder="e.g. invoice_no, line_no">`
      :`<div class="colgrid" style="max-height:130px;padding:4px 8px;font-weight:500">${targets.map(t=>`<label class="check"><input type="checkbox" data-key="${esc(t)}" ${e.keys.includes(t)?'checked':''}>${esc(t)}</label>`).join('')}</div>`}</label>`:''}
    ${e.mode!=='full'?`<label>Only read rows changed since… ${e.hand?`<input id="incTxt" value="${esc(e.inc)}" placeholder="column name, e.g. modified_at">`
      :`<select id="inc"><option value="">— read everything each time —</option>${incOpts.map(c=>`<option value="${esc(e.targets[c.name])}" ${e.inc===e.targets[c.name]?'selected':''}>${esc(e.targets[c.name])} (${esc(c.type)})</option>`).join('')}</select>`}</label>`:''}
    ${e.inc?`<label>Its type<select id="wmType">${S.info.watermark_types.map(w=>`<option ${w===e.wmType?'selected':''}>${w}</option>`).join('')}</select></label>
      <label>Start from (first load)<input id="initWm" value="${esc(e.initWm)}" placeholder="${e.wmType==='date'||e.wmType==='timestamp'?'e.g. 2024-01-01 (empty: everything)':'empty: everything'}"></label>`:''}
  </div>
  <div class="grid">
    <label>When<select id="sched"><option value="interval" ${e.sched==='interval'?'selected':''}>Every … minutes</option>
      <option value="group" ${e.sched==='group'?'selected':''} ${groups.length?'':'disabled'}>With a group${groups.length?'':' (create one under Groups)'}</option>
      <option value="manual" ${e.sched==='manual'?'selected':''}>Only when "Reload now" is clicked</option></select></label>
    ${e.sched==='interval'?`<label>Minutes<input id="interval" type="number" min="1" value="${esc(e.interval)}"></label>`:''}
    ${e.sched==='group'?`<label>Group<select id="group">${groups.map(g=>`<option ${g===e.group?'selected':''}>${esc(g)}</option>`).join('')}</select></label>`:''}
  </div>
  <label>SQL ${e.hand?'':'<span class="small muted" style="font-weight:400">(generated from the choices above)</span>'}
    <textarea id="sql" ${e.hand?'':'readonly'}>${esc(sqlOf(e))}</textarea></label>
  ${e.hand&&e.mode!=='full'&&e.inc?'<p class="hint">Put {{watermark}} where the "changed since" value goes, e.g. WHERE ModifiedDate &gt;= {{watermark}}.</p>':''}
  <div class="row" style="margin-top:10px">
    <button id="previewBtn">Preview rows</button><button id="testBtn" title="Reads the whole result once, like --test-table: row count, duplicate keys, next watermark">Full test</button>
    <span class="right"></span>${exists&&e.isNew?`<span class="small" style="color:var(--bad)">A table named ${esc(e.name)} already exists</span>`:''}
    <button class="primary" id="addBtn">${e.isNew?'Add to tables to load':'Update'}</button></div>
  ${S.preview?previewView(S.preview):''}${S.test?`<pre>${esc(S.test.output)}</pre>`:''}
  </div>`
}
function previewView(p){
  return `<div class="preview"><table><thead><tr>${p.columns.map(c=>`<th>${esc(c.name)}<br><span style="text-transform:none;font-weight:400">${esc(c.type)}</span></th>`).join('')}</tr></thead>
  <tbody>${p.rows.map(r=>`<tr>${r.map(v=>`<td title="${esc(v)}">${v===null?'<span class="muted">null</span>':esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  <div class="small muted">${p.rows.length} row(s)${p.truncated?' (first rows only)':''} in ${p.elapsed_ms} ms. Nothing was written anywhere.</div>`
}
function editToDef(e){
  const t={description:e.description||null,source:e.source,mode:e.mode,sql:sqlOf(e)}
  if(e.mode==='upsert')t.keys=e.keys
  if(e.mode!=='full'&&e.inc){t.incremental_column=e.inc;t.watermark_type=e.wmType;if(e.initWm)t.initial_watermark=e.initWm}
  if(e.sched==='interval')t.interval_minutes=e.interval
  if(e.sched==='group')t.group=e.group||Object.keys(S.doc.groups)[0]
  return t
}
function defToEdit(name,t){
  const e=newEdit(name,t.source||S.info.default_source,null,null)
  Object.assign(e,{isNew:false,origName:name,description:t.description||'',hand:true,sql:t.sql||'',mode:t.mode||S.doc.defaults.mode||'full',
    keys:t.keys||[],inc:t.incremental_column||'',wmType:t.watermark_type||'',initWm:t.initial_watermark||'',
    sched:t.group?'group':t.interval_minutes?'interval':'manual',interval:String(t.interval_minutes||60),group:t.group||''})
  return e
}

// ---------------------------------------------------------------- Tables to load
function listView(){
  const rows=Object.entries(S.doc.tables)
  return `<div class="card"><div class="row"><h3 style="margin:0">Tables to load</h3><span class="small muted">${esc(S.info.tables_file)}</span>
    <span class="right"></span>${dirty()?'<span class="small" style="color:#8a6200">Not saved yet</span><button id="revert">Undo changes</button>':''}
    <button class="primary" id="saveBtn" ${dirty()?'':'disabled'}>Save tables.toml</button></div>
  ${rows.length?`<table style="margin-top:10px"><thead><tr><th>Table</th><th>Source</th><th>Load</th><th>When</th><th></th></tr></thead><tbody>
  ${rows.map(([n,t])=>`<tr><td><b>${esc(n)}</b><br><span class="small muted">${esc(t.description||'')}</span></td><td>${esc(t.source||S.doc.defaults.source||'')}</td>
    <td>${esc({full:'Replace everything',upsert:'Add and update',append:'Add only'}[t.mode||S.doc.defaults.mode||'full'])}${t.incremental_column?`<br><span class="small muted">changed since ${esc(t.incremental_column)}</span>`:''}</td>
    <td>${t.group?'group '+esc(t.group):t.interval_minutes?'every '+esc(t.interval_minutes)+' min':'manual'}</td>
    <td style="text-align:right;white-space:nowrap"><button data-edit="${esc(n)}">Edit</button> <button class="danger" data-remove="${esc(n)}">Remove</button></td></tr>`).join('')}
  </tbody></table>`:'<div class="empty">No tables yet. Add some under "Add tables".</div>'}
  <p class="hint">Saving writes tables.toml on this computer (the old version is kept as a .bak file). The running agent only starts loading new or changed tables after <b>Publish to Supabase</b>.</p></div>`
}

// ---------------------------------------------------------------- Groups
function groupsView(){
  const gs=Object.entries(S.doc.groups)
  return `<div class="card"><h3>Groups</h3><p class="hint">Tables in a group are loaded together in one step on one schedule, so reports never see invoices without their lines.</p>
  ${gs.length?`<table><thead><tr><th>Group</th><th>Description</th><th>Every (minutes)</th><th>Tables</th><th></th></tr></thead><tbody>
  ${gs.map(([n,g])=>`<tr><td><b>${esc(n)}</b></td><td><input type="text" data-gdesc="${esc(n)}" value="${esc(g.description||'')}"></td>
    <td><input type="text" data-gint="${esc(n)}" value="${esc(g.interval_minutes||'')}" placeholder="manual"></td>
    <td class="small">${Object.entries(S.doc.tables).filter(([,t])=>t.group===n).map(([tn])=>esc(tn)).join(', ')||'<span class="muted">none yet</span>'}</td>
    <td><button class="danger" data-gremove="${esc(n)}">Remove</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No groups.</div>'}
  <div class="row" style="margin-top:12px"><input id="gname" placeholder="new group name, e.g. sales" style="max-width:260px"><button id="gadd">Add group</button></div>
  <p class="hint">Changes here are saved with "Save tables.toml" on the Tables to load tab.</p></div>`
}

// ---------------------------------------------------------------- events
function bind(){
  const on=(sel,ev,fn)=>document.querySelectorAll(sel).forEach(el=>el.addEventListener(ev,fn))
  const e=S.edit
  on('#src','change',ev=>{S.source=ev.target.value;render()})
  on('#loadTables','click',async ev=>{ev.target.disabled=true;ev.target.textContent='Loading…'
    try{S.tables[S.source]=await api('tables',{source:S.source});banner('')}catch(err){banner(err.message)}render()})
  on('#search','input',ev=>{S.search=ev.target.value;const pos=ev.target.selectionStart;render();const s=$('#search');s.focus();s.setSelectionRange(pos,pos)})
  on('[data-pick]','click',async ev=>{
    const key=ev.currentTarget.dataset.pick;const [catalog,schema,table]=JSON.parse(key);S.picked=key;S.preview=null;S.test=null
    try{const info=await api('columns',{source:S.source,catalog,schema,table})
      let name=info.suggested_name;let i=2;while(S.doc.tables[name])name=info.suggested_name+'_'+(i++)
      S.edit=newEdit(name,S.source,info.columns,info);banner('')}catch(err){banner(err.message)}render()})
  on('#blank','click',()=>{S.edit=newEdit('',S.source,null,null);S.edit.hand=true;S.edit.sql='SELECT \nFROM   ';render()})
  on('[data-edit]','click',ev=>{const n=ev.target.dataset.edit;S.edit=defToEdit(n,S.doc.tables[n]);S.preview=null;S.test=null;S.tab='browse';render()})
  on('[data-remove]','click',ev=>{const n=ev.target.dataset.remove;if(confirm(`Remove ${n} from tables.toml? After Publish its table and data are deleted in Supabase.`)){delete S.doc.tables[n];render()}})
  on('#saveBtn','click',save);on('#revert','click',()=>{S.doc=JSON.parse(S.saved);render()})
  on('#gadd','click',()=>{const n=$('#gname').value.trim().toLowerCase();if(!/^[a-z][a-z0-9_]{0,62}$/.test(n)){alert('Use lower case letters, digits and _, starting with a letter');return}
    if(S.doc.groups[n]||S.doc.tables[n]){alert('That name is already used');return}S.doc.groups[n]={description:'',interval_minutes:15};render()})
  on('[data-gdesc]','change',ev=>{S.doc.groups[ev.target.dataset.gdesc].description=ev.target.value;render()})
  on('[data-gint]','change',ev=>{const v=ev.target.value.trim();S.doc.groups[ev.target.dataset.gint].interval_minutes=v?Number(v):null;render()})
  on('[data-gremove]','click',ev=>{const n=ev.target.dataset.gremove
    if(Object.values(S.doc.tables).some(t=>t.group===n)){alert('Move its tables to another schedule first');return}delete S.doc.groups[n];render()})
  if(!e)return
  const set=(k,v,rerender=true)=>{e[k]=v;S.test=null;if(rerender)render()}
  on('#closeEdit','click',()=>{S.edit=null;S.picked=null;S.preview=null;S.test=null;render()})
  on('#tname','input',ev=>set('name',ev.target.value.trim(),false));on('#tname','change',()=>render())
  on('#tdesc','input',ev=>set('description',ev.target.value,false))
  on('#tsrc','change',ev=>set('source',ev.target.value))
  on('[data-col]','change',ev=>{const c=e.cols[ev.target.dataset.col];if(ev.target.checked)e.sel.add(c.name);else{e.sel.delete(c.name);e.keys=e.keys.filter(k=>k!==e.targets[c.name]);if(e.inc===e.targets[c.name])e.inc=''}render()})
  on('[data-target]','change',ev=>{const c=e.cols[ev.target.dataset.target];const old=e.targets[c.name];const v=ev.target.value.trim().toLowerCase()
    e.targets[c.name]=v;e.keys=e.keys.map(k=>k===old?v:k);if(e.inc===old)e.inc=v;render()})
  on('#allCols','click',()=>{e.cols.forEach(c=>e.sel.add(c.name));render()});on('#noCols','click',()=>{e.sel.clear();e.keys=[];e.inc='';render()})
  on('#toHand','click',()=>{e.sql=generatedSql(e);e.hand=true;render()})
  on('[data-mode]','click',ev=>{const m=ev.currentTarget.dataset.mode;e.mode=m;if(m==='full')e.inc='';render()})
  on('[data-key]','change',ev=>{const k=ev.target.dataset.key;e.keys=ev.target.checked?[...e.keys,k]:e.keys.filter(x=>x!==k);render()})
  on('#keysTxt','change',ev=>set('keys',ev.target.value.split(',').map(s=>s.trim()).filter(Boolean)))
  on('#inc','change',ev=>{e.inc=ev.target.value;const c=e.cols.find(x=>e.targets[x.name]===e.inc);e.wmType=c?.watermark_type||'timestamp';render()})
  on('#incTxt','change',ev=>{e.inc=ev.target.value.trim();if(!e.wmType)e.wmType='timestamp';render()})
  on('#wmType','change',ev=>set('wmType',ev.target.value));on('#initWm','change',ev=>set('initWm',ev.target.value.trim()))
  on('#sched','change',ev=>{e.sched=ev.target.value;if(e.sched==='group'&&!e.group)e.group=Object.keys(S.doc.groups)[0]||'';render()})
  on('#interval','change',ev=>set('interval',ev.target.value));on('#group','change',ev=>set('group',ev.target.value))
  on('#sql','input',ev=>{if(e.hand){e.sql=ev.target.value;S.test=null}})
  on('#countRows','click',async ev=>{ev.target.textContent='Counting…';try{e.rows=(await api('count',{source:e.source,from:e.from})).rows}catch(err){banner(err.message)}render()})
  on('#previewBtn','click',async ev=>{ev.target.disabled=true;ev.target.textContent='Reading…';S.test=null
    try{S.preview=await api('preview',{source:e.source,sql:sqlOf(e),limit:50,watermark_type:e.inc?e.wmType:null,watermark:e.initWm||null});banner('')}catch(err){S.preview=null;banner(err.message)}render()})
  on('#testBtn','click',async ev=>{ev.target.disabled=true;ev.target.textContent='Testing (reads every row)…';S.preview=null
    try{S.test=await api('test',{name:e.name||'picker_test',table:editToDef(e),defaults:S.doc.defaults,watermark:e.initWm||null});banner('')}catch(err){S.test=null;banner(err.message)}render()})
  on('#addBtn','click',async()=>{
    if(!/^[a-z][a-z0-9_]{0,62}$/.test(e.name)){banner('The table name must be lower case letters, digits and _, starting with a letter');return}
    if(e.isNew&&S.doc.tables[e.name]){banner(`There is already a table named ${e.name}`);return}
    if(!e.isNew&&e.name!==e.origName&&S.doc.tables[e.name]){banner(`There is already a table named ${e.name}`);return}
    if(!e.hand&&!e.sel.size){banner('Choose at least one column');return}
    const next=JSON.parse(JSON.stringify(S.doc))
    if(!e.isNew&&e.origName!==e.name)delete next.tables[e.origName]
    next.tables[e.name]=editToDef(e)
    try{const r=await api('check',{doc:next})
      if(r.problem){banner(r.problem);return}
      S.doc=next;banner(`${e.name} is in the list. Save tables.toml, then Publish to Supabase.`,'ok');S.edit=null;S.picked=null;S.preview=null;S.tab='list';render()
    }catch(err){banner(err.message)}})
}
async function save(){
  try{const r=await api('save',{doc:S.doc,expected_mtime:S.mtime})
    if(!r.saved){banner(r.problem);return}
    S.saved=JSON.stringify(S.doc);S.mtime=r.mtime
    banner(`tables.toml saved${r.backup?` (previous version: ${r.backup})`:''}. Publish to Supabase to start loading.`,'ok');render()
  }catch(err){banner(err.message)}
}

// ---------------------------------------------------------------- publish
$('#publishBtn').onclick=async()=>{
  const d=$('#dlg')
  if(dirty()&&!confirm('tables.toml has unsaved changes. Save them first?'))return
  if(dirty()){await save();if(dirty())return}
  $('#dlgHead').textContent='Publish to Supabase';$('#dlgBody').innerHTML='<p class="muted">Comparing tables.toml with Supabase…</p>';$('#dlgFoot').innerHTML='<button id="dlgClose">Close</button>'
  $('#dlgClose').onclick=()=>d.close();d.showModal()
  try{
    const p=await api('plan')
    if(p.errors.length){$('#dlgBody').innerHTML=`<div class="banner bad" style="margin:0">${esc(p.errors.join('\n'))}</div>`;return}
    if(!p.changes.length){$('#dlgBody').innerHTML='<p>Supabase is up to date with tables.toml. Nothing to publish.</p>';return}
    const removes=p.changes.some(c=>c.kind==='remove'&&c.object_type==='table')
    $('#dlgBody').innerHTML=p.changes.map(c=>`<div class="change"><span class="k-${c.kind}">${{add:'+ add',change:'~ change',remove:'− remove'}[c.kind]}</span> ${c.object_type} <b>${esc(c.name)}</b>
      <div class="small muted">${c.details.map(esc).join('<br>')}</div></div>`).join('')
      +(removes?'<p class="banner bad" style="margin:12px 0 0">Removing a table deletes it and its data in Supabase. Apps that use it stop working until it is taken out of them.</p>':'')
    $('#dlgFoot').innerHTML=`${removes?'<input id="confirmDel" placeholder="type delete" style="max-width:150px">':''}<button id="dlgClose">Cancel</button><button class="primary" id="dlgApply">Apply ${p.changes.length} change(s)</button>`
    $('#dlgClose').onclick=()=>d.close()
    $('#dlgApply').onclick=async ev=>{ev.target.disabled=true;ev.target.textContent='Applying…'
      try{const r=await api('apply',{changes:p.changes.map(c=>`${c.kind}:${c.object_type}:${c.name}`),confirm:$('#confirmDel')?.value||''})
        if(!r.applied){$('#dlgBody').insertAdjacentHTML('afterbegin',`<div class="banner bad" style="margin:0 0 10px">${esc(r.errors.join('\n'))}</div>`);ev.target.disabled=false;ev.target.textContent='Apply';return}
        d.close();banner(`Published ${r.count} change(s). The running agent starts loading within a few seconds; follow it in the Hub under Reporting → Data Loads.`,'ok')
      }catch(err){d.close();banner(err.message)}}
  }catch(err){$('#dlgBody').innerHTML=`<div class="banner bad" style="margin:0">${esc(err.message)}</div>`}
}
if(!TOKEN)banner('Open the full address the agent printed (it ends with #…).')
else load()
</script></body></html>"""
