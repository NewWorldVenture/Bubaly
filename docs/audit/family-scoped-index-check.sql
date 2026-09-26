-- ── A-14 / S-05: family-scoped reads and family erasure keep a USABLE index ──
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/family-scoped-index-check.sql
--
-- Both checks in this file are ABSENCE checks. Each builds the set of things
-- that ought to be indexed, subtracts the ones that are, and passes when
-- nothing is left over. So a green here means "the query returned no rows",
-- and that sentence is not the same as "every family-scoped read is indexed",
-- because the query returns no rows for three kinds of reason that have
-- nothing to do with a working index:
--
--   * A NAME THAT RESOLVES TO NOTHING. A-14 used to join its nine table names
--     to pg_class with an INNER join, so dropping, renaming, moving or
--     partitioning `crm_contacts` made it print "all nine family-scoped tables
--     keep a family_id-leading index" over eight of them. A-14 now has the
--     shape of the migration it verifies (0294_family_scoped_read_indexes.sql
--     :68-81, `from (values …) where not exists (…)`), in which a name that
--     does not resolve lands in `missing` and is red on its own. The control
--     below still resolves every name FIRST, so that case is reported as
--     UNPROVEN with its real cause instead of as a missing index.
--   * AN EMPTY POPULATION. S-05 enumerates the CASCADE/SET NULL constraints
--     referencing `families`. If that ever comes back EMPTY — `families`
--     renamed, the `confdeltype` letters changed, every such key gone
--     composite — then `unindexed` is null and S-05 passes having examined
--     nothing at all.
--   * AN INDEX THAT IS IN THE CATALOGUE AND SERVES NOTHING. Both checks used to
--     accept ANY pg_index row whose indkey[0] was the column. An INVALID index
--     — which is what an interrupted `create index concurrently` leaves behind
--     (family-erasure-indexes-concurrently.sql:14-20), and that file is the
--     production apply path 0321_family_erasure_indexes.sql:44-50 prescribes —
--     passed; so did `(family_id) where false` and `using brin (family_id)`.
--     Each one kept A-14, S-05 and both "must be able to fail" blocks green
--     while every read and every family-delete RI check was still, in effect,
--     a scan of the whole table.
--
-- A RENAMED COLUMN, by contrast, fails safe: if `family_id` became
-- `household_id` tomorrow, A-14's attnum lookup returns null, every table
-- lands in `missing`, and the probe goes red as it should. (S-05 reads the
-- column from the constraint, so it is indifferent to the name.)
--
-- ── ONE definition of each rule ─────────────────────────────────────────────
-- Everything below — the control, A-14, S-05 and both "must be able to fail"
-- blocks — asks through these functions and through nothing else, so no block
-- can quietly test a hand-written copy of another block's predicate (which is
-- how the A-14 fail block came to re-ask a `relname`-only lookup, and how the
-- control's "can still answer no" leg came to prove nothing about the lookup
-- it was written to guard). They live in pg_temp and vanish with the session;
-- they are definitions, not assertions — the first assertion is the control.
--
-- MECHANISM. Nothing here refuses a write, so there is no actor to control.
-- The invariant is "the planner has an index path for `<col> = $1`", and what
-- the probe asserts is the catalogue shape that gives it one
-- (`pg_temp.fsi_serving_index`):
--
--   * access method btree (`pg_am.amname = 'btree'`);
--   * `indisvalid and indisready and indislive` — the idiom of
--     0261_home_briefs_kind_uniqueness.sql:54-56. Postgres itself never
--     produces a not-ready or not-live index that is still valid, so
--     `indisvalid` is the conjunct that bites and the one exercised below;
--   * the FIRST key column is the plain column (`indkey[0] = attnum`). An
--     expression-led index has indkey[0] = 0, which is no column's attnum, so
--     it was never accepted and is not a new case;
--   * TOTAL, or partial on exactly `(<col> IS NOT NULL)` — the one predicate
--     the planner proves from a strict `<col> = $1`, generic plan included
--     (checked with `set enable_seqscan = off` and a prepared
--     `select 1 … where family_id = $1 for key share`: Index Scan). Any other
--     predicate leaves `<col> = $1` with no index path at all.
--
-- `indexprs` is deliberately NOT required to be null: an index whose leading
-- key is the plain column serves the scan whatever its later keys are.
--
-- What it deliberately does NOT do: it does not EXPLAIN the nine reads and
-- assert "Index Scan". On a freshly bootstrapped probe database these tables
-- hold a handful of rows, where the planner correctly prefers a sequential
-- scan whether or not the index exists — so that control would flag a
-- perfectly healthy schema, which is worse than no control at all.
--
-- WHERE THE INDEXES COME FROM. `grep -rl` for `idx_allowance_rules_family`
-- and `idx_crm_contacts_family` across supabase/migrations returns exactly
-- 0294_family_scoped_read_indexes.sql, and for `idx_ai_messages_family_id`
-- exactly 0321_family_erasure_indexes.sql. The only `drop index` statements in
-- the tree are 0260 (idx_emergency_sessions_active, dropped and re-created),
-- 0285 (four uniq_*/uq_*) and 0349 (uq_family_recipes_source); no
-- `execute format(…)` loop builds a `drop index`, a `set schema` or a table
-- rename (the loops that exist drop and re-create policies, triggers and
-- CHECK constraints), the only `rename` is 0184's `alter function`, and there
-- is no `drop table`. So 0294 and 0321 are the last word on these indexes —
-- not an earlier migration being replayed from memory. Neither migration's own
-- verify step checks validity or partiality (0294:74-81 asks only for a
-- family_id-leading pg_index row, and 0321's list of 36 "lacking a leading
-- index" omits the three RECORDED EXCEPTIONS below, so it counted a partial
-- index as a leading one too), so a green from either says less than this
-- file does.

