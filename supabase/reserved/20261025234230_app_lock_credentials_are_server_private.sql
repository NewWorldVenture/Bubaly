-- App Lock's PIN must not share a browser-readable/writable preferences blob.
-- Apply only after the new server-private App Lock reader is deployed: missing
-- schema fails closed until this transaction commits. Never deploy the old
-- preferences-based reader after this migration; it cannot see migrated locks.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Fence a legacy settings request for the entire copy + scrub + trigger change.
-- SELECT stays available; INSERT/UPDATE/DELETE cannot slip between those steps.
lock table public.user_preferences in share row exclusive mode;

-- A malformed existing PIN is not permission to silently turn its lock off.
-- Refuse the whole transition, with no user identifiers or secrets in errors.
do $$
begin
  if exists (
    select 1 from public.user_preferences
    where notification_prefs ? 'appLock'
      and notification_prefs->'appLock' <> 'null'::jsonb
      and not coalesce(
        jsonb_typeof(notification_prefs->'appLock') = 'object'
        and jsonb_typeof(notification_prefs->'appLock'->'enabled') = 'boolean'
        and jsonb_typeof(notification_prefs->'appLock'->'salt') = 'string'
        and notification_prefs->'appLock'->>'salt' ~ '^[0-9a-f]{32}$'
        and jsonb_typeof(notification_prefs->'appLock'->'hash') = 'string'
        and notification_prefs->'appLock'->>'hash' ~ '^[0-9a-f]{64}$', false
      )
  ) then
    raise exception 'App Lock migration refused malformed legacy credentials';
  end if;
end;
$$;

create table public.app_lock_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null,
  salt text,
  hash text,
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  constraint app_lock_credentials_pin_shape check (
    (enabled = false and salt is null and hash is null)
    or (salt is not null and hash is not null
      and salt ~ '^[0-9a-f]{32}$' and hash ~ '^[0-9a-f]{64}$')
  )
);
alter table public.app_lock_credentials enable row level security;
alter table public.app_lock_credentials force row level security;
-- Existing Supabase projects automatically grant new public tables broadly.
-- Revoke explicitly as well as leaving RLS with NO member/anonymous policies.
revoke all on table public.app_lock_credentials from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.app_lock_credentials to service_role;
comment on table public.app_lock_credentials is
  'Server-only App Lock credentials. Never grant browser access or return salt/hash to clients.';

insert into public.app_lock_credentials (user_id, enabled, salt, hash)
select user_id,
  (notification_prefs->'appLock'->>'enabled')::boolean,
  notification_prefs->'appLock'->>'salt',
  notification_prefs->'appLock'->>'hash'
from public.user_preferences
where notification_prefs ? 'appLock'
  and notification_prefs->'appLock' <> 'null'::jsonb;

-- Prove the copy before removing the public source. Any discrepancy rolls
-- back the whole transaction, leaving every original preference intact.
do $$
begin
  if exists (
    select 1 from public.user_preferences p
    left join public.app_lock_credentials c on c.user_id = p.user_id
    where p.notification_prefs ? 'appLock'
      and p.notification_prefs->'appLock' <> 'null'::jsonb
      and (c.user_id is null
        or c.enabled is distinct from (p.notification_prefs->'appLock'->>'enabled')::boolean
        or c.salt is distinct from p.notification_prefs->'appLock'->>'salt'
        or c.hash is distinct from p.notification_prefs->'appLock'->>'hash')
  ) then
    raise exception 'App Lock migration could not verify credential preservation';
  end if;
end;
$$;

update public.user_preferences
set notification_prefs = notification_prefs - 'appLock'
where notification_prefs ? 'appLock';

-- Reject stale/forged whole-blob writes. Silent stripping would let an old
-- settings client announce that it enabled a PIN while storing no lock at all.
-- SECURITY INVOKER: the function needs no elevated access to inspect NEW.
create function public.reject_app_lock_preferences()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.notification_prefs ? 'appLock' then
    raise exception using errcode = '23514',
      message = 'App Lock settings must use the private server endpoint';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_app_lock_preferences() from public, anon, authenticated, service_role;
create trigger user_preferences_reject_app_lock
  before insert or update of notification_prefs on public.user_preferences
  for each row execute function public.reject_app_lock_preferences();

commit;
