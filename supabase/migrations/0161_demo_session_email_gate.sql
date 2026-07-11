-- FamilyOS :: 0161 — Email-gate the demo + defer the countdown
--
-- The "Test Account" demo now opens behind a blurred email-capture pop-up: one
-- click provisions the demo and signs the visitor in, but the 5-minute clock does
-- NOT start until they enter an email. So `expires_at` becomes nullable (null =
-- provisioned, clock not started yet) and we capture the address in `email`.

alter table public.demo_sessions
  alter column expires_at drop not null;

alter table public.demo_sessions
  add column if not exists email text;

-- Reaping abandoned, never-started demos (email never entered) is by created_at,
-- so keep that queryable.
create index if not exists idx_demo_sessions_created on public.demo_sessions (created_at);
