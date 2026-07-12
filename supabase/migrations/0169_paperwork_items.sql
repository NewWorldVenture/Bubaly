-- FamilyOS :: 0169 — Paperwork Inbox (AI handles forms & paperwork, gap #4)
--
-- One triage inbox for the paper that floods families: permission slips, school
-- notices, medical forms, sports packets, bills, event flyers. Text is triaged
-- on capture (lib/paperwork/triage.ts — kind, summary, due date, amount, and the
-- ACTION ITEMS a parent must do: sign/pay/rsvp/schedule/provide), then each
-- action can be materialized one-tap into a real calendar event or reminder.
-- `actions` carries the extracted items + their materialization state so the
-- flow is idempotent and auditable.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.paperwork_items (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  kind        text not null default 'other' check (kind in (
                'permission_slip', 'school_notice', 'medical_form', 'sports',
                'bill_or_payment', 'event_flyer', 'other')),
  title       text not null,
  summary     text,
  raw_text    text,                              -- the pasted / captured source text
  sender      text,                              -- who it came from (school, coach, clinic…)
  due_on      date,                              -- earliest extracted due date
  amount      numeric(12,2),                     -- largest extracted dollar amount
  urgency     text not null default 'normal' check (urgency in ('urgent', 'soon', 'normal')),
  status      text not null default 'needs_action' check (status in (
                'needs_action', 'in_progress', 'done', 'archived')),
  actions     jsonb not null default '[]'::jsonb, -- [{kind,label,due_on,amount,materialized_as,materialized_id}]
  meta        jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_paperwork_family_status
  on public.paperwork_items(family_id, status, due_on nulls last);
create index if not exists idx_paperwork_family_created
  on public.paperwork_items(family_id, created_at desc);

drop trigger if exists set_paperwork_items_updated_at on public.paperwork_items;
create trigger set_paperwork_items_updated_at
  before update on public.paperwork_items
  for each row execute function public.set_updated_at();

alter table public.paperwork_items enable row level security;

drop policy if exists paperwork_items_select on public.paperwork_items;
create policy paperwork_items_select on public.paperwork_items
  for select using (public.is_family_member(family_id));

drop policy if exists paperwork_items_insert on public.paperwork_items;
create policy paperwork_items_insert on public.paperwork_items
  for insert with check (public.is_family_member(family_id));

drop policy if exists paperwork_items_update on public.paperwork_items;
create policy paperwork_items_update on public.paperwork_items
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists paperwork_items_delete on public.paperwork_items;
create policy paperwork_items_delete on public.paperwork_items
  for delete using (public.is_family_member(family_id));
