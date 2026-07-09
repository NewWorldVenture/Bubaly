-- ============================================================================
-- FamilyOS · SEED — Microsoft / Outlook two-way sync (500+ records).
-- Exercises the R9 provider-agnostic adapter at volume: a connected Microsoft
-- sync_account + connection, an Outlook calendar mirror, and 500 already-synced
-- Outlook-origin events with their external mappings (exactly what the generic
-- engine's PULL path produces). Lets the sync/Connections surfaces render a
-- SECOND live provider and the local reconcile queries run at scale — no live
-- Graph API or OAuth keys needed for the local side.
-- Idempotent: keyed on the seed account external_id; re-run safe. Resolves the
-- family by email. (Needs migration 0018 applied; 'microsoft' is already a
-- registered provider row.)
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================
do $$
declare
  v_email     text := 'newworldventurellc@gmail.com';
  v_acct_ext  text := 'seed-outlook@bubaly.test';
  v_family    uuid;
  v_user      uuid;
  v_account   uuid;
  v_calendar  uuid;
  n int := 500;
begin
  if to_regclass('public.sync_accounts') is null then
    raise notice 'sync platform (0018) not present — skipping.';
    return;
  end if;

  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  select fm.user_id into v_user from public.family_members fm
  where fm.family_id = v_family and fm.user_id is not null limit 1;
  if v_user is null then raise exception 'No user in family to own the connected account.'; end if;

  -- Ensure the provider reference row exists (0018 seeds it; upsert to be safe).
  insert into public.sync_providers (provider, label, auth_kind)
  values ('microsoft', 'Microsoft / Outlook', 'oauth2')
  on conflict (provider) do nothing;

  -- Connected account (idempotent on the unique (user_id, provider, external_id)).
  insert into public.sync_accounts (user_id, family_id, provider, external_id, display_name, sync_status, scopes, created_by)
  values (v_user, v_family, 'microsoft', v_acct_ext, 'Outlook (seed)', 'synced',
          array['Calendars.ReadWrite','Tasks.ReadWrite'], v_user)
  on conflict (user_id, provider, external_id) do update set sync_status = 'synced'
  returning id into v_account;
  if v_account is null then
    select id into v_account from public.sync_accounts where user_id = v_user and provider = 'microsoft' and external_id = v_acct_ext;
  end if;

  insert into public.sync_connections (account_id, user_id, family_id, provider, external_id, item_types, sync_direction, sync_status, health)
  values (v_account, v_user, v_family, 'microsoft', v_acct_ext, array['calendar','event']::public.sync_item_type[], 'two_way', 'synced', 'healthy')
  on conflict do nothing;

  -- Outlook calendar mirror (one per account; keyed by external_id).
  insert into public.sync_calendars (family_id, user_id, account_id, provider, external_id, name, timezone, is_primary, is_owned_locally, sync_status, sync_token)
  values (v_family, v_user, v_account, 'microsoft', 'ms-cal-primary', 'Outlook Calendar', 'UTC', true, false, 'synced', 'seed-delta-cursor')
  on conflict do nothing;
  select id into v_calendar from public.sync_calendars where account_id = v_account and provider = 'microsoft' and external_id = 'ms-cal-primary' limit 1;

  -- Clean prior seed rows for a deterministic re-run.
  delete from public.sync_external_mappings where account_id = v_account and external_id like 'ms-seed-%';
  delete from public.sync_calendar_events where calendar_id = v_calendar and external_id like 'ms-seed-%';

  -- 500 Outlook-origin events (provider='microsoft'), spread across ±120 days.
  insert into public.sync_calendar_events
    (calendar_id, family_id, user_id, provider, external_id, uid, title, description, location,
     starts_at, ends_at, all_day, status, etag, content_hash, sync_status, last_synced_at, metadata)
  select
    v_calendar, v_family, v_user, 'microsoft',
    'ms-seed-' || g.i,
    'ms-uid-' || g.i,
    (array['Standup','Dentist','Soccer practice','Piano lesson','Parent-teacher','Grocery run','Date night','Doctor','Team lunch','Book club'])[1+(g.i % 10)] || ' #' || g.i,
    'Synced from Outlook (seed).',
    (array['Home','Office','Field 3','School','Downtown','Clinic',null])[1+(g.i % 7)],
    (now() + ((g.i - 250) || ' hours')::interval),
    (now() + ((g.i - 250) || ' hours')::interval + interval '1 hour'),
    (g.i % 17) = 0,
    'confirmed',
    'etag-' || g.i,
    md5('ms-seed-' || g.i),          -- stand-in content hash (unique per event)
    'synced',
    now() - ((g.i % 48) || ' hours')::interval,
    '{"origin":"remote"}'::jsonb
  from generate_series(0, n - 1) g(i)
  on conflict do nothing;

  -- One external mapping per seeded event (the local<->remote backbone).
  insert into public.sync_external_mappings
    (family_id, account_id, provider, item_type, local_id, external_id, external_etag, sync_status, last_synced_at, metadata)
  select
    v_family, v_account, 'microsoft', 'event', e.id, e.external_id, e.etag, 'synced', now(),
    jsonb_build_object('lastHash', e.content_hash)
  from public.sync_calendar_events e
  where e.calendar_id = v_calendar and e.external_id like 'ms-seed-%'
  on conflict (provider, item_type, external_id, account_id) do nothing;

  raise notice 'Microsoft sync seeded: account %, calendar %, % events for family %',
    v_account, v_calendar, n, v_family;
end $$;

-- Verify:
--   select count(*) from sync_calendar_events where provider='microsoft' and external_id like 'ms-seed-%';  -- 500
--   select count(*) from sync_external_mappings where provider='microsoft' and external_id like 'ms-seed-%'; -- 500
--   select provider, sync_status from sync_accounts where external_id='seed-outlook@bubaly.test';
