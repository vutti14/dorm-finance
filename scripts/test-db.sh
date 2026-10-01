#!/usr/bin/env bash
# Spin up a throwaway Postgres 15/16, apply supabase/tests/stubs.sql + all migrations, run the DB tests.
# Usage: scripts/test-db.sh            (needs postgres binaries; set PG_BIN if not on PATH)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
PORT="${PGTEST_PORT:-54329}"
DIR="$(mktemp -d /tmp/dormpg.XXXXXX)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then chown -R postgres "$DIR"; RUN_AS=(runuser -u postgres --); fi

cleanup() { "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$DIR/data" -U postgres -A trust --locale=C.UTF-8 -E UTF8 >/dev/null
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c wal_level=logical -c timezone=Asia/Bangkok" -l "$DIR/log" -w start >/dev/null

PSQL=("$PG_BIN/psql" -h "$DIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
# each test file gets its own fresh database (they assert on global state)
setup_db() {
  "${PSQL[@]}" -d postgres -c "drop database if exists dorm" -c "create database dorm"
  "${PSQL[@]}" -d dorm -f "$ROOT/supabase/tests/stubs.sql"
  for f in "$ROOT"/supabase/migrations/*.sql; do
    "${PSQL[@]}" -d dorm -f "$f"
  done
  if [ -d "$ROOT/reference" ]; then
    (cd "$ROOT/scripts" && { [ -d node_modules ] || npm install --silent; } && npx tsx import-opening.ts --reference "$ROOT/reference" >/dev/null)
  fi
}

export DATABASE_URL="postgresql://postgres@localhost:$PORT/dorm?host=$DIR"
cd "$ROOT/app"
status=0
for t in tests/db/*.test.ts; do
  echo "== $t (fresh database: $(ls "$ROOT"/supabase/migrations/*.sql | wc -l) migrations)"
  setup_db
  npx vitest run "$t" "$@" || status=1
done
exit $status
