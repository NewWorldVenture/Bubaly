-- Bubaly :: 0142 Family signals — the "hard signal" family-intelligence store (R10)
-- ----------------------------------------------------------------------------
-- R10 (MOATS / Family Intelligence): the harder-to-copy behavioral signals the
-- strategy calls out — which reminders keep getting ignored, when the family is
-- most stressed, which chores create friction, which routines don't stick. The
-- detection engines (lib/intelligence/hard-signals.ts) recompute these from the
-- family's real data; this table is the durable, TRANSPARENT + EDITABLE record:
-- each signal carries its evidence and is acknowledged / dismissed by the family
-- (so a dismissed pattern doesn't nag), and the reasoning layer + Playbook can read
-- it. One row per (family, kind, subject) — recompute upserts in place.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_signals (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  kind          text not null
                  check (kind in ('ignored_reminder', 'stress_window', 'chore_conflict', 'routine_adherence')),
  subject_key   text not null,
  title         text not null,
  detail        text,
  score         integer not null default 0 check (score between 0 and 100),
  evidence      jsonb not null default '{}'::jsonb,
  status        text not null default 'active'
                  check (status in ('active', 'acknowledged', 'dismissed')),
  member_id     uuid references public.family_members(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (family_id, kind, subject_key)
);

create index if not exists idx_family_signals_family on public.family_signals(family_id, status, score desc);

drop trigger if exists set_family_signals_updated on public.family_signals;
create trigger set_family_signals_updated before update on public.family_signals
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.family_signals enable row level security;

drop policy if exists family_signals_select on public.family_signals;
create policy family_signals_select on public.family_signals
  for select using (public.is_family_member(family_id));

drop policy if exists family_signals_insert on public.family_signals;
create policy family_signals_insert on public.family_signals
  for insert with check (public.is_family_member(family_id));

drop policy if exists family_signals_update on public.family_signals;
create policy family_signals_update on public.family_signals
  for update using (public.is_family_member(family_id));

drop policy if exists family_signals_delete on public.family_signals;
create policy family_signals_delete on public.family_signals
  for delete using (public.is_family_member(family_id));
