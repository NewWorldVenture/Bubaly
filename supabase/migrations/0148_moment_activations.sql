-- FamilyOS :: 0148 Moment activations — the Moments organizing-layer log (R12)
-- ----------------------------------------------------------------------------
-- R12 (Moments as an organizing layer): the home/moments surface leads with the
-- life moment the family is in right now (Morning · School · Dinner · Weekend) or
-- one that's coming (Vacation · Birthday · Holiday), each orchestrating the right
-- capabilities. This table logs which moments were surfaced and how the family
-- engaged (engaged / dismissed) — so a dismissed moment stays quiet for the day,
-- and moment-engagement becomes a signal the reasoning layer can learn from
-- ("this family lives in the Dinner moment"). One row per (family, moment, day).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.moment_activations (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  moment_key  text not null,
  as_of_date  date not null default current_date,
  status      text not null default 'active' check (status in ('active', 'engaged', 'dismissed')),
  reason      text,
  priority    integer not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, moment_key, as_of_date)
);

create index if not exists idx_moment_activations_family on public.moment_activations(family_id, as_of_date, status);

drop trigger if exists set_moment_activations_updated on public.moment_activations;
create trigger set_moment_activations_updated before update on public.moment_activations
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.moment_activations enable row level security;

drop policy if exists moment_activations_select on public.moment_activations;
create policy moment_activations_select on public.moment_activations
  for select using (public.is_family_member(family_id));

drop policy if exists moment_activations_insert on public.moment_activations;
create policy moment_activations_insert on public.moment_activations
  for insert with check (public.is_family_member(family_id));

drop policy if exists moment_activations_update on public.moment_activations;
create policy moment_activations_update on public.moment_activations
  for update using (public.is_family_member(family_id));