-- The ONE copy of A-14's table list. It mirrors the list 0294 indexed and
-- verified (0294_family_scoped_read_indexes.sql:69-73); the control and A-14
-- both read it from here, so the two can no longer disagree about what A-14
-- covers.
create function pg_temp.fsi_a14_tables()
returns setof text
language sql as $fn$
  values ('sync_job_runs'), ('guardian_routing_rules'), ('social_post_variants'),
         ('activation_events'), ('allowance_rules'), ('meal_vote_options'),
         ('meal_vote_ballots'), ('move_boxes'), ('crm_contacts')
$fn$;

-- `public.<name>` as a plain table, or null. Keys on all three fields A-14
-- depends on — name, schema `public`, relkind 'r' — and the control proves it
-- still answers null for each of the three ways a name can fail to be that.
create function pg_temp.fsi_plain_public_table(p_name text)
returns oid
language sql as $fn$
  select c.oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
  where c.relname = p_name and ns.nspname = 'public' and c.relkind = 'r'
$fn$;

-- True when relation p_rel has an index the planner can use for
-- `<column p_attnum> = $1` (the MECHANISM paragraph above). p_any_partial
-- relaxes ONLY the total-or-IS-NOT-NULL rule, and only S-05's recorded
-- exceptions pass it.
create function pg_temp.fsi_serving_index(p_rel oid, p_attnum int2, p_any_partial boolean default false)
returns boolean
language sql as $fn$
  select exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class ic on ic.oid = i.indexrelid
    join pg_catalog.pg_am am on am.oid = ic.relam
    join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = p_rel
      and i.indkey[0] = p_attnum
      and am.amname = 'btree'
      and i.indisvalid and i.indisready and i.indislive
      and (i.indpred is null
           or pg_catalog.pg_get_expr(i.indpred, i.indrelid)
                = format('(%s IS NOT NULL)', quote_ident(a.attname))
           or p_any_partial)
  )
$fn$;

-- A-14's whole predicate: the names that do NOT resolve to a plain public
-- table with a serving index on `family_id`.
create function pg_temp.fsi_a14_missing()
returns text[]
language sql as $fn$
  select array_agg(t.name order by t.name)
  from pg_temp.fsi_a14_tables() as t(name)
  where not pg_temp.fsi_serving_index(
          pg_temp.fsi_plain_public_table(t.name),
          (select a.attnum from pg_catalog.pg_attribute a
            where a.attrelid = pg_temp.fsi_plain_public_table(t.name)
              and a.attname = 'family_id' and not a.attisdropped))
