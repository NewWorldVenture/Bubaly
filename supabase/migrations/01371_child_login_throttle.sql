-- Bubaly :: 0137 — Child login throttle (brute-force protection)
--
-- A child signs in with a guessable username + a 4-digit PIN (only 10,000
-- combinations). Without a durable, cross-instance limiter, a serverless
-- deployment can't stop an attacker brute-forcing a specific child's PIN. This
-- table persists per-username failure counts + lockouts so the sign-in server
-- action (which runs under the service role) can reject flooded attempts.
--
-- Keyed by the normalized (lowercase) username — the same value child_logins
-- stores — so a lock protects one child's account. Written ONLY by the
-- service-role sign-in / reset actions; there is no family-scoped access and no
-- public read (RLS on, no policies → deny-all to normal clients).

create table if not exists public.child_login_throttle (
  username     text        primary key,           -- normalized login handle
  fails        int         not null default 0,     -- failures in the current window
  window_start timestamptz not null default now(), -- when the window began
  locked_until timestamptz,                        -- locked out until this instant
  updated_at   timestamptz not null default now()
);

create index if not exists idx_child_login_throttle_locked
  on public.child_login_throttle (locked_until)
  where locked_until is not null;

drop trigger if exists trg_set_updated_at on public.child_login_throttle;
create trigger trg_set_updated_at before update on public.child_login_throttle
  for each row execute function public.set_updated_at();

-- RLS on, no policies: only the service role (which bypasses RLS) may touch it.
-- Normal authenticated/anon clients get deny-all, which is exactly right — the
-- throttle is server-enforced, never client-visible.
alter table public.child_login_throttle enable row level security;
