-- A notification is written once per occurrence: 0489's index, measured. (#936 follow-up)
--
-- Both writers of notifications dedupe with a read and then insert; two runs
-- for one family at the same minute could both read "not announced" and both
-- write. 0489 puts a partial unique index behind that read:
--
--   uq_notifications_unread_occurrence
--     on (family_id, type, related_id, user_id) nulls not distinct
--     where related_id is not null and is_read = false
--
-- and re-creates 0191's price-drop trigger with ON CONFLICT DO NOTHING so a
-- second drop while the first notice is unread does not fail the seller's
-- price change. Asserted here, on the fully replayed schema, as a session that
-- bypasses RLS (the writers are the service role):
--
--   1  the index is exactly 0489's: unique, those four columns, NULLS NOT
--      DISTINCT, that predicate                                        -> asserted
--   2  the second unread copy of one key for one member is refused with
--      23505 NAMING THAT INDEX (GET STACKED DIAGNOSTICS), not any 23505 -> asserted
--   3  the family-wide row (user_id NULL) is one occurrence too: its
--      second unread copy is refused the same way                       -> asserted
--   4  once the first copy is read, a second notice under the key lands
--      (notify()'s unread-only rule is kept)                            -> asserted
--   5  another member, another day key, another type each land: the key
--      is the occurrence, not the medication/renewal                    -> asserted
--   6  a row with no key is outside the index: two land                 -> asserted
--   7  a listing saved by another family drops its price twice while the
--      first notice is unread: both updates go through, one notice stands;
--      both changes are logged in marketplace_price_history as before; a
--      watcher who has READ the notice is told of the next drop; a rise
--      notifies nobody (0191's own rule, untouched)                        -> asserted
--
-- Negative control, first: a key written once lands and reads back as written,
-- so a refusal below is the index's and not a grant's, a CHECK's or a trigger's.
--
-- Synthetic households only; rolled back, nothing outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  def        text;
  cname      text;
  state      text;
  n          int;
  fam        uuid := 'a4890000-0000-4000-8000-0000000000f1';
  watcher    uuid := 'a4890000-0000-4000-8000-0000000000f2';
  mom        uuid := 'a4890000-0000-4000-8000-000000000001';
  dad        uuid := 'a4890000-0000-4000-8000-000000000002';
  wmom       uuid := 'a4890000-0000-4000-8000-000000000003';
  wmember    uuid;
  listing    uuid := 'a4890000-0000-4000-8000-000000000021';
  med        text := 'a4890000-0000-4000-8000-000000000031';
  key_today  text := med || ':2026-10-04';
  key_tmrw   text := med || ':2026-10-05';
begin
  if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
    raise exception '0489 probe: must run as a role that bypasses RLS (postgres in CI); % does not', current_user;
  end if;

  -- 1. the index, as 0489 describes it.
  select indexdef into def from pg_indexes
   where schemaname = 'public' and tablename = 'notifications' and indexname = 'uq_notifications_unread_occurrence';
  if def is null then
    raise exception '0489 FAIL: uq_notifications_unread_occurrence does not exist';
  end if;
  if def not like '%UNIQUE INDEX%' or def not like '%(family_id, type, related_id, user_id) NULLS NOT DISTINCT%'
     or def not like '%WHERE ((related_id IS NOT NULL) AND (is_read = false))%' then
    raise exception '0489 FAIL: the index is not the one 0489 describes: %', def;
  end if;

  -- The probe's households.
  insert into auth.users (id, email) values
    (mom, 'once-mom@example.test'), (dad, 'once-dad@example.test'), (wmom, 'once-watcher@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Once', mom), (watcher, 'Watcher', wmom) on conflict (id) do nothing;
  -- The families trigger seats the creator as a member; the save below is hers.
  select id into wmember from public.family_members where family_id = watcher and user_id = wmom;
  if wmember is null then
    insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (watcher, wmom, 'Watcher Mom', 'parent', true) returning id into wmember;
  end if;

  -- Negative control: the first copy lands and reads back.
  insert into public.notifications (family_id, user_id, type, title, related_type, related_id)
  values (fam, mom, 'medication_due', 'Medication due: Vitamin D', 'medications', key_today);
  select count(*) into n from public.notifications where family_id = fam and user_id = mom and related_id = key_today and is_read = false;
  if n <> 1 then
    raise exception '0489 FAIL (control): the first copy of a key did not land as written (found %)', n;
  end if;

  -- 2. the second unread copy, same member: refused by THIS index.
  begin
    insert into public.notifications (family_id, user_id, type, title, related_type, related_id)
    values (fam, mom, 'medication_due', 'Medication due: Vitamin D', 'medications', key_today);
    raise exception '0489 FAIL: a second unread copy of one key for one member landed';
  exception when unique_violation then
    get stacked diagnostics cname = constraint_name;
    if cname <> 'uq_notifications_unread_occurrence' then
      raise exception '0489 FAIL: refused by "%", not by uq_notifications_unread_occurrence', cname;
    end if;
  end;

  -- 3. the family-wide row is one occurrence too.
  insert into public.notifications (family_id, user_id, type, title, related_type, related_id)
  values (fam, null, 'document_expiry', 'Renewal due: Car insurance', 'renewals', 'a4890000-0000-4000-8000-000000000041:2026-10-20');
  begin
    insert into public.notifications (family_id, user_id, type, title, related_type, related_id)
    values (fam, null, 'document_expiry', 'Renewal due: Car insurance', 'renewals', 'a4890000-0000-4000-8000-000000000041:2026-10-20');
    raise exception '0489 FAIL: a second unread family-wide copy of one key landed (NULLS NOT DISTINCT is not in force)';
  exception when unique_violation then
    get stacked diagnostics cname = constraint_name;
    if cname <> 'uq_notifications_unread_occurrence' then
      raise exception '0489 FAIL: the family-wide pair was refused by "%", not by the index', cname;
    end if;
  end;

  -- 4. read, then a second notice lands.
  update public.notifications set is_read = true where family_id = fam and user_id = mom and related_id = key_today;
  insert into public.notifications (family_id, user_id, type, title, related_type, related_id)
  values (fam, mom, 'medication_due', 'Medication due: Vitamin D', 'medications', key_today);
  select count(*) into n from public.notifications where family_id = fam and user_id = mom and related_id = key_today;
  if n <> 2 then
    raise exception '0489 FAIL: a read first copy should let a second notice land (found % rows)', n;
  end if;

  -- 5. another member, another day, another type: each its own occurrence.
  insert into public.notifications (family_id, user_id, type, title, related_type, related_id) values
    (fam, dad, 'medication_due', 'Medication due: Vitamin D', 'medications', key_today),
    (fam, mom, 'medication_due', 'Medication due: Vitamin D', 'medications', key_tmrw),
    (fam, mom, 'system',         'Medication due: Vitamin D', 'medications', key_tmrw);

  -- 6. no key, no index: two land.
  insert into public.notifications (family_id, user_id, type, title) values
    (fam, mom, 'system', 'Keyless notice'), (fam, mom, 'system', 'Keyless notice');

  -- 7. the price-drop trigger steps aside instead of failing the seller.
  insert into public.marketplace_listings (id, family_id, title, price_cents) values (listing, fam, 'Stroller', 12000);
  insert into public.marketplace_saves (family_id, listing_id, member_id) values (watcher, listing, wmember);
  update public.marketplace_listings set price_cents = 10000 where id = listing;
  select count(*) into n from public.notifications where family_id = watcher and related_id = listing::text and is_read = false;
  if n <> 1 then
    raise exception '0489 FAIL (control): the first price drop did not notify the watcher (found % rows)', n;
  end if;
  begin
    update public.marketplace_listings set price_cents = 9000 where id = listing;
  exception when others then
    get stacked diagnostics state = returned_sqlstate;
    raise exception '0489 FAIL: a second price drop while the first notice is unread failed the seller''s update (%: %)', state, sqlerrm;
  end;
  select count(*) into n from public.notifications where family_id = watcher and related_id = listing::text;
  if n <> 1 then
    raise exception '0489 FAIL: expected the watcher to keep exactly one unread notice after two drops, found %', n;
  end if;
  if (select price_cents from public.marketplace_listings where id = listing) <> 9000 then
    raise exception '0489 FAIL: the second price change did not land';
  end if;
  -- The rest of 0191 is untouched: every change is still logged, drop or not.
  select count(*) into n from public.marketplace_price_history where listing_id = listing;
  if n <> 2 then
    raise exception '0489 FAIL: expected two price-history rows after two changes, found % (the trigger''s logging changed)', n;
  end if;
  -- …and a watcher who has READ the notice is told of the next drop, as before:
  -- the index covers unread rows only, so the trigger''s insert lands again.
  update public.notifications set is_read = true where family_id = watcher and related_id = listing::text;
  update public.marketplace_listings set price_cents = 8000 where id = listing;
  select count(*) into n from public.notifications where family_id = watcher and related_id = listing::text;
  if n <> 2 then
    raise exception '0489 FAIL: a watcher who read the first notice should be told of the next drop (found % rows)', n;
  end if;
  -- …and a rise, or a change to a sold listing, still notifies nobody (0191's own rule).
  update public.marketplace_listings set price_cents = 9500 where id = listing;
  select count(*) into n from public.notifications where family_id = watcher and related_id = listing::text;
  if n <> 2 then
    raise exception '0489 FAIL: a price rise notified the watcher (found % rows)', n;
  end if;

  raise notice '0489 OK: one unread row per occurrence, by name; read rows and keyless rows are outside it; the price-drop trigger steps aside.';
end $probe$;

rollback;
