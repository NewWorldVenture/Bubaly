-- FamilyOS :: 0138 — Ephemeral "Try it free" demo sessions
--
-- Powers the pricing-page "Test Account → Login Now to Try Me" flow: one click
-- provisions a throwaway Family+ family (seeded with data), signs the visitor
-- straight in, and runs a 5-minute countdown. On logout / expiry / the cron, the
-- whole thing is deleted (auth user + family cascade), so it fully resets for the
-- next person. This table just tracks each live demo + when it expires.

create table if not exists public.demo_sessions (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  family_id   uuid        not null references public.families(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  unique (user_id)
);

create index if not exists idx_demo_sessions_expires on public.demo_sessions (expires_at);

alter table public.demo_sessions enable row level security;

-- A demo visitor may read only their OWN session row (to drive the countdown).
-- All writes/cleanup run through the service-role client in server actions + cron.
drop policy if exists demo_sessions_select_own on public.demo_sessions;
create policy demo_sessions_select_own on public.demo_sessions
  for select to authenticated
  using (user_id = auth.uid());
