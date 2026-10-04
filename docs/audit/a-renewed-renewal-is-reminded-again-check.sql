-- A renewed renewal, and a renewed document, are reminded about again: the occurrence key is stored. (#936)
--
-- #936 keys a renewal's reminder `<renewal id>:<expires_at>` and a document's
-- `<document id>:<expiry day>:<manager member id>` in notifications.related_id,
-- and reads the legacy key beside it (`<renewal id>`, `<document id>:<manager
-- member id>`) with created_at, to tell an occurrence announced under the old
-- key from one that is new. A review read 0002's `related_id uuid` and asked
-- whether a real insert fails with 22P02. 0293 widened the column to text
-- (notification-related-id-is-a-key-check.sql holds that line); this probe
-- asserts the two writes #936 adds, on the fully replayed schema:
--
--   the column is text                                              -> asserted
--   `document_expiry` is a notification_type value (both candidates) -> asserted
--   both dated rows land, with the columns the engine writes
--     (family_id, user_id, type, title, body, related_type, related_id, send_at)
--     beside the legacy rows an earlier deploy's run would have left,
--     and read back as the exact text that was written               -> asserted
--   the engine's ONE dedupe read — type, related_id, user_id, created_at
--     where related_id in (dated, legacy) — returns the dated row AND the
--     legacy row for each candidate, so the legacy question can be answered
--     from created_at                                                 -> asserted
--
-- Synthetic fixture only: the probe's own auth user and family, never the
-- anchor household. Rolled back: nothing here outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  col_type    text;
  mgr_user    uuid := 'a9360000-0000-4000-8000-000000000001';
  mgr_member  uuid := 'a9360000-0000-4000-8000-000000000002';
  fam         uuid := 'a9360000-0000-4000-8000-0000000000f9';
  renewal     uuid := 'a9360000-0000-4000-8000-000000000011';
  document    uuid := 'a9360000-0000-4000-8000-000000000012';
  renewal_key text := renewal::text || ':2026-11-30';
  renewal_old text := renewal::text;
  doc_key     text := document::text || ':2026-11-30:' || mgr_member::text;
  doc_old     text := document::text || ':' || mgr_member::text;
  n           int;
  back        text;
begin
  -- 1. the column type, named: a later retype would bring the 22P02 outage back.
  select data_type into col_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'notifications' and column_name = 'related_id';
  if col_type is distinct from 'text' then
    raise exception '#936 FAIL: notifications.related_id is %, not text; the dated occurrence keys would be rejected (22P02)', coalesce(col_type, 'absent');
  end if;

  -- 2. the type both candidates carry.
  if not exists (select 1 from unnest(enum_range(null::public.notification_type)) v where v::text = 'document_expiry') then
    raise exception '#936 FAIL: notification_type has no document_expiry value';
  end if;

  -- The probe's own household.
  insert into auth.users (id, email) values (mgr_user, 'renewal-probe-manager@example.test') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Renewal probe', mgr_user) on conflict (id) do nothing;

  -- 3. the two writes, as the engine makes them (toRow + deliveryTimeFor's send_at),
  --    beside the legacy rows an earlier deploy would have left.
  begin
    insert into public.notifications (family_id, user_id, type, title, body, related_type, related_id, send_at, created_at) values
      (fam, null,     'document_expiry', 'Renewal due: Passport',      'Expires Nov 30 · in 14 days', 'renewals',  renewal_key, now(), now()),
      (fam, mgr_user, 'document_expiry', 'Document expiring: Passport', 'Expires Nov 30',             'documents', doc_key,     now(), now()),
      -- the legacy rows, dated as an earlier deploy's run six days ago would have left them
      (fam, null,     'document_expiry', 'Renewal due: Passport',      'Expires Nov 30 · in 20 days', 'renewals',  renewal_old, now() - interval '6 days', now() - interval '6 days'),
      (fam, mgr_user, 'document_expiry', 'Document expiring: Passport', 'Expires Nov 30',             'documents', doc_old,     now() - interval '6 days', now() - interval '6 days');
  exception when invalid_text_representation then
    raise exception '#936 FAIL: a dated occurrence key was rejected (22P02): %', sqlerrm;
  end;

  select related_id into back from public.notifications where family_id = fam and related_id = renewal_key;
  if back is distinct from renewal_key then
    raise exception '#936 FAIL: the renewal key read back as %, expected %', coalesce(back, 'nothing'), renewal_key;
  end if;
  select related_id into back from public.notifications where family_id = fam and related_id = doc_key;
  if back is distinct from doc_key then
    raise exception '#936 FAIL: the document key read back as %, expected %', coalesce(back, 'nothing'), doc_key;
  end if;

  -- 4. the engine's one dedupe read: both keys of each candidate, with created_at.
  select count(*) into n
  from public.notifications
  where family_id = fam
    and related_id in (renewal_key, renewal_old, doc_key, doc_old)
    and created_at is not null;
  if n <> 4 then
    raise exception '#936 FAIL: the dedupe read found % rows for the four keys, expected 4', n;
  end if;
  -- …and the legacy row is the OLDER one under its key, so "announced since" is decidable.
  select count(*) into n
  from public.notifications a
  join public.notifications b on b.family_id = a.family_id and b.type = a.type and b.user_id is not distinct from a.user_id
  where a.family_id = fam
    and ((a.related_id = renewal_key and b.related_id = renewal_old) or (a.related_id = doc_key and b.related_id = doc_old))
    and b.created_at < a.created_at;
  if n <> 2 then
    raise exception '#936 FAIL: expected the legacy row to be older than the dated row for both candidates, found % such pairs', n;
  end if;

  raise notice '#936 OK: related_id is text; a renewal key and a document key are stored and read back with their legacy rows.';
end $probe$;

rollback;
