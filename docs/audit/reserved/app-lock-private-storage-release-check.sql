-- Read-only release preflight. Run immediately before the scoped transition.
-- Do NOT apply the unrelated migration backlog with this App Lock release.
-- SQL stays in supabase/reserved/20261025234230_app_lock_credentials_are_server_private.sql
-- to prevent Supabase Git integration replay before the source deployment.
-- Activate the new application first: a missing private table must render the
-- unavailable lock screen, refusing protected content/settings/unlock calls.
-- Then apply ONLY app_lock_credentials_are_server_private in one transaction.
-- Its exclusive writer fence includes validation, exact-copy verification,
-- preference scrub and the stale-write rejection trigger.
select current_setting('server_version') as postgres_version,
  to_regclass('public.app_lock_credentials') as existing_private_table,
  count(*) filter (where notification_prefs ? 'appLock') as legacy_keys,
  count(*) filter (where notification_prefs->'appLock'->>'enabled' = 'true') as enabled_legacy_locks,
  count(*) filter (
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
  ) as malformed_legacy_locks
from public.user_preferences;

-- Post-transition checks (run separately AFTER the transaction commits).
-- Counts must match the immediate preflight, unless a verified new app request
-- created/changed a lock in the intervening period. Never print salts/hashes.
select count(*) as private_records,
  count(*) filter (where enabled) as enabled_private_locks,
  count(*) filter (where salt is null and hash is null) as cleared_pin_records
from public.app_lock_credentials;

select count(*) as remaining_public_lock_keys
from public.user_preferences where notification_prefs ? 'appLock';

select relrowsecurity, relforcerowsecurity
from pg_class where oid = 'public.app_lock_credentials'::regclass;

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'app_lock_credentials'
  and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
order by grantee, privilege_type;

select policyname from pg_policies
where schemaname = 'public' and tablename = 'app_lock_credentials';

select tgname, tgenabled from pg_trigger
where tgrelid = 'public.user_preferences'::regclass
  and tgname = 'user_preferences_reject_app_lock';

select has_function_privilege('anon', 'public.reject_app_lock_preferences()', 'execute') as anon_can_call_trigger,
  has_function_privilege('authenticated', 'public.reject_app_lock_preferences()', 'execute') as member_can_call_trigger;

-- Forward recovery only after commit: retain the private table, scrub and
-- trigger. Deploy corrected server-private code, or keep the app unavailable.
-- NEVER restore hashes to user_preferences or deploy the old preferences-based
-- reader: either would recreate the privacy defect. A pre-commit SQL error
-- automatically rolls back all of this migration; diagnose it and retry the
-- exact reviewed migration while the new application continues to fail closed.