$fn$;

-- S-05's population: single-column CASCADE/SET NULL foreign keys from a
-- `public` table to a relation named `families`. The parent is matched by
-- NAME, as S-05 always has — that is the wider net (a `families` in any
-- schema is examined), and the control pins separately that `public.families`
-- is a plain table and is the parent of the rows it relies on.
create function pg_temp.fsi_s05_population()
returns table (child name, col name, conrelid oid, attnum int2, parent oid)
language sql as $fn$
  select cl.relname, a.attname, con.conrelid, con.conkey[1], con.confrelid
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class cl on cl.oid = con.conrelid
  join pg_catalog.pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
  join pg_catalog.pg_class pa on pa.oid = con.confrelid
  left join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
  where con.contype = 'f'
    and con.confdeltype in ('c', 'n')
    and pa.relname = 'families'
    -- Single-column keys only: a composite key's leading column is a separate
    -- question and there are none of these today.
    and array_length(con.conkey, 1) = 1
$fn$;

-- RECORDED EXCEPTIONS — three real erasure scans, found by tightening S-05.
-- Each is ON DELETE CASCADE and its ONLY family_id-leading index is partial on
-- an unrelated predicate, so `delete from only <t> where family_id = $1` has
-- no index path (`set enable_seqscan = off` still plans a Seq Scan on all
-- three; ai_messages, for contrast, plans its index):
--
--   emergency_sessions.family_id  idx_emergency_sessions_active  where ended_at is null    0260:62-65 (re-created; first 0093:153)
--   library_progress.family_id    idx_library_progress_saved     where saved = true        0284:85-86
--   trust_delegations.family_id   idx_trust_delegations_active   where revoked_at is null  0093:83
--
-- The old S-05 was green over all three. The fix is a total `(family_id)`
-- index on each — a migration, which is not this file's to write, so they are
-- RECORDED here rather than waved through: each must still be led by a valid
-- btree index (only totality is relaxed), the control requires every entry to
-- name a member of S-05's population, and S-05 goes red the moment one of
-- them gains a total index — so this list can only shrink, and cannot outlive
-- the debt it records and then hide a regression on that table.
create function pg_temp.fsi_s05_partial_only()
returns setof text
language sql as $fn$
  values ('emergency_sessions.family_id'), ('library_progress.family_id'),
         ('trust_delegations.family_id')
$fn$;

-- S-05's whole predicate: population members with no serving index.
create function pg_temp.fsi_s05_unindexed()
returns text[]
language sql as $fn$
  select array_agg(format('%s.%s', p.child, p.col) order by p.child, p.col)
  from pg_temp.fsi_s05_population() p
  where not pg_temp.fsi_serving_index(
          p.conrelid, p.attnum,
          format('%s.%s', p.child, p.col) in (select pg_temp.fsi_s05_partial_only()))
$fn$;

-- Recorded exceptions that no longer need to be exceptions.
create function pg_temp.fsi_s05_healed()
returns text[]
language sql as $fn$
  select array_agg(format('%s.%s', p.child, p.col) order by p.child, p.col)
  from pg_temp.fsi_s05_population() p
  where format('%s.%s', p.child, p.col) in (select pg_temp.fsi_s05_partial_only())
    and pg_temp.fsi_serving_index(p.conrelid, p.attnum, false)
$fn$;

-- Run DDL, evaluate a check against the result, undo the DDL, return what the
-- check saw. The undo is a raised exception caught one level up — this is a
-- probe, not a migration — and any OTHER error is re-raised, so a mutation
-- that fails to apply is red rather than a silent "detected".
create function pg_temp.fsi_after(p_ddl text, p_check text)
returns text[]
language plpgsql as $fn$
declare
  seen text[];
begin
  begin
    execute p_ddl;
    execute p_check into seen;
    raise exception 'fsi: undo the mutation';
  exception when others then
    if sqlerrm <> 'fsi: undo the mutation' then raise; end if;
  end;
  return coalesce(seen, '{}');
end $fn$;

