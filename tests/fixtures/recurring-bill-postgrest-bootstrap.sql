\set ON_ERROR_STOP on
-- Empty, owned disposable PG17 database only. No migration history is written.
-- Auth claim accessors and dependency-only tables are modeled here; the test
-- executes actual 0275/0382 policies and source helper/trigger excerpts later.
do $$ begin
  if current_database() <> 'bubaly_bill_postgrest_ci'
    or current_setting('server_version_num')::integer not between 170000 and 179999
    or exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
               where n.nspname='public' and c.relkind in ('r','p','v','m','f')) then
    raise exception 'Refuse anything except an empty disposable bill PG17 database';
  end if;
end $$;
-- psql supplies this run's non-secret marker. Invalid/missing markers fail first.
select 1 / ((:'gate_marker' ~ '^([0-9]+-[0-9]+|[a-f0-9]{32})$')::integer);
create schema bill_gate_private;
revoke all on schema bill_gate_private from public;
create table bill_gate_private.marker (run_id text primary key);
insert into bill_gate_private.marker values (:'gate_marker');

create role anon nologin;
create role authenticated nologin;
create role bubaly_bill_authenticator login noinherit;
grant anon, authenticated to bubaly_bill_authenticator;
revoke create on schema public from public;
grant usage on schema public to anon, authenticated;
-- Binds the HTTP endpoint to the same private marker checked over the owned
-- PostgreSQL connection before the test performs any further fixture DDL.
create function public.bill_gate_identity() returns jsonb
language sql security definer set search_path = pg_catalog as $$
  select jsonb_build_object('database', current_database(), 'marker', run_id)
  from bill_gate_private.marker;
$$;
revoke all on function public.bill_gate_identity() from public, anon;
grant execute on function public.bill_gate_identity() to authenticated;

create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt()->>'sub', '')::uuid;
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.jwt(), auth.uid() to authenticated;
create table auth.mfa_factors (user_id uuid not null, status text not null);
create table public.family_members (
  family_id uuid not null, user_id uuid not null, role text not null,
  is_active boolean not null default true, primary key (family_id, user_id)
);
insert into public.family_members values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'parent', true),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'child', true),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003', 'parent', true);

-- 0275 requires five wallet dependencies; 0382 requires budgets/savings_goals.
-- They carry no product rows and are not evidence for those product domains.
do $$ declare t text; begin
  foreach t in array array['family_wallets','child_wallets','wallet_buckets',
    'wallet_transactions','wallet_rules','financial_accounts','transactions',
    'budgets','savings_goals'] loop
    execute format('create table public.%I (id uuid primary key, family_id uuid not null)', t);
  end loop;
end $$;
create table public.bills (
  id uuid primary key, family_id uuid not null, name text not null,
  amount numeric(12,2) not null default 100, due_date date not null,
  status text not null default 'upcoming', is_recurring boolean not null default true,
  recurrence text default 'monthly', category text, autopay boolean not null default false,
  created_by uuid, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.bills to authenticated;
select 'Owned bill PostgREST bootstrap PASS (modeled auth; no due_day yet)' as result;
