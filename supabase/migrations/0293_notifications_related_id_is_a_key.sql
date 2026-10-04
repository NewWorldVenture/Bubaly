-- Bubaly :: 0293 notifications.related_id is a dedupe KEY, not a uuid
-- ----------------------------------------------------------------------------
-- Notification generation fails outright for any household with an upcoming
-- "moment" or a schedule conflict:
--
--   Notification generation failed for family 11111111-…:
--   invalid input syntax for type uuid: "moment:3fd2b8f5-…:2026-09-14"
--
-- `related_id` is typed `uuid`, but three separate subsystems deliberately put
-- a COMPOSITE KEY in it, because that is what the column is used for — the
-- generic dedupe pass reads `.in('related_id', …)` and skips any candidate
-- whose `(type, related_id, user_id)` already exists:
--
--   lib/server/notifications.ts  'moment:<eventId>:<date>'   — so a recurring
--                                 occurrence pings at most once
--                                'conflict:<eventIds>' and ':<memberId>'
--   lib/services/approvals       `.in('related_id', candidates.map(c => c.dedupe_key))`
--   lib/ai/tools/notifications   `related_id: z.string().nullish()`
--
-- None of those are uuids, and Postgres rejects every one. The failure is
-- caught per family, so the cron keeps going and reports success overall — but
-- that family receives NO notifications at all from that run, not merely no
-- moment reminder. Five of sixteen seeded households hit it on a single pass.
--
-- The column type is the outlier here, not the callers: a polymorphic pointer
-- qualified by `related_type`, with no foreign key and no index on it, and a
-- read-side helper (`entityIdFrom`, lib/notifications/actions.ts) whose whole
-- job is to pick the uuid back out of a colon-delimited string. Widening
-- uuid -> text is lossless: every existing value becomes its own canonical
-- text form, and nothing compares the column to a uuid in SQL.
--
-- Verified before: inserting 'moment:<uuid>:<date>' raises 22P02.
-- Verified after: the same insert succeeds and the dedupe read matches it.

-- This migration is also replayed against populated schemas during repair
-- rehearsals. A later policy can depend on related_id's text type, so do not
-- issue ALTER TYPE again once the conversion has already landed.
do $migration$
declare
  related_id_type text;
begin
  select data_type into related_id_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'notifications'
    and column_name = 'related_id';

  if related_id_type = 'uuid' then
    alter table public.notifications
      alter column related_id type text using related_id::text;
  elsif related_id_type is distinct from 'text' then
    raise exception '0293 FAILED: notifications.related_id has unexpected type %, expected uuid or text',
      coalesce(related_id_type, '<missing>');
  end if;
end;
$migration$;

do $$
begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'notifications'
        and column_name = 'related_id') is distinct from 'text' then
    raise exception '0293 FAILED: notifications.related_id is still not text';
  end if;
  raise notice '0293 OK: notifications.related_id is text and can hold a dedupe key.';
end $$;
