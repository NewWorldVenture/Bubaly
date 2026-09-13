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
