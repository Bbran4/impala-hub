#!/usr/bin/env bash
# Creates the local test environment on a PostgreSQL 15+ server at localhost:5432 (with pgTAP):
#   database "sb"  — stands in for Supabase: every migration in supabase/migrations applied
#                    to the platform stand-in in supabase/tests/local_stub
#   database "erp" — stands in for the ERP, read over ODBC with a read-only login
#   tests/branches.db — a second source (SQLite over ODBC)
#   TLS on the server with a test CA, reachable as "pg.impala.test" (for verify-full tests)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(cd .. && pwd)"
P="psql -U postgres -h localhost -v ON_ERROR_STOP=1 -q"
PGDATA_DIR=$(psql -U postgres -h localhost -tAc "show data_directory")

# --- TLS: test CA + server certificate for pg.impala.test ---------------------
mkdir -p tests/tls
if [ ! -f tests/tls/server.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Impala Test CA" \
    -keyout tests/tls/ca.key -out tests/tls/ca.crt 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=pg.impala.test" \
    -keyout tests/tls/server.key -out tests/tls/server.csr 2>/dev/null
  printf "subjectAltName=DNS:pg.impala.test\n" > tests/tls/ext.cnf
  openssl x509 -req -in tests/tls/server.csr -CA tests/tls/ca.crt -CAkey tests/tls/ca.key -CAcreateserial \
    -days 30 -extfile tests/tls/ext.cnf -out tests/tls/server.crt 2>/dev/null
fi
cp tests/tls/server.crt tests/tls/server.key "$PGDATA_DIR/"
chown postgres "$PGDATA_DIR/server.crt" "$PGDATA_DIR/server.key"; chmod 600 "$PGDATA_DIR/server.key"
$P -c "alter system set ssl = on" -c "select pg_reload_conf()" >/dev/null
grep -q "pg.impala.test" /etc/hosts || echo "127.0.0.1 pg.impala.test" >> /etc/hosts

# --- databases ------------------------------------------------------------------
$P -c "drop database if exists erp" -c "create database erp"
STUB_DB=sb PGHOST=localhost PGUSER=postgres bash "$REPO/supabase/tests/local_stub/run.sh" --no-tests
$P -c "do \$\$begin if not exists(select 1 from pg_roles where rolname='erp_reader') then create role erp_reader login; end if; end\$\$" \
   -c "alter role erp_reader password 'Rdr-9f2k!xQ'"
$P -d sb -c "alter role bi_agent login password 'Agt-77Qp#zW'"

$P -d erp <<'SQL'
create table "StockItems" ("ItemCode" char(15) primary key, "Description" varchar(100), "Cost Price" numeric(18,2), "Qty On Hand" int, "Active" boolean);
insert into "StockItems" values ('BRK-001','Brake pad set',350.50,12,true),('FLT-020','Oil filter',85.00,40,true),('BAT-100','Battery 652',1450.00,5,false);

create table invoices (invoice_no int primary key, invoice_date date, branch text, total numeric(18,2), modified_at timestamp);
create table invoice_lines (invoice_no int, line_no int, item_code char(15), qty int, price numeric(18,2), modified_at timestamp,
  primary key (invoice_no, line_no));
insert into invoices select g, date '2026-10-01' + (g % 26), case when g%2=0 then 'Centurion' else 'Pretoria' end, 0,
  timestamp '2026-10-01 08:00' + g * interval '1 minute' from generate_series(1, 4000) g;
insert into invoice_lines select i, l, case l%3 when 0 then 'BRK-001' when 1 then 'FLT-020' else 'BAT-100' end, l, 100 + l,
  timestamp '2026-10-01 08:00' + i * interval '1 minute' from generate_series(1, 4000) i, generate_series(1, 3) l;
update invoices v set total = (select sum(qty*price) from invoice_lines l where l.invoice_no = v.invoice_no);

create table grv (grv_no text, item_code char(15), qty int, received date);
insert into grv values ('G1','BRK-001',10,'2026-10-26'),('G2','FLT-020',24,'2026-10-26'),('G2','FLT-020',24,'2026-10-26');
create table secret_payroll (employee text, salary numeric);
insert into secret_payroll values ('someone', 1);
grant select on "StockItems", invoices, invoice_lines, grv to erp_reader;
SQL

python3 - <<'PY'
import sqlite3
c = sqlite3.connect("tests/branches.db")
c.execute("drop table if exists branches"); c.execute("create table branches(code text, name text, region text)")
c.executemany("insert into branches values (?,?,?)", [("CEN", "Centurion", "Gauteng"), ("PTA", "Pretoria", "Gauteng")]); c.commit()
PY
printf 'BI_AGENT_DB_PASSWORD=Agt-77Qp#zW\nERP_PASSWORD=Rdr-9f2k!xQ\n' > tests/.env
echo "Ready. Run: python3 tests/test_agent.py"
