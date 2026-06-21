-- FamilyOS :: 0035 push devices
-- Stores per-user push registrations so the notification engine can deliver
-- pushes to the installed PWA (Web Push / VAPID) and the native iOS/iPadOS and
-- Android apps (Capacitor → APNs/FCM tokens). One row per physical device.
--
-- Security: a user may only see/manage their OWN devices (user_id = auth.uid()).
-- The server-role dispatcher (lib/server/push.ts) reads across users to send.

create table if not exists public.push_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  family_id     uuid references public.families(id) on delete set null,
  platform      text not null default 'web',     -- web | ios | android
  provider      text not null default 'webpush', -- webpush | fcm | apns
  -- Web Push (VAPID) fields:
  endpoint      text,
  p256dh        text,
  auth          text,
  -- Native (APNs/FCM) token:
  token         text,
  -- Stable per-device key (endpoint for web, token for native) for upsert.
  device_key    text not null,
  user_agent    text,
  enabled       boolean not null default true,
  last_seen_at  timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, device_key)
);
create index if not exists idx_push_devices_user on public.push_devices(user_id);
create index if not exists idx_push_devices_enabled on public.push_devices(enabled) where enabled;

-- updated_at trigger (matches the project-wide pattern).
drop trigger if exists trg_set_updated_at on public.push_devices;
create trigger trg_set_updated_at before update on public.push_devices
  for each row execute function public.set_updated_at();

-- RLS: own-device only.
alter table public.push_devices enable row level security;

drop policy if exists push_devices_select on public.push_devices;
create policy push_devices_select on public.push_devices for select
  using (user_id = auth.uid());
drop policy if exists push_devices_insert on public.push_devices;
create policy push_devices_insert on public.push_devices for insert
  with check (user_id = auth.uid());
drop policy if exists push_devices_update on public.push_devices;
create policy push_devices_update on public.push_devices for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists push_devices_delete on public.push_devices;
create policy push_devices_delete on public.push_devices for delete
  using (user_id = auth.uid());