-- ── NEGATIVE CONTROL for A-14 and S-05 below, and it runs FIRST ─────────────
--
-- The control is the same machinery, asked the other way round and required
-- to LAND: every name A-14 subtracts from must RESOLVE, the resolution must
-- still be able to say NO, and the population S-05 subtracts from must be
-- NON-EMPTY, hang off `public.families`, and contain the rows the S-05 blocks
-- rest on. It reads the catalogue; the only objects it creates are scratch
-- relations inside a rolled-back subtransaction. It seeds no rows and invents
-- no UUIDs, so it cannot collide with a sibling probe's anchors when
-- run-probes.sh runs all of them in sequence against one database.
do $$
declare
  unresolved text[];
  n_a14      int;
  said       text[];
  pub_fam    oid;
  fam_fks    int;
  ai_fks     int;
  stray      text[];
  failures   text[] := '{}';
begin
  -- 1. Every name A-14 subtracts from must resolve to a plain `public` table.
  select count(*) into n_a14 from pg_temp.fsi_a14_tables();
  select array_agg(t.name order by t.name) into unresolved
  from pg_temp.fsi_a14_tables() as t(name)
  where pg_temp.fsi_plain_public_table(t.name) is null;

  if unresolved is not null then
    failures := array_append(failures, format(
      'CONTROL FAILED: %s of A-14''s %s names do not resolve to a plain table in `public` (%s), so A-14 would be reporting on a table that is not there',
      array_length(unresolved, 1), n_a14, array_to_string(unresolved, ', ')));
  end if;

  -- 2. The SAME resolution function must answer NO for each way a name can
  -- fail to be a plain public table — and YES for its plain twin, so a NO is
  -- the shape talking and not a function that answers NO to everything.
  -- Drop `ns.nspname = 'public'` from it and the pg_temp twin resolves; drop
  -- `c.relkind = 'r'` and the partitioned twin does; drop the name match and
  -- the absent name does.
  said := pg_temp.fsi_after(
    'create table public.bubaly_fsi_ctl_plain (family_id uuid);
     create table public.bubaly_fsi_ctl_parted (family_id uuid) partition by list (family_id);
     create temp table bubaly_fsi_ctl_elsewhere (family_id uuid)',
    $q$select array[
       (pg_temp.fsi_plain_public_table('bubaly_fsi_ctl_plain')     is not null)::text,
       (pg_temp.fsi_plain_public_table('bubaly_fsi_ctl_parted')    is not null)::text,
       (pg_temp.fsi_plain_public_table('bubaly_fsi_ctl_elsewhere') is not null)::text,
       (pg_temp.fsi_plain_public_table('bubaly_fsi_ctl_absent')    is not null)::text]$q$);

  if said is distinct from array['true', 'false', 'false', 'false'] then
    failures := array_append(failures, format(
      'CONTROL FAILED: the resolution A-14 uses answered %s for (plain public table, partitioned public table, table outside public, absent name); it must answer {true,false,false,false}, or its "resolves" says nothing about the nine names',
      said));
  end if;

  -- 3. S-05's population must be non-empty, and `public.families` — the table
  -- S-05 is about — must be a plain table that is the parent of some of it.
  pub_fam := pg_temp.fsi_plain_public_table('families');
  select count(*) into fam_fks
  from pg_temp.fsi_s05_population() p
  where p.parent = pub_fam;

  if pub_fam is null then
    failures := array_append(failures,
      'CONTROL FAILED: `public.families` is not a plain table, so S-05''s by-name parent match is examining some other `families` or nothing');
  elsif fam_fks = 0 then
    failures := array_append(failures,
      'CONTROL FAILED: not one single-column CASCADE/SET NULL constraint referencing `public.families` is visible, so the S-05 check below passes having examined nothing');
  end if;

  -- 4. And that population must still contain the row the S-05 detection
  -- block rests on: it degrades `idx_ai_messages_family_id` and asks whether
  -- `ai_messages` gets reported, which proves nothing if `ai_messages` was
  -- never in the population. 0002_tables.sql:440 declares
  -- `family_id uuid not null references public.families(id) on delete
  -- cascade`, and 0321:54 is what indexes it.
  select count(*) into ai_fks
  from pg_temp.fsi_s05_population() p
  where p.child = 'ai_messages' and p.col = 'family_id' and p.parent = pub_fam;

  if ai_fks = 0 then
    failures := array_append(failures,
      'CONTROL FAILED: `ai_messages.family_id` is not in S-05''s population, so the S-05 detection block below is not measuring S-05''s predicate');
  end if;

  -- 5. Every recorded S-05 exception must name a member of that population.
  -- An entry that names nothing relaxes nothing today and relaxes whatever
  -- later takes the name.
  select array_agg(e.name order by e.name) into stray
  from pg_temp.fsi_s05_partial_only() as e(name)
  where not exists (
    select 1 from pg_temp.fsi_s05_population() p
    where format('%s.%s', p.child, p.col) = e.name and p.parent = pub_fam);

  if stray is not null then
    failures := array_append(failures, format(
      'CONTROL FAILED: recorded S-05 exception(s) %s are not CASCADE/SET NULL keys to `public.families`; delete them from pg_temp.fsi_s05_partial_only()',
      array_to_string(stray, ', ')));
  end if;

  -- No count is pinned in 3. 0321's "36" counts only the constraints that
  -- LACKED an index the day it was written; the real population is larger and
  -- moves legitimately whenever a table is added or retired, so a hard number
  -- would turn a healthy schema red — and a control that flags healthy rows is
  -- worse than no control.

  -- A failed control makes both halves below unreadable, so say why here,
  -- while the reason is still in hand. The invariant is not reported as
  -- holding and it is not reported as broken: it is reported as unproven, and
  -- under `psql -v ON_ERROR_STOP=1` the build is red either way.
  if array_length(failures, 1) is not null then
    raise exception 'family-scoped index invariant UNPROVEN (the control both halves rest on did not hold): %', array_to_string(failures, ' | ');
  end if;
  raise notice 'CONTROL OK: all % A-14 names resolve to plain public tables, the resolution still answers no for a partitioned, an out-of-schema and an absent name, and S-05''s population hangs off public.families (% constraints) and contains ai_messages.family_id and every recorded exception',
    n_a14, fam_fks;
