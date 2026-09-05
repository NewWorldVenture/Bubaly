-- Bubaly :: 0168 — Financial Copilot: money-timeline insights (schedule↔money)
--
-- Deepens the schedule↔money linkage (industry-first #8). The forward cash-flow
-- timeline itself is computed live in the app (lib/finance/timeline.ts) by fusing
-- bills + savings goals + calendar events + account balances. This table persists
-- the COPILOT'S generated insights ("a heavy money week is coming", "balance runs
-- thin", "‘Summer camp’ needs $X/wk") so a family can acknowledge or dismiss them
-- and the trend sticks — mirroring how the other reasoning surfaces persist their
-- outputs. Recomputed on demand from the page (syncMoneyInsightsAction).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.money_timeline_insights (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  kind         text not null check (kind in (
                 'low_balance', 'heavy_week', 'goal_at_risk',
                 'recurring_creep', 'set_aside', 'all_clear')),
  title        text not null,
  detail       text not null,
  severity     text not null default 'info' check (severity in ('info', 'watch', 'urgent')),
  week_start   date,                              -- the week this concerns (null = general)
  amount       numeric(12,2),                     -- dollar magnitude (nullable)
  status       text not null default 'active' check (status in ('active', 'acknowledged', 'dismissed')),
  -- Stable identity for an insight (e.g. 'heavy_week:2026-01-05', 'recurring_creep:general')
  -- so re-syncing UPSERTs in place instead of piling up duplicates, and a family's
  -- acknowledge/dismiss survives the refresh (sync updates content, never status).
  dedupe_key   text not null,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, dedupe_key)
);

create index if not exists idx_money_insights_family_status
  on public.money_timeline_insights(family_id, status, created_at desc);

drop trigger if exists set_money_timeline_insights_updated_at on public.money_timeline_insights;
create trigger set_money_timeline_insights_updated_at
  before update on public.money_timeline_insights
  for each row execute function public.set_updated_at();

alter table public.money_timeline_insights enable row level security;

drop policy if exists money_timeline_insights_select on public.money_timeline_insights;
create policy money_timeline_insights_select on public.money_timeline_insights
  for select using (public.is_family_member(family_id));

drop policy if exists money_timeline_insights_insert on public.money_timeline_insights;
create policy money_timeline_insights_insert on public.money_timeline_insights
  for insert with check (public.is_family_member(family_id));

drop policy if exists money_timeline_insights_update on public.money_timeline_insights;
create policy money_timeline_insights_update on public.money_timeline_insights
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists money_timeline_insights_delete on public.money_timeline_insights;
create policy money_timeline_insights_delete on public.money_timeline_insights
  for delete using (public.is_family_member(family_id));
