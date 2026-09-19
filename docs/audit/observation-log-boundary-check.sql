-- ── 0329: a record ABOUT someone is not that person's to rewrite ────────────
--
-- Two tables whose own schemas separate the SUBJECT from the AUTHOR, and whose
-- policies know about neither.
--
-- `behavior_logs` (0073). The column comments say it outright:
--
--   member_id  uuid REFERENCES public.family_members(id) …,  -- the child
--   logged_by  uuid REFERENCES auth.users(id) …
--
-- and the migration header calls it "per-child behavior observations … Powers
-- parenting insights". It carries `kind = 'concern'` notes and a signed
-- `points` column. Its only policy is `FOR ALL … is_family_member`, so the
-- child it is about can edit the concerns written about them, delete them, and
-- award themselves points.
--
-- `care_log` (0032) is a different shape and this probe keeps them apart.
-- Its header says the log exists "so the whole family can see who last checked
-- in and how they're doing", so family-wide reads and family-wide INSERTs are
-- the stated intent — any sibling may record a visit. What is not intended is
-- one member REWRITING another's entry: `logged_by` is documented as "the
-- family member who performed/recorded the care", and an entry whose author or
-- subject can be changed afterwards records nothing.
--
-- Measured before 0329, as a signed-in child:
--   NOTICE: child erased a "concern" logged about them
--   NOTICE: child awarded themselves 99 behaviour points
--   NOTICE: child rewrote a SIBLING's care-log note
--   NOTICE: child reassigned a care-log entry to a different author
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/observation-log-boundary-check.sql
--
-- Re-runnable: the fixture family's rows are cleared before each run.
-- Audit C1-S8-09.
do $$
declare
  fam uuid := 'f0329000-0000-4000-8000-00000000fa01';
  up  uuid := 'f0329000-0000-4000-8000-00000000c001';  -- parent
  uk  uuid := 'f0329000-0000-4000-8000-00000000c002';  -- child (the attacker)
  us  uuid := 'f0329000-0000-4000-8000-00000000c003';  -- sibling
  mp uuid; mk uuid; ms uuid; blog uuid; clog uuid;
  n int; txt text; holes text[] := '{}';
