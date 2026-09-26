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
-- MECHANISM — two of them, not one. Checks 1 and 4 are refused by RLS
-- (`notif_insert`'s WITH CHECK as 0301 re-created it). Checks 2 and 3 are NOT
-- RLS: `notif_update` admits both writes, and what refuses them is the column
-- GRANT 0301 narrowed to `is_read`. Anything that files this probe under a
-- single mechanism has half of it wrong.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/notification-authorship-check.sql
--
-- Each attempt is judged on the row count as well as the refusal: an UPDATE
-- that RLS filters to no visible row changes nothing and raises nothing, so an
-- exception handler alone would read a silent block as a breach.
--
-- A NEGATIVE CONTROL runs first and gives those refusals their attribution —
-- see the block headed "NEGATIVE CONTROL" below, before check 1. Check 4's
-- refusal gets a second, smaller one at its own site.
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
  wide_n int; own_n int;
  ctl text[] := '{}';
  control_ok boolean := true;
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

  -- How many rows checks 2 and 3 name, counted by the superuser over the SAME
  -- WHERE clauses before any role switch — the ground truth control B/C and the
  -- must-still-work line compare against, instead of a hand-counted "1" that
  -- goes red on a healthy database the day this seed gains a row. Control A's
  -- row is addressed to `par`, so it joins neither set.
  select count(*) into wide_n from public.notifications where family_id = fam and user_id is null;
  select count(*) into own_n  from public.notifications where user_id = kid;
  if wide_n < 1 or own_n < 1 then
    raise exception '0301: fixture wrong — % family-wide and % child-addressed row(s) seeded; checks 2 and 3 would run against nothing', wide_n, own_n;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', kid::text, true);
  if auth.uid() is distinct from kid then
    raise exception '0301: impersonation failed — auth.uid() is %, expected the child', auth.uid();
  end if;
  if not public.is_family_member(fam) then
    raise exception '0301: fixture wrong — the child is not a family member, so nothing below is tested';
  end if;

  -- ── NEGATIVE CONTROL, and it runs FIRST, before the three refusals ─────────
  --
  -- WHICH RULE IS ACTUALLY UNDER TEST, AND WHICH MIGRATION OWNS IT. The three
  -- checks below are refused by TWO different mechanisms, so the control has a
  -- leg for each.
  --
  --   Check 1 (a cross-family recipient) is RLS. `notif_insert` was created by
  --   0004_rls.sql on the bare `is_family_member(family_id)`, re-created
  --   identically by 0118_rls_drift_repair.sql, and then DROPPED AND RE-CREATED
  --   by 0301_notification_authorship.sql with a second conjunct: `user_id is
  --   null or exists (select 1 from family_members m where m.family_id =
  --   notifications.family_id and m.user_id = notifications.user_id and
  --   m.is_active)`. 0301 is the last migration to name the policy: a grep for
  --   `notif_insert` hits 0004, 0118 and 0301 and nothing else, no
  --   `execute format(...)` policy loop reaches `notifications` (0004's list
  --   omits it; 0118's every-table-with-family_id loop names it in its
  --   exclusion list), and the catalog of a replayed database carries exactly
  --   notif_select/insert/update/delete.
  --   But a grep is true only on the day it ran, and the tree keeps growing,
  --   so this probe does NOT rest on it: the trailing catalog block re-reads
  --   `notif_insert`'s LIVE WITH CHECK and fails unless it still joins
  --   `family_members` and still calls `is_family_member(family_id)` — the
  --   assertion 0301 makes at its own end. That is what makes 0301's predicate
  --   the one being measured, not 0004's. Replaying the older one in your head
  --   is how this audit once credited a guard a later migration had replaced.
  --
  --   Checks 2 and 3 (rewriting a Bubaly notice; clearing the delivery stamps)
  --   are NOT RLS at all, and that is worth saying out loud because it is the
  --   easy thing to get wrong here. `notif_update`'s last definition is still
  --   0118's — USING `user_id = auth.uid() or (user_id is null and
  --   is_family_member(family_id))`, with no WITH CHECK, so USING is reused as
  --   the write test — and BOTH statements SATISFY it: in check 3 the child owns
  --   the row, and in check 2 the child is a member of the family-wide row's
  --   family. What refuses them is the column GRANT. 0301 ran `revoke update on
  --   notifications from anon, authenticated` and then `grant update (is_read)
  --   ... to authenticated`, so `title`, `body`, `sent_at` and `pushed_at` are
  --   columns this session may not name in a SET list. (Nothing else on this
  --   table raises 42501. Read from pg_trigger / pg_constraint / pg_index of a
  --   replayed database, not from a grep: its only triggers are Postgres's
  --   internal RI_ConstraintTrigger pairs for the two foreign keys — family_id
  --   -> families, user_id -> auth.users — which raise 23503, not 42501, and
  --   pass here because every id the probe writes exists; its only unique
  --   index is the primary key on `id`; it has no CHECK constraint and no
  --   rule. A guard trigger added LATER is not left to this sentence: control
  --   A/B/C below go red on one.) The trailing DO block reads that grant out
  --   of the catalog; what it cannot say is that the session reached the rows
  --   at all.
  --
  -- WHY THE REFUSALS ALONE PROVE NOTHING. All three catch
  -- `insufficient_privilege`, and 42501 is what Postgres raises for an RLS
  -- violation, for a missing table GRANT, for a column denial, for a NULL
  -- `auth.uid()` — and for a guard trigger, which is how this repository
  -- refuses writes in 0223, 0305, 0326 and 0331. Checks 2 and 3 then fall
  -- through to a ROW COUNT, and a row this session cannot SEE reports zero rows
  -- just as readily as a blocked write does. So without this control all three
  -- keep passing if:
  --
  --   * INSERT on notifications is revoked from `authenticated` outright, or a
  --     guard trigger is added to the table for some unrelated rule — check 1
  --     goes on passing with 0301's recipient conjunct loosened back to bare
  --     `is_family_member`, which is the exact cross-family address 0301 exists
  --     to close, and the one the email cron delivers without ever reading
  --     family_id;
  --   * the UPDATE grant is revoked wholesale rather than narrowed to `is_read`
  --     — checks 2 and 3 pass while the product's own mark-as-read is broken;
  --   * `set_config('request.jwt.claim.sub', …)` stops taking effect so
  --     `auth.uid()` is NULL — `is_family_member` then answers no to everything
  --     and every refusal arrives for a reason that has nothing to do with
  --     authorship. (The fixture check above catches that for the CHILD's
  --     session; check 4's outsider gets the same treatment at its own site.)
  --
  -- THE CONTROL: the same child, in the same session, through the same
  -- predicate and the same mechanism, with the one thing that mechanism keys on
  -- changed, and all three writes MUST LAND.
  --
  --   A. the same INSERT, the same column list, addressed to `par` instead of
  --      `out_u`. `par` is a 'parent' of THIS family and `out_u` a 'parent' of
  --      the other one, so the single conjunct that moves is the recipient's
  --      membership — precisely what 0301 added.
  --   B, C. the same UPDATE, over the SAME ROWS checks 2 and 3 name, with
  --      `is_read` in the SET list instead of title/body/sent_at/pushed_at.
  --      Naming the same rows is the load-bearing half: it is what proves the
  --      child could SEE and WRITE the family-wide notice and their own
  --      delivered row, which is what turns "zero rows" below into a statement
  --      about the SET list rather than about visibility. Postgres checks column
  --      privileges against the SET list and not against the values, so
  --      swapping the column on the same rows is the whole of the mirror — a
  --      control that touched some other row would sail straight past a
  --      narrowed USING clause. Each must reach EVERY row its check names —
  --      the counts `wide_n` / `own_n` taken by the superuser above — not a
  --      literal 1. Control B's leg is not an invented product claim: the
  --      notifications module's "mark all read" is `update({ is_read: true })
  --      .eq('family_id', …)`, which is exactly a member setting is_read on the
  --      family-wide rows.
  --
  -- The parent's writes further down do not cover any of this: they prove the
  -- guard lets SOMEBODY through, not that the CHILD's session could have written
  -- anything at all. Nor do the child's own must-still-work lines, because they
  -- run AFTER the refusals — which is how the document-vault probe passed for a
  -- release while the teen could not INSERT a document in the first place.
  --
  -- No UUID is invented here: the control reuses this probe's own `fam`, `par`
  -- and `kid` anchors and the two rows the seed above already plants, so it
  -- cannot collide with any of the other probes that share the database.
  begin
    insert into public.notifications (family_id,user_id,type,title,body)
      values (fam, par, 'system', 'control: recipient IS a member of this family', 'x');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      ctl := array_append(ctl, format(
        'CONTROL A FAILED: the child stored %s row(s) addressing a notification to a member of their OWN family, expected 1 — so check 1''s refusal says nothing about notif_insert''s recipient conjunct', n));
    end if;
  exception when others then
    control_ok := false;
    ctl := array_append(ctl, format(
      'CONTROL A FAILED: the child was refused a notification addressed to a member of their OWN family (%s: %s) — check 1''s refusal is not attributable to notif_insert; a revoked INSERT grant, a guard trigger and a dead auth.uid() all land here too', sqlstate, sqlerrm));
  end;

  if control_ok then
    begin
      update public.notifications set is_read = true
       where family_id = fam and user_id is null;
      get diagnostics n = row_count;
      if n <> wide_n then
        control_ok := false;
        ctl := array_append(ctl, format(
          'CONTROL B FAILED: the child changed is_read on %s of the %s family-wide notice(s) check 2 names — this session cannot reach every row check 2 tries to rewrite, so check 2''s zero rows would measure visibility and not the column grant. If notif_update was DELIBERATELY narrowed so members cannot write a family-wide row, that is a tightening, not a regression — but it also stops "mark all read" (components/modules/notifications-module.tsx) clearing family-wide notices, and check 2 must then be re-attributed to the policy and this control rewritten', n, wide_n));
      end if;
    exception when others then
      control_ok := false;
      ctl := array_append(ctl, format(
        'CONTROL B FAILED: the child could not set is_read on the family-wide notice (%s: %s) — the UPDATE grant is gone entirely rather than narrowed to is_read, or something else on this table refuses the write; either way check 2''s refusal is not the title/body column denial, and the product''s own "mark all read" is broken too', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      update public.notifications set is_read = true where user_id = kid;
      get diagnostics n = row_count;
      if n <> own_n then
        control_ok := false;
        ctl := array_append(ctl, format(
          'CONTROL C FAILED: the child changed is_read on %s of the %s delivered notification(s) addressed to them that check 3 names — so check 3''s zero rows would measure visibility, not the sent_at/pushed_at column denial', n, own_n));
      end if;
    exception when others then
      control_ok := false;
      ctl := array_append(ctl, format(
        'CONTROL C FAILED: the child could not set is_read on their own delivered notification (%s: %s), so check 3''s refusal is not attributable to the sent_at/pushed_at column denial', sqlstate, sqlerrm));
    end;
  end if;

  -- A failed control makes every refusal below unreadable, so say WHY here,
  -- while the reason is still in hand. The boundary is not reported as holding
  -- and not reported as broken: it is reported as UNPROVEN, and the build is red
  -- either way.
  if not control_ok then
    raise exception '0301 notification authorship UNPROVEN (the control these checks rest on did not hold): %', array_to_string(ctl, ' | ');
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
  if n <> own_n then
    raise exception '0301: a member can no longer mark their own notification read (% of % rows)', n, own_n;
  end if;

  insert into public.notifications (family_id,user_id,type,title,body)
    values (fam, par, 'system', 'in-family recipient', 'x');
  insert into public.notifications (family_id,user_id,type,title,body)
    values (fam, null, 'system', 'family-wide row', 'x');

  -- 4. Control: a non-member is refused the same insert, so the assertions
  --    above are measuring the recipient rule and not an empty capability.
  perform set_config('request.jwt.claim.sub', out_u::text, true);
  if auth.uid() is distinct from out_u then
    raise exception '0301: impersonation failed — auth.uid() is %, expected the outsider; a NULL uid refuses the insert below for a reason that is not membership', auth.uid();
  end if;

  --    ...and this refusal gets a control of its own, in the same idiom as the
  --    one at the top and for the same reason: THIS actor, the same statement,
  --    the same `notif_insert` predicate, with the truth of ONE conjunct
  --    flipped — `is_family_member(family_id)`, asked about the outsider's OWN
  --    family instead of `fam`. Two literals move to do it, (fam, par) ->
  --    (other, out_u), and that is forced: the recipient conjunct is TRUE in
  --    both statements (`par` is active in `fam`, `out_u` is active in
  --    `other`), whereas keeping `par` with `other` would make the recipient
  --    conjunct false too and the control would fail for the wrong reason. So
  --    two values move, one conjunct's value does. It must land. Without it, "the outsider was
  --    refused" is equally consistent with an outsider who could not address a
  --    notification anywhere at all, which is not a boundary; and the child's
  --    control above cannot stand in for it, because the whole question here is
  --    whether THIS session has the access the refusal is supposed to withhold.
  ctl := '{}'; control_ok := true;
  begin
    insert into public.notifications (family_id,user_id,type,title,body)
      values (other, out_u, 'system', 'control: an outsider CAN address a notification in their own family', 'x');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      ctl := array_append(ctl, format('stored %s row(s) instead of 1', n));
    end if;
  exception when others then
    control_ok := false;
    ctl := array_append(ctl, format('refused with %s: %s', sqlstate, sqlerrm));
  end;
  if not control_ok then
    raise exception '0301 non-member control UNPROVEN: the outsider could not address a notification inside their OWN family either (%) — so the refusal below is not attributable to is_family_member; a revoked INSERT grant, a guard trigger or a dead auth.uid() lands there too', array_to_string(ctl, ' | ');
  end if;

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
  raise notice '0301 notification authorship OK — control: the same child CAN address a notification to a member of their own family and CAN set is_read on both rows under test, and the outsider CAN write in their own family, so the refusals above are the recipient rule and the is_read-only column grant rather than a missing privilege, a guard trigger or a row nobody could see';
end $$;

-- The grants AND the policy body from the catalog, because the attribution
-- above rests on both and a later migration can change either: a policy can be
-- re-created, and a table-level grant cannot be narrowed by revoking one column.
-- The policy half is 0301's own closing assertion, lifted here so the claim
-- "notif_insert still pins the recipient" is re-checked on every run rather
-- than resting on a grep made when this file was written. It also closes the
-- one compound case the controls cannot: `notif_insert` loosened back to bare
-- `is_family_member` WHILE some guard trigger happens to refuse cross-family
-- recipients — check 1 stays blocked, control A still lands, and only this
-- reads the predicate itself.
do $$
declare n int; wc text; begin
  select pg_get_expr(p.polwithcheck, p.polrelid) into wc
    from pg_policy p
   where p.polrelid = 'public.notifications'::regclass
     and p.polname = 'notif_insert' and p.polcmd = 'a';
  if wc is null then
    raise exception '0301: notif_insert is gone from notifications (or no longer an INSERT policy) — checks 1 and 4 are refused by something this probe does not attribute';
  end if;
  if wc not like '%family_members%' then
    raise exception '0301: notif_insert no longer pins the recipient to the family — its WITH CHECK is now: %', wc;
  end if;
  if wc not like '%is_family_member(family_id)%' then
    raise exception '0301: notif_insert no longer requires the WRITER to be a family member — its WITH CHECK is now: %', wc;
  end if;

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
  raise notice '0301 notification grants and notif_insert predicate OK';
end $$;
