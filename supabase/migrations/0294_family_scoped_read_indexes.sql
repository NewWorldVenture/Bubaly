-- Bubaly :: 0294 Index the family-scoped reads that were scanning whole tables
-- ----------------------------------------------------------------------------
-- Every one of these tables is read as "this family's rows" and had no index
-- leading on `family_id`, so each read was a sequential scan of the WHOLE table
-- — every other household's rows included. The cost therefore grows with the
-- platform rather than with the family, which is the shape that looks fine in
-- staging and is a page-load problem at scale.
--
-- Measured on `sync_job_runs` with 700,000 rows across 2,000 households (a year
-- of quarter-hourly calendar syncs), running the query the sync history page
-- actually issues:
--
--   before   Parallel Seq Scan   38,258 buffers   ~46 ms
--   after    Index Scan               54 buffers   ~0.30 ms
--
-- ~150x faster, ~700x fewer buffers, and — the part that matters — bounded by
-- one family's rows instead of the whole table.
--
-- RLS makes this worse than it looks: the policies gate on `family_id`, so the
-- predicate is applied to every row of every one of these tables on every read,
-- whether or not the application also filters on it.
--
-- Column order follows the query each page issues, so the index serves the
-- filter AND the sort:
--   sync_job_runs           .eq(family_id).order(started_at desc)
--   guardian_routing_rules  .eq(family_id).order(priority asc)
--   social_post_variants    .eq(family_id).eq(post_id)
--   activation_events       .eq(family_id).eq(milestone)
--   the rest                .eq(family_id) alone
--
-- `if not exists` throughout: this migration is additive and re-runnable, and
-- an environment that already grew one of these by hand must not fail the chain.

create index if not exists idx_sync_job_runs_family_started
  on public.sync_job_runs (family_id, started_at desc);

create index if not exists idx_guardian_routing_rules_family_priority
  on public.guardian_routing_rules (family_id, priority);

create index if not exists idx_social_post_variants_family_post
  on public.social_post_variants (family_id, post_id);

create index if not exists idx_activation_events_family_milestone
  on public.activation_events (family_id, milestone);

create index if not exists idx_allowance_rules_family
  on public.allowance_rules (family_id);

create index if not exists idx_meal_vote_options_family
  on public.meal_vote_options (family_id);

create index if not exists idx_meal_vote_ballots_family
  on public.meal_vote_ballots (family_id);

create index if not exists idx_move_boxes_family
  on public.move_boxes (family_id);

create index if not exists idx_crm_contacts_family
  on public.crm_contacts (family_id);

-- Verify: every table touched above now has an index LEADING on family_id.
-- Leading matters — a composite that merely mentions the column somewhere does
-- not serve a family-scoped scan.
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
  where not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where n.nspname = 'public' and c.relname = t.name and a.attname = 'family_id'
  );

  if missing is not null then
    raise exception '0294 FAILED: still no family_id-leading index on %', missing;
  end if;
  raise notice '0294 OK: all nine family-scoped tables have a family_id-leading index.';
end $$;