begin
  insert into public.families (id, name) values (fam, '0329 observation logs') on conflict do nothing;
  insert into auth.users (id, email) values
    (up, 'p0329@example.test'), (uk, 'k0329@example.test'), (us, 's0329@example.test')
    on conflict do nothing;
  delete from public.behavior_logs where family_id = fam;
  delete from public.care_log       where family_id = fam;
  delete from public.family_members where family_id = fam;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, up, 'Parent', 'parent', true) returning id into mp;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uk, 'Kid', 'child', true) returning id into mk;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, us, 'Sibling', 'child', true) returning id into ms;

  -- A parent's observation about the child.
  insert into public.behavior_logs (family_id, member_id, kind, category, note, points, logged_by)
    values (fam, mk, 'concern', 'respect', 'Spoke rudely at dinner', -2, up)
    returning id into blog;
  -- A sibling's care entry about the person being cared for.
  insert into public.care_log (family_id, member_id, log_type, wellbeing, note, logged_by, created_by)
    values (fam, mp, 'visit', 3, 'Seemed tired; ate little.', ms, us)
    returning id into clog;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', uk::text, true);
  if auth.uid() is distinct from uk then
    raise exception '0329: impersonation failed — auth.uid() is %, expected the child', auth.uid();
  end if;

  -- ── 1. Erasing a concern logged about you ─────────────────────────────────
  begin
    delete from public.behavior_logs where id = blog;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child erased a "concern" logged about them'::text;
    raise notice 'child erased a "concern" logged about them';
  end if;

  -- ── 2. Awarding yourself points ───────────────────────────────────────────
  begin
    insert into public.behavior_logs (family_id, member_id, kind, category, note, points, logged_by)
      values (fam, mk, 'positive', 'responsibility', 'Did everything', 99, uk);
    holes := holes || 'child awarded themselves 99 behaviour points'::text;
    raise notice 'child awarded themselves 99 behaviour points';
  exception when insufficient_privilege then null;
  end;

  -- ── 3. Rewriting someone else's care entry ────────────────────────────────
  begin
    update public.care_log set note = 'Cheerful and well.', wellbeing = 5 where id = clog;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child rewrote a SIBLING''s care-log note'::text;
    raise notice 'child rewrote a SIBLING''s care-log note';
  end if;

  -- ── 4. Reassigning its authorship ─────────────────────────────────────────
  begin
    update public.care_log set logged_by = mk where id = clog;
    get diagnostics n = row_count;
  exception when insufficient_privilege then n := 0;
  end;
  if n > 0 then
    holes := holes || 'child reassigned a care-log entry to a different author'::text;
    raise notice 'child reassigned a care-log entry to a different author';
  end if;

  -- ── What must still work ──────────────────────────────────────────────────
  -- care_log INSERT is family-wide on purpose: 0032 says the point is that the
  -- whole family can see who last checked in, and any of them may record one.
  insert into public.care_log (family_id, member_id, log_type, wellbeing, note, logged_by, created_by)
    values (fam, mp, 'call', 4, 'Called after school.', mk, uk) returning id into clog;
  -- And the author may correct their own entry, and remove it.
  update public.care_log set note = 'Called after school; chatty.' where id = clog;
  select note into txt from public.care_log where id = clog;
  if txt is distinct from 'Called after school; chatty.' then
    raise exception '0329: an author can no longer correct their OWN care entry';
  end if;
  delete from public.care_log where id = clog;

  -- Reading both logs stays family-wide. Whether a child should SEE the
  -- concerns logged about them is a real product question and is recorded in
  -- the audit; this migration does not decide it.
  select count(*) into n from public.behavior_logs where family_id = fam;
  if n < 1 then raise exception '0329: behaviour logs are no longer readable by the family'; end if;
  select count(*) into n from public.care_log where family_id = fam;
  if n < 1 then raise exception '0329: care logs are no longer readable by the family'; end if;
  reset role;

  -- ── A parent keeps the pen ────────────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', up::text, true);
  insert into public.behavior_logs (family_id, member_id, kind, category, note, points, logged_by)
    values (fam, mk, 'positive', 'kindness', 'Helped a neighbour', 2, up) returning id into blog;
  update public.behavior_logs set note = 'Helped a neighbour carry shopping' where id = blog;
  select note into txt from public.behavior_logs where id = blog;
  if txt is distinct from 'Helped a neighbour carry shopping' then
    raise exception '0329: a parent can no longer edit a behaviour log';
  end if;
  delete from public.behavior_logs where id = blog;

  -- A manager may also moderate a care entry they did not write — the same
  -- allowance 0323 gives a family manager over a marketplace review.
  insert into public.care_log (family_id, member_id, log_type, note, logged_by, created_by)
    values (fam, mp, 'note', 'Sibling note.', ms, us) returning id into clog;
  update public.care_log set note = 'Moderated.' where id = clog;
  select note into txt from public.care_log where id = clog;
  if txt is distinct from 'Moderated.' then
    raise exception '0329: a parent can no longer moderate a care entry';
  end if;
  -- But not even a parent may rewrite WHO recorded it.
  begin
    update public.care_log set logged_by = mp where id = clog;
    holes := holes || 'a parent reassigned the authorship of a care entry'::text;
    raise notice 'a parent reassigned the authorship of a care entry';
  exception when insufficient_privilege then null;
  end;
  reset role;

  if array_length(holes, 1) is not null then
    raise exception '0329: %', array_to_string(holes, '; ');
  end if;
  raise notice '0329 OK — parents keep the behaviour log, and a care entry keeps its author';
end $$;
