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
create schema if not exists auth; create schema if not exists storage; create schema if not exists extensions;

-- pgcrypto goes in `extensions`, NOT `public`, because that is where a real
-- Supabase project puts it:
--
--   select e.extname, n.nspname from pg_extension e
--     join pg_namespace n on n.oid = e.extnamespace;
--   pgcrypto   | extensions
--   uuid-ossp  | extensions
--   vector     | extensions
--
-- This line used to read `create extension if not exists pgcrypto;` with no
-- schema, which lands it in `public` — and that single difference made CI
-- structurally incapable of catching a whole class of defect.
--
-- `marketplace_create_circle` is `security definer` and pinned
-- `set search_path = public` while calling `gen_random_bytes`. On a real
-- Supabase project that raises 42883 on every call, and creating a sharing
-- circle was dead from 0176 until 0318. `docs/audit/circle-join-code-check.sql`
-- calls that function and asserts it works — the probe was correct, it ran on
-- every pull request, and it PASSED, because on a CI database with pgcrypto in
-- `public` the broken function resolves fine. Measured, with the pre-0318
-- definition restored on a CI-shaped database: probe exit 0.
--
-- A guard that cannot fail in the environment it runs in is not a guard. So the
-- environment is made to match production instead.
create extension if not exists pgcrypto with schema extensions;

-- And the search_path a real project gives the `postgres` role, for the same
-- reason. Supabase ships:
--
--   select setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
--    where r.rolname = 'postgres';
--   {"search_path=\"$user\", public, extensions"}
--
-- Without it, DDL that resolves an extension function at CREATE time — a column
-- default such as `invites.token default encode(gen_random_bytes(24),'hex')` —
-- cannot find it once pgcrypto moves out of `public`, and every migration
-- declaring one would fail here while working on a real project. Matching
-- production means matching both halves, not only the schema.
do $$ begin
  execute 'alter role ' || quote_ident(current_user) || ' set search_path = "$user", public, extensions';
exception when insufficient_privilege then
  raise notice 'could not set a role search_path; extension functions may not resolve in DDL';
end $$;
set search_path = "$user", public, extensions;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role authenticator noinherit login password 'x'; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_admin superuser; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_storage_admin; exception when duplicate_object then null; end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema auth, storage, extensions, public to anon, authenticated, service_role;

-- Reproduce Supabase's DEFAULT PRIVILEGES, and do it HERE — before a single
-- migration has run — because that is when they take effect on a real project.
--
-- A hosted Supabase ships `alter default privileges in schema public grant all
-- on tables to anon, authenticated, service_role`, so every table a migration
-- creates carries arwdDxt for anon from the moment it exists and RLS is the
-- only thing holding the line. This shim used to grant anon plain SELECT after
-- the migrations, which made it SAFER than production — the wrong direction for
-- a boundary harness. wallet-write-rls-check.sql asserts anon holds no INSERT on
-- wallet_transactions; that passed here for free while being false on every real
-- database, until 0286 closed it. Setting the defaults up front means a
-- migration's REVOKE survives, and a missing one is caught.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
-- And FUNCTIONS, for the same reason (TEST-012). Supabase grants EXECUTE on
-- every new function directly to anon and authenticated (pg_default_acl,
-- objtype f), so a migration's `revoke ... from public` leaves both callers in
-- place on a real project while it closes the function here. Without this line
-- the harness was safer than production again: wallet_reserve_card_auth and
-- marketplace_place_bid_unchecked were callable with the anon key on every real
-- database (SEC-024) and not callable here, so no probe could see it.
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
  raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now());
-- Supabase's own definitions, copied from a live project (TEST-012). Each reads
-- the single claim setting OR the JSON claims PostgREST sets. These used to read
-- only `request.jwt.claim.<x>`, so a probe that set `request.jwt.claims` — the
-- way PostgREST and the local stack do it — was nobody here, and its CONTROL
-- refused to pass. And auth.role() defaulted to 'authenticated', where
-- Supabase returns NULL for a session with no role claim.
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $f$;
create or replace function auth.email() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text $f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $f$;
-- auth.mfa_factors, as GoTrue creates it (0326 reads it to decide who must step
-- up). Without it 0326 failed to replay and the bootstrap stopped before the
-- anchor account, so five further probes failed on a missing anchor family.
do $$ begin create type auth.factor_type as enum ('totp', 'webauthn', 'phone'); exception when duplicate_object then null; end $$;
do $$ begin create type auth.factor_status as enum ('unverified', 'verified'); exception when duplicate_object then null; end $$;
create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text, factor_type auth.factor_type not null, status auth.factor_status not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  secret text, phone text, last_challenged_at timestamptz);
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
-- Sequences only. Table privileges come from the default privileges set in the
-- shims block ABOVE, before any migration runs — granting them here instead
-- would re-grant whatever a migration had deliberately revoked (0286 revokes
-- anon's writes on the money tables) and quietly undo it.
grant usage, select on all sequences in schema public to authenticated, anon;
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
