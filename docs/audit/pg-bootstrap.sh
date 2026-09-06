#!/usr/bin/env bash
# ── Bootstrap a Bubaly database on an ALREADY-RUNNING Postgres 16 ────────────
# Applies the Supabase shims, every migration in order, the anchor account, and
# SEED_ALL. Connects with the standard PG* environment variables, so it works
# against verify-pg.sh's throwaway local server and against a CI service
# container alike — which is the point: CI and the harness a person runs by hand
# must bootstrap from ONE definition, or the thing CI proves drifts from the
# thing anyone can reproduce.
#
#   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly bash docs/audit/pg-bootstrap.sh
#
# Exits non-zero if ANY migration fails. That is the difference between a replay
# and a report: `0118` exists because production had RLS on with its family
# policies missing, and a bootstrap that merely counts failures cannot catch the
# next one.
#
# Requires the `vector` extension (0237). postgres:16 alone does not have it;
# use pgvector/pgvector:pg16 or install postgresql-16-pgvector.
#
# Agents must NOT apply migrations to production (human-owned; see
# docs/PENDING_PROD_MIGRATIONS.md). This touches a throwaway database only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ANCHOR_EMAIL=${ANCHOR_EMAIL:-newworldventurellc@gmail.com}
ANCHOR_UID=${ANCHOR_UID:-00000000-0000-4000-8000-000000000001}
ANCHOR_FID=${ANCHOR_FID:-00000000-0000-4000-8000-0000000000f1}

echo "== shims =="
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
-- Supabase ships storage.objects with RLS ENABLED + DML granted to the client
-- roles by default (the platform does this at project creation, NOT a migration).
-- Replicate it so the storage.objects POLICIES the migrations add are actually
-- enforced here — otherwise storage isolation is untestable (policies inert).
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.objects to anon;
SQL

echo "== migrations =="
applied=0
failed=()
for f in "$ROOT"/supabase/migrations/*.sql; do   # glob is already lexicographic
  if psql -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>/tmp/pgbootstrap.err; then
    applied=$((applied + 1))
  else
    failed+=("$(basename "$f")")
    echo "MIGRATION FAIL: $(basename "$f")"
    tail -3 /tmp/pgbootstrap.err | sed 's/^/    /'
  fi
done
echo "== migrations applied: $applied, failed: ${#failed[@]} =="
if [ ${#failed[@]} -ne 0 ]; then
  echo "FAILED MIGRATIONS: ${failed[*]}"
  exit 1
fi

echo "== anchor account =="
psql -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (id,email) values ('$ANCHOR_UID','$ANCHOR_EMAIL') on conflict do nothing;
do \$\$ begin if to_regclass('public.profiles') is not null then
  insert into public.profiles (id,full_name) values ('$ANCHOR_UID','New World Family') on conflict do nothing; end if; end \$\$;
insert into public.families (id,name,created_by) values ('$ANCHOR_FID','The New World Family','$ANCHOR_UID') on conflict do nothing;
grant select on all tables in schema public to authenticated, anon;
grant usage on all sequences in schema public to authenticated, anon;
SQL

# SEED_ALL is applied best-effort: it carries known, pre-existing errors and is
# not this script's contract. What the probes actually need from it is asserted
# by the probes themselves — rls-isolation-check.sql fails outright if a table it
# reads has no anchor-family rows, so a seed regression that empties one shows up
# as a red probe rather than as silence here.
echo "== seed (best effort) =="
psql -v ON_ERROR_STOP=0 -q -f "$ROOT/supabase/SEED_ALL.sql" 2>&1 \
  | grep -iE "^psql.*ERROR" | grep -viE "No families found|anchored account" | head -20 || true

echo "== bootstrap complete: anchor_family=$ANCHOR_FID =="