end $$;

-- ── A-14: family-scoped reads do not scan whole tables ──────────────────────
--
-- A read filtered by `family_id` on a table with no index LEADING on that column
-- is a sequential scan of the whole table — every other household's rows
-- included — so its cost grows with the platform rather than with the family.
-- RLS sharpens it: the policies gate on `family_id`, so the predicate is applied
-- to every row on every read whether or not the application filters on it too.
--
-- Measured on sync_job_runs at 700,000 rows across 2,000 households, running the
-- query the sync history page issues:
--
--     before   Parallel Seq Scan   38,258 buffers   ~46 ms
--     after    Index Scan               54 buffers   ~0.30 ms
--
-- The nine tables below are the ones the application reads by `family_id` with
-- NO other selective column in the same query chain, so the family_id index is
-- the only thing standing between the page and a full scan. Tables read by
-- family_id *alongside* a primary key or another indexed column are deliberately
-- absent: there the other index already does the selective work, and adding one
-- here would buy nothing and cost write throughput. `ai_messages`,
-- `member_badges`, `marketplace_listing_shares` and `social_publish_jobs` were
-- each checked and left alone for exactly that reason.
--
-- This probe asserts against pg_index rather than against the migration text,
-- because a UNIQUE or PRIMARY KEY declaration creates a leading index too and
-- reading the SQL for that is how a check ends up with false positives.
do $$
declare
  missing text[];
begin
  missing := pg_temp.fsi_a14_missing();

  if missing is not null then
    raise exception 'A-14 FAIL: family-scoped read has no family_id-leading index on %', missing;
  end if;
  raise notice 'A-14 OK: all % family-scoped tables keep a usable family_id-leading index (btree, valid, total or partial only on family_id IS NOT NULL)',
    (select count(*) from pg_temp.fsi_a14_tables());
end $$;

