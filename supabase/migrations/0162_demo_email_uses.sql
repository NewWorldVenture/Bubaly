-- FamilyOS :: 0162 — One demo per email (durable per-email demo usage ledger)
--
-- The demo is a SINGLE shared account, so demo_sessions.email is one row the next
-- visitor overwrites — useless for "this email already used its demo". This table
-- is the durable, per-email record: when an email starts a demo we stamp it here
-- with that demo's 5-minute expiry. Once expired, that email can't start another
-- demo — the email gate routes it to the upgrade/plan-choice page instead.
--
-- Service-role only (writes + the gate check run through the service client in the
-- demo server actions); RLS enabled with no policies so it's never client-readable.
-- Additive + idempotent.

create table if not exists public.demo_email_uses (
  email         text        primary key,
  first_used_at timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  -- the 5-minute expiry of this email's most recent demo; once now() passes it,
  -- the email is "used up" and can't demo again.
  expires_at    timestamptz not null,
  uses          integer     not null default 1,
  created_at    timestamptz not null default now()
);

create index if not exists idx_demo_email_uses_expires on public.demo_email_uses (expires_at);

alter table public.demo_email_uses enable row level security;
-- No policies: only the service-role client (demo actions) reads/writes this.
