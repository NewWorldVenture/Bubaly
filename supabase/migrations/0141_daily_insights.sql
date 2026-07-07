-- FamilyOS :: 0141 Daily insights — the one proactive "insight of the day" (T4)
-- ----------------------------------------------------------------------------
-- T4 (TIME-TO-FIRST-VALUE): instead of many small reminders, the home surfaces ONE
-- ranked, proactive insight above the fold ("leave 20 min earlier", "2 assignments
-- due tomorrow aren't acknowledged", "these groceries together save money"). Every
-- render recomputes candidate insights from the family's live data and upserts them
-- here (one row per family per day per kind); the home shows the highest-impact
-- ACTIVE one. Dismissing marks that row dismissed so the NEXT-best insight surfaces
-- — and we keep a record of which insights drove action (engagement / TTFV signal).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.daily_insights (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  as_of_date  date not null default current_date,
  kind        text not null,
  title       text not null,
  detail      text,
  href        text,
  impact      integer not null default 0 check (impact >= 0),
  status      text not null default 'active' check (status in ('active', 'dismissed', 'acted')),
  member_id   uuid references public.family_members(id) on delete set null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, as_of_date, kind)
);

create index if not exists idx_daily_insights_family_day on public.daily_insights(family_id, as_of_date, status);

drop trigger if exists set_daily_insights_updated on public.daily_insights;
create trigger set_daily_insights_updated before update on public.daily_insights
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.daily_insights enable row level security;

drop policy if exists daily_insights_select on public.daily_insights;
create policy daily_insights_select on public.daily_insights
  for select using (public.is_family_member(family_id));

drop policy if exists daily_insights_insert on public.daily_insights;
create policy daily_insights_insert on public.daily_insights
  for insert with check (public.is_family_member(family_id));

drop policy if exists daily_insights_update on public.daily_insights;
create policy daily_insights_update on public.daily_insights
  for update using (public.is_family_member(family_id));
