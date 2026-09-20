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
set -uo pipefail

psql -v ON_ERROR_STOP=1 -q <<'SQL'
\pset border 2
with verbs(v) as (values ('INSERT'),('UPDATE'),('DELETE')),

-- Only a function that can RAISE can refuse a write. set_updated_at cannot.
guardfn as (select oid from pg_proc where prosrc ~* 'raise +exception'),
guarded as (
  select distinct c.relname as tablename
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
     and t.tgfoid in (select oid from guardfn)),

w as (
  select tablename, cmd, permissive,
         coalesce(qual, '') || ' ' || coalesce(with_check, '') as pred
    from pg_policies
   where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE','ALL')),

-- BOTH sides expanded, so a bare FOR ALL meets its own three restrictive guards.
xw as (select tablename, v.v as cmd, permissive, pred from w, verbs v
        where w.cmd = v.v or w.cmd = 'ALL'),

-- "Bare": strip the call itself and nothing is left. A predicate that also pins
-- a column (parent_approvals' status='pending') is role-blind but constrained,
-- and is deliberately not counted here.
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

select 'tables with any role-blind write policy' as bucket,
       count(distinct tablename)::text as n from w
 where permissive = 'PERMISSIVE' and pred like '%is_family_member%'
   and pred not like '%can_manage_family%'
union all
select 'OPEN tables (bare, unguarded, no raising trigger)', count(distinct tablename)::text from open_pairs
union all
select 'OPEN (table, verb) pairs', count(*)::text from open_pairs
union all
select 'tables carrying a raise-exception trigger', count(*)::text from guarded
union all
select 'tables carrying set_updated_at (guards NOTHING)', count(distinct c.relname)::text
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
 where n.nspname = 'public' and not t.tgisinternal and p.proname = 'set_updated_at';

\echo ''
\echo 'The open tables, with the verbs each still takes from any member:'
with verbs(v) as (values ('INSERT'),('UPDATE'),('DELETE')),
guardfn as (select oid from pg_proc where prosrc ~* 'raise +exception'),
guarded as (select distinct c.relname as tablename from pg_trigger t
   join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal and t.tgfoid in (select oid from guardfn)),
w as (select tablename, cmd, permissive, coalesce(qual,'') || ' ' || coalesce(with_check,'') as pred
    from pg_policies where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE','ALL')),
xw as (select tablename, v.v as cmd, permissive, pred from w, verbs v where w.cmd = v.v or w.cmd = 'ALL'),
bare as (select distinct tablename, cmd from xw
   where permissive = 'PERMISSIVE' and pred like '%is_family_member%' and pred not like '%can_manage_family%'
     and regexp_replace(pred, '[()\s]|is_family_member|family_id|::text|public\.', '', 'g') = ''),
restricted as (select distinct tablename, cmd from xw where permissive = 'RESTRICTIVE')
select b.tablename, string_agg(b.cmd, ',' order by b.cmd) as still_open_to_any_member
  from bare b
 where not exists (select 1 from restricted r where r.tablename = b.tablename and r.cmd = b.cmd)
   and not exists (select 1 from guarded g where g.tablename = b.tablename)
 group by b.tablename order by b.tablename;
SQL
