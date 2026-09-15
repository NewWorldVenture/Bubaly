-- ── 0301: who may address and rewrite a notification ─────────────────────────
--
-- `notifications` is not an in-app list. The cron reads it with the service
-- role and turns each row into an email from Bubaly's own sender and a device
-- push. The email cron selects by `user_id` with NO family filter, so the
-- family_id a row claims never reaches the delivery decision.
--
-- Three things a client could do, none of them legitimate:
--   1. address a notification to a user in ANOTHER family
--   2. rewrite the text of a family-wide notice the product itself generated
--   3. clear sent_at/pushed_at, re-arming a delivered row so the cron sends
--      it again
--
-- and three it must still be able to do, asserted alongside, because a revoke
-- that broke the product would otherwise read as a pass.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/notification-authorship-check.sql
--
-- Each attempt is judged on the row count as well as the refusal: an UPDATE
-- that RLS filters to no visible row changes nothing and raises nothing, so an
-- exception handler alone would read a silent block as a breach.
--
-- Re-runnable: the fixture family's rows are cleared before each run.
do $$
declare
  fam   uuid := 'e0301000-0000-4000-8000-00000000fa01';
  other uuid := 'e0301000-0000-4000-8000-00000000fa02';
  par   uuid := 'e0301000-0000-4000-8000-00000000c001';
  kid   uuid := 'e0301000-0000-4000-8000-00000000c002';
  out_u uuid := 'e0301000-0000-4000-8000-00000000c003';
  n int; blocked boolean;
begin
  insert into public.families (id, name) values (fam,'0301 notifications'), (other,'0301 other')
    on conflict (id) do nothing;
  insert into auth.users (id, email) values
    (par,'p0301@example.test'), (kid,'k0301@example.test'), (out_u,'o0301@example.test')
    on conflict (id) do nothing;

  delete from public.notifications  where family_id in (fam, other);
  delete from public.family_members where family_id in (fam, other);
  insert into public.family_members (family_id,user_id,display_name,role,is_active) values
    (fam,par,'Parent','parent',true), (fam,kid,'Kid','child',true),
    (other,out_u,'Outsider','parent',true);

  -- Bubaly's own rows: one family-wide notice and one already delivered to the
  -- child. Both are seeded deliberately — an assertion against an empty table
  -- passes whatever the policy says.
  insert into public.notifications (family_id,user_id,type,title,body,sent_at,pushed_at) values
    (fam, null, 'system', 'Rent is due Friday', 'From Bubaly', now(), now()),
    (fam, kid,  'system', 'Your chore',         'x',           now(), now());

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', kid::text, true);
  if auth.uid() is distinct from kid then
    raise exception '0301: impersonation failed — auth.uid() is %, expected the child', auth.uid();
  end if;
  if not public.is_family_member(fam) then
    raise exception '0301: fixture wrong — the child is not a family member, so nothing below is tested';
  end if;

  -- 1. A notification for this family addressed to someone outside it. The
  --    email cron would deliver it to that person regardless of family_id.
  blocked := false;
  begin
    insert into public.notifications (family_id,user_id,type,title,body)
      values (fam, out_u, 'system', 'cross-family', 'x');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception '0301: a member addressed a notification to a user in another family — Bubaly would email them';
  end if;

  -- 2. Rewriting a family-wide notice the product generated.
  blocked := false; n := 0;
  begin
    update public.notifications set title = 'Rent is CANCELLED this month', body = '— Bubaly'
     where family_id = fam and user_id is null;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0301: a member rewrote % family-wide notice(s) attributed to Bubaly', n;
  end if;

  -- 3. Clearing the delivery stamps is clearing the only thing that makes
  --    delivery once-only.
  blocked := false; n := 0;
  begin
    update public.notifications set sent_at = null, pushed_at = null where user_id = kid;
    get diagnostics n = row_count;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked and n > 0 then
    raise exception '0301: a member re-armed % delivered row(s) — the cron will send them again', n;
  end if;

  -- ── and the other direction: what must still work ──────────────────────────
  update public.notifications set is_read = true where user_id = kid;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '0301: a member can no longer mark their own notification read (% rows)', n;
  end if;

  insert into public.notifications (family_id,user_id,type,title,body)
    values (fam, par, 'system', 'in-family recipient', 'x');
  insert into public.notifications (family_id,user_id,type,title,body)
    values (fam, null, 'system', 'family-wide row', 'x');

  -- 4. Control: a non-member is refused the same insert, so the assertions
  --    above are measuring the recipient rule and not an empty capability.
  perform set_config('request.jwt.claim.sub', out_u::text, true);
  blocked := false;
  begin
    insert into public.notifications (family_id,user_id,type,title,body)
      values (fam, par, 'system', 'outsider', 'x');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception '0301: a non-member inserted into this family — the probe is not measuring a boundary';
  end if;

  reset role;
  raise notice '0301 notification authorship OK';
end $$;

-- The grants from the catalog: a policy can be re-created by a later migration,
-- and a table-level grant cannot be narrowed by revoking one column.
do $$
declare n int; begin
  select count(*) into n from information_schema.column_privileges
   where table_schema='public' and table_name='notifications'
     and grantee in ('anon','authenticated') and privilege_type='UPDATE'
     and column_name <> 'is_read';
  if n <> 0 then
    raise exception '0301: % client UPDATE grant(s) beyond is_read are back on notifications', n;
  end if;
  select count(*) into n from information_schema.column_privileges
   where table_schema='public' and table_name='notifications'
     and grantee='authenticated' and privilege_type='UPDATE' and column_name='is_read';
  if n <> 1 then
    raise exception '0301: marking a notification read lost its grant';
  end if;
  raise notice '0301 notification grants OK';
end $$;
