-- ── What the family library streams is added by a parent or adult (0526) ─────
--
-- KIDS-O02: a subscription's episodes and a book's audio address reach every
-- member's library, a young child's included, and stream through Bubaly's own
-- media route. The actions let only a parent or adult subscribe or attach an
-- audio address, and the places that fetch ask who added the row
-- (lib/library/curator.ts); 0284's policies are `for all using
-- is_family_member(family_id)`, and created_by is whatever the writer says. The
-- held 0526 puts the rule on the tables.
--
-- Fixture, Library House: a parent (also a parent of Other House), an adult, a
-- teen (also a parent of Other House), a child, a caregiver, a guest, and a
-- second adult whose account is deleted. The parent's subscription with one
-- episode, the parent's audiobook, the second adult's subscription and book,
-- and a subscription the child planted before 0526 (written by the owner here).
--
-- What this probe asserts, through PostgREST's role, each attempt in its own
-- rolled-back subtransaction:
--
--   1. as the teen, the child and the caregiver, each refused by 0526's guard
--      (42501, its own sentence): adding a subscription; retargeting the
--      parent's; adding a book with an audio address; filing an episode under
--      the parent's subscription; rewriting the audio address of the parent's
--      audiobook; filing that audiobook under another subscription; emptying
--      created_by on the subscription the child planted (the curator check lets
--      an empty one through); filing a book under the parent's name. And the
--      teen, a parent of Other House, moving the parent's audiobook there;
--   2. the parent filing a subscription under the adult's name is refused, and
--      so is the parent emptying created_by while its account is still there;
--   3. control: the parent and the adult each add a subscription, an audiobook
--      and an episode, rewrite an audio address and file a subscription under
--      themselves; the teen, the child and the caregiver each add a title and a
--      page link, describe the parent's subscription (Refresh's own columns) and
--      rename the audiobook; the server (service_role, no user) files an episode
--      and describes the subscription; a guest is answered by 0464's guard; the
--      parent moves their audiobook to Other House, where they are a parent too;
--      and the second adult's account deleted in the parent's session empties
--      created_by on their rows (0284's on delete set null);
--   4. wiring: each table carries its guard, enabled, FOR EACH ROW, BEFORE
--      INSERT and UPDATE (not DELETE), SECURITY DEFINER, named to fire after
--      0481's guest guard;
--
-- and, only where 0526 is installed:
--
--   N1. NEGATIVE CONTROL: with both guards disabled, the child's subscription,
--       audio book and audio rewrite land: the fixture reaches the defect;
--   M1. MUTATION CONTROL: with library_items' guard on INSERT only, the child's
--       rewrite of the parent's audio address lands, so 1. catches the UPDATE
--       half going.
--
-- Everything is rolled back. This needs none of the other held files.
--
-- HELD with 0526: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/library-curation-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0526 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8526-0000000000a1','c0526-parent@example.com'),
  ('00000000-0000-4000-8526-0000000000a2','c0526-adult@example.com'),
  ('00000000-0000-4000-8526-0000000000a3','c0526-teen@example.com'),
  ('00000000-0000-4000-8526-0000000000a4','c0526-child@example.com'),
  ('00000000-0000-4000-8526-0000000000a5','c0526-caregiver@example.com'),
  ('00000000-0000-4000-8526-0000000000a6','c0526-guest@example.com'),
  ('00000000-0000-4000-8526-0000000000a8','c0526-departing@example.com')
  on conflict do nothing;
-- on_family_created files each creator as the household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8526-0000000000f1','Library House','00000000-0000-4000-8526-0000000000a1'),
  ('00000000-0000-4000-8526-0000000000f2','Other House','00000000-0000-4000-8526-0000000000a3');
update public.family_members set role = 'parent', is_active = true
 where (family_id, user_id) in (('00000000-0000-4000-8526-0000000000f1'::uuid,'00000000-0000-4000-8526-0000000000a1'::uuid),
                                ('00000000-0000-4000-8526-0000000000f2'::uuid,'00000000-0000-4000-8526-0000000000a3'::uuid));
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8526-0000000000f1','00000000-0000-4000-8526-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8526-0000000000f1','00000000-0000-4000-8526-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8526-0000000000f1','00000000-0000-4000-8526-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8526-0000000000f1','00000000-0000-4000-8526-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8526-0000000000f1','00000000-0000-4000-8526-0000000000a6','Grandma','guest',true),
  ('00000000-0000-4000-8526-0000000000f1','00000000-0000-4000-8526-0000000000a8','Departing adult','adult',true),
  ('00000000-0000-4000-8526-0000000000f2','00000000-0000-4000-8526-0000000000a1','Parent','parent',true);
insert into public.library_feeds (id, family_id, kind, title, feed_url, created_by) values
  ('00000000-0000-4000-8526-0000000000e1','00000000-0000-4000-8526-0000000000f1','podcast','Parent show','https://parent.test/feed','00000000-0000-4000-8526-0000000000a1'),
  ('00000000-0000-4000-8526-0000000000e2','00000000-0000-4000-8526-0000000000f1','podcast','Departing show','https://departing.test/feed','00000000-0000-4000-8526-0000000000a8'),
  -- Planted by the child over PostgREST before 0526 (written by the owner here).
  ('00000000-0000-4000-8526-0000000000e3','00000000-0000-4000-8526-0000000000f1','podcast','Planted show','https://planted.test/feed','00000000-0000-4000-8526-0000000000a4');
insert into public.library_items (id, family_id, feed_id, kind, guid, title, media_url, created_by) values
  ('00000000-0000-4000-8526-0000000000b1','00000000-0000-4000-8526-0000000000f1',null,'book','manual:parent','Parent audiobook','https://cdn.test/book.mp3','00000000-0000-4000-8526-0000000000a1'),
  ('00000000-0000-4000-8526-0000000000b2','00000000-0000-4000-8526-0000000000f1',null,'book','manual:departing','Departing audiobook','https://cdn.test/departing.mp3','00000000-0000-4000-8526-0000000000a8'),
  ('00000000-0000-4000-8526-0000000000b3','00000000-0000-4000-8526-0000000000f1','00000000-0000-4000-8526-0000000000e1','episode','parent-1','Episode one','https://cdn.test/ep1.mp3',null);

-- One statement as one caller, and exactly what happened; back to the owner
-- with no user id. p_uid '' is a caller with no user (the service role).
create or replace function pg_temp.c0526_as(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', case when p_uid = '' then json_build_object('role', p_role)
                                                 else json_build_object('sub', p_uid, 'role', p_role) end::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

-- The same, undone afterwards, so no attempt changes what the next one sees.
create or replace function pg_temp.c0526_try(p_role text, p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare got text;
begin
  begin
    got := pg_temp.c0526_as(p_role, p_uid, p_sql);
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  return got;
end
$fn$;

-- What a teen, a child or a caregiver may not do, the refusal 0526 gives, and
-- the statement (%1$s: the caller's own user id).
create temp table c0526_refused (what text, refusal text, stmt text) on commit drop;
insert into c0526_refused values
  ('added a subscription', 'subscription',
   'insert into public.library_feeds (family_id, title, feed_url, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''Planted'', ''https://planted.test/new'', %1$L)'),
  ('retargeted the parent''s subscription', 'subscription',
   'update public.library_feeds set feed_url = ''https://planted.test/retargeted'' where id = ''00000000-0000-4000-8526-0000000000e1'''),
  ('added a book with an audio address', 'audio',
   'insert into public.library_items (family_id, kind, guid, title, media_url, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''book'', ''manual:planted'', ''Planted'', ''https://planted.test/a.mp3'', %1$L)'),
  ('filed an episode under the parent''s subscription', 'audio',
   'insert into public.library_items (family_id, feed_id, kind, guid, title, media_url) values (''00000000-0000-4000-8526-0000000000f1'', ''00000000-0000-4000-8526-0000000000e1'', ''episode'', ''planted-1'', ''Planted'', ''https://planted.test/e.mp3'')'),
  ('rewrote the audio address of the parent''s audiobook', 'audio',
   'update public.library_items set media_url = ''https://planted.test/b.mp3'' where id = ''00000000-0000-4000-8526-0000000000b1'''),
  ('filed the parent''s audiobook under another subscription', 'audio',
   'update public.library_items set feed_id = ''00000000-0000-4000-8526-0000000000e3'' where id = ''00000000-0000-4000-8526-0000000000b1'''),
  ('emptied who added the subscription the child planted', 'created_by',
   'update public.library_feeds set created_by = null where id = ''00000000-0000-4000-8526-0000000000e3'''),
  ('filed a book under the parent''s name', 'created_by',
   'insert into public.library_items (family_id, kind, guid, title, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''book'', ''manual:mine'', ''Mine'', ''00000000-0000-4000-8526-0000000000a1'')');

do $$
declare
  subscription constant text := '42501: Only a parent or another adult adds or changes a subscription in the family library';
  audio constant text := '42501: Only a parent or another adult adds or changes audio in the family library';
  named constant text := '42501: A row in the family library names the adult who added it';
  guest_guard constant text := '42501: A guest can see the household but not change it';
  parent constant text := '00000000-0000-4000-8526-0000000000a1';
  adult constant text := '00000000-0000-4000-8526-0000000000a2';
  child constant text := '00000000-0000-4000-8526-0000000000a4';
  failures text[] := '{}';
  bad text[];
  installed boolean;
  r record;
  m record;
  expected text;
  got text;
  n bigint;
begin
  installed := (select count(*) from pg_trigger g
                 where g.tgfoid in (to_regprocedure('public.a_library_feed_is_added_by_a_parent_or_adult()'),
                                    to_regprocedure('public.a_library_items_audio_is_added_by_a_parent_or_adult()'))) = 2;

  -- 1. What the teen, the child and the caregiver may not do.
  for m in select * from (values ('teen', '00000000-0000-4000-8526-0000000000a3'),
                                 ('child', '00000000-0000-4000-8526-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8526-0000000000a5')) v(role, uid) loop
    for r in select * from c0526_refused loop
      expected := case r.refusal when 'subscription' then subscription when 'audio' then audio else named end;
      got := pg_temp.c0526_try('authenticated', m.uid, format(r.stmt, m.uid));
      if got like 'OK%' then
        failures := array_append(failures, format('the %s %s (%s)', m.role, r.what, got));
      elsif got is distinct from expected then
        failures := array_append(failures, format('the %s was refused when they %s, but not by 0526''s guard (%s)', m.role, r.what, got));
      end if;
    end loop;
  end loop;
  got := pg_temp.c0526_try('authenticated', '00000000-0000-4000-8526-0000000000a3',
    'update public.library_items set family_id = ''00000000-0000-4000-8526-0000000000f2'' where id = ''00000000-0000-4000-8526-0000000000b1''');
  if got like 'OK%' then
    failures := array_append(failures, format('the teen moved the parent''s audiobook to Other House, where they are a parent (%s)', got));
  elsif got is distinct from audio then
    failures := array_append(failures, format('the teen''s move of the parent''s audiobook was refused, but not by 0526''s guard (%s)', got));
  end if;

  -- 2. A parent files a subscription under their own name, not another adult's.
  got := pg_temp.c0526_try('authenticated', parent, format(
    'insert into public.library_feeds (family_id, title, feed_url, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''Show'', ''https://parent.test/other'', %L)', adult));
  if got like 'OK%' then
    failures := array_append(failures, format('the parent filed a subscription under the adult''s name (%s)', got));
  elsif got is distinct from named then
    failures := array_append(failures, format('the parent''s subscription under the adult''s name was refused, but not by 0526''s guard (%s)', got));
  end if;
  -- Nor empties who added one while that adult's account is still there.
  got := pg_temp.c0526_try('authenticated', parent,
    'update public.library_feeds set created_by = null where id = ''00000000-0000-4000-8526-0000000000e2''');
  if got like 'OK%' then
    failures := array_append(failures, format('the parent emptied who added the departing adult''s subscription while that account is there (%s)', got));
  elsif got is distinct from named then
    failures := array_append(failures, format('the parent''s emptying of who added a subscription was refused, but not by 0526''s guard (%s)', got));
  end if;

  -- 3. Controls.
  bad := '{}';
  for m in select * from (values ('parent', '00000000-0000-4000-8526-0000000000a1'),
                                 ('adult', '00000000-0000-4000-8526-0000000000a2')) v(role, uid) loop
    for r in select * from (values
        ('add a subscription', format('insert into public.library_feeds (family_id, title, feed_url, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''Show'', %L, %L)', 'https://' || m.role || '.test/new', m.uid)),
        ('add an audiobook', format('insert into public.library_items (family_id, kind, guid, title, media_url, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''book'', %L, ''Book'', ''https://cdn.test/new.mp3'', %L)', 'manual:new-' || m.role, m.uid)),
        ('file an episode', 'insert into public.library_items (family_id, feed_id, kind, guid, title, media_url) values (''00000000-0000-4000-8526-0000000000f1'', ''00000000-0000-4000-8526-0000000000e1'', ''episode'', ''parent-2'', ''Episode two'', ''https://cdn.test/ep2.mp3'')'),
        ('rewrite an audio address', 'update public.library_items set media_url = ''https://cdn.test/book-2.mp3'' where id = ''00000000-0000-4000-8526-0000000000b1'''),
        ('file the subscription under themselves', format('update public.library_feeds set created_by = %L where id = ''00000000-0000-4000-8526-0000000000e1''', m.uid))) v(what, stmt) loop
      got := pg_temp.c0526_try('authenticated', m.uid, r.stmt);
      if got <> 'OK 1' then
        bad := array_append(bad, format('the %s could not %s (%s)', m.role, r.what, got));
      end if;
    end loop;
  end loop;
  for m in select * from (values ('teen', '00000000-0000-4000-8526-0000000000a3'),
                                 ('child', '00000000-0000-4000-8526-0000000000a4'),
                                 ('caregiver', '00000000-0000-4000-8526-0000000000a5')) v(role, uid) loop
    for r in select * from (values
        ('add a title and a page link', format('insert into public.library_items (family_id, kind, guid, title, page_url, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''book'', %L, ''My book'', ''https://example.org/book'', %L)', 'manual:' || m.role, m.uid)),
        ('describe the parent''s subscription', 'update public.library_feeds set title = ''Renamed'', description = ''About'', last_fetched_at = now(), last_error = ''That address could not be read.'' where id = ''00000000-0000-4000-8526-0000000000e1'''),
        ('rename the parent''s audiobook', 'update public.library_items set title = ''Renamed'' where id = ''00000000-0000-4000-8526-0000000000b1''')) v(what, stmt) loop
      got := pg_temp.c0526_try('authenticated', m.uid, r.stmt);
      if got <> 'OK 1' then
        bad := array_append(bad, format('the %s could not %s (%s)', m.role, r.what, got));
      end if;
    end loop;
  end loop;
  got := pg_temp.c0526_try('service_role', '',
    'insert into public.library_items (family_id, feed_id, kind, guid, title, media_url) values (''00000000-0000-4000-8526-0000000000f1'', ''00000000-0000-4000-8526-0000000000e1'', ''episode'', ''parent-3'', ''Episode three'', ''https://cdn.test/ep3.mp3'')');
  if got <> 'OK 1' then
    bad := array_append(bad, format('the server could not file an episode (%s)', got));
  end if;
  got := pg_temp.c0526_try('service_role', '',
    'update public.library_feeds set title = ''Parent show'', last_fetched_at = now(), last_error = null where id = ''00000000-0000-4000-8526-0000000000e1''');
  if got <> 'OK 1' then
    bad := array_append(bad, format('the server could not describe the subscription (%s)', got));
  end if;
  for r in select * from (values
      ('a subscription', 'insert into public.library_feeds (family_id, title, feed_url, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''Show'', ''https://guest.test/feed'', ''00000000-0000-4000-8526-0000000000a6'')'),
      ('a book', 'insert into public.library_items (family_id, kind, guid, title, created_by) values (''00000000-0000-4000-8526-0000000000f1'', ''book'', ''manual:guest'', ''Book'', ''00000000-0000-4000-8526-0000000000a6'')')) v(what, stmt) loop
    got := pg_temp.c0526_try('authenticated', '00000000-0000-4000-8526-0000000000a6', r.stmt);
    if got is distinct from guest_guard then
      bad := array_append(bad, format('the guest''s %s was not answered by 0464''s guard (%s)', r.what, got));
    end if;
  end loop;
  got := pg_temp.c0526_try('authenticated', parent,
    'update public.library_items set family_id = ''00000000-0000-4000-8526-0000000000f2'' where id = ''00000000-0000-4000-8526-0000000000b1''');
  if got <> 'OK 1' then
    bad := array_append(bad, format('the parent could not move their audiobook to Other House, where they are a parent too (%s)', got));
  end if;
  -- The departing adult's account, deleted while the parent is signed in.
  begin
    perform set_config('request.jwt.claim.sub', parent, true);
    perform set_config('request.jwt.claims', json_build_object('sub', parent, 'role', 'authenticated')::text, true);
    begin
      delete from auth.users where id = '00000000-0000-4000-8526-0000000000a8';
      select count(*) into n
        from (select created_by from public.library_feeds where id = '00000000-0000-4000-8526-0000000000e2'
              union all
              select created_by from public.library_items where id = '00000000-0000-4000-8526-0000000000b2') x
       where x.created_by is null;
      if n <> 2 then
        bad := array_append(bad, format('deleting the departing adult''s account emptied created_by on %s of their 2 rows', n));
      end if;
    exception when others then
      bad := array_append(bad, format('deleting the departing adult''s account in the parent''s session failed (%s: %s)', sqlstate, sqlerrm));
    end;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  if cardinality(bad) > 0 then
    failures := array_append(failures, 'CONTROL: ' || array_to_string(bad, '; '));
  end if;

  -- 4. Wiring.
  bad := '{}';
  for r in select * from (values
      ('library_feeds', 'trg_library_feeds_parent_or_adult', 'trg_library_feeds_not_a_guests', 'public.a_library_feed_is_added_by_a_parent_or_adult()'),
      ('library_items', 'trg_library_items_parent_or_adult', 'trg_library_items_not_a_guests', 'public.a_library_items_audio_is_added_by_a_parent_or_adult()')) v(tbl, trg, guest_trg, fn) loop
    if to_regprocedure(r.fn) is null
       or not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                       where g.tgrelid = ('public.' || r.tbl)::regclass and g.tgname = r.trg
                         and g.tgfoid = to_regprocedure(r.fn) and g.tgenabled <> 'D'
                         and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 20) = 20 and (g.tgtype & 8) = 0
                         and p.prosecdef
                         and r.trg > r.guest_trg) then
      bad := array_append(bad, r.tbl);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    failures := array_append(failures, format('0526''s guard is not in place on %s', array_to_string(bad, ', ')));
  end if;

  if installed then
    -- N1. Both guards disabled.
    begin
      alter table public.library_feeds disable trigger trg_library_feeds_parent_or_adult;
      alter table public.library_items disable trigger trg_library_items_parent_or_adult;
      bad := '{}';
      for r in select * from c0526_refused where what in ('added a subscription', 'added a book with an audio address', 'rewrote the audio address of the parent''s audiobook') loop
        got := pg_temp.c0526_try('authenticated', child, format(r.stmt, child));
        if got <> 'OK 1' then
          bad := array_append(bad, format('%s (%s)', r.what, got));
        end if;
      end loop;
      if cardinality(bad) > 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guards disabled the child still was not let through: %s, so this fixture cannot see the defect', array_to_string(bad, '; ')));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. library_items' guard on INSERT only.
    begin
      drop trigger trg_library_items_parent_or_adult on public.library_items;
      create trigger trg_library_items_parent_or_adult before insert on public.library_items
        for each row execute function public.a_library_items_audio_is_added_by_a_parent_or_adult();
      got := pg_temp.c0526_try('authenticated', child,
        'update public.library_items set media_url = ''https://planted.test/mutated.mp3'' where id = ''00000000-0000-4000-8526-0000000000b1''');
      if got <> 'OK 1' then
        failures := array_append(failures, format('MUTATION CONTROL: with library_items'' guard off UPDATE the child''s rewrite of the audio address still did not land (%s), so 1. cannot catch the update half going', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'what the family library streams is added by a parent or adult:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'what-the-library-streams-is-added-by-a-parent-or-adult: OK (as the teen, the child and the caregiver, adding or retargeting a subscription, adding a book with audio, filing an episode, rewriting or refiling the parent''s audiobook, emptying created_by and filing a book under the parent''s name were each refused by 0526''s guard, and the teen''s move of the audiobook to a household they manage too; the parent''s subscription under another adult''s name, and the parent''s emptying of created_by on a live account, refused; parents and adults still add and change audio and subscriptions, everyone else still adds a title and a link and describes a subscription, the server still files and describes, a guest is answered by 0464''s guard, a parent of both moves a book, a deleted account empties created_by; both guards in place after the guest guard; negative control: with the guards disabled the child''s writes landed; mutation control: with the items guard off UPDATE the audio rewrite landed)';
end $$;

rollback;
