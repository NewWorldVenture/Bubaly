-- Bubaly :: money write boundary — READ ONLY, changes nothing
-- ============================================================================
-- One question, answered per table: can a non-manager write to this money
-- table right now?
--
-- This exists because the question kept being answered by reading migration
-- files instead of the database. docs/runbooks/LB-016-...md §2 argues the
-- boundary is closed BECAUSE 0254 added restrictive guards — which is sound
-- Postgres semantics, and is proved in CI by wallet-write-rls-check.sql. But
-- CI proves it *after replaying every migration*. Production has not replayed
-- them, so on production that argument is a claim about provenance, not a
-- reading of state. On 2026-09-11 a production pre-flight showed no restrictive
-- policy at all on wallet_transactions, which is not what the runbook said to
-- expect. Hence this file: state, not provenance.
--
-- The distinction the verdict column exists to preserve, because three reviews
-- have collapsed it:
--
--   A stray permissive write policy is REPORTABLE but not EXPLOITABLE when a
--   restrictive guard is present, because a restrictive policy ANDs with the
--   union of the permissive ones. The same stray with NO restrictive guard is
--   exploitable. Those look identical in a policy listing sorted by name.
--
-- Validated against PostgreSQL 16.13 on a fixture covering all five states
-- (guarded; stray-but-guarded; stray-and-unguarded; gated-and-unguarded;
-- table absent) before being committed.

with money_tables(t) as (
  values ('family_wallets'),('child_wallets'),('wallet_buckets'),('wallet_transactions'),('wallet_rules'),
         ('financial_accounts'),('transactions'),('budgets'),('bills'),('savings_goals')
), pol as (
  select m.t,
         to_regclass('public.'||m.t) as reg,
         c.relrowsecurity as rls_on,
         p.polname, p.polpermissive, p.polcmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid),'') ||
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid),'') as expr
  from money_tables m
  left join pg_class c on c.relname = m.t and c.relnamespace = 'public'::regnamespace
  left join pg_policy p on p.polrelid = c.oid
)
select t as table_name,
       (reg is not null) as table_exists,
       coalesce(rls_on, false) as rls_enabled,
       -- polcmd: a=INSERT, w=UPDATE, d=DELETE, *=ALL. SELECT ('r') is out of
       -- scope here: reads are gated on membership by design (runbook §3).
       count(*) filter (where not polpermissive)                      as restrictive_guards,
       count(*) filter (where polpermissive and polcmd in ('a','w','d','*')) as permissive_writes,
       count(*) filter (where polpermissive and polcmd in ('a','w','d','*')
                          and expr not like '%can_manage_family%')    as ungated_permissive_writes,
       string_agg(polname, ', ') filter (where polpermissive and polcmd in ('a','w','d','*')
                          and expr not like '%can_manage_family%')    as offending_policies,
       case
         when reg is null then 'table absent'
         -- Checked FIRST and deliberately: with RLS off, every policy below is
         -- inert and the table is writable by anyone holding the table grant.
         -- A no-policy table then reads "no ungated write" and looks clean,
         -- which is the most dangerous way for this query to be wrong.
         -- moneyWriteVerdict in the audit script has this same blind spot: its
         -- `unguarded` list only contains tables that have at least one write
         -- policy, so a table with none is absent from the verdict entirely.
         when not coalesce(rls_on, false) then '*** OPEN - RLS DISABLED ***'
         when count(*) filter (where polpermissive and polcmd in ('a','w','d','*')) = 0
           then 'CLOSED - RLS on, no write policy grants access'
         when count(*) filter (where polpermissive and polcmd in ('a','w','d','*')
                                 and expr not like '%can_manage_family%') = 0 then 'CLOSED - every write is manager-gated'
         when count(*) filter (where not polpermissive) > 0 then 'closed by restrictive guard'
         else '*** OPEN - non-manager can write ***'
       end as verdict
from pol
group by t, reg, rls_on
order by t;
