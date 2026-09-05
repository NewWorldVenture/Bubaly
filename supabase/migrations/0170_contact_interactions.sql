-- Bubaly :: 0170 — Relationship CRM: per-contact interactions (gap #5)
--
-- Deepens the household relationship CRM: family_contacts holds WHO the people
-- are; this table holds the RELATIONSHIP — every visit, call, gift, favor and
-- note the family logs against a contact. The per-contact timeline page merges
-- these with inbox communications + birthdays (lib/contacts/timeline.ts) and
-- computes relationship health (last touch vs. the natural cadence).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.contact_interactions (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  contact_id   uuid not null references public.family_contacts(id) on delete cascade,
  kind         text not null default 'note' check (kind in ('visit', 'call', 'message', 'gift', 'favor', 'note')),
  occurred_on  date not null default current_date,
  title        text not null,
  note         text,
  amount       numeric(12,2),                    -- gift value etc. (dollars)
  meta         jsonb not null default '{}'::jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_contact_interactions_contact
  on public.contact_interactions(contact_id, occurred_on desc);
create index if not exists idx_contact_interactions_family
  on public.contact_interactions(family_id, occurred_on desc);

drop trigger if exists set_contact_interactions_updated_at on public.contact_interactions;
create trigger set_contact_interactions_updated_at
  before update on public.contact_interactions
  for each row execute function public.set_updated_at();

alter table public.contact_interactions enable row level security;

drop policy if exists contact_interactions_select on public.contact_interactions;
create policy contact_interactions_select on public.contact_interactions
  for select using (public.is_family_member(family_id));

drop policy if exists contact_interactions_insert on public.contact_interactions;
create policy contact_interactions_insert on public.contact_interactions
  for insert with check (public.is_family_member(family_id));

drop policy if exists contact_interactions_update on public.contact_interactions;
create policy contact_interactions_update on public.contact_interactions
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists contact_interactions_delete on public.contact_interactions;
create policy contact_interactions_delete on public.contact_interactions
  for delete using (public.is_family_member(family_id));
