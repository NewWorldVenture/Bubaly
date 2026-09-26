#!/usr/bin/env bash
# ── How many tables still take a write from any household member? ────────────
#
# This is a MEASUREMENT, not a gate. It prints three buckets and exits 0 either
# way; run-probes.sh globs `*-check.sql` and will not pick it up. The reason it
# exists is that the number was quoted three times in this audit from three
# different derivations, and two of them were wrong — so the derivation now
# lives in one file that anyone can re-run.
#
#   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly bash docs/audit/role-blind-write-census.sh
#
# ── The two errors this query is written to avoid ────────────────────────────
#
# 1. "Exclude any table that has a trigger." `set_updated_at` is on 406 tables
#    and guards nothing at all. That proxy reported 26 open tables where there
#    are 247 — a tenfold over-credit, and in the direction that makes a tree
#    look safe. Only trigger functions whose source matches `raise +exception`
#    can refuse a write, so only those count.
#
# 2. Comparing `FOR ALL` against per-verb policies WITHOUT EXPANDING EITHER. A
#    bare `FOR ALL … is_family_member` policy is covered when restrictive
#    INSERT, UPDATE and DELETE guards exist beside it — which is exactly the
#    shape 0322-0325 left behind. Matching cmd-to-cmd reported thirteen tables
#    this audit had already closed as still open. Both sides are expanded into
#    the three verbs before they are compared.
#
# 3. Treating "the table has a raising trigger" as "the table has a ROLE guard".
#    Nine of the seventeen guard functions are role-aware; eight are not.
#    `reference_shares_family` checks that a referenced row is in the same
#    family and says nothing about who may write; `validate_marketplace_
#    negotiation_round` and `sync_blog_image_provenance` are validation. So
#    grocery_items, meal_plans, moves and move_tasks were credited with a
#    boundary they do not have, and the true open count is 251 rather than 247.
#    Small in magnitude and exactly the AUTHZ-014 shape: a TABLE-granular bucket
#    standing in for a COLUMN-granular truth. Both numbers are printed below,
#    and the four tables in the gap are named, because collapsing them into one
#    figure is how the distinction gets lost again.
#
# ── What "open" means here, and what it does NOT mean ────────────────────────
#
# Open = the write predicate is NOTHING BUT `is_family_member(family_id)`, there
# is no restrictive policy on that verb, and no raise-exception trigger on the
# table. `is_family_member` answers "is this user in the household" and ignores
# role, so a child's own JWT satisfies it.
#
# That is NOT a defect count. Most of these tables are open ON PURPOSE — the
# application has no manager gate on them either, and restricting them would
# break the product for the members it is built for. The defect is the narrower
# thing: a table the APPLICATION gates on `isManager` while the DATABASE does
# not, because a server action is not a boundary against a JWT holder. Deciding
# which is which needs the call sites read one at a time; CENSUS-002 is what
# happened when a name on this list was taken for a verdict.
#
# ── One derivation, used three times ────────────────────────────────────────
# The `open_pairs` query below used to be written out TWICE in this file — once
# for the counts and once for the table list — and a third time, differently, in
# role-blind-write-triage.sh. That third copy used a looser definition of "bare"
# and reported 251 open tables where this file reported 248, because it counted
# `marketplace_listings`, `marketplace_stores` and `notifications`, whose
# predicates pin a column beyond `is_family_member` (`member_id =
# marketplace_member_id(family_id)`, `user_id = auth.uid()`). Those three are
# role-blind but CONSTRAINED, which the definition below deliberately excludes.
#
# A number that disagrees with itself is how CENSUS-001, -002 and -003 each
# happened. So the CTEs now live in $OPEN_PAIRS_CTE, one copy, and both this
# script and the triage read from it. `--tables` prints just the bare names,
# which is the interface the triage uses.
set -uo pipefail

