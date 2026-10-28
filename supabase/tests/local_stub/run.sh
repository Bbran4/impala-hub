#!/usr/bin/env bash
# Fallback for machines without Docker: applies every migration to a fresh database on a
# plain PostgreSQL 15+ server (with pgTAP installed) and runs the pgTAP suite.
# The real release gate remains `supabase test db` on the local Supabase stack (see docs/DEPLOYMENT.md).
#
#   PGHOST=localhost PGUSER=postgres bash supabase/tests/local_stub/run.sh [tests/<file>.test.sql ...]
#   (paths relative to supabase/; --no-tests only builds the database)
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${STUB_DB:-impala_hub_stub}
psql -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $DB" -c "create database $DB"
sed "s/current_database_placeholder/$DB/" tests/local_stub/supabase_stub.sql | psql -q -v ON_ERROR_STOP=1 -d "$DB" -f -
for f in migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" > /dev/null || { echo "Migration failed: $f"; exit 1; }
done
echo "Applied $(ls migrations/*.sql | wc -l) migrations to $DB"
[ "${1:-}" = "--no-tests" ] && exit 0
if [ $# -gt 0 ]; then tests=("$@"); else tests=(tests/*.test.sql); fi
pg_prove -d "$DB" "${tests[@]}"
