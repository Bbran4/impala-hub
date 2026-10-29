#!/usr/bin/env python3
"""
Impala BI sync agent
====================

Runs on a machine inside your network that can reach your SQL sources over ODBC
(the ERP, or any other SQL database) and loads data into Supabase.

WHAT gets loaded from the ERP is defined in tables.toml on this machine (like a Qlik
load script). Web and folder connectors are created in the app, but only run within the
limits of [connectors] in config.toml here (allowed hosts, folders, secrets, SharePoint/OneDrive
locations and the Google service account). You publish changes to Supabase with --plan / --apply. The agent only
ever runs queries that are in tables.toml here, so nobody can make it run a
different query against your ERP by changing things in Supabase.

Commands:
  --validate              check config.toml and tables.toml, no connections
  --test-table NAME       run one table's query against the source and show the result; writes nothing
  --test-all              the same for every table
  --check                 test the Supabase connection and every source
  --plan                  show what --apply would change in Supabase
  --apply [--yes]         publish tables.toml to Supabase (add / change / remove tables)
  --run NAME              load one table, group or connector now, then exit
  --once                  do all due work once, then exit
  (no command)            run continuously
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import decimal
import fnmatch
import getpass
import hashlib
import io
import json
import logging
import os
import re
import signal
import socket
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import psycopg
import pyodbc
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

VERSION = "0.4.0"
PLACEHOLDER = "{{watermark}}"
DATA_SCHEMA = "bi_data"
LOADED_AT_COLUMN = "_bi_loaded_at"
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
REQUEST_KINDS = ("test_connection", "list_tables", "list_columns", "preview")
RETRY_MINUTES = 5
RETRY_OK = ("({t}.last_status is distinct from 'error' "
            "or {t}.last_run_at < now() - make_interval(mins => " + str(RETRY_MINUTES) + "))")

log = logging.getLogger("impala_bi_agent")

DEFAULT_WATERMARKS = {
    "timestamp": "1900-01-01 00:00:00",
    "date": "1900-01-01",
    "integer": "-2147483648",
    "numeric": "-2147483648",
    "text": "",
}

PY_TO_PG = {
    bool: "boolean",
    int: "bigint",
    float: "double precision",
    decimal.Decimal: "numeric",
    str: "text",
    dt.datetime: "timestamp without time zone",
    dt.date: "date",
    dt.time: "time without time zone",
    bytes: "bytea",
    bytearray: "bytea",
    uuid.UUID: "uuid",
}


class AgentError(Exception):
    """An error with a message meant for a person."""


# =============================================================================
# Secrets & logging
# =============================================================================

_SECRETS: set[str] = set()


def remember_secret(value: str | None) -> None:
    if value and len(value) >= 4:
        _SECRETS.add(value)


def redact(text: str) -> str:
    for s in sorted(_SECRETS, key=len, reverse=True):
        text = text.replace(s, "***")
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        clean = redact(msg)
        if clean != msg:
            record.msg, record.args = clean, ()
        return True


def setup_logging(cfg: dict) -> None:
    level = getattr(logging, str(cfg["agent"]["log_level"]).upper(), logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s")
    root = logging.getLogger()
    root.setLevel(level)
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    log_file = Path(cfg["agent"]["log_file"])
    log_file.parent.mkdir(parents=True, exist_ok=True)
    handlers.append(RotatingFileHandler(log_file, maxBytes=5_000_000, backupCount=5, encoding="utf-8"))
    for h in handlers:
        h.setFormatter(fmt)
        h.addFilter(RedactingFilter())
        root.addHandler(h)


# =============================================================================
# config.toml
# =============================================================================

_ENV_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _expand_env(value: Any) -> Any:
    if isinstance(value, str):
        def repl(m: re.Match) -> str:
            name = m.group(1)
            if name not in os.environ:
                raise AgentError(f"Config refers to ${{{name}}}, which is not set (add it to .env)")
            remember_secret(os.environ[name])
            return os.environ[name]
        return _ENV_RE.sub(repl, value)
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    return value


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def _odbc_password(conn_str: str) -> str | None:
    m = re.search(r"(?:^|;)\s*(?:PWD|Password)\s*=\s*(\{[^}]*\}|[^;]*)", conn_str, re.I)
    return m.group(1).strip("{}") if m else None


def check_supabase_tls(db_url: str) -> str | None:
    """Refuse unencrypted connections to anything but this machine. Returns a warning, if any."""
    try:
        info = conninfo_to_dict(db_url)
    except psycopg.ProgrammingError as e:
        raise AgentError(f"[supabase] db_url is not a valid connection string: {redact(str(e))}") from e
    remember_secret(info.get("password"))
    host = str(info.get("host") or "")
    sslmode = str(info.get("sslmode") or "")
    local = host in ("", "localhost", "127.0.0.1", "::1") or host.startswith("/")
    if local:
        return None
    if sslmode not in ("require", "verify-ca", "verify-full"):
        raise AgentError("[supabase] db_url must use an encrypted connection: add ?sslmode=verify-full "
                         "(recommended, with sslrootcert=...) or at least ?sslmode=require")
    if sslmode != "verify-full":
        return ("Supabase connection is encrypted but the server certificate is not verified. "
                "Use sslmode=verify-full with Supabase's CA certificate (see README).")
    return None


def load_config(path: str) -> dict:
    cfg_path = Path(path).resolve()
    if not cfg_path.exists():
        raise AgentError(f"Config file not found: {cfg_path}")
    load_dotenv(cfg_path.parent / ".env")
    with open(cfg_path, "rb") as f:
        cfg = _expand_env(tomllib.load(f))

    agent = cfg.setdefault("agent", {})
    agent.setdefault("name", socket.gethostname().lower())
    agent.setdefault("tables_file", "tables.toml")
    agent.setdefault("poll_seconds", 5)
    agent.setdefault("heartbeat_seconds", 30)
    agent.setdefault("batch_size", 5000)
    agent.setdefault("log_file", "logs/agent.log")
    agent.setdefault("log_level", "INFO")
    agent.setdefault("grant_select_to", ["postgres", "service_role"])
    agent.setdefault("run_history_days", 90)
    agent.setdefault("request_history_days", 7)
    agent.setdefault("preview_max_rows", 200)
    agent["tables_file"] = str((cfg_path.parent / agent["tables_file"]).resolve())
    agent["log_file"] = str((cfg_path.parent / agent["log_file"]).resolve())

    if "db_url" not in cfg.get("supabase", {}):
        raise AgentError("Config is missing [supabase] db_url")
    cfg["_warnings"] = [w for w in [check_supabase_tls(cfg["supabase"]["db_url"])] if w]

    sources = cfg.get("sources") or {}
    if not sources:
        raise AgentError("Config has no [sources.<name>] sections")
    for name, src in sources.items():
        if not NAME_RE.match(name):
            raise AgentError(f"Source name '{name}' must be lower case letters, digits and _")
        if "odbc" not in src:
            raise AgentError(f"[sources.{name}] is missing 'odbc'")
        remember_secret(_odbc_password(src["odbc"]))
        src.setdefault("read_only_guard", True)
        src.setdefault("rstrip_strings", True)
        src.setdefault("isolation", "read_committed")
        src.setdefault("login_timeout_seconds", 30)
        src.setdefault("query_timeout_seconds", 0)
        src.setdefault("app_requests", ["test_connection"])
        if src["isolation"] not in ("read_committed", "read_uncommitted", "default"):
            raise AgentError(f"[sources.{name}] isolation must be read_committed, read_uncommitted or default")
        bad = [k for k in src["app_requests"] if k not in REQUEST_KINDS]
        if bad:
            raise AgentError(f"[sources.{name}] app_requests: unknown kind(s) {bad}; allowed: {list(REQUEST_KINDS)}")
    cfg["connectors"] = parse_connector_config(cfg.get("connectors") or {})
    return cfg


def parse_sharepoint_locations(raw: dict) -> dict:
    """[connectors.sharepoint]: named SharePoint document libraries or OneDrives (optionally one folder in them).
       finance = { site = "impalaspares.sharepoint.com:/sites/Finance", library = "Documents", folder = "Budgets" }
       jaco    = { onedrive = "jaco@impalaspares.co.za", folder = "Reports" }
       sales   = "impalaspares.sharepoint.com:/sites/Sales"          (the site's default library)"""
    if not isinstance(raw, dict):
        raise AgentError("[connectors.sharepoint] must map a name to a site or OneDrive")
    out = {}
    for name, loc in raw.items():
        if isinstance(loc, str):
            loc = {"site": loc}
        if not NAME_RE.match(name) or not isinstance(loc, dict):
            raise AgentError(f"[connectors.sharepoint] '{name}': names are lower case letters, digits and _")
        bad = set(loc) - {"site", "library", "onedrive", "folder"}
        if bad:
            raise AgentError(f"[connectors.sharepoint.{name}]: unknown setting(s) {', '.join(sorted(bad))}")
        site, drive = str(loc.get("site") or ""), str(loc.get("onedrive") or "")
        if bool(site) == bool(drive):
            raise AgentError(f"[connectors.sharepoint.{name}]: set either site (host:/sites/Name) or onedrive (a user's email)")
        if site and not re.fullmatch(r"[a-z0-9-]+\.sharepoint\.com:/(sites|teams)/[^/?#]+", site, re.I):
            raise AgentError(f"[connectors.sharepoint.{name}]: site must look like impalaspares.sharepoint.com:/sites/Finance")
        if drive and not re.fullmatch(r"[^@\s/]+@[^@\s/]+", drive):
            raise AgentError(f"[connectors.sharepoint.{name}]: onedrive must be the user's email address")
        folder = str(loc.get("folder") or "").strip("/")
        if ".." in folder.split("/") or "\\" in folder:
            raise AgentError(f"[connectors.sharepoint.{name}]: invalid folder")
        out[name] = {"site": site, "library": str(loc.get("library") or ""), "onedrive": drive, "folder": folder}
    return out


def parse_microsoft(raw: dict) -> dict | None:
    """[connectors.microsoft]: the app registration the agent uses for Microsoft Graph (client credentials).
    The client secret stays in .env under client_secret_env (default MS_GRAPH_CLIENT_SECRET)."""
    if not raw:
        return None
    if not re.fullmatch(r"[0-9a-fA-F-]{36}|[a-z0-9.-]+\.onmicrosoft\.com", str(raw.get("tenant_id") or "")):
        raise AgentError("[connectors.microsoft] tenant_id must be the directory (tenant) ID")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", str(raw.get("client_id") or "")):
        raise AgentError("[connectors.microsoft] client_id must be the application (client) ID")
    env = str(raw.get("client_secret_env") or "MS_GRAPH_CLIENT_SECRET")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", env):
        raise AgentError("[connectors.microsoft] client_secret_env must be the name of a value in .env")
    return {"tenant_id": str(raw["tenant_id"]), "client_id": str(raw["client_id"]), "secret_env": env,
            # only for the agent's own tests: where Microsoft's login and Graph are
            "login_url": test_endpoint(raw, "login_url", "https://login.microsoftonline.com"),
            "graph_url": test_endpoint(raw, "graph_url", "https://graph.microsoft.com")}


def parse_google(raw: dict) -> dict | None:
    """[connectors.google]: the service account key file used to read Google Sheets shared with it."""
    if not raw:
        return None
    key_file = str(raw.get("key_file") or "")
    if not key_file:
        raise AgentError("[connectors.google] key_file must be the path of the service account's JSON key")
    return {"key_file": key_file, "sheets_url": test_endpoint(raw, "sheets_url", "https://sheets.googleapis.com")}


def test_endpoint(raw: dict, key: str, default: str) -> str:
    """Microsoft and Google addresses are fixed; only the agent's own tests may point them at this machine."""
    value = str(raw.get(key) or default).rstrip("/")
    if value != default and not re.fullmatch(r"http://(127\.0\.0\.1|localhost):\d+", value):
        raise AgentError(f"{key} can only be changed for local tests")
    return value


def parse_connector_config(raw: dict) -> dict:
    """[connectors]: what web and folder connectors created in the app are allowed to do.
    Nothing is allowed unless it is listed here."""
    hosts = raw.get("allow_hosts") or []
    if not isinstance(hosts, list) or not all(isinstance(h, str) and re.fullmatch(r"[a-z0-9.-]+(:\d+)?", h.lower()) for h in hosts):
        raise AgentError("[connectors] allow_hosts must be a list of host names, e.g. [\"api.example.com\"]")
    folders = raw.get("folders") or {}
    if not isinstance(folders, dict):
        raise AgentError("[connectors.folders] must map a name to a folder path")
    for name, path in folders.items():
        if not NAME_RE.match(name) or not isinstance(path, str) or not path:
            raise AgentError(f"[connectors.folders] '{name}': names are lower case letters, digits and _; values are folder paths")
    secrets = raw.get("secrets") or {}
    if not isinstance(secrets, dict):
        raise AgentError("[connectors.secrets] must map a .env name to the one host it may be sent to")
    for name, host in secrets.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or not isinstance(host, str) or host.lower() not in [h.lower() for h in hosts]:
            raise AgentError(f"[connectors.secrets] {name}: the host must be one of allow_hosts")
    return {
        "allow_hosts": sorted({h.lower() for h in hosts}),
        "folders": {n: str(p) for n, p in folders.items()},
        "secrets": {n: h.lower() for n, h in secrets.items()},
        "sharepoint": parse_sharepoint_locations(raw.get("sharepoint") or {}),
        "microsoft": parse_microsoft(raw.get("microsoft") or {}),
        "google": parse_google(raw.get("google") or {}),
        "max_bytes": int(raw.get("max_mb", 50)) * 1024 * 1024,
        "max_rows": int(raw.get("max_rows", 1_000_000)),
        "timeout_seconds": int(raw.get("timeout_seconds", 60)),
    }


# =============================================================================
# SQL helpers
# =============================================================================

def sanitize_identifier(name: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", str(name or "")).strip("_").lower()
    if not s:
        s = "col"
    if s[0].isdigit():
        s = "c_" + s
    return s[:63]


def unique_column_names(raw: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for i, name in enumerate(raw):
        base = sanitize_identifier(name) if name else f"col_{i + 1}"
        if base == LOADED_AT_COLUMN.strip("_"):
            base += "_src"
        cand, n = base, 2
        while cand in seen:
            suffix = f"_{n}"
            cand = base[: 63 - len(suffix)] + suffix
            n += 1
        seen.add(cand)
        out.append(cand)
    return out


_STRIP_RE = re.compile(
    r"--[^\n]*|/\*.*?\*/|'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|\[[^\]]*\]|`[^`]*`",
    re.S,
)
_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|into|call"
    r"|openrowset|opendatasource|openquery|openxml|bulk|backup|restore|dbcc|reconfigure|shutdown|kill|waitfor"
    r"|xp_\w+|sp_\w+|dbms_\w+|utl_\w+|pg_read\w*|pg_sleep\w*|pg_terminate_backend|lo_import|lo_export"
    r"|load_file|outfile|dumpfile|copy|set|declare|begin|commit|rollback)\b"
    r"|\bfor\s+update\b",
    re.I,
)


def check_read_only(query: str) -> None:
    """Safety net: one plain SELECT. The real protection is a read-only database user."""
    stripped = _STRIP_RE.sub(" ", query).strip().rstrip(";").strip()
    if not stripped:
        raise AgentError("The query is empty")
    if stripped.split(None, 1)[0].lower() not in ("select", "with"):
        raise AgentError("Only SELECT (or WITH ... SELECT) queries are allowed")
    if ";" in stripped:
        raise AgentError("Only one statement is allowed per query")
    bad = _FORBIDDEN.search(stripped)
    if bad:
        raise AgentError(f"The query contains '{bad.group(0).upper()}', which is not allowed in a read-only load")


def parse_watermark(value: str, wtype: str) -> Any:
    try:
        if wtype == "timestamp":
            return dt.datetime.fromisoformat(value)
        if wtype == "date":
            return dt.date.fromisoformat(value[:10])
        if wtype == "integer":
            return int(value)
        if wtype == "numeric":
            return decimal.Decimal(value)
        return value
    except (ValueError, decimal.InvalidOperation) as e:
        raise AgentError(f"Watermark '{value}' is not a valid {wtype}") from e


def format_watermark(value: Any) -> str:
    if isinstance(value, dt.datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    return str(value)


def prepare_source_query(query: str, wtype: str | None, watermark: str | None) -> tuple[str, list]:
    count = query.count(PLACEHOLDER)
    if count == 0:
        return query, []
    if not wtype:
        raise AgentError("The query uses {{watermark}} but no watermark type is set")
    value = parse_watermark(watermark if watermark is not None else DEFAULT_WATERMARKS[wtype], wtype)
    return query.replace(PLACEHOLDER, "?"), [value] * count


def to_json_value(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if v == v and v not in (float("inf"), float("-inf")) else str(v)
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return f"<{len(v)} bytes>"
    return str(v)


def short_error(e: BaseException, limit: int = 4000) -> str:
    msg = str(e).strip() or e.__class__.__name__
    if isinstance(e, pyodbc.Error) and len(e.args) >= 2:
        msg = str(e.args[1])
    return redact(msg)[:limit]


# =============================================================================
# tables.toml
# =============================================================================

TABLE_KEYS = {"description", "source", "group", "sql", "mode", "keys", "incremental_column",
              "watermark_type", "initial_watermark", "interval_minutes"}
GROUP_KEYS = {"description", "interval_minutes"}


@dataclass
class TableDef:
    name: str
    sql: str
    source: str
    mode: str = "full"
    description: str | None = None
    group: str | None = None
    keys: list[str] = field(default_factory=list)
    incremental_column: str | None = None
    watermark_type: str | None = None
    initial_watermark: str | None = None
    interval_minutes: int | None = None

    @property
    def sha256(self) -> str:
        """Fingerprint of everything that decides what is read and how it is stored."""
        canonical = json.dumps({
            "source": self.source,
            "sql": "\n".join(line.rstrip() for line in self.sql.strip().splitlines()),
            "mode": self.mode,
            "keys": self.keys,
            "incremental_column": self.incremental_column,
            "watermark_type": self.watermark_type,
            "initial_watermark": self.initial_watermark,
        }, sort_keys=True)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @property
    def incremental(self) -> bool:
        return self.incremental_column is not None


@dataclass
class GroupDef:
    name: str
    description: str | None = None
    interval_minutes: int | None = None


@dataclass
class TablesFile:
    path: str
    tables: dict[str, TableDef]
    groups: dict[str, GroupDef]
    mtime: float = 0.0

    def group_tables(self, group: str) -> list[TableDef]:
        return [t for t in self.tables.values() if t.group == group]


def _interval(value: Any, where: str, errors: list[str]) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        errors.append(f"{where}: interval_minutes must be a whole number of at least 1")
        return None
    return value


def load_tables(path: str, cfg: dict) -> TablesFile:
    p = Path(path)
    if not p.exists():
        raise AgentError(f"Tables file not found: {p}")
    try:
        with open(p, "rb") as f:
            raw = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise AgentError(f"{p.name} is not valid TOML: {e}") from e

    errors: list[str] = []
    unknown_top = set(raw) - {"defaults", "groups", "tables"}
    if unknown_top:
        errors.append(f"Unknown section(s): {', '.join(sorted(unknown_top))} (expected defaults, groups, tables)")
    defaults = raw.get("defaults", {})
    bad_defaults = set(defaults) - {"source", "mode"}
    if bad_defaults:
        errors.append(f"[defaults]: unknown setting(s) {', '.join(sorted(bad_defaults))} (allowed: source, mode)")

    groups: dict[str, GroupDef] = {}
    for gname, g in (raw.get("groups") or {}).items():
        where = f"[groups.{gname}]"
        if not NAME_RE.match(gname):
            errors.append(f"{where}: name must be lower case letters, digits and _ (max 63), starting with a letter")
        unknown = set(g) - GROUP_KEYS
        if unknown:
            errors.append(f"{where}: unknown setting(s) {', '.join(sorted(unknown))}")
        groups[gname] = GroupDef(gname, g.get("description"), _interval(g.get("interval_minutes"), where, errors))

    tables: dict[str, TableDef] = {}
    for tname, t in (raw.get("tables") or {}).items():
        where = f"[tables.{tname}]"
        if not NAME_RE.match(tname):
            errors.append(f"{where}: name must be lower case letters, digits and _ (max 63), starting with a letter")
        unknown = set(t) - TABLE_KEYS
        if unknown:
            errors.append(f"{where}: unknown setting(s) {', '.join(sorted(unknown))}")
        query = t.get("sql")
        if not isinstance(query, str) or not query.strip():
            errors.append(f"{where}: 'sql' is required")
            continue
        source = t.get("source", defaults.get("source"))
        mode = t.get("mode", defaults.get("mode", "full"))
        keys = t.get("keys", [])
        if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
            errors.append(f"{where}: keys must be a list of column names, e.g. keys = [\"invoice_no\"]")
            keys = []
        td = TableDef(
            name=tname,
            sql=query.strip(),
            source=source,
            mode=mode,
            description=t.get("description"),
            group=t.get("group"),
            keys=[sanitize_identifier(k) for k in keys],
            incremental_column=sanitize_identifier(t["incremental_column"]) if t.get("incremental_column") else None,
            watermark_type=t.get("watermark_type"),
            initial_watermark=str(t["initial_watermark"]) if t.get("initial_watermark") is not None else None,
            interval_minutes=_interval(t.get("interval_minutes"), where, errors),
        )
        if not source:
            errors.append(f"{where}: no source (set source = \"...\" here or in [defaults])")
        elif source not in cfg["sources"]:
            errors.append(f"{where}: source '{source}' is not in config.toml (have: {', '.join(cfg['sources'])})")
        if mode not in ("full", "append", "upsert"):
            errors.append(f"{where}: mode must be full, append or upsert")
        if mode == "upsert" and not td.keys:
            errors.append(f"{where}: upsert needs keys = [\"...\"]")
        if td.group is not None:
            if td.group not in groups:
                errors.append(f"{where}: group '{td.group}' is not defined under [groups]")
            if td.interval_minutes is not None:
                errors.append(f"{where}: a table in a group uses the group's schedule; remove interval_minutes")
        has_placeholder = PLACEHOLDER in td.sql
        if td.incremental:
            if mode == "full":
                errors.append(f"{where}: incremental loads need mode = \"upsert\" or \"append\"")
            if not has_placeholder:
                errors.append(f"{where}: incremental loads need {PLACEHOLDER} in the sql, "
                              f"e.g. WHERE ModifiedDate >= {PLACEHOLDER}")
            if td.watermark_type not in DEFAULT_WATERMARKS:
                errors.append(f"{where}: watermark_type must be one of {', '.join(DEFAULT_WATERMARKS)}")
            elif td.initial_watermark is not None:
                try:
                    parse_watermark(td.initial_watermark, td.watermark_type)
                except AgentError as e:
                    errors.append(f"{where}: initial_watermark: {e}")
        else:
            if has_placeholder:
                errors.append(f"{where}: sql contains {PLACEHOLDER} but incremental_column is not set")
            if td.watermark_type or td.initial_watermark:
                errors.append(f"{where}: watermark settings need incremental_column")
        if source in cfg["sources"] and cfg["sources"][source]["read_only_guard"]:
            try:
                check_read_only(td.sql.replace(PLACEHOLDER, "0"))
            except AgentError as e:
                errors.append(f"{where}: {e}")
        tables[tname] = td

    for g in groups.values():
        if not any(t.group == g.name for t in tables.values()):
            errors.append(f"[groups.{g.name}]: has no tables (add group = \"{g.name}\" to some tables, or remove it)")
    clash = set(groups) & set(tables)
    if clash:
        errors.append(f"Names used for both a group and a table: {', '.join(sorted(clash))}")

    if errors:
        raise AgentError(f"{p.name} has {len(errors)} problem(s):\n  - " + "\n  - ".join(errors))
    return TablesFile(str(p), tables, groups, p.stat().st_mtime)


# =============================================================================
# Source (ODBC) side
# =============================================================================

class Source:
    def __init__(self, name: str, cfg: dict):
        self.name = name
        self.cfg = cfg

    def connect(self) -> pyodbc.Connection:
        try:
            conn = pyodbc.connect(self.cfg["odbc"], autocommit=True, timeout=int(self.cfg["login_timeout_seconds"]))
        except pyodbc.Error as e:
            raise AgentError(f"Could not connect to source '{self.name}': {short_error(e)}") from e
        if self.cfg["query_timeout_seconds"]:
            conn.timeout = int(self.cfg["query_timeout_seconds"])
        iso = self.cfg["isolation"]
        if iso != "default":
            level = pyodbc.SQL_TXN_READ_UNCOMMITTED if iso == "read_uncommitted" else pyodbc.SQL_TXN_READ_COMMITTED
            try:
                conn.set_attr(pyodbc.SQL_ATTR_TXN_ISOLATION, level)
            except pyodbc.Error as e:
                log.debug("Source '%s' does not support setting isolation: %s", self.name, short_error(e))
        return conn

    def execute(self, conn: pyodbc.Connection, query: str, params: list) -> pyodbc.Cursor:
        if self.cfg["read_only_guard"]:
            check_read_only(query.replace("?", " 0 "))
        cur = conn.cursor()
        try:
            cur.execute(query, params) if params else cur.execute(query)
        except pyodbc.Error as e:
            raise AgentError(f"Source query failed: {short_error(e)}") from e
        if cur.description is None:
            raise AgentError("The query did not return any columns")
        return cur

    def clean_row(self, row) -> list:
        rstrip = self.cfg["rstrip_strings"]
        out = []
        for v in row:
            if isinstance(v, str):
                if "\x00" in v:
                    v = v.replace("\x00", "")
                if rstrip:
                    v = v.rstrip()
            out.append(v)
        return out


def describe_columns(cur: pyodbc.Cursor, sample: list[list]) -> list[dict]:
    raw_names = [d[0] for d in cur.description]
    names = unique_column_names(raw_names)
    cols = []
    for i, d in enumerate(cur.description):
        pg_type = PY_TO_PG.get(d[1]) if isinstance(d[1], type) else None
        if pg_type is None:
            value = next((r[i] for r in sample if r[i] is not None), None)
            pg_type = PY_TO_PG.get(type(value), "text")
        cols.append({"name": names[i], "source_name": raw_names[i], "type": pg_type})
    return cols


# =============================================================================
# Supabase (Postgres) side
# =============================================================================

def pg_connect(cfg: dict) -> psycopg.Connection:
    conn = psycopg.connect(
        cfg["supabase"]["db_url"],
        autocommit=True,
        prepare_threshold=None,
        row_factory=dict_row,
        application_name=f"impala-bi-agent/{VERSION}",
        connect_timeout=30,
    )
    conn.execute("set statement_timeout = 0")
    conn.execute("set idle_in_transaction_session_timeout = 0")
    conn.execute("set search_path = ''")
    return conn


class Warehouse:
    """Two connections: `main` for loads (long transactions) and `ddl` for short schema changes,
    so table changes are committed immediately and never hold locks for the length of a load."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._main: psycopg.Connection | None = None
        self._ddl: psycopg.Connection | None = None

    @staticmethod
    def _ok(c: psycopg.Connection | None) -> bool:
        return c is not None and not c.closed and not c.broken

    @property
    def main(self) -> psycopg.Connection:
        if not self._ok(self._main):
            log.info("Connecting to Supabase...")
            self._main = pg_connect(self.cfg)
        return self._main

    @property
    def ddl(self) -> psycopg.Connection:
        if not self._ok(self._ddl):
            self._ddl = pg_connect(self.cfg)
        return self._ddl

    def close(self) -> None:
        for c in (self._main, self._ddl):
            if c is not None:
                try:
                    c.close()
                except Exception:
                    pass
        self._main = self._ddl = None

    def table_columns(self, table: str, conn: psycopg.Connection | None = None) -> dict[str, str]:
        rows = (conn or self.ddl).execute(
            """
            select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type
            from pg_catalog.pg_attribute a
            join pg_catalog.pg_class c on c.oid = a.attrelid
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where n.nspname = %s and c.relname = %s and a.attnum > 0 and not a.attisdropped
            order by a.attnum
            """,
            (DATA_SCHEMA, table),
        ).fetchall()
        return {r["name"]: r["type"] for r in rows}

    def ensure_table(self, table: str, cols: list[dict]) -> dict[str, str]:
        conn = self.ddl
        ident = sql.Identifier(DATA_SCHEMA, table)
        existing = self.table_columns(table)
        if not existing:
            defs = [sql.SQL("{} {}").format(sql.Identifier(c["name"]), sql.SQL(c["type"])) for c in cols]
            defs.append(sql.SQL("{} timestamptz not null default pg_catalog.now()").format(
                sql.Identifier(LOADED_AT_COLUMN)))
            with conn.transaction():
                conn.execute(sql.SQL("create table {} ({})").format(ident, sql.SQL(", ").join(defs)))
                conn.execute(sql.SQL("revoke all on {} from public").format(ident))
                for role in self.cfg["agent"]["grant_select_to"]:
                    if conn.execute("select 1 from pg_catalog.pg_roles where rolname = %s", (role,)).fetchone():
                        conn.execute(sql.SQL("grant select on {} to {}").format(ident, sql.Identifier(role)))
            log.info("Created table %s.%s with %d columns", DATA_SCHEMA, table, len(cols))
            return self.table_columns(table)

        for c in cols:
            current = existing.get(c["name"])
            if current is None:
                conn.execute(sql.SQL("alter table {} add column {} {}").format(
                    ident, sql.Identifier(c["name"]), sql.SQL(c["type"])))
                log.info("Added column %s (%s) to %s", c["name"], c["type"], table)
            elif current != c["type"] and not current.startswith(c["type"] + "(") and current != "text":
                try:
                    conn.execute(sql.SQL("alter table {} alter column {} type {} using {}::{}").format(
                        ident, sql.Identifier(c["name"]), sql.SQL(c["type"]),
                        sql.Identifier(c["name"]), sql.SQL(c["type"])))
                    log.info("Changed column %s of %s from %s to %s", c["name"], table, current, c["type"])
                except psycopg.Error as e:
                    raise AgentError(
                        f"Column '{c['name']}' of {table} changed type from {current} to {c['type']} and could not "
                        f"be converted ({short_error(e)}). Cast it in the query to keep the old type."
                    ) from e
        return self.table_columns(table)

    def ensure_key_index(self, table: str, keys: list[str]) -> None:
        conn = self.ddl
        index = f"{table[:50]}_bi_key"
        row = conn.execute(
            """
            select array_agg(a.attname::text order by k.ord) as cols
            from pg_catalog.pg_class i
            join pg_catalog.pg_namespace n on n.oid = i.relnamespace
            join pg_catalog.pg_index x on x.indexrelid = i.oid
            cross join lateral unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
            join pg_catalog.pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum
            where n.nspname = %s and i.relname = %s
            """,
            (DATA_SCHEMA, index),
        ).fetchone()
        current = row["cols"] if row else None
        if current == keys:
            return
        if current is not None:
            conn.execute(sql.SQL("drop index {}").format(sql.Identifier(DATA_SCHEMA, index)))
        try:
            conn.execute(sql.SQL("create unique index {} on {} ({})").format(
                sql.Identifier(index), sql.Identifier(DATA_SCHEMA, table),
                sql.SQL(", ").join(map(sql.Identifier, keys))))
        except psycopg.Error as e:
            raise AgentError(f"Could not create a unique key on {table} ({', '.join(keys)}): {short_error(e)}. "
                             f"The existing data has duplicates for this key; run a full reload.") from e


# =============================================================================
# Connectors: web APIs and folders (data that does not come from the ERP)
# =============================================================================

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def connector_url(url: str, ccfg: dict) -> urllib.parse.SplitResult:
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower() + (f":{parts.port}" if parts.port else "")
    if parts.scheme not in ("http", "https"):
        raise AgentError("Only http and https web addresses can be fetched")
    if host not in ccfg["allow_hosts"] and (parts.hostname or "").lower() not in ccfg["allow_hosts"]:
        raise AgentError(f"Host '{host}' is not in [connectors] allow_hosts in this agent's config.toml")
    return parts


def connector_headers(headers: list, host: str, ccfg: dict) -> dict:
    out: dict[str, str] = {}
    for h in headers or []:
        name, value = str(h.get("name", "")), str(h.get("value", ""))
        if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", name):
            raise AgentError(f"Invalid header name '{name}'")

        def repl(m: re.Match) -> str:
            key = m.group(1)
            allowed = ccfg["secrets"].get(key)
            if allowed is None:
                raise AgentError(f"${{{key}}} is not in [connectors.secrets] in this agent's config.toml")
            if allowed not in (host, host.split(":")[0]):
                raise AgentError(f"${{{key}}} may only be sent to {allowed}, not {host}")
            if key not in os.environ:
                raise AgentError(f"${{{key}}} is not set in this agent's .env")
            remember_secret(os.environ[key])
            return os.environ[key]
        out[name] = _ENV_RE.sub(repl, value)
    return out


def fetch_web(cfg_c: dict, ccfg: dict) -> bytes:
    parts = connector_url(cfg_c.get("url", ""), ccfg)
    host = (parts.hostname or "").lower() + (f":{parts.port}" if parts.port else "")
    req = urllib.request.Request(urllib.parse.urlunsplit(parts), method="GET",
                                 headers={"User-Agent": f"impala-bi-agent/{VERSION}", "Accept": "application/json, text/csv, */*",
                                          **connector_headers(cfg_c.get("headers") or [], host, ccfg)})
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(req, timeout=ccfg["timeout_seconds"]) as resp:
            data = resp.read(ccfg["max_bytes"] + 1)
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise AgentError(f"The web address redirects ({e.code}) to {e.headers.get('Location')}; use the final address "
                             f"(redirects are not followed, so the agent never leaves the allowed hosts)") from None
        raise AgentError(f"The web address answered {e.code} {e.reason}") from None
    except urllib.error.URLError as e:
        raise AgentError(f"Could not reach {host}: {e.reason}") from None
    if len(data) > ccfg["max_bytes"]:
        raise AgentError(f"The response is larger than {ccfg['max_bytes'] // (1024 * 1024)} MB ([connectors] max_mb)")
    return data


def json_records(data: Any, path: str) -> list[dict]:
    for part in [p for p in (path or "").split(".") if p]:
        if isinstance(data, dict) and part in data:
            data = data[part]
        elif isinstance(data, list) and part.isdigit() and int(part) < len(data):
            data = data[int(part)]
        else:
            raise AgentError(f"The records path '{path}' was not found in the response (stopped at '{part}')")
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        raise AgentError("The records path must lead to a list of records")
    out = []
    for item in data:
        if not isinstance(item, dict):
            item = {"value": item}
        flat: dict[str, Any] = {}
        for k, v in item.items():
            if isinstance(v, dict):
                for k2, v2 in v.items():
                    flat[f"{k}_{k2}"] = json.dumps(v2) if isinstance(v2, (dict, list)) else v2
            elif isinstance(v, list):
                flat[k] = json.dumps(v)
            else:
                flat[k] = v
        out.append(flat)
    return out


def csv_records(raw: bytes) -> list[dict]:
    for enc in ("utf-8-sig", "cp1252"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    sample = text[:4096]
    delimiter = ";" if sample.count(";") > sample.count(",") else "\t" if sample.count("\t") > sample.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        return []
    header = rows[0]
    return [{header[i] if i < len(header) else f"col_{i + 1}": (v if v != "" else None) for i, v in enumerate(r)} for r in rows[1:]]


def xlsx_records(path: Path | io.BytesIO, sheet: str, label: str = "") -> list[dict]:
    try:
        import openpyxl  # optional: only needed for Excel files
    except ImportError:
        raise AgentError("Reading Excel files needs openpyxl: run  pip install openpyxl") from None
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        if sheet and sheet not in wb.sheetnames:
            raise AgentError(f"Sheet '{sheet}' is not in {label or getattr(path, 'name', 'the file')} (sheets: {', '.join(wb.sheetnames)})")
        ws = wb[sheet] if sheet else wb.worksheets[0]
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
    finally:
        wb.close()
    rows = [r for r in rows if any(v not in (None, "") for v in r)]
    if not rows:
        return []
    header = [str(h) if h not in (None, "") else f"col_{i + 1}" for i, h in enumerate(rows[0])]
    return [{header[i] if i < len(header) else f"col_{i + 1}": v for i, v in enumerate(r)} for r in rows[1:]]


def folder_files(cfg_c: dict, ccfg: dict) -> list[Path]:
    alias = cfg_c.get("folder", "")
    if alias not in ccfg["folders"]:
        raise AgentError(f"Folder '{alias}' is not in [connectors.folders] in this agent's config.toml")
    pattern = str(cfg_c.get("pattern", ""))
    if not re.fullmatch(r"[A-Za-z0-9 _.*?()-]{1,100}", pattern) or ".." in pattern:
        raise AgentError("Invalid file pattern")
    folder = Path(ccfg["folders"][alias])
    if not folder.is_dir():
        raise AgentError(f"Folder '{alias}' ({folder}) does not exist or cannot be read")
    files = [p for p in folder.iterdir() if p.is_file() and fnmatch.fnmatch(p.name.lower(), pattern.lower())
             and p.suffix.lower() in (".csv", ".txt", ".xlsx", ".xlsm") and not p.name.startswith("~$")]
    if not files:
        raise AgentError(f"No files match '{pattern}' in folder '{alias}'")
    files.sort(key=lambda p: (p.stat().st_mtime, p.name))
    return files if cfg_c.get("combine") == "all" else files[-1:]


def read_folder(cfg_c: dict, ccfg: dict) -> list[dict]:
    out: list[dict] = []
    files = folder_files(cfg_c, ccfg)
    for f in files:
        if f.stat().st_size > ccfg["max_bytes"]:
            raise AgentError(f"{f.name} is larger than {ccfg['max_bytes'] // (1024 * 1024)} MB ([connectors] max_mb)")
        recs = xlsx_records(f, str(cfg_c.get("sheet") or "")) if f.suffix.lower() in (".xlsx", ".xlsm") else csv_records(f.read_bytes())
        if len(files) > 1:
            for r in recs:
                r["source_file"] = f.name
        out.extend(recs)
    return out


# --- SharePoint / OneDrive (Microsoft Graph) ------------------------------------------

_TOKENS: dict[str, tuple[str, float]] = {}


def http_call(url: str, ccfg: dict, what: str, *, data: bytes | None = None, headers: dict | None = None,
              max_bytes: int | None = None) -> bytes:
    """One HTTPS request without following redirects, with the connector size and time limits."""
    limit = max_bytes or ccfg["max_bytes"]
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET",
                                 headers={"User-Agent": f"impala-bi-agent/{VERSION}", **(headers or {})})
    try:
        with urllib.request.build_opener(_NoRedirect()).open(req, timeout=ccfg["timeout_seconds"]) as resp:
            body = resp.read(limit + 1)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            err = json.loads(e.read(20000).decode("utf-8", "replace"))
            detail = (err.get("error_description") or (err.get("error") or {}).get("message") if isinstance(err.get("error"), dict)
                      else err.get("error_description") or err.get("error") or "")
        except Exception:
            pass
        raise AgentError(f"{what} answered {e.code} {e.reason}{': ' + str(detail)[:300] if detail else ''}") from None
    except urllib.error.URLError as e:
        raise AgentError(f"Could not reach {what}: {e.reason}") from None
    if len(body) > limit:
        raise AgentError(f"The file from {what} is larger than {limit // (1024 * 1024)} MB ([connectors] max_mb)")
    return body


def graph_token(ms: dict, ccfg: dict) -> str:
    key = f"ms:{ms['tenant_id']}:{ms['client_id']}"
    cached = _TOKENS.get(key)
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    secret = os.environ.get(ms["secret_env"])
    if not secret:
        raise AgentError(f"{ms['secret_env']} (the app registration's client secret) is not set in this agent's .env")
    remember_secret(secret)
    body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": ms["client_id"], "client_secret": secret,
                                   "scope": "https://graph.microsoft.com/.default"}).encode()
    resp = json.loads(http_call(f"{ms['login_url']}/{urllib.parse.quote(ms['tenant_id'])}/oauth2/v2.0/token", ccfg,
                                "Microsoft sign-in", data=body, headers={"Content-Type": "application/x-www-form-urlencoded"},
                                max_bytes=1024 * 1024))
    token = resp.get("access_token")
    if not token:
        raise AgentError("Microsoft sign-in returned no access token")
    remember_secret(token)
    _TOKENS[key] = (token, time.time() + int(resp.get("expires_in", 3600)))
    return token


def graph_json(path_or_url: str, ms: dict, ccfg: dict) -> dict:
    url = path_or_url if path_or_url.startswith(ms["graph_url"] + "/") else f"{ms['graph_url']}/v1.0{path_or_url}"
    if not url.startswith(ms["graph_url"] + "/"):
        raise AgentError("Microsoft Graph returned a link to another host")
    return json.loads(http_call(url, ccfg, "Microsoft Graph", headers={"Authorization": f"Bearer {graph_token(ms, ccfg)}",
                                                                     "Accept": "application/json"}, max_bytes=20 * 1024 * 1024))


def graph_drive(loc: dict, ms: dict, ccfg: dict) -> str:
    """The Graph path of the location's document library or OneDrive."""
    q = urllib.parse.quote
    if loc["onedrive"]:
        return f"/users/{q(loc['onedrive'])}/drive"
    host, site_path = loc["site"].split(":", 1)
    site = graph_json(f"/sites/{q(host)}:{q(site_path)}", ms, ccfg)
    if not loc["library"]:
        return f"/sites/{q(site['id'])}/drive"
    drives = graph_json(f"/sites/{q(site['id'])}/drives?$select=id,name", ms, ccfg).get("value", [])
    for d in drives:
        if d.get("name", "").lower() == loc["library"].lower():
            return f"/drives/{q(d['id'])}"
    raise AgentError(f"The site has no library '{loc['library']}' (libraries: {', '.join(d.get('name', '') for d in drives)})")


def graph_download(item: dict, ms: dict, ccfg: dict) -> bytes:
    url = item.get("@microsoft.graph.downloadUrl") or ""
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    graph_host = (urllib.parse.urlsplit(ms["graph_url"]).hostname or "").lower()
    if not (host.endswith(".sharepoint.com") or host == graph_host) or not url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
        raise AgentError(f"Unexpected download location for {item.get('name')}")
    if int(item.get("size") or 0) > ccfg["max_bytes"]:
        raise AgentError(f"{item.get('name')} is larger than {ccfg['max_bytes'] // (1024 * 1024)} MB ([connectors] max_mb)")
    return http_call(url, ccfg, "SharePoint")  # pre-authorised, short-lived link: no token sent


def read_sharepoint(cfg_c: dict, ccfg: dict) -> list[dict]:
    ms = ccfg["microsoft"]
    if not ms:
        raise AgentError("This agent has no [connectors.microsoft] app registration in config.toml")
    alias = str(cfg_c.get("location") or "")
    loc = ccfg["sharepoint"].get(alias)
    if not loc:
        raise AgentError(f"Location '{alias}' is not in [connectors.sharepoint] in this agent's config.toml")
    rel = str(cfg_c.get("path") or "").strip("/")
    parts = rel.split("/")
    if not rel or ".." in parts or "\\" in rel or any(ch in "".join(parts[:-1]) for ch in "*?") \
            or not re.search(r"\.(xlsx|xlsm|csv|txt)$", parts[-1], re.I):
        raise AgentError("Invalid file path")
    folder = "/".join(p for p in [loc["folder"], *parts[:-1]] if p)
    drive = graph_drive(loc, ms, ccfg)
    q = urllib.parse.quote
    pattern = parts[-1]
    if any(ch in pattern for ch in "*?"):
        url = f"{drive}/root:/{q(folder)}:/children" if folder else f"{drive}/root/children"
        items: list[dict] = []
        while url and len(items) < 5000:
            page = graph_json(url + ("" if "?" in url else "?$top=500"), ms, ccfg)
            items += page.get("value", [])
            url = page.get("@odata.nextLink")
        files = [i for i in items if "file" in i and fnmatch.fnmatch(i.get("name", "").lower(), pattern.lower())
                 and not i.get("name", "").startswith("~$")]
        if not files:
            raise AgentError(f"No files match '{pattern}' in {alias}{'/' + folder if folder else ''}")
        files.sort(key=lambda i: (i.get("lastModifiedDateTime") or "", i.get("name") or ""))
        if cfg_c.get("combine") != "all":
            files = files[-1:]
    else:
        files = [graph_json(f"{drive}/root:/{q('/'.join(p for p in [folder, pattern] if p))}", ms, ccfg)]
    out: list[dict] = []
    for f in files:
        raw = graph_download(f, ms, ccfg)
        name = f.get("name", "")
        recs = (xlsx_records(io.BytesIO(raw), str(cfg_c.get("sheet") or ""), name)
                if name.lower().endswith((".xlsx", ".xlsm")) else csv_records(raw))
        if len(files) > 1:
            for r in recs:
                r["source_file"] = name
        out.extend(recs)
    return out


# --- Google Sheets (service account) ---------------------------------------------------

def google_key(g: dict) -> dict:
    try:
        key = json.loads(Path(g["key_file"]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise AgentError(f"Cannot read the Google key file {g['key_file']}: {e}") from None
    if key.get("type") != "service_account" or not key.get("client_email") or not key.get("private_key"):
        raise AgentError("The Google key file is not a service account key (JSON)")
    remember_secret(key["private_key"])
    return key


def google_account(g: dict | None) -> str | None:
    if not g:
        return None
    try:
        return google_key(g)["client_email"]
    except AgentError:
        return "key file missing"


def google_token(g: dict, ccfg: dict) -> str:
    key = google_key(g)
    cached = _TOKENS.get("g:" + key["client_email"])
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError:
        raise AgentError("Google Sheets needs the cryptography package: run  pip install cryptography") from None
    token_uri = key.get("token_uri") or "https://oauth2.googleapis.com/token"
    if not (token_uri == "https://oauth2.googleapis.com/token" or token_uri.startswith(g["sheets_url"] + "/")):
        raise AgentError("The key file's token_uri is not Google's")
    b64 = lambda b: __import__("base64").urlsafe_b64encode(b).rstrip(b"=")  # noqa: E731
    now = int(time.time())
    claims = {"iss": key["client_email"], "scope": "https://www.googleapis.com/auth/spreadsheets.readonly",
              "aud": token_uri, "iat": now, "exp": now + 3600}
    signing_input = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()) + b"." + b64(json.dumps(claims).encode())
    pk = serialization.load_pem_private_key(key["private_key"].encode(), password=None)
    assertion = signing_input + b"." + b64(pk.sign(signing_input, padding.PKCS1v15(), hashes.SHA256()))
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion.decode()}).encode()
    resp = json.loads(http_call(token_uri, ccfg, "Google sign-in", data=body,
                                headers={"Content-Type": "application/x-www-form-urlencoded"}, max_bytes=1024 * 1024))
    token = resp.get("access_token")
    if not token:
        raise AgentError("Google sign-in returned no access token")
    remember_secret(token)
    _TOKENS["g:" + key["client_email"]] = (token, time.time() + int(resp.get("expires_in", 3600)))
    return token


def read_gsheet(cfg_c: dict, ccfg: dict) -> list[dict]:
    g = ccfg["google"]
    if not g:
        raise AgentError("This agent has no [connectors.google] service account in config.toml")
    sid = str(cfg_c.get("spreadsheet_id") or "")
    tab, rng = str(cfg_c.get("sheet") or ""), str(cfg_c.get("range") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,100}", sid) or re.search(r"['!]", tab) or not re.fullmatch(r"([A-Z]{1,3}\d{0,7}:[A-Z]{1,3}\d{0,7})?", rng):
        raise AgentError("Invalid spreadsheet, tab or range")
    base = f"{g['sheets_url']}/v4/spreadsheets/{sid}"
    auth = {"Authorization": f"Bearer {google_token(g, ccfg)}", "Accept": "application/json"}
    try:
        if not tab:
            meta = json.loads(http_call(base + "?fields=sheets.properties.title", ccfg, "Google Sheets", headers=auth))
            tab = meta["sheets"][0]["properties"]["title"]
        a1 = f"'{tab}'" + (f"!{rng}" if rng else "")
        data = json.loads(http_call(f"{base}/values/{urllib.parse.quote(a1)}?valueRenderOption=UNFORMATTED_VALUE"
                                    f"&dateTimeRenderOption=FORMATTED_STRING&majorDimension=ROWS", ccfg, "Google Sheets", headers=auth))
    except AgentError as e:
        if " 403 " in str(e) or " 404 " in str(e):
            raise AgentError(f"{e}. Share the sheet (Viewer) with {google_key(g)['client_email']}") from None
        raise
    rows = [r for r in data.get("values", []) if any(v not in (None, "") for v in r)]
    if not rows:
        return []
    header = [str(h).strip() if h not in (None, "") else f"col_{i + 1}" for i, h in enumerate(rows[0])]
    width = max(len(header), *(len(r) for r in rows[1:])) if len(rows) > 1 else len(header)
    header += [f"col_{i + 1}" for i in range(len(header), width)]
    return [{header[i]: (r[i] if i < len(r) and r[i] != "" else None) for i in range(width)} for r in rows[1:]]


_INT_RE = re.compile(r"^-?\d{1,18}$")
_NUM_RE = re.compile(r"^-?\d+([.,]\d+)?$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")


def infer_records(records: list[dict]) -> tuple[list[dict], list[list]]:
    """Columns (name, pg type) and rows for records from JSON, CSV or Excel."""
    raw_names: list[str] = []
    for r in records:
        for k in r:
            if k not in raw_names:
                raw_names.append(k)
    names = unique_column_names([str(n) for n in raw_names])
    types: list[str] = []
    for key in raw_names:
        vals = [r.get(key) for r in records if r.get(key) not in (None, "")]
        def all_(pred):
            return bool(vals) and all(pred(v) for v in vals)
        if all_(lambda v: isinstance(v, bool)):
            t = "boolean"
        elif all_(lambda v: (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, str) and _INT_RE.match(v.strip()))):
            t = "bigint"
        elif all_(lambda v: (isinstance(v, (int, float, decimal.Decimal)) and not isinstance(v, bool)) or (isinstance(v, str) and _NUM_RE.match(v.strip()))):
            t = "numeric"
        elif all_(lambda v: isinstance(v, dt.datetime) and v.time() == dt.time(0) and v.tzinfo is None):
            t = "date"   # Excel stores dates as date-times at midnight
        elif all_(lambda v: isinstance(v, dt.datetime) or (isinstance(v, str) and _TS_RE.match(v.strip()))):
            t = "timestamp without time zone" if not any(isinstance(v, str) and re.search(r"(Z|[+-]\d{2}:?\d{2})$", v.strip()) for v in vals) else "timestamp with time zone"
        elif all_(lambda v: (isinstance(v, dt.date) and not isinstance(v, dt.datetime)) or (isinstance(v, str) and _DATE_RE.match(v.strip()))):
            t = "date"
        else:
            t = "text"
        types.append(t)

    def conv(v: Any, t: str) -> Any:
        if v is None or v == "":
            return None
        if t == "text":
            return v.isoformat() if isinstance(v, (dt.date, dt.time)) else str(v)
        if t == "date" and isinstance(v, dt.datetime):
            return v.date()
        if t == "numeric" and isinstance(v, str):
            return v.strip().replace(",", ".")
        if isinstance(v, str):
            return v.strip()
        return v
    rows = [[conv(r.get(k), t) for k, t in zip(raw_names, types)] for r in records]
    return [{"name": n, "source_name": str(k), "type": t} for n, k, t in zip(names, raw_names, types)], rows


# =============================================================================
# Plan / apply
# =============================================================================

@dataclass
class Change:
    kind: str          # add | change | remove
    object_type: str   # group | table
    name: str
    details: list[str]
    reload: str | None = None   # None | "load" | "full"


def actor(agent_name: str) -> str:
    try:
        user = getpass.getuser()
    except Exception:
        user = "unknown"
    return f"{user}@{socket.gethostname()} (agent {agent_name})"


def compute_plan(conn: psycopg.Connection, tf: TablesFile, agent_name: str) -> tuple[list[Change], list[str]]:
    """Compare tables.toml with what is in Supabase for this agent."""
    errors: list[str] = []
    db_groups = {r["name"]: r for r in conn.execute("select * from bi.load_groups").fetchall()}
    db_jobs = {r["target_table"]: r for r in conn.execute("select * from bi.load_jobs").fetchall()}
    counts = {r["table_name"]: r["row_count"] for r in conn.execute("select table_name, row_count from bi.data_tables").fetchall()}
    orphans = {r["t"] for r in conn.execute(
        "select c.relname as t from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace "
        "where n.nspname = %s and c.relkind = 'r'", (DATA_SCHEMA,)).fetchall()}

    for name, row in db_groups.items():
        if name in tf.groups and row["managed_by"] != agent_name:
            errors.append(f"Group '{name}' already belongs to agent '{row['managed_by']}'")
    for name, row in db_jobs.items():
        if name in tf.tables and row["managed_by"] != agent_name:
            errors.append(f"Table '{name}' already belongs to agent '{row['managed_by']}'")
    for name in tf.tables:
        if name not in db_jobs and name in orphans:
            errors.append(f"Table bi_data.{name} already exists but is not managed by any load job. "
                          f"Pick another name, or drop that table first.")
    if errors:
        return [], errors

    def sched(m: int | None) -> str:
        return f"every {m} min" if m else "manual only"

    changes: list[Change] = []
    for g in tf.groups.values():
        row = db_groups.get(g.name)
        members = ", ".join(t.name for t in tf.group_tables(g.name))
        if row is None:
            changes.append(Change("add", "group", g.name, [sched(g.interval_minutes), f"tables: {members}"]))
            continue
        d = []
        if row["interval_minutes"] != g.interval_minutes:
            d.append(f"schedule: {sched(row['interval_minutes'])} -> {sched(g.interval_minutes)}")
        if (row["description"] or None) != (g.description or None):
            d.append("description changed")
        if d:
            changes.append(Change("change", "group", g.name, d))

    for t in tf.tables.values():
        row = db_jobs.get(t.name)
        where = f"group {t.group}" if t.group else sched(t.interval_minutes)
        if row is None:
            changes.append(Change("add", "table", t.name, [f"{t.mode} from '{t.source}', {where}",
                                                           "loads on the agent's next cycle"], reload="load"))
            continue
        d = []
        reload = None
        differs = [label for label, a, b in [
            ("query", row["sql_query"].strip(), t.sql),
            ("source", row["source_name"], t.source),
            ("mode", row["load_mode"], t.mode),
            ("keys", list(row["key_columns"]), t.keys),
            ("incremental column", row["incremental_column"], t.incremental_column),
            ("watermark", (row["watermark_type"], row["initial_watermark"]), (t.watermark_type, t.initial_watermark)),
        ] if a != b]
        if row["definition_sha256"] != t.sha256:
            d.append(f"{', '.join(differs or ['definition'])} changed -> table is reloaded in full on the next cycle")
            reload = "full"
        elif differs:
            # fingerprint matches tables.toml but the stored copy doesn't: someone edited it outside the agent
            d.append(f"WARNING: {', '.join(differs)} in Supabase was modified outside tables.toml -> restored "
                     f"(the agent always ran the version in tables.toml)")
        if row["group_name"] != t.group:
            d.append(f"group: {row['group_name'] or '(none)'} -> {t.group or '(none)'}")
        if row["interval_minutes"] != t.interval_minutes:
            d.append(f"schedule: {sched(row['interval_minutes'])} -> {sched(t.interval_minutes)}")
        if (row["description"] or None) != (t.description or None):
            d.append("description changed")
        if d:
            changes.append(Change("change", "table", t.name, d, reload=reload))

    for name, row in db_jobs.items():
        if row["managed_by"] == agent_name and name not in tf.tables:
            n = counts.get(name)
            rows = f"{n:,} rows" if n is not None else "its data"
            changes.append(Change("remove", "table", name, [f"load job removed and bi_data.{name} with {rows} DELETED"]))
    for name, row in db_groups.items():
        if row["managed_by"] == agent_name and name not in tf.groups:
            changes.append(Change("remove", "group", name, ["group removed (its tables are not deleted by this)"]))
    return changes, []


def print_plan(changes: list[Change]) -> None:
    if not changes:
        print("Supabase is up to date with tables.toml. Nothing to apply.")
        return
    symbols = {"add": "+", "change": "~", "remove": "-"}
    print("Changes to apply:\n")
    for c in changes:
        print(f"  {symbols[c.kind]} {c.object_type:<5} {c.name}")
        for d in c.details:
            print(f"        {d}")
    adds = sum(c.kind == "add" for c in changes)
    chg = sum(c.kind == "change" for c in changes)
    rem = sum(c.kind == "remove" for c in changes)
    print(f"\n  {adds} to add, {chg} to change, {rem} to remove")


def apply_plan(conn: psycopg.Connection, tf: TablesFile, changes: list[Change], agent_name: str) -> None:
    who = actor(agent_name)
    removed_tables = [c.name for c in changes if c.kind == "remove" and c.object_type == "table"]
    removed_groups = [c.name for c in changes if c.kind == "remove" and c.object_type == "group"]
    with conn.transaction():
        # 1. groups first (tables reference them)
        for g in tf.groups.values():
            conn.execute(
                """
                insert into bi.load_groups (name, description, interval_minutes, managed_by, applied_at, applied_by)
                values (%s, %s, %s, %s, now(), %s)
                on conflict (name) do update set
                  description = excluded.description, interval_minutes = excluded.interval_minutes,
                  applied_at = case when bi.load_groups.description is distinct from excluded.description
                                      or bi.load_groups.interval_minutes is distinct from excluded.interval_minutes
                                    then now() else bi.load_groups.applied_at end,
                  applied_by = case when bi.load_groups.description is distinct from excluded.description
                                      or bi.load_groups.interval_minutes is distinct from excluded.interval_minutes
                                    then excluded.applied_by else bi.load_groups.applied_by end
                """,
                (g.name, g.description, g.interval_minutes, agent_name, who),
            )
        # 2. tables
        reload_by_name = {c.name: c.reload for c in changes if c.object_type == "table"}
        for t in tf.tables.values():
            if t.name not in reload_by_name:
                continue
            reload = reload_by_name[t.name]
            conn.execute(
                """
                insert into bi.load_jobs (target_table, description, source_name, group_name, sql_query,
                  definition_sha256, load_mode, key_columns, incremental_column, watermark_type,
                  initial_watermark, interval_minutes, managed_by, reload_requested, applied_at, applied_by)
                values (%(name)s, %(description)s, %(source)s, %(group)s, %(sql)s, %(sha)s, %(mode)s, %(keys)s,
                  %(inc)s, %(wtype)s, %(winit)s, %(interval)s, %(agent)s, true, now(), %(who)s)
                on conflict (target_table) do update set
                  description = excluded.description, source_name = excluded.source_name,
                  group_name = excluded.group_name, sql_query = excluded.sql_query,
                  definition_sha256 = excluded.definition_sha256, load_mode = excluded.load_mode,
                  key_columns = excluded.key_columns, incremental_column = excluded.incremental_column,
                  watermark_type = excluded.watermark_type, initial_watermark = excluded.initial_watermark,
                  interval_minutes = excluded.interval_minutes,
                  watermark = case when %(full)s then null else bi.load_jobs.watermark end,
                  full_reload_requested = bi.load_jobs.full_reload_requested or %(full)s,
                  reload_requested = bi.load_jobs.reload_requested,
                  applied_at = now(), applied_by = excluded.applied_by
                """,
                {"name": t.name, "description": t.description, "source": t.source, "group": t.group,
                 "sql": t.sql, "sha": t.sha256, "mode": t.mode, "keys": t.keys, "inc": t.incremental_column,
                 "wtype": t.watermark_type, "winit": t.initial_watermark, "interval": t.interval_minutes,
                 "agent": agent_name, "who": who, "full": reload == "full"},
            )
        # 3. removals: data table, catalogue entry, job
        for name in removed_tables:
            try:
                with conn.transaction():
                    conn.execute(sql.SQL("drop table if exists {}").format(sql.Identifier(DATA_SCHEMA, name)))
            except psycopg.errors.DependentObjectsStillExist as e:
                raise AgentError(f"Cannot remove table '{name}': other objects (e.g. report views) still use it. "
                                 f"Remove those first.\n{short_error(e)}") from e
            conn.execute("delete from bi.data_tables where table_name = %s", (name,))
            conn.execute("delete from bi.load_jobs where target_table = %s and managed_by = %s", (name, agent_name))
        for name in removed_groups:
            conn.execute("update bi.load_jobs set group_name = null where group_name = %s", (name,))
            conn.execute("delete from bi.load_groups where name = %s and managed_by = %s", (name, agent_name))
        # 4. audit trail
        for c in changes:
            conn.execute(
                "insert into bi.audit_log (actor, action, object_type, object_name, details) values (%s, %s, %s, %s, %s)",
                (who, c.kind, c.object_type, c.name, Jsonb({"details": c.details,
                    "definition_sha256": tf.tables[c.name].sha256 if c.object_type == "table" and c.name in tf.tables else None})),
            )


# =============================================================================
# Loading
# =============================================================================

@dataclass
class Staged:
    table: TableDef
    job: dict
    run_id: int
    stage: str
    names: list[str]
    total: int
    max_wm: Any
    start_wm: str | None


class Agent:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.name: str = cfg["agent"]["name"]
        self.sources = {n: Source(n, c) for n, c in cfg["sources"].items()}
        self.wh = Warehouse(cfg)
        self.stopping = False
        self.started_at = dt.datetime.now(dt.timezone.utc)
        self.tf: TablesFile | None = None
        self._tables_error: str | None = None
        self._last_heartbeat = 0.0
        self._last_cleanup = 0.0
        self._warned_drift: set[str] = set()

    # --- tables.toml (re-read whenever it changes) ------------------------------

    def refresh_tables(self) -> None:
        path = self.cfg["agent"]["tables_file"]
        try:
            mtime = Path(path).stat().st_mtime
        except OSError:
            mtime = -1
        if self.tf is not None and self.tf.mtime == mtime:
            return
        try:
            self.tf = load_tables(path, self.cfg)
            self._tables_error = None
            self._warned_drift.clear()
            log.info("Loaded %s: %d table(s), %d group(s)", Path(path).name, len(self.tf.tables), len(self.tf.groups))
        except AgentError as e:
            if str(e) != self._tables_error:
                log.error("%s\nKeeping the previous version until this is fixed.", e)
            self._tables_error = str(e)
            if self.tf is None:
                self.tf = TablesFile(path, {}, {}, mtime)
            else:
                self.tf.mtime = mtime

    # --- lifecycle ----------------------------------------------------------------

    def heartbeat(self, force: bool = False) -> None:
        if not force and time.monotonic() - self._last_heartbeat < self.cfg["agent"]["heartbeat_seconds"]:
            return
        allowed = {n: s.cfg["app_requests"] for n, s in self.sources.items()}
        c = self.cfg["connectors"]
        options = {"hosts": c["allow_hosts"], "folders": sorted(c["folders"]), "secrets": c["secrets"],
                   "sharepoint": {n: (f"OneDrive of {loc['onedrive']}" if loc["onedrive"] else loc["site"].split(":", 1)[1]
                                      + (f" · {loc['library']}" if loc["library"] else ""))
                                     + (f" / {loc['folder']}" if loc["folder"] else "") for n, loc in c["sharepoint"].items()},
                   "microsoft": c["microsoft"] is not None, "google": google_account(c["google"])}
        self.wh.main.execute(
            """
            insert into bi.agents (name, sources, app_requests, version, hostname, started_at, last_seen_at, connector_options)
            values (%s, %s, %s, %s, %s, %s, now(), %s)
            on conflict (name) do update set
              sources = excluded.sources, app_requests = excluded.app_requests, version = excluded.version,
              hostname = excluded.hostname, started_at = excluded.started_at, last_seen_at = now(),
              connector_options = excluded.connector_options
            """,
            (self.name, sorted(self.sources), Jsonb(allowed), VERSION, socket.gethostname(), self.started_at, Jsonb(options)),
        )
        self._last_heartbeat = time.monotonic()

    def recover_interrupted(self) -> None:
        conn = self.wh.main
        msg = "The agent stopped while this was running"
        with conn.transaction():
            runs = conn.execute(
                "update bi.sync_runs set status = 'error', error = %s, finished_at = now() "
                "where status = 'running' and agent_name = %s returning job_id, group_name",
                (msg, self.name)).fetchall()
            conn.execute(
                "update bi.load_jobs set last_status = 'error', last_error = %s "
                "where managed_by = %s and last_status = 'running'", (msg, self.name))
            conn.execute(
                "update bi.load_groups set last_status = 'error', last_error = %s "
                "where managed_by = %s and last_status = 'running'", (msg, self.name))
            conn.execute(
                "update bi.agent_requests set status = 'error', error = %s, completed_at = now() "
                "where status = 'running' and agent_name = %s", (msg, self.name))
            conn.execute(
                "update bi.connectors set last_status = 'error', last_error = %s "
                "where agent_name = %s and last_status = 'running'", (msg, self.name))
        if runs:
            log.warning("Marked %d interrupted run(s) as failed", len(runs))

    def cleanup(self) -> None:
        if time.monotonic() - self._last_cleanup < 6 * 3600:
            return
        a = self.cfg["agent"]
        conn = self.wh.main
        conn.execute("delete from bi.sync_runs where started_at < now() - make_interval(days => %s) "
                     "and status <> 'running'", (int(a["run_history_days"]),))
        conn.execute("delete from bi.agent_requests where created_at < now() - make_interval(days => %s)",
                     (int(a["request_history_days"]),))
        self._last_cleanup = time.monotonic()

    def run_forever(self) -> None:
        log.info("Impala BI agent %s starting as '%s' (sources: %s)", VERSION, self.name, ", ".join(sorted(self.sources)))
        for w in self.cfg.get("_warnings", []):
            log.warning(w)
        backoff = 5
        recovered = False
        while not self.stopping:
            try:
                self.refresh_tables()
                if not recovered:
                    self.recover_interrupted()
                    recovered = True
                self.heartbeat()
                worked = self.process_requests()
                worked = self.run_due() or worked
                self.cleanup()
                backoff = 5
                if not worked:
                    self._sleep(self.cfg["agent"]["poll_seconds"])
            except (psycopg.OperationalError, psycopg.InterfaceError) as e:
                log.error("Lost connection to Supabase: %s (retrying in %ss)", short_error(e), backoff)
                self.wh.close()
                self._sleep(backoff)
                backoff = min(backoff * 2, 300)
            except Exception:
                log.exception("Unexpected error (retrying in %ss)", backoff)
                self.wh.close()
                self._sleep(backoff)
                backoff = min(backoff * 2, 300)
        self.wh.close()
        log.info("Agent stopped")

    def run_once(self) -> None:
        self.refresh_tables()
        self.recover_interrupted()
        self.heartbeat(force=True)
        self.process_requests()
        while self.run_due():
            self.process_requests()
        self.cleanup()

    def _sleep(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while not self.stopping and time.monotonic() < end:
            time.sleep(max(0.0, min(0.5, end - time.monotonic())))

    # --- interactive requests from the app ------------------------------------------

    def process_requests(self) -> bool:
        worked = False
        while not self.stopping:
            conn = self.wh.main
            req = conn.execute(
                """
                update bi.agent_requests set status = 'running', started_at = now(), agent_name = %s
                where id = (
                  select id from bi.agent_requests
                  where status = 'pending' and source_name = any(%s)
                  order by created_at for update skip locked limit 1
                )
                returning id, kind, source_name, payload, created_by
                """,
                (self.name, list(self.sources))).fetchone()
            if not req:
                return worked
            worked = True
            source = self.sources[req["source_name"]]
            log.info("Request %s: %s on '%s' (user %s)", req["id"], req["kind"], req["source_name"], req["created_by"])
            try:
                if req["kind"] not in source.cfg["app_requests"]:
                    raise AgentError(f"'{req['kind']}' requests from the app are switched off for source "
                                     f"'{source.name}' (app_requests in the agent's config.toml)")
                result = self.handle_request(req["kind"], source, req["payload"] or {})
                conn.execute("update bi.agent_requests set status = 'done', result = %s, completed_at = now() "
                             "where id = %s", (Jsonb(result), req["id"]))
            except Exception as e:
                if isinstance(e, (AgentError, pyodbc.Error)):
                    log.warning("Request %s refused/failed: %s", req["id"], short_error(e))
                else:
                    log.exception("Request %s failed", req["id"])
                conn.execute("update bi.agent_requests set status = 'error', error = %s, completed_at = now() "
                             "where id = %s", (short_error(e), req["id"]))
        return worked

    def handle_request(self, kind: str, source: Source, payload: dict) -> dict:
        src = source.connect()
        try:
            if kind == "test_connection":
                return {"ok": True, "dbms": src.getinfo(pyodbc.SQL_DBMS_NAME),
                        "dbms_version": src.getinfo(pyodbc.SQL_DBMS_VER),
                        "driver": src.getinfo(pyodbc.SQL_DRIVER_NAME)}
            if kind == "list_tables":
                limit, tables = 5000, []
                for t in src.cursor().tables(schema=payload.get("schema") or None, table=payload.get("name_like") or None):
                    if t.table_type in ("TABLE", "VIEW", "SYNONYM"):
                        tables.append({"catalog": t.table_cat, "schema": t.table_schem, "name": t.table_name, "type": t.table_type})
                        if len(tables) > limit:
                            break
                return {"tables": tables[:limit], "truncated": len(tables) > limit}
            if kind == "list_columns":
                if not payload.get("table"):
                    raise AgentError("list_columns needs a 'table'")
                return {"columns": [
                    {"name": c.column_name, "type": c.type_name, "size": c.column_size,
                     "nullable": bool(c.nullable), "position": c.ordinal_position}
                    for c in src.cursor().columns(table=payload["table"], schema=payload.get("schema") or None)]}
            if kind == "preview":
                limit = max(1, min(int(payload.get("limit") or 100), int(self.cfg["agent"]["preview_max_rows"])))
                q, params = prepare_source_query(payload.get("sql") or "", payload.get("watermark_type"), payload.get("watermark"))
                started = time.monotonic()
                cur = source.execute(src, q, params)
                rows = [source.clean_row(r) for r in cur.fetchmany(limit + 1)]
                cols = describe_columns(cur, rows)
                cur.close()
                return {"columns": cols, "rows": [[to_json_value(v) for v in r] for r in rows[:limit]],
                        "truncated": len(rows) > limit, "elapsed_ms": int((time.monotonic() - started) * 1000)}
            raise AgentError(f"Unknown request kind '{kind}'")
        finally:
            src.close()

    # --- deciding what to run -------------------------------------------------------

    def _verify(self, job: dict) -> TableDef:
        """The job in Supabase must match tables.toml on this machine exactly, or it does not run."""
        assert self.tf is not None
        t = self.tf.tables.get(job["target_table"])
        if t is None:
            raise AgentError(f"Table '{job['target_table']}' is not in tables.toml on agent '{self.name}'. "
                             f"Run --apply to remove it, or add it back to tables.toml.")
        if job["definition_sha256"] != t.sha256:
            raise AgentError(f"The definition of '{t.name}' in Supabase does not match tables.toml on agent "
                             f"'{self.name}'. Run --plan / --apply on the agent machine. Not run.")
        return t

    def run_due(self, force: str | None = None) -> bool:
        """Run one due unit of work (a group or a single table). Returns True if something ran."""
        if self.tf is None:
            self.refresh_tables()
        conn = self.wh.main
        mine = (self.name,)
        if force:
            grp = conn.execute("select * from bi.load_groups where name = %s and managed_by = %s", (force, self.name)).fetchone()
            if grp:
                self._run_group(grp, "manual")
                return True
            job = conn.execute("select * from bi.load_jobs where target_table = %s and managed_by = %s", (force, self.name)).fetchone()
            if job:
                self._run_batch([job], "manual", None)
                return True
            con = conn.execute("select * from bi.connectors where name = %s and agent_name = %s and kind <> 'upload'",
                               (force, self.name)).fetchone()
            if con:
                self._run_connector(con, "manual")
                return True
            raise AgentError(f"No table, group or connector '{force}' for agent '{self.name}' in Supabase (did you run --apply?)")

        # A failed full reload stays requested, but is retried at most every RETRY_MINUTES.
        grp = conn.execute(
            f"""
            select g.*, (g.reload_requested or g.full_reload_requested or exists (
                           select 1 from bi.load_jobs j where j.group_name = g.name
                             and (j.reload_requested or j.full_reload_requested))) as requested
            from bi.load_groups g
            where g.managed_by = %s and coalesce(g.last_status, '') <> 'running'
              and (g.reload_requested
                   or (g.full_reload_requested and {RETRY_OK.format(t="g")})
                   or exists (select 1 from bi.load_jobs j where j.group_name = g.name and j.managed_by = g.managed_by
                              and (j.reload_requested or (j.full_reload_requested and {RETRY_OK.format(t="g")})))
                   or (g.enabled and g.interval_minutes is not null
                       and (g.last_run_at is null or g.last_run_at + make_interval(mins => g.interval_minutes) <= now())))
            order by requested desc, g.last_run_at nulls first
            limit 1
            """, mine).fetchone()
        if grp:
            trigger = "full_reload" if grp["full_reload_requested"] else "manual" if grp["requested"] else "schedule"
            self._run_group(grp, trigger)
            return True

        job = conn.execute(
            f"""
            select * from bi.load_jobs j
            where managed_by = %s and group_name is null and coalesce(last_status, '') <> 'running'
              and (reload_requested
                   or (full_reload_requested and {RETRY_OK.format(t="j")})
                   or (enabled and interval_minutes is not null
                       and (last_run_at is null or last_run_at + make_interval(mins => interval_minutes) <= now())))
            order by (reload_requested or full_reload_requested) desc, last_run_at nulls first, id
            limit 1
            """, mine).fetchone()
        if job:
            trigger = "full_reload" if job["full_reload_requested"] else "manual" if job["reload_requested"] else "schedule"
            self._run_batch([job], trigger, None)
            return True

        con = conn.execute(
            f"""
            select * from bi.connectors
            where agent_name = %s and kind <> 'upload' and coalesce(last_status, '') <> 'running'
              and (reload_requested
                   or (enabled and interval_minutes is not null
                       and (last_run_at is null or last_run_at + make_interval(mins => interval_minutes) <= now())))
              and (reload_requested or {RETRY_OK.format(t="bi.connectors")})
            order by reload_requested desc, last_run_at nulls first, name
            limit 1
            """, mine).fetchone()
        if con:
            self._run_connector(con, "manual" if con["reload_requested"] else "schedule")
            return True
        return False

    # --- connectors: web APIs and folders ------------------------------------------------

    def _run_connector(self, con: dict, trigger: str) -> None:
        conn = self.wh.main
        name = con["name"]
        with conn.transaction():
            run_id = conn.execute(
                "insert into bi.sync_runs (batch_id, target_table, agent_name, trigger) values (%s, %s, %s, %s) returning id",
                (uuid.uuid4(), name, self.name, trigger)).fetchone()["id"]
            conn.execute("update bi.connectors set last_status = 'running', last_error = null, reload_requested = false "
                         "where id = %s", (con["id"],))
        log.info("Loading %s connector '%s' [%s]", con["kind"], name, trigger)
        started = time.monotonic()
        try:
            if not NAME_RE.match(name):
                raise AgentError("Invalid connector name")
            if conn.execute("select 1 from bi.load_jobs where target_table = %s", (name,)).fetchone():
                raise AgentError(f"'{name}' is also a table in tables.toml; rename the connector")
            ccfg = self.cfg["connectors"]
            c = con["config"] or {}
            if con["kind"] == "web":
                raw = fetch_web(c, ccfg)
                if c.get("format", "json") == "csv":
                    records = csv_records(raw)
                else:
                    try:
                        records = json_records(json.loads(raw.decode("utf-8-sig")), str(c.get("records_path") or ""))
                    except (UnicodeDecodeError, json.JSONDecodeError) as e:
                        raise AgentError(f"The response is not valid JSON ({e})") from None
            elif con["kind"] == "sharepoint":
                records = read_sharepoint(c, ccfg)
            elif con["kind"] == "gsheet":
                records = read_gsheet(c, ccfg)
            elif con["kind"] == "folder":
                records = read_folder(c, ccfg)
            else:
                raise AgentError(f"This agent ({VERSION}) cannot run '{con['kind']}' connectors; update it")
            if len(records) > ccfg["max_rows"]:
                raise AgentError(f"{len(records):,} rows is more than [connectors] max_rows ({ccfg['max_rows']:,})")
            if not records:
                raise AgentError("No rows were found")
            cols, rows = infer_records(records)
            target_types = self.wh.ensure_table(name, cols)
            names = [x["name"] for x in cols]
            target = sql.Identifier(DATA_SCHEMA, name)
            with conn.transaction():
                conn.execute(sql.SQL("truncate {}").format(target))
                with conn.cursor() as pgcur:
                    with pgcur.copy(sql.SQL("copy {} ({}) from stdin").format(
                            target, sql.SQL(", ").join(map(sql.Identifier, names)))) as cp:
                        for r in rows:
                            cp.write_row(r)
                final_cols = [{"name": n, "type": ty} for n, ty in self.wh.table_columns(name, conn).items()]
                conn.execute(
                    """
                    insert into bi.data_tables (table_name, job_id, group_name, description, columns, row_count, last_loaded_at, last_run_id)
                    values (%s, null, null, %s, %s, %s, now(), %s)
                    on conflict (table_name) do update set job_id = null, group_name = null, description = excluded.description,
                      columns = excluded.columns, row_count = excluded.row_count, last_loaded_at = excluded.last_loaded_at,
                      last_run_id = excluded.last_run_id
                    """, (name, con["description"] or f"{con['kind']} connector", Jsonb(final_cols), len(rows), run_id))
                conn.execute("update bi.connectors set last_status = 'success', last_error = null, last_run_at = now(), "
                             "last_row_count = %s where id = %s", (len(rows), con["id"]))
                conn.execute("update bi.sync_runs set status = 'success', row_count = %s, finished_at = now() where id = %s",
                             (len(rows), run_id))
            del target_types
            log.info("Loaded connector '%s': %s rows in %.1fs", name, f"{len(rows):,}", time.monotonic() - started)
        except Exception as e:
            err = short_error(e)
            if isinstance(e, (AgentError, psycopg.errors.DataError, OSError, ValueError)):
                log.error("Loading connector '%s' failed: %s", name, err)
            else:
                log.exception("Loading connector '%s' failed", name)
            if isinstance(e, (psycopg.OperationalError, psycopg.InterfaceError)):
                self.wh.close()
                conn = self.wh.main
            with conn.transaction():
                conn.execute("update bi.connectors set last_status = 'error', last_error = %s, last_run_at = now() where id = %s",
                             (err, con["id"]))
                conn.execute("update bi.sync_runs set status = 'error', error = %s, finished_at = now() where id = %s",
                             (err, run_id))

    def _run_group(self, grp: dict, trigger: str) -> None:
        conn = self.wh.main
        jobs = conn.execute(
            "select * from bi.load_jobs where group_name = %s and managed_by = %s and (enabled or %s) order by id",
            (grp["name"], self.name, trigger != "schedule")).fetchall()
        with conn.transaction():
            conn.execute("update bi.load_groups set reload_requested = false, full_reload_requested = false "
                         "where name = %s", (grp["name"],))
        if not jobs:
            conn.execute("update bi.load_groups set last_run_at = now(), last_status = 'success', last_error = null "
                         "where name = %s", (grp["name"],))
            return
        if trigger == "full_reload":
            for j in jobs:
                j["full_reload_requested"] = True
        self._run_batch(jobs, trigger, grp["name"])

    # --- running a batch (one table, or all tables of a group, in one transaction) ----

    def _run_batch(self, jobs: list[dict], trigger: str, group: str | None) -> None:
        conn = self.wh.main
        batch_id = uuid.uuid4()
        ids = [j["id"] for j in jobs]
        run_ids: dict[int, int] = {}
        with conn.transaction():
            for j in jobs:
                run_ids[j["id"]] = conn.execute(
                    "insert into bi.sync_runs (batch_id, job_id, target_table, group_name, agent_name, trigger, "
                    "watermark_before) values (%s, %s, %s, %s, %s, %s, %s) returning id",
                    (batch_id, j["id"], j["target_table"], group, self.name,
                     "full_reload" if j["full_reload_requested"] else trigger, j["watermark"])).fetchone()["id"]
            conn.execute("update bi.load_jobs set last_status = 'running', last_error = null, "
                         "reload_requested = false, full_reload_requested = false where id = any(%s)", (ids,))
            if group:
                conn.execute("update bi.load_groups set last_status = 'running', last_error = null where name = %s", (group,))

        label = f"group '{group}' ({len(jobs)} tables)" if group else f"table '{jobs[0]['target_table']}'"
        log.info("Loading %s [%s]", label, trigger)
        started = time.monotonic()
        current = None
        try:
            staged: list[Staged] = []
            with conn.transaction():
                for i, j in enumerate(jobs):
                    current = j["target_table"]
                    t = self._verify(j)
                    staged.append(self._stage(t, j, run_ids[j["id"]], i, bool(j["full_reload_requested"])))
                    if self.stopping:
                        raise AgentError("The agent was stopped during the load")
                current = None
                for s in staged:
                    current = s.table.name
                    self._apply_stage(s, bool(s.job["full_reload_requested"]))
                if group:
                    conn.execute("update bi.load_groups set last_status = 'success', last_error = null, "
                                 "last_run_at = now() where name = %s", (group,))
            total = sum(s.total for s in staged)
            log.info("Loaded %s: %s rows in %.1fs", label, f"{total:,}", time.monotonic() - started)
        except Exception as e:
            err = short_error(e)
            if isinstance(e, (AgentError, pyodbc.Error, psycopg.errors.DataError, psycopg.errors.IntegrityError)):
                log.error("Loading %s failed%s: %s", label, f" at table '{current}'" if current else "", err)
            else:
                log.exception("Loading %s failed", label)
            if isinstance(e, (psycopg.OperationalError, psycopg.InterfaceError)):
                self.wh.close()
                conn = self.wh.main
            def keep_full(j: dict) -> bool:
                # a failed full reload stays requested (retried after RETRY_MINUTES): on the group when the
                # whole group was fully reloaded, otherwise on the table itself (e.g. its definition changed)
                return bool(j["full_reload_requested"]) and not (group and trigger == "full_reload")

            with conn.transaction():
                for j in jobs:
                    msg = err if (current is None or j["target_table"] == current) else \
                        f"Not loaded: '{current}' in the same group failed ({err})"
                    conn.execute("update bi.sync_runs set status = 'error', error = %s, finished_at = now() "
                                 "where id = %s", (msg, run_ids[j["id"]]))
                    conn.execute("update bi.load_jobs set last_status = 'error', last_error = %s, last_run_at = now(), "
                                 "full_reload_requested = %s where id = %s",
                                 (msg, keep_full(j), j["id"]))
                if group:
                    conn.execute("update bi.load_groups set last_status = 'error', last_error = %s, last_run_at = now(), "
                                 "full_reload_requested = full_reload_requested or %s where name = %s",
                                 (f"{current}: {err}" if current else err,
                                  any(j["full_reload_requested"] for j in jobs) and trigger == "full_reload", group))

    def _stage(self, t: TableDef, job: dict, run_id: int, idx: int, full_reload: bool) -> Staged:
        """Read the source and copy the rows into a temporary table (inside the open transaction)."""
        source = self.sources[t.source]
        start_wm = None if full_reload else job["watermark"]
        if start_wm is None:
            start_wm = t.initial_watermark
        query, params = prepare_source_query(t.sql, t.watermark_type, start_wm)
        batch_size = int(self.cfg["agent"]["batch_size"])
        conn = self.wh.main
        stage = f"_bi_stage_{idx}"

        src = source.connect()
        try:
            cur = source.execute(src, query, params)
            first = [source.clean_row(r) for r in cur.fetchmany(batch_size)]
            cols = describe_columns(cur, first)
            names = [c["name"] for c in cols]
            missing = [k for k in t.keys if k not in names]
            if missing:
                raise AgentError(f"Key column(s) {', '.join(missing)} are not in the query result. "
                                 f"Result columns: {', '.join(names)}")
            wm_idx = None
            if t.incremental:
                if t.incremental_column not in names:
                    raise AgentError(f"Incremental column '{t.incremental_column}' is not in the query result. "
                                     f"Result columns: {', '.join(names)}")
                wm_idx = names.index(t.incremental_column)

            target_types = self.wh.ensure_table(t.name, cols)
            if t.mode == "upsert":
                self.wh.ensure_key_index(t.name, t.keys)

            conn.execute(sql.SQL("create temp table {} ({}) on commit drop").format(
                sql.Identifier(stage),
                sql.SQL(", ").join(sql.SQL("{} {}").format(sql.Identifier(n), sql.SQL(target_types[n])) for n in names)))
            max_wm, total = None, 0
            with conn.cursor() as pgcur:
                with pgcur.copy(sql.SQL("copy {} ({}) from stdin").format(
                        sql.Identifier(stage), sql.SQL(", ").join(map(sql.Identifier, names)))) as cp:
                    batch = first
                    while batch:
                        for row in batch:
                            cp.write_row(row)
                            if wm_idx is not None:
                                v = row[wm_idx]
                                if v is not None and (max_wm is None or v > max_wm):
                                    max_wm = v
                        total += len(batch)
                        if total % (batch_size * 20) < len(batch):
                            log.info("  %s: %s rows read", t.name, f"{total:,}")
                        if self.stopping:
                            raise AgentError("The agent was stopped during the load")
                        batch = [source.clean_row(r) for r in cur.fetchmany(batch_size)]
            cur.close()
            return Staged(t, job, run_id, stage, names, total, max_wm, start_wm)
        finally:
            src.close()

    def _apply_stage(self, s: Staged, full_reload: bool) -> None:
        """Move staged rows into the real table and record the run (same transaction)."""
        conn = self.wh.main
        t = s.table
        target = sql.Identifier(DATA_SCHEMA, t.name)
        stage = sql.Identifier(s.stage)
        col_list = sql.SQL(", ").join(map(sql.Identifier, s.names))
        if t.mode == "full" or full_reload:
            conn.execute(sql.SQL("truncate {}").format(target))
        if t.mode == "upsert":
            non_keys = [n for n in s.names if n not in t.keys]
            key_list = sql.SQL(", ").join(map(sql.Identifier, t.keys))
            if non_keys:
                sets = sql.SQL(", ").join(
                    [sql.SQL("{0} = excluded.{0}").format(sql.Identifier(n)) for n in non_keys]
                    + [sql.SQL("{} = pg_catalog.now()").format(sql.Identifier(LOADED_AT_COLUMN))])
                action = sql.SQL("do update set {}").format(sets)
            else:
                action = sql.SQL("do nothing")
            conn.execute(sql.SQL("insert into {t} ({c}) select distinct on ({k}) {c} from {s} on conflict ({k}) {a}")
                         .format(t=target, c=col_list, k=key_list, s=stage, a=action))
        else:
            conn.execute(sql.SQL("insert into {} ({}) select {} from {}").format(target, col_list, col_list, stage))

        new_wm = None
        if t.incremental:
            new_wm = format_watermark(s.max_wm) if s.max_wm is not None else \
                (t.initial_watermark if full_reload else s.job["watermark"])
        row_count = conn.execute(sql.SQL("select count(*) as n from {}").format(target)).fetchone()["n"]
        final_cols = [{"name": n, "type": ty} for n, ty in self.wh.table_columns(t.name, conn).items()]
        conn.execute(
            """
            insert into bi.data_tables (table_name, job_id, group_name, description, columns, row_count, last_loaded_at, last_run_id)
            values (%s, %s, %s, %s, %s, %s, now(), %s)
            on conflict (table_name) do update set
              job_id = excluded.job_id, group_name = excluded.group_name, description = excluded.description,
              columns = excluded.columns, row_count = excluded.row_count,
              last_loaded_at = excluded.last_loaded_at, last_run_id = excluded.last_run_id
            """, (t.name, s.job["id"], t.group, t.description, Jsonb(final_cols), row_count, s.run_id))
        conn.execute("update bi.load_jobs set last_status = 'success', last_error = null, last_run_at = now(), "
                     "last_row_count = %s, watermark = %s where id = %s", (s.total, new_wm, s.job["id"]))
        conn.execute("update bi.sync_runs set status = 'success', row_count = %s, watermark_after = %s, "
                     "finished_at = now() where id = %s", (s.total, new_wm, s.run_id))

    # --- dry runs: read the source, write nothing ---------------------------------------

    def test_table(self, t: TableDef, sample_rows: int = 10, watermark: str | None = None) -> bool:
        source = self.sources[t.source]
        print(f"\n=== {t.name}  ({t.mode} from '{t.source}'{', group ' + t.group if t.group else ''}) ===")
        wm = watermark if watermark is not None else t.initial_watermark
        try:
            query, params = prepare_source_query(t.sql, t.watermark_type, wm)
            if params:
                print(f"  {PLACEHOLDER} = {params[0]!r}")
            started = time.monotonic()
            src = source.connect()
            try:
                cur = source.execute(src, query, params)
                batch_size = int(self.cfg["agent"]["batch_size"])
                first = [source.clean_row(r) for r in cur.fetchmany(batch_size)]
                cols = describe_columns(cur, first)
                names = [c["name"] for c in cols]
                problems = []
                missing = [k for k in t.keys if k not in names]
                if missing:
                    problems.append(f"key column(s) not in result: {', '.join(missing)}")
                if t.incremental and t.incremental_column not in names:
                    problems.append(f"incremental column '{t.incremental_column}' not in result")
                key_idx = [names.index(k) for k in t.keys if k in names]
                wm_idx = names.index(t.incremental_column) if t.incremental and t.incremental_column in names else None
                seen: set = set()
                dupes, total, max_wm, null_keys = 0, 0, None, 0
                track_keys = bool(key_idx)
                batch = first
                while batch:
                    for row in batch:
                        if track_keys:
                            k = tuple(row[i] for i in key_idx)
                            if any(v is None for v in k):
                                null_keys += 1
                            elif k in seen:
                                dupes += 1
                            else:
                                seen.add(k)
                                if len(seen) > 5_000_000:
                                    track_keys = False
                                    seen.clear()
                        if wm_idx is not None:
                            v = row[wm_idx]
                            if v is not None and (max_wm is None or v > max_wm):
                                max_wm = v
                    total += len(batch)
                    batch = [source.clean_row(r) for r in cur.fetchmany(batch_size)]
            finally:
                src.close()
            elapsed = time.monotonic() - started
        except AgentError as e:
            print(f"  FAILED: {e}")
            return False

        print(f"  rows: {total:,}   time: {elapsed:.1f}s")
        print("  columns:")
        for c in cols:
            renamed = f"   (from \"{c['source_name']}\")" if c["source_name"] != c["name"] else ""
            print(f"    {c['name']:<32} {c['type']}{renamed}")
        if wm_idx is not None:
            print(f"  next watermark would be: {format_watermark(max_wm) if max_wm is not None else '(unchanged, no rows)'}")
        if key_idx:
            if dupes:
                problems.append(f"{dupes:,} duplicate key(s) for ({', '.join(t.keys)}) — only one row per key is kept")
            if null_keys:
                problems.append(f"{null_keys:,} row(s) with an empty key value")
        if first and sample_rows:
            print(f"  first {min(sample_rows, len(first))} row(s):")
            shown = first[:sample_rows]
            widths = [min(28, max(len(n), *(len(str(to_json_value(r[i]))) for r in shown))) for i, n in enumerate(names)]
            print("    " + " | ".join(n[:w].ljust(w) for n, w in zip(names, widths)))
            for r in shown:
                print("    " + " | ".join(str(to_json_value(v))[:w].ljust(w) for v, w in zip(r, widths)))
        for p in problems:
            print(f"  WARNING: {p}")
        print("  nothing was written anywhere")
        return not any(p.startswith(("key column", "incremental column")) for p in problems)

    # --- diagnostics -----------------------------------------------------------------

    def check(self) -> bool:
        ok = True
        print(f"Impala BI agent {VERSION} — '{self.name}'\n")
        for w in self.cfg.get("_warnings", []):
            print(f"  [WARN] {w}")
        try:
            self.tf = load_tables(self.cfg["agent"]["tables_file"], self.cfg)
            print(f"  [OK]   tables.toml: {len(self.tf.tables)} table(s), {len(self.tf.groups)} group(s)")
        except AgentError as e:
            ok = False
            print(f"  [FAIL] {e}")
        try:
            conn = self.wh.main
            who = conn.execute("select current_user as u").fetchone()["u"]
            ssl = conn.pgconn.ssl_in_use
            print(f"  [OK]   Supabase: connected as {who}, {'encrypted (TLS)' if ssl else 'NOT encrypted (local only)'}")
            self.heartbeat(force=True)
            if self.tf and self.tf.tables:
                changes, errors = compute_plan(conn, self.tf, self.name)
                if errors:
                    ok = False
                    for e in errors:
                        print(f"  [FAIL] {e}")
                elif changes:
                    print(f"  [WARN] tables.toml has {len(changes)} change(s) not applied yet — run --plan")
                else:
                    print("  [OK]   Supabase matches tables.toml")
        except Exception as e:
            ok = False
            print(f"  [FAIL] Supabase: {short_error(e)}")
        for name, source in self.sources.items():
            try:
                res = self.handle_request("test_connection", source, {})
                print(f"  [OK]   Source '{name}': {res['dbms']} {res['dbms_version']} via {res['driver']}")
            except Exception as e:
                ok = False
                print(f"  [FAIL] Source '{name}': {short_error(e)}")
        return ok


# =============================================================================
# Entry point
# =============================================================================

def confirm(prompt: str, expected: str) -> bool:
    try:
        return input(prompt).strip().lower() == expected
    except EOFError:
        return False


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Impala BI sync agent", formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog=__doc__.split("Commands:", 1)[1])
    p.add_argument("--config", default="config.toml", help="path to config.toml (default: ./config.toml)")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--validate", action="store_true")
    g.add_argument("--test-table", metavar="NAME")
    g.add_argument("--test-all", action="store_true")
    g.add_argument("--check", action="store_true")
    g.add_argument("--plan", action="store_true")
    g.add_argument("--apply", action="store_true")
    g.add_argument("--run", metavar="NAME")
    g.add_argument("--once", action="store_true")
    p.add_argument("--yes", action="store_true", help="with --apply: don't ask for confirmation")
    p.add_argument("--watermark", help="with --test-table: use this {{watermark}} value")
    p.add_argument("--rows", type=int, default=10, help="with --test-table/--test-all: sample rows to show")
    args = p.parse_args(argv)

    try:
        cfg = load_config(args.config)
    except (AgentError, OSError, tomllib.TOMLDecodeError) as e:
        print(f"Config error: {redact(str(e))}", file=sys.stderr)
        return 2

    if args.validate:
        try:
            tf = load_tables(cfg["agent"]["tables_file"], cfg)
        except AgentError as e:
            print(e)
            return 1
        print(f"{Path(args.config).name} and {Path(tf.path).name} are valid: {len(tf.tables)} table(s), {len(tf.groups)} group(s)")
        for t in tf.tables.values():
            where = f"group {t.group}" if t.group else (f"every {t.interval_minutes} min" if t.interval_minutes else "manual")
            print(f"  {t.name:<30} {t.mode:<7} {t.source:<12} {where}")
        for w in cfg.get("_warnings", []):
            print(f"WARNING: {w}")
        return 0

    if args.check:
        logging.basicConfig(level=logging.WARNING)
        return 0 if Agent(cfg).check() else 1

    if args.test_table or args.test_all:
        logging.basicConfig(level=logging.WARNING)
        try:
            tf = load_tables(cfg["agent"]["tables_file"], cfg)
        except AgentError as e:
            print(e)
            return 1
        agent = Agent(cfg)
        if args.test_table:
            if args.test_table not in tf.tables:
                print(f"No table '{args.test_table}' in tables.toml (have: {', '.join(tf.tables)})")
                return 1
            return 0 if agent.test_table(tf.tables[args.test_table], args.rows, args.watermark) else 1
        results = [agent.test_table(t, args.rows) for t in tf.tables.values()]
        print(f"\n{sum(results)} of {len(results)} table(s) OK")
        return 0 if all(results) else 1

    if args.plan or args.apply:
        try:
            tf = load_tables(cfg["agent"]["tables_file"], cfg)
            conn = pg_connect(cfg)
        except AgentError as e:
            print(e)
            return 1
        except psycopg.Error as e:
            print(f"Could not connect to Supabase: {short_error(e)}")
            return 1
        try:
            changes, errors = compute_plan(conn, tf, cfg["agent"]["name"])
            if errors:
                print("Cannot apply:\n  - " + "\n  - ".join(errors))
                return 1
            print_plan(changes)
            if not args.apply or not changes:
                return 0
            removals = [c for c in changes if c.kind == "remove" and c.object_type == "table"]
            if not args.yes:
                if removals:
                    print(f"\nThis permanently deletes {len(removals)} table(s) and their data in Supabase.")
                    if not confirm("Type 'delete' to continue: ", "delete"):
                        print("Cancelled.")
                        return 1
                elif not confirm("\nApply these changes? [y/N] ", "y"):
                    print("Cancelled.")
                    return 1
            apply_plan(conn, tf, changes, cfg["agent"]["name"])
            print("Applied. A running agent picks up new and changed tables within a few seconds.")
            return 0
        except AgentError as e:
            print(e)
            return 1
        finally:
            conn.close()

    setup_logging(cfg)
    agent = Agent(cfg)

    def stop(*_):
        if not agent.stopping:
            log.info("Stop requested — finishing the current step...")
        agent.stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, stop)

    try:
        if args.run:
            agent.refresh_tables()
            agent.recover_interrupted()
            agent.run_due(force=args.run)
            c = agent.wh.main
            row = (c.execute("select last_status from bi.load_groups where name = %s", (args.run,)).fetchone()
                   or c.execute("select last_status from bi.load_jobs where target_table = %s", (args.run,)).fetchone()
                   or c.execute("select last_status from bi.connectors where name = %s", (args.run,)).fetchone())
            return 0 if row and row["last_status"] == "success" else 1
        if args.once:
            agent.run_once()
            return 0
        agent.run_forever()
        return 0
    except AgentError as e:
        log.error("%s", e)
        return 1
    finally:
        agent.wh.close()


if __name__ == "__main__":
    sys.exit(main())
