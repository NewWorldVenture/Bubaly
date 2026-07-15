-- ============================================================================
-- 0214 · Family Contact Center — the central @bubaly.com address + dedicated
-- phone number per Family+ account, and the unified inbox everything routes into.
--
-- Every Family+ family gets ONE contact identity (a bubaly.com email local-part
-- and a dedicated Twilio number). Inbound calls / texts / emails to that identity
-- all land in family_inbox_messages, where the AI concierge triages them.
--
-- RLS: family members READ both tables (is_family_member). All WRITES are
-- privileged — provisioning + inbound webhooks use the service role, and the
-- family-facing controls go through parent-gated server actions — so there are
-- no client INSERT/UPDATE policies (same posture as admin_notifications, but
-- family-scoped reads). Additive + idempotent. Requires 0004 (is_family_member).
-- ============================================================================

create table if not exists public.family_contact_channels (
  family_id uuid primary key references public.families(id) on delete cascade,
  email_local text,                       -- part before @bubaly.com (unique when set)
  phone_number text,                      -- E.164, the dedicated Twilio number
  phone_number_sid text,                  -- Twilio IncomingPhoneNumber SID
  provisioning_status text not null default 'unprovisioned'
    check (provisioning_status in ('unprovisioned', 'pending', 'active', 'failed')),
  ai_concierge_enabled boolean not null default true,
  ai_greeting text,
  forward_to_phone text,                  -- optional human fallback (E.164)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One bubaly.com local-part per family, case-insensitive; one number per family.
create unique index if not exists uq_contact_channels_email_local
  on public.family_contact_channels (lower(email_local)) where email_local is not null;
create unique index if not exists uq_contact_channels_phone
  on public.family_contact_channels (phone_number) where phone_number is not null;

create table if not exists public.family_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  channel text not null check (channel in ('email', 'sms', 'voice')),
  direction text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  from_addr text,
  to_addr text,
  subject text,
  body text,
  ai_summary text,
  ai_intent text,
  ai_handled boolean not null default false,
  status text not null default 'new' check (status in ('new', 'read', 'archived')),
  provider_ref text,                      -- Twilio SID / email message id (idempotency)
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_inbox_family_time
  on public.family_inbox_messages (family_id, occurred_at desc);
-- De-dupe re-delivered provider events (a webhook may fire twice).
create unique index if not exists uq_inbox_provider_ref
  on public.family_inbox_messages (channel, provider_ref) where provider_ref is not null;

-- updated_at maintenance for the channel row.
drop trigger if exists trg_contact_channels_updated_at on public.family_contact_channels;
create trigger trg_contact_channels_updated_at
  before update on public.family_contact_channels
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.family_contact_channels enable row level security;
alter table public.family_inbox_messages enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'family_contact_channels' and policyname = 'contact_channels_select') then
    create policy contact_channels_select on public.family_contact_channels
      for select using (public.is_family_member(family_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'family_inbox_messages' and policyname = 'inbox_select') then
    create policy inbox_select on public.family_inbox_messages
      for select using (public.is_family_member(family_id));
  end if;
end $$;
