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
export PGHOST=$PGROOT PGPORT=$PORT PGUSER=postgres PGDATABASE=familyos

cmd=${1:-up}

up() {
  pkill -u ubuntu -f "$BIN/postgres" 2>/dev/null || true; sleep 1
  rm -rf "$PGROOT"; mkdir -p "$DATA"; chown -R ubuntu:ubuntu "$PGROOT"
  sudo -u ubuntu "$BIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
  sudo -u ubuntu "$BIN/pg_ctl" -D "$DATA" -l "$PGROOT/pg.log" -o "-p $PORT -k $PGROOT" -w start
  PGDATABASE=postgres psql -qc "create database familyos;"
  # Supabase shims
  psql -v ON_ERROR_STOP=1 -q <<'SQL'
create extension if not exists pgcrypto;
create schema if not exists auth; create schema if not exists storage; create schema if not exists extensions;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role authenticator noinherit login password 'x'; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_admin superuser; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_storage_admin; exception when duplicate_object then null; end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema auth, storage, extensions, public to anon, authenticated, service_role;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
  raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now());
create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $f$;
create or replace function auth.role() returns text language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claim.role', true),''),'authenticated') $f$;
create or replace function auth.email() returns text language sql stable as $f$ select nullif(current_setting('request.jwt.claim.email', true),'') $f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$ select coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb,'{}'::jsonb) $f$;
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now());
create or replace function storage.foldername(name text) returns text[] language sql immutable as $f$ select string_to_array(name,'/') $f$;
SQL
  # Migrations
  local fail=0
  for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
    if ! psql -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>"$PGROOT/err"; then
      echo "MIGRATION FAIL: $(basename "$f")"; tail -2 "$PGROOT/err"; fail=$((fail+1)); [ $fail -ge 3 ] && break
    fi
  done
  # Anchor account (family trigger creates the parent member + subscription)
  psql -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (id,email) values ('$ANCHOR_UID','$ANCHOR_EMAIL') on conflict do nothing;
do \$\$ begin if to_regclass('public.profiles') is not null then
  insert into public.profiles (id,full_name) values ('$ANCHOR_UID','New World Family') on conflict do nothing; end if; end \$\$;
insert into public.families (id,name,created_by) values ('$ANCHOR_FID','The New World Family','$ANCHOR_UID') on conflict do nothing;
grant select on all tables in schema public to authenticated, anon;
grant usage on all sequences in schema public to authenticated, anon;
SQL
  psql -v ON_ERROR_STOP=0 -q -f "$ROOT/supabase/SEED_ALL.sql" 2>&1 | grep -iE "^psql.*ERROR" | grep -viE "No families found|anchored account" | head -20 || true
  echo "== harness up: db=familyos host=$PGROOT port=$PORT anchor_family=$ANCHOR_FID migration_fail=$fail =="
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
  down) pkill -u ubuntu -f "$BIN/postgres" 2>/dev/null || true; rm -rf "$PGROOT"; echo "harness down" ;;
  *) echo "usage: verify-pg.sh {up|psql|rls '<SQL>'|down}"; exit 1 ;;
esac
