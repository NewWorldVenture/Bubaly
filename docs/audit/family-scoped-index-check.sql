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
  select array_agg(t.name order by t.name) into missing
  from (values
    ('sync_job_runs'), ('guardian_routing_rules'), ('social_post_variants'),
    ('activation_events'), ('allowance_rules'), ('meal_vote_options'),
    ('meal_vote_ballots'), ('move_boxes'), ('crm_contacts')
  ) as t(name)
  join pg_class c on c.relname = t.name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'r'
    and not exists (
      select 1
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = c.oid and a.attname = 'family_id'
    );

  if missing is not null then
    raise exception 'A-14 FAIL: family-scoped read has no family_id-leading index on %', missing;
  end if;
  raise notice 'A-14 OK: all nine family-scoped tables keep a family_id-leading index';
end $$;

-- The check must be able to fail. Drop one index inside a transaction that is
-- rolled back, and confirm the assertion above notices — a probe that cannot
-- detect the state it forbids is decoration.
do $$
declare
  detected boolean := false;
begin
  begin
    drop index public.idx_allowance_rules_family;
    if not exists (
      select 1 from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where c.relname = 'allowance_rules' and a.attname = 'family_id'
    ) then
      detected := true;
    end if;
    -- Undo it: this is a probe, not a migration.
    raise exception 'rollback the probe';
  exception when others then
    if sqlerrm <> 'rollback the probe' then raise; end if;
  end;

  if not detected then
    raise exception 'A-14 FAIL: the check cannot see a missing index, so it proves nothing';
  end if;
  raise notice 'A-14 OK: the check detects a dropped index (verified, then rolled back)';
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
-- Deliberately scoped to `families`. 191 further constraints reference
-- `family_members` (158), `vacations` (22) and `child_wallets` (11) — those are
-- member-reference columns rather than the RLS predicate, so indexing them
-- accelerates member removal and nothing else, and 191 indexes' worth of write
-- amplification is a tradeoff for the owner. Recorded in finalaudit.md; asserting
-- it here would encode a decision nobody has made.
do $$
declare
  unindexed text[];
begin
  select array_agg(format('%s.%s', child, col) order by child, col) into unindexed
  from (
    select cl.relname as child, con.conrelid, con.conkey[1] as attnum,
           (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) as col
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_class pa on pa.oid = con.confrelid
    join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
    where con.contype = 'f'
      and con.confdeltype in ('c', 'n')
      and pa.relname = 'families'
      -- Single-column keys only: a composite key's leading column is a separate
      -- question and there are none of these today.
      and array_length(con.conkey, 1) = 1
  ) fk
  where not exists (
    select 1 from pg_index i where i.indrelid = fk.conrelid and i.indkey[0] = fk.attnum
  );

  if unindexed is not null then
    raise exception 'S-05 FAIL: % family-erasure constraint(s) have no leading index, so deleting a family scans the whole table for each: %',
      array_length(unindexed, 1), array_to_string(unindexed, ', ');
  end if;
  raise notice 'S-05 OK: every CASCADE/SET NULL constraint referencing families has a leading index';
end $$;

-- And this half must be able to fail too, for the same reason as the one above.
do $$
declare
  detected boolean := false;
begin
  begin
    drop index public.idx_ai_messages_family_id;
    if exists (
      select 1
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_class pa on pa.oid = con.confrelid
      where con.contype = 'f' and con.confdeltype in ('c','n')
        and pa.relname = 'families' and cl.relname = 'ai_messages'
        and not exists (
          select 1 from pg_index i
          where i.indrelid = con.conrelid and i.indkey[0] = con.conkey[1]
        )
    ) then
      detected := true;
    end if;
    raise exception 'rollback the probe';
  exception when others then
    if sqlerrm <> 'rollback the probe' then raise; end if;
  end;

  if not detected then
    raise exception 'S-05 FAIL: the erasure check cannot see a dropped index, so it proves nothing';
  end if;
  raise notice 'S-05 OK: the erasure check detects a dropped index (verified, then rolled back)';
end $$;
