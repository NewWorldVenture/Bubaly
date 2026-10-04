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
--   7  the price-drop trigger, change by change, with the notice bodies
--      read back: a listing saved by another family drops twice while
--      the first notice is unread — both updates go through, ONE notice
--      stands and it still carries the FIRST drop's prices (the payload
--      difference 0489 introduces, documented in its header); a watcher
--      who has READ the notice is told of the next drop with that drop's
--      prices; with EVERY notice read (so the index cannot mask it) a
--      rise notifies nobody and a drop on a completed listing notifies
--      nobody (0191's own rules); every change is in
--      marketplace_price_history                                        -> asserted
--   8  negative control for 7's rise rule: the trigger function is
--      replaced, inside this rolled-back transaction, by 0191's body with
--      the "price went down" condition removed; a rise then DOES write a
--      notice, so the assertion in 7 is live, not masked by the index    -> asserted
--   9  the repair, on pre-existing duplicates, by re-applying 0489 ITSELF
--      (\ir, same transaction): with the index dropped, duplicate groups
--      with distinct titles and bodies are seeded for a member, for the
--      family-wide row and with a created_at tie; the file is re-applied;
--      every row is still there, the oldest (created_at, then id) of each
--      group is the one left unread, the others are read, no title or
--      body changed, a row that was already read and a row under another
--      key are untouched, the index is back and the function is 0489's;
--      re-applied once more, nothing changes (LB-016 §4)                 -> asserted
--
-- Negative control, first: a key written once lands and reads back as written,
-- so a refusal below is the index's and not a grant's, a CHECK's or a trigger's.
--
-- Synthetic households only; rolled back, nothing outlives the assertion. The
-- two re-applications of 0489 run inside this transaction too: the file opens
-- no transaction of its own, so the rollback at the end takes them with it.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  def        text;
  cname      text;
  state      text;
  n          int;
  body_now   text;
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
  tail       text := ' — you saved this. Grab it before it''s gone.';
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

  -- 7. the price-drop trigger, change by change. The listing starts at $120.
  insert into public.marketplace_listings (id, family_id, title, price_cents) values (listing, fam, 'Stroller', 12000);
  insert into public.marketplace_saves (family_id, listing_id, member_id) values (watcher, listing, wmember);

  -- 7a. first drop, $120 -> $100: one unread notice, carrying those prices (control).
  update public.marketplace_listings set price_cents = 10000 where id = listing;
  select count(*), min(body) into n, body_now from public.notifications where family_id = watcher and related_id = listing::text and is_read = false;
  if n <> 1 then
    raise exception '0489 FAIL (control): the first price drop did not notify the watcher (found % rows)', n;
  end if;
  if body_now <> '$120.00 → $100.00' || tail then
    raise exception '0489 FAIL (control): the first notice does not carry the first drop''s prices: %', body_now;
  end if;

  -- 7b. second drop, $100 -> $90, while that notice is unread: the seller's
  --     update goes through, the watcher still has ONE notice, and it is the
  --     FIRST one, old prices and all. That is the behaviour 0489 trades for
  --     the index: before it, a second notice with "$100.00 → $90.00" was
  --     written. The header of 0489 says so; this pins it.
  begin
    update public.marketplace_listings set price_cents = 9000 where id = listing;
  exception when others then
    get stacked diagnostics state = returned_sqlstate;
    raise exception '0489 FAIL: a second price drop while the first notice is unread failed the seller''s update (%: %)', state, sqlerrm;
  end;
  select count(*), min(body) into n, body_now from public.notifications where family_id = watcher and related_id = listing::text;
  if n <> 1 then
    raise exception '0489 FAIL: expected the watcher to keep exactly one unread notice after two drops, found %', n;
  end if;
  if body_now <> '$120.00 → $100.00' || tail then
    raise exception '0489 FAIL: the one notice kept should be the first drop''s, with its prices; it reads: %', body_now;
  end if;
  if (select price_cents from public.marketplace_listings where id = listing) <> 9000 then
    raise exception '0489 FAIL: the second price change did not land';
  end if;
  -- The rest of 0191 is untouched: every change is still logged, drop or not.
  select count(*) into n from public.marketplace_price_history where listing_id = listing;
  if n <> 2 then
    raise exception '0489 FAIL: expected two price-history rows after two changes, found % (the trigger''s logging changed)', n;
  end if;

  -- 7c. the watcher reads the notice; the next drop, $90 -> $80, is announced
  --     with ITS prices: the index covers unread rows only, so the insert lands.
  update public.notifications set is_read = true where family_id = watcher and related_id = listing::text;
  update public.marketplace_listings set price_cents = 8000 where id = listing;
  select count(*) into n from public.notifications where family_id = watcher and related_id = listing::text;
  if n <> 2 then
    raise exception '0489 FAIL: a watcher who read the first notice should be told of the next drop (found % rows)', n;
  end if;
  select body into body_now from public.notifications where family_id = watcher and related_id = listing::text and is_read = false;
  if body_now <> '$90.00 → $80.00' || tail then
    raise exception '0489 FAIL: the notice of the third drop should carry the third drop''s prices; it reads: %', body_now;
  end if;

  -- 7d. a rise, $80 -> $95, notifies nobody — asserted with EVERY notice read,
  --     so a row written here could not have been refused by the index. With
  --     an unread notice standing, this assertion would hold even without
  --     0191's rule; 8 below proves it is the rule that holds it.
  update public.notifications set is_read = true where family_id = watcher and related_id = listing::text;
  update public.marketplace_listings set price_cents = 9500 where id = listing;
  select count(*) into n from public.notifications where family_id = watcher and related_id = listing::text;
  if n <> 2 then
    raise exception '0489 FAIL: a price rise notified the watcher (found % rows)', n;
  end if;

  -- 7e. a drop on a listing that is no longer available ($95 -> $70 on a
  --     completed one) notifies nobody either — same precaution: all read.
  update public.marketplace_listings set status = 'completed' where id = listing;
  update public.marketplace_listings set price_cents = 7000 where id = listing;
  select count(*) into n from public.notifications where family_id = watcher and related_id = listing::text;
  if n <> 2 then
    raise exception '0489 FAIL: a price drop on a completed listing notified the watcher (found % rows)', n;
  end if;
  if (select count(*) from public.notifications where family_id = watcher and related_id = listing::text and is_read = false) <> 0 then
    raise exception '0489 FAIL: 7d/7e were not run with every notice read; their assertions prove nothing';
  end if;

  -- 7f. the history has every one of the five changes, whatever direction or
  --     status: 0191's logging is before its notice condition and is untouched.
  select count(*) into n from public.marketplace_price_history where listing_id = listing;
  if n <> 5 then
    raise exception '0489 FAIL: expected five price-history rows after five changes, found %', n;
  end if;
  -- Available again for the control in 8.
  update public.marketplace_listings set status = 'available' where id = listing;
end $probe$;

-- 8. Negative control for 7d. 0191's function with ONE condition removed: the
--    "price went down" test. Inside this transaction only; the re-application
--    of 0489 in 9 puts the real function back, and the rollback at the end
--    would anyway. Every notice is read, so the index refuses nothing here.
create or replace function public.marketplace_log_price_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old text := '$' || to_char(old.price_cents / 100.0, 'FM999990.00');
  v_new text := '$' || to_char(new.price_cents / 100.0, 'FM999990.00');
begin
  if coalesce(new.sale_format, 'fixed') = 'auction' then return new; end if;
  insert into public.marketplace_price_history (listing_id, family_id, old_cents, new_cents)
  values (new.id, new.family_id, old.price_cents, new.price_cents);
  -- MUTANT (probe only): no `new.price_cents < old.price_cents` here.
  if new.price_cents > 0 and new.status in ('available', 'pending') then
    insert into public.notifications (family_id, user_id, type, title, body, related_type, related_id)
    select distinct s.family_id, null::uuid, 'system'::public.notification_type,
      'Price dropped: "' || left(new.title, 60) || '"',
      v_old || ' → ' || v_new || ' — you saved this. Grab it before it''s gone.',
      'marketplace_listings', new.id
    from public.marketplace_saves s
    where s.listing_id = new.id
    on conflict do nothing;
  end if;
  return new;
end $$;

do $mutant$
declare
  n        int;
  body_now text;
  watcher  uuid := 'a4890000-0000-4000-8000-0000000000f2';
  listing  uuid := 'a4890000-0000-4000-8000-000000000021';
begin
  if (select count(*) from public.notifications where family_id = watcher and related_id = listing::text and is_read = false) <> 0 then
    raise exception '0489 FAIL (control 8): an unread notice stands, so a refusal here would be the index''s, not the mutant''s';
  end if;
  -- A rise, $70 -> $75, under the mutant: a notice IS written. So 7d's "found
  -- 2 rows" was the rule's doing, not the index's.
  update public.marketplace_listings set price_cents = 7500 where id = listing;
  select count(*) into n from public.notifications where family_id = watcher and related_id = listing::text;
  if n <> 3 then
    raise exception '0489 FAIL (control 8): with the rise condition removed a rise should have notified the watcher; found % rows, so 7d''s assertion is masked', n;
  end if;
  select body into body_now from public.notifications where family_id = watcher and related_id = listing::text and is_read = false;
  if body_now not like '$70.00 → $75.00%' then
    raise exception '0489 FAIL (control 8): the mutant''s notice should carry the rise''s prices; it reads: %', body_now;
  end if;
  update public.notifications set is_read = true where family_id = watcher and related_id = listing::text;
end $mutant$;

-- 9. The repair, on pre-existing duplicates, by re-applying the file itself.
--    The index goes first (inside this transaction), the duplicates are seeded
--    the way a database that was never under the index would hold them, and
--    0489 is then applied over them exactly as docs/audit/pg-bootstrap.sh and
--    rehearse-ledger-repair.sh apply it: the same statements, in order.
drop index public.uq_notifications_unread_occurrence;

do $seed$
declare
  fam uuid := 'a4890000-0000-4000-8000-0000000000f1';
  mom uuid := 'a4890000-0000-4000-8000-000000000001';
  dad uuid := 'a4890000-0000-4000-8000-000000000002';
  k_a text := 'a4890000-0000-4000-8000-000000000051:2026-10-04';
  k_b text := 'a4890000-0000-4000-8000-000000000052:2026-10-04';
  k_c text := 'a4890000-0000-4000-8000-000000000053:2026-10-20';
  k_d text := 'a4890000-0000-4000-8000-000000000054:2026-10-04';
begin
  if exists (select 1 from pg_indexes where indexname = 'uq_notifications_unread_occurrence') then
    raise exception '0489 FAIL (9): the index is still there; the duplicates below could not be seeded';
  end if;
  insert into public.notifications (id, family_id, user_id, type, title, body, related_type, related_id, is_read, created_at) values
    -- group A, one member, one key: three unread with DIFFERENT texts, plus a
    -- row already read under the key, plus an unread row under another key.
    ('a4890000-0000-4000-8000-0000000000a1', fam, mom, 'medication_due', 'A first',  'written 08:00', 'medications', k_a, false, '2026-10-04 08:00:00+00'),
    ('a4890000-0000-4000-8000-0000000000a2', fam, mom, 'medication_due', 'A second', 'written 08:05', 'medications', k_a, false, '2026-10-04 08:05:00+00'),
    ('a4890000-0000-4000-8000-0000000000a3', fam, mom, 'medication_due', 'A third',  'written 08:10', 'medications', k_a, false, '2026-10-04 08:10:00+00'),
    ('a4890000-0000-4000-8000-0000000000a4', fam, mom, 'medication_due', 'A read',   'read already',  'medications', k_a, true,  '2026-10-04 07:00:00+00'),
    ('a4890000-0000-4000-8000-0000000000a5', fam, mom, 'medication_due', 'B alone',  'another key',   'medications', k_b, false, '2026-10-04 07:30:00+00'),
    -- group C, the family-wide row (user_id NULL): two unread, different bodies.
    ('a4890000-0000-4000-8000-0000000000c1', fam, null, 'document_expiry', 'C old', 'expires in 16 days', 'renewals', k_c, false, '2026-10-04 09:00:00+00'),
    ('a4890000-0000-4000-8000-0000000000c2', fam, null, 'document_expiry', 'C new', 'expires in 15 days', 'renewals', k_c, false, '2026-10-04 09:01:00+00'),
    -- group D, another member: two unread written at the SAME instant; the
    -- tie is broken by id, so ...d1 is the survivor.
    ('a4890000-0000-4000-8000-0000000000d1', fam, dad, 'medication_due', 'D one', 'tie',  'medications', k_d, false, '2026-10-04 10:00:00+00'),
    ('a4890000-0000-4000-8000-0000000000d2', fam, dad, 'medication_due', 'D two', 'tie',  'medications', k_d, false, '2026-10-04 10:00:00+00');
  create temp table once_seeded as
    select id, family_id, user_id, type, title, body, related_id, is_read, created_at
      from public.notifications where id::text like 'a4890000-0000-4000-8000-0000000000__';
  if (select count(*) from once_seeded) <> 9 then
    raise exception '0489 FAIL (9): expected 9 seeded rows, found %', (select count(*) from once_seeded);
  end if;
end $seed$;

\ir ../../supabase/migrations/0489_a_notification_is_written_once_per_occurrence.sql

do $repair$
declare
  n    int;
  src  text;
  bad  text;
begin
  -- Every seeded row is still there; no title, body, recipient, key or time changed.
  select count(*) into n from public.notifications n2 join once_seeded s using (id)
   where n2.family_id = s.family_id and n2.user_id is not distinct from s.user_id and n2.type = s.type
     and n2.title = s.title and n2.body = s.body and n2.related_id = s.related_id and n2.created_at = s.created_at;
  if n <> 9 then
    raise exception '0489 FAIL (9): the repair should keep all 9 rows as written; % match', n;
  end if;
  -- Survivor selection: oldest unread by created_at, then id.
  select string_agg(right(id::text, 2) || '=' || is_read::text, ',' order by id) into bad
    from public.notifications where id::text like 'a4890000-0000-4000-8000-0000000000__'
     and is_read <> (right(id::text, 2) in ('a2', 'a3', 'a4', 'c2', 'd2'));
  if bad is not null then
    raise exception '0489 FAIL (9): wrong survivors after the repair (id=is_read): % — expected a1, a5, c1, d1 unread and a2, a3, a4, c2, d2 read', bad;
  end if;
  -- The index is back, and the function is 0489's (the mutant of 8 is gone).
  if not exists (select 1 from pg_indexes where indexname = 'uq_notifications_unread_occurrence') then
    raise exception '0489 FAIL (9): re-applying 0489 did not re-create the index';
  end if;
  select prosrc into src from pg_proc where proname = 'marketplace_log_price_change' and pronamespace = 'public'::regnamespace;
  if src not like '%new.price_cents < old.price_cents%' or src not like '%on conflict do nothing%' then
    raise exception '0489 FAIL (9): re-applying 0489 did not restore its trigger function';
  end if;
  create temp table once_after_first as select id, is_read from public.notifications where id::text like 'a4890000-0000-4000-8000-0000000000__';
end $repair$;

-- Once more: a file that is re-applied onto a schema that already carries it
-- (LB-016 §4, the rehearsal CI runs last) changes nothing.
\ir ../../supabase/migrations/0489_a_notification_is_written_once_per_occurrence.sql

do $again$
begin
  if exists (select id, is_read from once_after_first except select id, is_read from public.notifications where id::text like 'a4890000-0000-4000-8000-0000000000__')
     or exists (select id, is_read from public.notifications where id::text like 'a4890000-0000-4000-8000-0000000000__' except select id, is_read from once_after_first) then
    raise exception '0489 FAIL (9): re-applying 0489 a second time changed a row''s read state';
  end if;
  raise notice '0489 OK: one unread row per occurrence, by name; read rows and keyless rows are outside it; the price-drop trigger steps aside and its rules are live; the repair keeps every row and leaves the oldest unread; re-application is a no-op.';
end $again$;

rollback;
