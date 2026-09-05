-- ============================================================================
-- 0258_home_briefs_kind.sql — a brief is a delivery, not just a snapshot.
-- ----------------------------------------------------------------------------
-- `home_briefs` (0110) stores one row per family per day: the numbers behind
-- the home screen's "here is your week". Spec §49 asks for more than that —
-- a morning brief AND an evening recap, an honest list of what Bubaly actually
-- handled, and a record of when the family was told. Without those:
--
--   * a second brief cannot exist for the same day, so the evening recap would
--     overwrite the morning one;
--   * "Bubaly handled" is a claim with nothing behind it, when the truth is
--     already in `family_automation_runs` (completed / partially_completed);
--   * a delivery cron has no way to know it has already sent today's, so a
--     retried invocation notifies the family twice.
--
--   kind          'daily' (morning) or 'evening' (the recap).
--   handled       what Bubaly finished since the last brief, as the run rows
--                 the Command Center already shows: [{run_id, title, detail,
--                 href, at, partial}]. Copied, not derived at read time, so a
--                 brief keeps saying what was true when it was sent.
--   delivered_at  when the family was told. Null means "built, not yet sent".
--
-- The unique index is the delivery guard: one brief per family per day per
-- kind, so `insert … on conflict do update` is the whole idempotency story.
--
-- ADDITIVE + IDEMPOTENT. Existing rows become `kind = 'daily'` with an empty
-- handled list, which is exactly what they are.
-- ============================================================================

alter table public.home_briefs add column if not exists kind text not null default 'daily';
alter table public.home_briefs add column if not exists handled jsonb not null default '[]'::jsonb;
alter table public.home_briefs add column if not exists delivered_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'home_briefs_kind_check' and conrelid = 'public.home_briefs'::regclass
  ) then
    alter table public.home_briefs
      add constraint home_briefs_kind_check check (kind in ('daily', 'evening'));
  end if;
end $$;

-- One brief per family per day per kind. Partial-free on purpose: every row
-- has all three values, so every row takes part in the guarantee.
create unique index if not exists uq_home_briefs_family_date_kind
  on public.home_briefs (family_id, as_of_date, kind);

-- Production verification:
--   select kind, count(*) from public.home_briefs group by kind;
--   select indexname from pg_indexes where indexname = 'uq_home_briefs_family_date_kind';
