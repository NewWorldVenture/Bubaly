-- FamilyOS :: 0171 — Progressive-profiling store (visitor-intelligence gap #13)
--
-- Progressive profiling asks a lead/contact ONE thing at a time across visits
-- (role → priority → household → kids → interests) instead of a big form. The
-- captured, structured attributes live here (one row per contact) and feed
-- segmentation + the personalization engine. `extra.skipped[]` remembers which
-- questions the person dismissed so we don't re-ask. The question flow itself is
-- in `lib/marketing/progressive-profile.ts` (pure, tested).
--
-- Additive + idempotent. Owner-scoped RLS via the linked crm_contacts.owner_id.

create table if not exists public.crm_contact_profile (
  contact_id      uuid primary key references public.crm_contacts(id) on delete cascade,
  role            text,
  top_priority    text,
  household_size  int,
  child_ages      text,
  interests       text[] not null default '{}',
  extra           jsonb  not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

drop trigger if exists set_crm_contact_profile_updated_at on public.crm_contact_profile;
create trigger set_crm_contact_profile_updated_at
  before update on public.crm_contact_profile
  for each row execute function public.set_updated_at();

alter table public.crm_contact_profile enable row level security;

-- The owning user (the person this contact belongs to) may read their own
-- profile row. Writes go through the service-role server actions (identity is
-- verified there), matching how the rest of the CRM tables are written.
drop policy if exists crm_contact_profile_select_own on public.crm_contact_profile;
create policy crm_contact_profile_select_own on public.crm_contact_profile
  for select to authenticated
  using (exists (
    select 1 from public.crm_contacts c
    where c.id = crm_contact_profile.contact_id and c.owner_id = auth.uid()
  ));