OPEN_PAIRS_CTE=$(cat <<'CTE'
with verbs(v) as (values ('INSERT'),('UPDATE'),('DELETE')),

-- Only a function that can RAISE can refuse a write. set_updated_at cannot.
-- And only a raising function that consults the ROLE is a role boundary:
-- reference_shares_family raises, and guards cross-family references, not who.
anyfn as (select oid from pg_proc where prosrc ~* 'raise +exception'),
rolefn as (select oid from pg_proc where prosrc ~* 'raise +exception'
             and prosrc ~* 'can_manage_family|is_manager|role +in +\(|role +='),
trig_tables as (
  select distinct c.relname as tablename, t.tgfoid
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal),
anyguard  as (select distinct tablename from trig_tables where tgfoid in (select oid from anyfn)),
guarded   as (select distinct tablename from trig_tables where tgfoid in (select oid from rolefn)),

w as (
  select tablename, cmd, permissive,
         coalesce(qual, '') || ' ' || coalesce(with_check, '') as pred
    from pg_policies
   where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE','ALL')),

-- BOTH sides expanded, so a bare FOR ALL meets its own three restrictive guards.
xw as (select tablename, v.v as cmd, permissive, pred from w, verbs v
        where w.cmd = v.v or w.cmd = 'ALL'),

-- "Bare": strip the call itself and nothing is left. A predicate that also pins
-- a column (parent_approvals' status='pending', marketplace_listings'
-- member_id = marketplace_member_id(family_id), notifications' user_id =
-- auth.uid()) is role-blind but constrained, and is deliberately not counted
-- here. Loosening this is what made the triage's private copy disagree by three.
bare as (
  select distinct tablename, cmd from xw
   where permissive = 'PERMISSIVE'
     and pred like '%is_family_member%'
     and pred not like '%can_manage_family%'
     and regexp_replace(pred, '[()\s]|is_family_member|family_id|::text|public\.', '', 'g') = ''),

restricted as (select distinct tablename, cmd from xw where permissive = 'RESTRICTIVE'),

open_pairs as (
  select b.* from bare b
   where not exists (select 1 from restricted r
                      where r.tablename = b.tablename and r.cmd = b.cmd)
     and not exists (select 1 from guarded g where g.tablename = b.tablename))
CTE
)

# `--tables` is the triage's interface: bare table names, one per line, nothing
# else on stdout. Anything that needs the list must come through here.
if [ "${1:-}" = "--tables" ]; then
  psql -v ON_ERROR_STOP=1 -tAq <<SQL
$OPEN_PAIRS_CTE
select distinct tablename from open_pairs order by 1;
SQL
  exit $?
fi

psql -v ON_ERROR_STOP=1 -q <<SQL
\pset border 2
$OPEN_PAIRS_CTE
select 'tables with any role-blind write policy' as bucket,
       count(distinct tablename)::text as n from w
 where permissive = 'PERMISSIVE' and pred like '%is_family_member%'
   and pred not like '%can_manage_family%'
union all
select 'OPEN tables (bare, unguarded, no raising trigger)', count(distinct tablename)::text from open_pairs
union all
select 'OPEN (table, verb) pairs', count(*)::text from open_pairs
union all
select 'tables carrying a ROLE-AWARE raising trigger', count(*)::text from guarded
union all
select 'tables carrying a raising trigger that is NOT role-aware',
       (select count(*)::text from (select tablename from anyguard except select tablename from guarded) x)
union all
select '  of those, still open once it is not miscounted',
       coalesce((select string_agg(distinct o.tablename, ', ' order by o.tablename) from open_pairs o
                  where o.tablename in (select tablename from anyguard except select tablename from guarded)), 'none')
union all
select 'tables carrying set_updated_at (guards NOTHING)', count(distinct c.relname)::text
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
 where n.nspname = 'public' and not t.tgisinternal and p.proname = 'set_updated_at';
SQL

echo ''
echo 'The open tables, with the verbs each still takes from any member:'
psql -v ON_ERROR_STOP=1 -q <<SQL
\pset border 2
$OPEN_PAIRS_CTE
select tablename, string_agg(cmd, ',' order by cmd) as still_open_to_any_member
  from open_pairs group by tablename order by tablename;
SQL