-- The check must be able to fail. Degrade one index inside a transaction that
-- is rolled back, and confirm the assertion above — the same function, not a
-- copy of it — notices; a probe that cannot detect the state it forbids is
-- decoration. `allowance_rules` has exactly one family_id-leading index
-- (0294:46), so each case below leaves nothing else to serve the read. The
-- last case is the other direction: the one partial shape the planner CAN use
-- must NOT be reported, or the check would be flagging a healthy table.
-- (The INVALID case writes pg_index directly, as superuser, inside the
-- rolled-back subtransaction: it is the only way to reproduce an interrupted
-- CONCURRENTLY build inside a transaction.)
do $$
declare
  labels   text[] := array[
    'a dropped index',
    'a partial index `where false`',
    'a BRIN index',
    'an INVALID index',
    'a partial index `where family_id is not null`'];
  ddl      text[] := array[
    'drop index public.idx_allowance_rules_family',
    'drop index public.idx_allowance_rules_family;
     create index bubaly_fsi_ctl_a14_partial on public.allowance_rules (family_id) where false',
    'drop index public.idx_allowance_rules_family;
     create index bubaly_fsi_ctl_a14_brin on public.allowance_rules using brin (family_id)',
    'update pg_catalog.pg_index set indisvalid = false
      where indexrelid = ''public.idx_allowance_rules_family''::regclass',
    'drop index public.idx_allowance_rules_family;
     create index bubaly_fsi_ctl_a14_notnull on public.allowance_rules (family_id) where family_id is not null'];
  expect   boolean[] := array[true, true, true, true, false];
  reported boolean;
  failures text[] := '{}';
begin
  for k in 1 .. array_length(labels, 1) loop
    reported := 'allowance_rules' = any(
      pg_temp.fsi_after(ddl[k], 'select pg_temp.fsi_a14_missing()'));
    if reported is distinct from expect[k] then
      failures := array_append(failures, format('%s was %s', labels[k],
        case when expect[k] then 'NOT reported' else 'reported' end));
    end if;
  end loop;

  if array_length(failures, 1) is not null then
    raise exception 'A-14 FAIL: the check cannot see a missing index, so it proves nothing (%)',
      array_to_string(failures, '; ');
  end if;
  raise notice 'A-14 OK: the check detects a dropped, a `where false`, a BRIN and an INVALID index, and accepts `where family_id is not null` (verified, then rolled back)';
end $$;

select 'A-14 family-scoped index probe: ALL INVARIANTS PASSED' as result;

-- ── S-05 The erasure path, asserted generically ──────────────────────────────
--
-- The nine tables above are a LIST, and a list is only ever right about the day
-- it was written. This half names no table: every CASCADE or SET NULL foreign key
-- that references `public.families` must have an index leading on its referencing
-- column, because that is precisely the predicate the referential-integrity
-- trigger issues on a family delete —
--
--     select 1 from <child> x where x.<fkcol> = $1 for key share
--
-- — with no other column to help it. So a new child table added next month is
-- caught here rather than by a GDPR erasure request that times out half-way.
-- "An index" means a SERVING one (MECHANISM, at the top), less only the three
-- recorded exceptions in `pg_temp.fsi_s05_partial_only()`, which must still be
-- led by a valid btree index.
--
-- Measured on `ai_messages` at 200,050 rows, 50 of them the family's:
-- LockRows → Seq Scan, 4,990 buffers, 21.4 ms, 200,008 rows removed by filter;
-- with the index, LockRows → Index Scan, 55 buffers, 0.064 ms.
--
-- `ai_messages` is the example on purpose: the list above names it as one of four
-- tables "checked and left alone", on the correct grounds that its page query
-- carries another selective column. That reasoning is about the READ and says
-- nothing about the DELETE, which is how all four ended up in 0321's list.
--
-- Deliberately scoped to `families`. When 0321 was written, 191 further
-- constraints referencing `family_members` (158), `vacations` (22) and
-- `child_wallets` (11) had no leading index — those are member-reference columns
-- rather than the RLS predicate, so indexing them accelerates member removal and
-- nothing else, and 191 indexes' worth of write amplification is a tradeoff for
-- the owner. Recorded in finalaudit.md; asserting it here would encode a
-- decision nobody has made.
do $$
declare
  unindexed text[];
  healed    text[];
begin
  unindexed := pg_temp.fsi_s05_unindexed();

  if unindexed is not null then
    raise exception 'S-05 FAIL: % family-erasure constraint(s) have no leading index, so deleting a family scans the whole table for each: %',
      array_length(unindexed, 1), array_to_string(unindexed, ', ');
  end if;

  -- The exception list can only shrink: an entry that has gained a total
  -- index is no longer debt, and leaving it listed would let a later
  -- regression on that table pass as "recorded".
  healed := pg_temp.fsi_s05_healed();
  if healed is not null then
    raise exception 'S-05 FAIL: recorded exception(s) % now have a valid total index; delete them from pg_temp.fsi_s05_partial_only() so the exception cannot hide the next regression on them',
      array_to_string(healed, ', ');
  end if;

  raise notice 'S-05 OK: every CASCADE/SET NULL constraint referencing families (% of them) has a usable leading index (btree, valid, total or partial only on the column IS NOT NULL), except the % recorded partial-only exceptions (%), which are still led by a valid btree index but remain erasure scans for the owner to index',
    (select count(*) from pg_temp.fsi_s05_population()),
    (select count(*) from pg_temp.fsi_s05_partial_only()),
    (select string_agg(e, ', ' order by e) from pg_temp.fsi_s05_partial_only() e);
end $$;

-- And this half must be able to fail too, for the same reason as the one
-- above, through S-05's own function. `ai_messages` has exactly one
-- family_id-leading index (0321:54). The last two cases guard the exception
-- list from both sides: it relaxes ONLY totality (an exception whose partial
-- index goes INVALID is still reported), and it cannot outlive its debt (an
-- exception that gains a total index is reported as healed).
do $$
declare
  labels   text[] := array[
    'ai_messages: a dropped index',
    'ai_messages: a partial index `where false`',
    'ai_messages: an INVALID index',
    'ai_messages: a partial index `where family_id is not null`',
    'emergency_sessions (recorded exception): its partial index made INVALID',
    'emergency_sessions (recorded exception): a total index added'];
  ddl      text[] := array[
    'drop index public.idx_ai_messages_family_id',
    'drop index public.idx_ai_messages_family_id;
     create index bubaly_fsi_ctl_s05_partial on public.ai_messages (family_id) where false',
    'update pg_catalog.pg_index set indisvalid = false
      where indexrelid = ''public.idx_ai_messages_family_id''::regclass',
    'drop index public.idx_ai_messages_family_id;
     create index bubaly_fsi_ctl_s05_notnull on public.ai_messages (family_id) where family_id is not null',
    'update pg_catalog.pg_index set indisvalid = false
      where indexrelid = ''public.idx_emergency_sessions_active''::regclass',
    'create index bubaly_fsi_ctl_s05_healed on public.emergency_sessions (family_id)'];
  checks   text[] := array[
    'select pg_temp.fsi_s05_unindexed()',
    'select pg_temp.fsi_s05_unindexed()',
    'select pg_temp.fsi_s05_unindexed()',
    'select pg_temp.fsi_s05_unindexed()',
    'select pg_temp.fsi_s05_unindexed()',
    'select pg_temp.fsi_s05_healed()'];
  target   text[] := array[
    'ai_messages.family_id', 'ai_messages.family_id', 'ai_messages.family_id',
    'ai_messages.family_id', 'emergency_sessions.family_id',
    'emergency_sessions.family_id'];
  expect   boolean[] := array[true, true, true, false, true, true];
  reported boolean;
  failures text[] := '{}';
begin
  for k in 1 .. array_length(labels, 1) loop
    reported := target[k] = any(pg_temp.fsi_after(ddl[k], checks[k]));
    if reported is distinct from expect[k] then
      failures := array_append(failures, format('%s was %s', labels[k],
        case when expect[k] then 'NOT reported' else 'reported' end));
    end if;
  end loop;

  if array_length(failures, 1) is not null then
    raise exception 'S-05 FAIL: the erasure check cannot see a dropped index, so it proves nothing (%)',
      array_to_string(failures, '; ');
  end if;
  raise notice 'S-05 OK: the erasure check detects a dropped, a `where false` and an INVALID index, accepts `where family_id is not null`, and holds the recorded exceptions to validity and to their debt (verified, then rolled back)';
end $$;
