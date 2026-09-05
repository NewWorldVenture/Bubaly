-- Bubaly :: 0142 AI-facilitated group decisions (T6)
-- ----------------------------------------------------------------------------
-- Turns Group Voting (family_polls) into AI-facilitated consensus: a poll can
-- now carry a decision CATEGORY (meal / vacation / shopping / activity), an
-- optional BUDGET cap, and REQUIRED tags (e.g. dietary needs every option must
-- satisfy). Each option gains objective metrics — cost and travel — plus free
-- tags (e.g. 'vegetarian', 'gluten-free'). The pure consensus engine
-- (lib/voting/consensus.ts) blends the democratic signal (votes) with the
-- decision engine's objective fit (cost/travel + hard budget/dietary
-- constraints) and surfaces a recommendation + vote-vs-fit conflicts.
--
-- Additive + idempotent. No new tables → the existing family-scoped RLS on
-- family_polls / family_poll_options (migration 0078, FOR ALL is_family_member)
-- already governs every new column. Validated on PG16.

-- ── family_polls: category + budget + required tags ─────────────────────────
alter table public.family_polls
  add column if not exists decision_category text not null default 'general';
alter table public.family_polls
  add column if not exists budget_cents bigint;
alter table public.family_polls
  add column if not exists required_tags text[] not null default '{}';

-- Constrain the category to the supported set (idempotent: drop + re-add).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_polls_decision_category_check'
  ) then
    alter table public.family_polls
      add constraint family_polls_decision_category_check
      check (decision_category in ('general','meal','vacation','shopping','activity'));
  end if;
end $$;

-- ── family_poll_options: objective metrics + tags ───────────────────────────
alter table public.family_poll_options
  add column if not exists cost_cents bigint;
alter table public.family_poll_options
  add column if not exists travel_minutes integer;
alter table public.family_poll_options
  add column if not exists tags text[] not null default '{}';
