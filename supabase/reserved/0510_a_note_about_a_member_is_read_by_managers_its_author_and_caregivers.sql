-- 0510 — A note about a member is read by a manager, its author and a
-- caregiver.
-- Decided by the account holder this session, recorded and requested on #771
-- in comment 6103909775. The question 0506's header left open ("behavior_logs
-- and care_log … whether the member reads them is a separate decision") and
-- 0481's FIX 2 deferred.
--
-- behavior_logs_select and care_log_read are is_family_member(family_id)
-- (minus a guest: 0481 for care_log, the held 0509 for both), so a sibling, a
-- teen or a child reads every behaviour note and care note written about every
-- other member: "Concern: focus, -1" about a brother, the care log of a
-- sister's bad night. lib/ai/context/policy.ts lists both as sensitive
-- ("behaviour notes about children", "care notes").
--
-- The decision:
--   * a parent or adult reads every note;
--   * whoever wrote a note keeps reading it (behavior_logs.logged_by,
--     care_log.created_by: the user id each table's attribution guard pins to
--     the writer), so a child's note about themselves stays theirs;
--   * a caregiver reads the household's notes: a babysitter needs the care
--     log of the children they look after;
--   * nobody else, and not the member a note is about when someone else
--     wrote it.
--
-- For each table this replaces every permissive SELECT policy with one:
--
--   is_family_member(family_id)
--   and (can_manage_family(family_id)               -- a parent or adult
--        or <author> = auth.uid()                   -- what you wrote
--        or family_role(family_id) = 'caregiver')   -- the babysitter
--
-- The outer is_family_member keeps it to active members (family_role does not
-- read is_active; one membership row per family and user makes the pair
-- exact). RESTRICTIVE read policies already there (0481's, the held 0509's)
-- are kept and still AND with it. Writes are unchanged: 0481's insert guard
-- keeps a non-manager logging only about themselves.
--
-- Shipped with the source (lib/care/note-scope.ts, the same rule): the care log
-- (/dashboard/care) shows each reader the notes this rule gives them, and a
-- reader of only their own notes gets no summary cards (a summary of part of a
-- log reads as the whole); the behaviour page, where logging is a manager's,
-- tells anyone else whose the notes are. The AI care summary is a manager's
-- already (MANAGER_ONLY_INSIGHTS); the AI insights route and
-- /api/behavior/insight read through the caller's session, so RLS narrows them
-- too.
--
-- HELD: 0510, the first number above 0509, requested on #771 in comment
-- 6103909775 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-note-about-a-member-is-read-by-managers-its-author-and-caregivers-check.sql
-- and .github/workflows/member-notes-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  t record;
  p record;
begin
  if to_regprocedure('public.family_role(uuid)') is null or to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0510 needs family_role and can_manage_family';
  end if;
  for t in select * from (values ('behavior_logs', 'logged_by'), ('care_log', 'created_by')) as v(tbl, author) loop
    if to_regclass('public.' || t.tbl) is null
       or not exists (select 1 from information_schema.columns c
                       where c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = t.author and c.udt_name = 'uuid') then
      raise exception '0510 needs public.%.% (uuid)', t.tbl, t.author;
    end if;
    for p in select polname from pg_policy
              where polrelid = ('public.' || t.tbl)::regclass and polpermissive and polcmd in ('r', '*') loop
      execute format('drop policy %I on public.%I', p.polname, t.tbl);
    end loop;
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || 'public.is_family_member(family_id) and ('
      || 'public.can_manage_family(family_id) or %I = auth.uid() or public.family_role(family_id) = ''caregiver''))',
      'A note is read by a manager, its author or a caregiver', t.tbl, t.author);
  end loop;
end
$$;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['behavior_logs', 'care_log'] loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*');
    if n <> 1 or not exists (select 1 from pg_policy
                              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'r'
                                and polname = 'A note is read by a manager, its author or a caregiver') then
      raise exception '0510: public.% carries % permissive read policies, not the one it sets', t, n;
    end if;
  end loop;
end
$$;
