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
with probe(version, what, present) as (
  values
    ('0249', 'mark_model_dirty() skips a deleted family',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'mark_model_dirty'
                and pg_get_functiondef(p.oid) like '%not exists (select 1 from public.families%')),
    ('0254', 'restrictive manager guards on wallet_transactions',
      exists (select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid
              where c.relname = 'wallet_transactions' and not pol.polpermissive)),
    ('0275', 'no permissive write policy on bills lacking can_manage_family',
      not exists (select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid
                  where c.relname = 'bills' and pol.polpermissive
                    and pol.polcmd in ('a','w','d','*')
                    and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ||
                        coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                        not like '%can_manage_family%'))
)
select version,
       what,
       case when present then 'present in schema' else 'NOT present' end as schema_state,
       case when exists (select 1 from supabase_migrations.schema_migrations m
                         where m.version = probe.version)
            then 'recorded' else 'unrecorded' end as ledger_state
from   probe
order  by version;
