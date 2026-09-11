-- Bubaly :: migration ledger pre-flight — READ ONLY, changes nothing
-- ============================================================================
-- Run this before attempting the ledger repair described in
-- docs/runbooks/LB-016-wallet-permissive-policy-finding.md §4. It answers the
-- three questions that decide whether the repair is safe to start, and it
-- writes nothing, locks nothing and can be run on a live database any time.
--
-- Background: production's supabase_migrations.schema_migrations records only
-- 0001-0003 while the schema is far ahead of that, so `supabase db push` wants
-- to replay everything from 0004 and the workflow's --enforce-history guard
-- stops it. Three migrations (0249, 0254, 0275) were additionally applied BY
-- HAND and are recorded nowhere.

-- ── 1. What the ledger thinks is applied ───────────────────────────────────
select 'ledger' as source, version, name
from   supabase_migrations.schema_migrations
order  by version;

-- ── 2. How far ahead the schema actually is ────────────────────────────────
-- A ledger at 0003 with hundreds of tables means the schema was built by some
-- path other than `db push`. Large numbers here are expected, not alarming.
select (select count(*) from pg_tables  where schemaname = 'public') as public_tables,
       (select count(*) from pg_policies where schemaname = 'public') as public_policies,
       (select max(version) from supabase_migrations.schema_migrations) as ledger_high_water;

-- ── 3. Spot-check the hand-applied three ───────────────────────────────────
-- Each row says whether that migration's effect is present in the schema and
-- whether the ledger knows about it. "present / unrecorded" is the state this
-- pre-flight exists to surface: the work is done, the ledger cannot prove it.
--
-- EVERY probe here must be a POSITIVE existence check on something the
-- migration CREATES. The 0275 probe used to be an absence check — "no
-- permissive write policy on bills lacking can_manage_family" — which passes
-- whether or not 0275 ever ran, because a table with no such policy satisfies
-- it vacuously. On 2026-09-11 that is exactly what happened: 0275 reported
-- "present in schema" on a production database whose wallet_transactions
-- carried no restrictive policy at all, which 0275 creates unconditionally.
-- A probe that cannot fail cannot be evidence. tests/migration-ledger-preflight
-- pins this shape so the weaker form cannot come back.
--
-- The two money probes are scoped to tell 0254 and 0275 apart, which matters
-- because both create identically-named guards:
--   0254 covers the WALLET group only.
--   0275 covers the wallet group AND gives the FINANCE group the same guard
--        ("Give this group the guard the wallet group has had since 0254").
-- So restrictive guards on the finance tables are 0275's signature alone.
with wallet_tables(t) as (
  values ('family_wallets'),('child_wallets'),('wallet_buckets'),('wallet_transactions'),('wallet_rules')
), finance_tables(t) as (
  values ('financial_accounts'),('transactions'),('budgets'),('bills'),('savings_goals')
), guarded as (
  select c.relname as t
  from   pg_policy pol
  join   pg_class c on c.oid = pol.polrelid and c.relnamespace = 'public'::regnamespace
  where  not pol.polpermissive
    and  pol.polcmd in ('a','w','d','*')
  group  by c.relname
), probe(version, what, present) as (
  values
    ('0249', 'mark_model_dirty() skips a deleted family',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'mark_model_dirty'
                and pg_get_functiondef(p.oid) like '%not exists (select 1 from public.families%')),
    ('0254', 'restrictive manager write guards on ALL 5 wallet tables',
      not exists (select 1 from wallet_tables w
                  where to_regclass('public.'||w.t) is not null
                    and w.t not in (select t from guarded))
      and exists (select 1 from wallet_tables w where w.t in (select t from guarded))),
    ('0275', 'restrictive manager write guards on the finance group too',
      not exists (select 1 from finance_tables f
                  where to_regclass('public.'||f.t) is not null
                    and f.t not in (select t from guarded))
      and exists (select 1 from finance_tables f where f.t in (select t from guarded)))
)
select version,
       what,
       case when present then 'present in schema' else 'NOT present' end as schema_state,
       case when exists (select 1 from supabase_migrations.schema_migrations m
                         where m.version = probe.version)
            then 'recorded' else 'unrecorded' end as ledger_state
from   probe
order  by version;
