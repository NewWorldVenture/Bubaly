#!/usr/bin/env bash
# ── Launch-audit throwaway PG16 harness ──────────────────────────────────────
# Bootstraps a local Postgres 16 with the Supabase shims (auth/storage/realtime
# + roles), applies ALL migrations, loads SEED_ALL against the anchored account,
# and leaves a running DB you can query under RLS as an authenticated member.
#
# Usage:
#   bash docs/audit/verify-pg.sh up      # bootstrap + migrate + seed
#   bash docs/audit/verify-pg.sh psql     # open psql on the seeded DB
#   bash docs/audit/verify-pg.sh rls '<SQL>'   # run SQL as the authenticated anchor member
#   bash docs/audit/verify-pg.sh probes   # run every docs/audit/*-check.sql boundary probe
#   bash docs/audit/verify-pg.sh down    # stop + remove
#
# Never run Postgres as root — this uses the `ubuntu` user. Agents must NOT apply
# migrations to prod (human-owned; see docs/PENDING_PROD_MIGRATIONS.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGROOT=/tmp/pgaudit_db
DATA=$PGROOT/data
PORT=54399
BIN=/usr/lib/postgresql/16/bin
ANCHOR_EMAIL=newworldventurellc@gmail.com
ANCHOR_UID=00000000-0000-4000-8000-000000000001
ANCHOR_FID=00000000-0000-4000-8000-0000000000f1
export PGHOST=$PGROOT PGPORT=$PORT PGUSER=postgres PGDATABASE=bubaly

cmd=${1:-up}

up() {
  pkill -u ubuntu -f "$BIN/postgres" 2>/dev/null || true; sleep 1
  rm -rf "$PGROOT"; mkdir -p "$DATA"; chown -R ubuntu:ubuntu "$PGROOT"
  sudo -u ubuntu "$BIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
  sudo -u ubuntu "$BIN/pg_ctl" -D "$DATA" -l "$PGROOT/pg.log" -o "-p $PORT -k $PGROOT" -w start
  PGDATABASE=postgres psql -qc "create database bubaly;"
  # Shims, migrations, anchor and seed all live in pg-bootstrap.sh, which CI runs
  # against a service container. One definition, so what CI proves is what a
  # person reproduces here.
  ANCHOR_EMAIL=$ANCHOR_EMAIL ANCHOR_UID=$ANCHOR_UID ANCHOR_FID=$ANCHOR_FID \
    bash "$ROOT/docs/audit/pg-bootstrap.sh"
  echo "== harness up: db=bubaly host=$PGROOT port=$PORT anchor_family=$ANCHOR_FID =="
}

case "$cmd" in
  up) up ;;
  psql) shift; psql "$@" ;;
  rls)
    psql -v ON_ERROR_STOP=1 <<SQL
set role authenticated;
set request.jwt.claim.sub = '$ANCHOR_UID';
set request.jwt.claim.role = 'authenticated';
${2}
reset role;
SQL
    ;;
  probes) bash "$ROOT/docs/audit/run-probes.sh" ;;
  down) pkill -u ubuntu -f "$BIN/postgres" 2>/dev/null || true; rm -rf "$PGROOT"; echo "harness down" ;;
  *) echo "usage: verify-pg.sh {up|psql|rls '<SQL>'|probes|down}"; exit 1 ;;
esac
