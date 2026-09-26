-- ── CRITICAL An invite may not be rewritten by the person it invites ────────
--
-- `invites_update` was created with `USING` and no `WITH CHECK`. Postgres then
-- reuses `USING` as the write check, and that clause's invitee branch pinned
-- only `email` — so the invited person could rewrite `family_id` and `role` on
-- their own row and still satisfy it. `accept_invite()` is SECURITY DEFINER and
-- copies `family_id` and `role` from that row into `family_members`.
--
-- The end-to-end consequence, which is what this probe asserts: a babysitter
-- invited as `guest` issued one UPDATE and joined the household as a `parent`.
-- She needed no second family and no guessed UUID — the `family_id` was in her
-- own invite row, which `invites_select` lets her read.
--
-- 0298 removes the invitee branch (no application code updates `invites`;
-- acceptance runs entirely through `accept_invite`) and states `WITH CHECK`
-- explicitly so the omission cannot recur silently.
--
-- Four assertions, and the third is the one that matters — a structural check
-- would have passed over this for as long as the app never looked:
--
--   1. the invitee cannot change `role` on her own invite;
--   2. she cannot move it to another family;
--   3. **end to end**: after trying, she joins with the role she was offered;
--   4. a manager can still edit an invite in their own family, and cannot move
--      one out of it (the positive control, and the other half of the check).
--
-- NEGATIVE CONTROL, and it runs FIRST, before any of the four
-- ---------------------------------------------------------------------------
-- The rule under test today is 0298's, not 0004's and not 0118's. `grep -rl
-- invites_update supabase/migrations` returns 0004, 0118 and 0298, and 0298 is
-- the LAST: `0298_invites_update_manager_only.sql` dropped the policy 0118 had
-- left carrying a USING arm that matched the invitee's own email and NO `WITH
-- CHECK`, and re-created it as `using (public.can_manage_family(family_id))
-- with check (public.can_manage_family(family_id))` — one question on both
-- sides. Nothing after 0298 names this table: `grep -rlE '\binvites\b'
-- supabase/migrations` stops at 0298 (0002, 0004, 0005, 0118, 0136, 0202,
-- 0210, 0298 — and 0202's hit is a blog paragraph), and every later loop that
-- creates policies or triggers iterates an explicit array that does not list
-- it (0036, 0093, 0120, 0132, 0240, 0244, 0245, 00430).
--
-- The whole of the DDL that reaches `invites`, so the mechanism is named and
-- not assumed: 0002 creates it; 0003:86-98 attaches `trg_set_updated_at` — NOT
-- by naming the table but by looping over `information_schema.columns where
-- column_name = 'updated_at'` and running `execute format('create trigger
-- trg_set_updated_at before update on public.%I ...')`, and `invites.updated_at`
-- (0002:77) puts it in that set; 0004 enables RLS and writes the first
-- policies; 0118 re-asserts them; 0210 adds `onboarding_key` and the unique
-- index on (family_id, onboarding_key); 0298 replaces `invites_update`. So the
-- table carries exactly ONE trigger, and it is 0003's generic `set_updated_at`:
-- BEFORE UPDATE, it assigns `new.updated_at` and raises nothing; no migration
-- drops it and none adds another. (An earlier revision of this header said "no
-- trigger at all" — wrong in exactly the shape that fools a grep for the
-- table's name, a blanket information_schema loop. docs/audit/
-- invite-role-escalation-check.sql:32 has it right.) Hence the mechanism every
-- assertion here attributes to is the RLS policy `invites_update`: its USING
-- half answers a refusal as ZERO ROWS, its WITH CHECK half raises 42501.
--
-- One question is all the boundary is, so the control is the same invitee, the
-- same policy and the same two columns in households where that invitee IS a
-- manager: `role` and `family_id` set in ONE statement on an invite in FS and
-- moved to FT — two families she created, so `can_manage_family` answers yes on
-- the old row and on the new one. The same actor, through the same predicate,
-- with the answer the other way, and that write MUST LAND.
--
-- What the control is FOR, stated exactly. It does not detect the 0298
-- regression itself: loosen `invites_update` back to 0118's shape and the
-- control still lands (its row passes through `can_manage_family` under either
-- version) while assertions 1 and 2 flip from 0 rows to 1 and turn the build
-- red — THEY are the detectors. The control detects the boundary becoming
-- UNREACHABLE, which is the silent-green hole: a RESTRICTIVE policy added
-- later, `invites_update` re-created `TO` a role this session is not in, a
-- guard trigger that refuses every write, a row this session cannot see, or
-- mis-seeded claims. Under any of those, 1 and 2 report zero rows for a reason
-- that is not `invites_update`'s USING, and 3 and 4 pass regardless
-- (`accept_invite` is SECURITY DEFINER; the host satisfies any manager-side
-- predicate) — the whole file green over a boundary nobody examined. The
-- control makes this session prove it can write `role` AND `family_id` on
-- `invites` at all, so it fails first and names itself:
--
--   * 1 and 2 assert ZERO ROWS, and a row this session cannot SEE reports zero
--     just as readily as a USING clause does — so the control's second leg
--     asserts she can still READ her own invite (0118's `invites_select` email
--     arm), which is the read the attack in the header depends on;
--   * a guard TRIGGER on `invites` that refuses writes with 42501 — the way
--     0223, 0305, 0326 and 0331 refuse them — would abort the unguarded UPDATE
--     below and bury the diagnosis under a raw "permission denied for table
--     invites". Triggers are per-table, not per-user, so one that fires on any
--     `role` or `family_id` write fires on the control too, and the control
--     catches it. One keyed on the ROW or the ACTOR would not: it could fire on
--     the host's move-out in 4 and stay silent here — which is why 4 carries a
--     control of its own (below) and does not lean on this one;
--   * the impersonation rides on TWO different GUCs — `auth.uid()` reads the
--     dotted `request.jwt.claim.sub`, `auth.jwt()` reads the JSON
--     `request.jwt.claims` (docs/audit/pg-bootstrap.sh:57 and :60, with no
--     fallback from one to the other). Seed one and not the other and every
--     `can_manage_family` in this file answers false, so 1 and 2 pass while
--     proving nothing whatsoever. The guards assert both took; the control
--     would notice anyway.
--
-- Premise guards run before the control, lifted from the sibling probe
-- (docs/audit/invite-role-escalation-check.sql:138-156): `current_user` is
-- `authenticated` (RLS enforced at all); `auth.uid()` and `auth.jwt()->>'email'`
-- are the babysitter's; `can_manage_family` is TRUE for FS and FT and FALSE for
-- FH — the last is the premise of 1 and 2, and a seed that made her a manager
-- of FH would turn every refusal below into a claim about nothing. The host's
-- block gets the same: TRUE for FH and FH2, FALSE for FO (the first draft of
-- this probe seeded FO with the host as creator and reported the FIX as broken).
--
-- The manager's positive control in 4 is a DIFFERENT session (the host's), so
-- it shows the guard lets SOMEBODY through, not that the INVITEE's session
-- could have written anything at all. And its own second half — the caught
-- 42501 on a move OUT of the family — expects a `family_id` write to be
-- REFUSED, so by itself it cannot tell a WITH CHECK from a trigger that raises
-- 42501 on that row. It gets the treatment the sibling gives its manager block
-- (invite-role-escalation-check.sql, "A manager must keep managing"): the host
-- first moves the SAME invite into a second family the host DOES manage (FH2)
-- and back, and both must land, so the refusal that follows is on a row and a
-- column the host's session has just written.
--
-- One honest limit, so a later reader does not over-credit this: the probe
-- re-grants table DML on `invites` itself below, and a table-level grant covers
-- every column, so neither a revoked table GRANT nor a column-level revoke is
-- a live false attribution in this file (pg-bootstrap.sh's default privileges
-- hand `authenticated` every column anyway). What the controls catch is the
-- rest of the list.
--
-- Why this file exists next to docs/audit/invite-role-escalation-check.sql,
-- which controls the same policy the same way (same actor, same two managed
-- households, a control invite addressed to somebody else): that probe mints
-- its anchors at run time and commits nothing it can name afterwards; this one
-- runs on FIXED anchors inside one rolled-back transaction, so the fixture can
-- be `select`ed mid-run, and it ends by pinning the structural cause in
-- `pg_policy` — a WITH CHECK present, exactly ONE policy governing UPDATE on
-- the table, and both halves still asking `can_manage_family(family_id)` and
-- nothing about the email — which the sibling does not. The control's design
-- and the guards are lifted from the sibling on purpose; the facts in this
-- header were re-derived against the migrations, not copied.
--
-- The control's invite is addressed to sitter-guest@example.com and NOT to the
-- babysitter, on purpose: it has to pass through `can_manage_family` and not
-- through the invitee-email arm 0298 deleted, or restoring that arm would keep
-- the control green while the boundary it attributes to was gone.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/invite-cannot-rewrite-what-it-grants-check.sql

\set FH '00000000-0000-4000-8000-00000000bf01'
\set FO '00000000-0000-4000-8000-00000000bf02'
\set UH '00000000-0000-4000-8000-00000000b001'
\set US '00000000-0000-4000-8000-00000000b002'
\set UO '00000000-0000-4000-8000-00000000b003'
-- The negative control's own households: two families the BABYSITTER creates, so
-- `can_manage_family` answers YES for the very user it answers no for in FH, and
-- the control can move `family_id` between them and still satisfy WITH CHECK.
-- CIR is the control's own invite row; it is never the row under test.
\set FS '00000000-0000-4000-8000-00000000bf03'
\set FT '00000000-0000-4000-8000-00000000bf04'
\set CIR '00000000-0000-4000-8000-00000000be02'
-- The HOST's second household: the legal destination that makes 4's move-out
-- refusal attributable (see the header).
\set FH2 '00000000-0000-4000-8000-00000000bf05'

begin;

insert into auth.users (id, email) values
  (:'UH','host@example.com'), (:'US','babysitter@example.com'), (:'UO','stranger@example.com')
  on conflict do nothing;
-- `Another Family` must have a DIFFERENT creator. A trigger on `families`
-- (`on_family_created` -> `handle_new_family`) provisions
-- `created_by` as a manager, so seeding both with the same owner makes the host
-- a manager of both — and the move-out assertion below then tests nothing. The
-- first draft of this probe did exactly that and reported the FIX as broken;
-- the host's premise guard below now says so by name. FH2 is the opposite case
-- on purpose: created BY the host, so the host manages it too.
insert into public.families (id, name, created_by) values
  (:'FH','The Host Family',:'UH'), (:'FO','Another Family',:'UO'),
  (:'FH2','The Host''s Other House',:'UH')
  on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  (:'FH',:'UH','Host','parent',true),
  (:'FH2',:'UH','Host (a manager here too)','parent',true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
insert into public.invites (id, family_id, email, role, token, invited_by, status, expires_at)
  values ('00000000-0000-4000-8000-00000000be01', :'FH','babysitter@example.com','guest','tok-sitter',:'UH','pending', now() + interval '7 days');

-- ── The negative control's seed ─────────────────────────────────────────────
-- Both created BY the babysitter, which is what makes her a manager of both and
-- the control's UPDATE legitimate on both sides of `invites_update`.
insert into public.families (id, name, created_by) values
  (:'FS','The Sitter''s Own House',:'US'), (:'FT','The Sitter''s Other House',:'US')
  on conflict do nothing;
-- `on_family_created` -> `handle_new_family` already files the creator as a
-- 'parent'; upsert rather than assume, for the same reason the FH seed above
-- states the host's row explicitly — a seed whose roles are wrong would fail the
-- control for a reason that is not the control's, and then this probe would
-- report a boundary it can see perfectly well as unproven.
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  (:'FS',:'US','Sitter (a manager here)','parent',true),
  (:'FT',:'US','Sitter (a manager here too)','parent',true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
-- Addressed to somebody else on purpose: the control must pass through
-- `can_manage_family`, never through the invitee-email arm 0298 removed.
insert into public.invites (id, family_id, email, role, token, invited_by, status, expires_at)
  values (:'CIR', :'FS','sitter-guest@example.com','guest','tok-sitter-control',:'US','pending', now() + interval '7 days');

grant select, insert, update, delete on public.invites to authenticated;

do $$
declare
  n int; rol text; fam uuid; joined text;
  failures text[] := '{}';
  shape_ok boolean;
  -- The anchors (see the header block). ctl_fam/ctl_fam2 are the two households
  -- the BABYSITTER manages, ctl_row is the control's own invite, own_row is the
  -- invite under test; host_fam/host_fam2 are the two the HOST manages and
  -- other_fam the one nobody in this file but the stranger does.
  sitter     constant uuid := '00000000-0000-4000-8000-00000000b002';
  host       constant uuid := '00000000-0000-4000-8000-00000000b001';
  host_fam   constant uuid := '00000000-0000-4000-8000-00000000bf01';
  other_fam  constant uuid := '00000000-0000-4000-8000-00000000bf02';
  host_fam2  constant uuid := '00000000-0000-4000-8000-00000000bf05';
  ctl_fam    constant uuid := '00000000-0000-4000-8000-00000000bf03';
  ctl_fam2   constant uuid := '00000000-0000-4000-8000-00000000bf04';
  ctl_row    constant uuid := '00000000-0000-4000-8000-00000000be02';
  own_row    constant uuid := '00000000-0000-4000-8000-00000000be01';
  control_ok boolean := true;
begin
  -- ── As the invited babysitter ───────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b002', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-00000000b002","email":"babysitter@example.com","role":"authenticated"}', true);

  -- ── Premise guards: the probe is testing what it claims to be testing ───────
  -- Each of these is a reason the control could fail — or the refusals pass —
  -- that has nothing to do with `invites_update`. Say which one, here.
  if current_user <> 'authenticated' then
    raise exception 'invite grant boundary UNPROVEN: running as %, so RLS is not being enforced at all', current_user;
  end if;
  if auth.uid() is distinct from sitter then
    raise exception 'invite grant boundary UNPROVEN: auth.uid() is %, expected the babysitter — request.jwt.claim.sub did not take, and every can_manage_family below would answer false', auth.uid();
  end if;
  if auth.jwt()->>'email' is distinct from 'babysitter@example.com' then
    raise exception 'invite grant boundary UNPROVEN: auth.jwt()->>''email'' is % — request.jwt.claims did not take, so invites_select''s email arm (the read the attack depends on) and accept_invite''s email check are both untested', auth.jwt()->>'email';
  end if;
  if public.can_manage_family(host_fam) then
    raise exception 'invite grant boundary UNPROVEN: the babysitter already manages the host family, so every refusal below would be a claim about nothing';
  end if;
  if not public.can_manage_family(ctl_fam) or not public.can_manage_family(ctl_fam2) then
    raise exception 'invite grant boundary UNPROVEN: the control households are mis-seeded (can_manage_family: FS=%, FT=%) — the control would fail for a reason that is not the control''s',
      public.can_manage_family(ctl_fam), public.can_manage_family(ctl_fam2);
  end if;

  -- ── NEGATIVE CONTROL: the same invitee, the same predicate, the other answer ─
  -- ONE statement writing BOTH columns the attacks below write — `role`, and
  -- `family_id` moved from a household she manages to another household she
  -- manages. `invites_update`'s USING sees the old row (can_manage_family(FS) =
  -- true) and its WITH CHECK sees the new one (can_manage_family(FT) = true), so
  -- this must affect exactly 1 row. If it does not, this session never had the
  -- access the refusals below are supposed to be measuring, and the probe says
  -- so rather than reporting a boundary it cannot see.
  --
  -- The verdict is recorded inside the block and RAISED after it: a `raise` in
  -- the body of a block with `exception when others` is caught by that block's
  -- own handler, and the diagnosis would be swallowed by the construct meant to
  -- report it.
  begin
    -- `family_id = ctl_fam` in the WHERE is not decoration either: it pins the
    -- row's starting household, so a mis-seeded control reports itself as a
    -- failed control instead of quietly landing somewhere else.
    update public.invites set role = 'parent', family_id = ctl_fam2
     where id = ctl_row and family_id = ctl_fam;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: this invitee''s UPDATE of role AND family_id on an invite in a family she DOES manage changed %s rows, so the zero-row refusals below would prove nothing — a row this session cannot write reports zero either way', n));
    end if;
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: this invitee''s UPDATE of role AND family_id on an invite in a family she DOES manage raised %s: %s — so a refusal below would prove only that something said no, not that invites_update said it', sqlstate, sqlerrm));
  end;

  -- Second leg: the row the attacks target must be VISIBLE to this session. A
  -- zero-row UPDATE is also what an invisible row looks like, and "she could read
  -- her own invite" is the premise of the whole finding — 0118's `invites_select`
  -- email arm is what grants it (is_family_member(FH) is false for her), and it
  -- is deliberately unchanged by 0298.
  if control_ok then
    select count(*) into n from public.invites where id = own_row;
    if n <> 1 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the invitee can see %s rows of her own invite, so a zero-row refusal below would be invites_select answering, not invites_update', n));
    end if;
  end if;

  -- A failed control makes every refusal below unreadable, and those statements
  -- are deliberately unguarded: a guard trigger or a revoked privilege would
  -- abort the block there and bury the diagnosis under a raw "permission denied
  -- for table invites". Say WHY the probe cannot speak, here, while the reason is
  -- still in hand. The boundary is not reported as holding and not as broken: it
  -- is reported as UNPROVEN, and the build is red either way.
  if not control_ok then
    raise exception 'invite grant boundary UNPROVEN (the control this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;

  update public.invites set role = 'parent' where token = 'tok-sitter';
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('the invitee rewrote role on %s invite row(s)', n)); end if;

  update public.invites set family_id = '00000000-0000-4000-8000-00000000bf02' where token = 'tok-sitter';
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('the invitee moved the invite to another family on %s row(s)', n)); end if;

  -- The assertion that actually matters: what role does she END UP with?
  perform public.accept_invite('tok-sitter');

  perform set_config('role','postgres', true);
  select fm.role into joined from public.family_members fm
   where fm.family_id = '00000000-0000-4000-8000-00000000bf01'
     and fm.user_id = '00000000-0000-4000-8000-00000000b002';
  if joined is null then
    failures := array_append(failures, 'the invitee could not accept a legitimate invite at all — the fix is too tight');
  elsif joined <> 'guest' then
    failures := array_append(failures, format('the invitee joined as %s, having been offered guest', joined));
  end if;

  -- ── As the host: the positive control ───────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000b001', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-00000000b001","email":"host@example.com","role":"authenticated"}', true);

  -- The host's premises. FO must answer NO, or the move-out refusal below tests
  -- nothing — the first draft seeded FO with the host as creator and hit exactly
  -- this. FH2 must answer YES, or the host's control below fails for a reason
  -- that is not the control's. Findings collected so far ride along in the
  -- message rather than being lost to the raise.
  if auth.uid() is distinct from host
     or not public.can_manage_family(host_fam) or not public.can_manage_family(host_fam2)
     or public.can_manage_family(other_fam) then
    raise exception 'invite grant boundary UNPROVEN (the host''s premises did not hold: auth.uid()=%, can_manage_family FH=%, FH2=%, FO=%) — findings so far: %',
      auth.uid(), public.can_manage_family(host_fam), public.can_manage_family(host_fam2), public.can_manage_family(other_fam),
      coalesce(nullif(array_to_string(failures, ' | '), ''), '(none)');
  end if;

  update public.invites set role = 'adult' where token = 'tok-sitter';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not edit an invite in their own family — the guard refuses everyone'); end if;

  -- ── The host's own control, before the refusal it attributes ─────────────
  -- The SAME row, the SAME column, the SAME session, and a destination where
  -- `can_manage_family` answers YES: move the invite into FH2 and back. Both
  -- must land. Without this, the caught 42501 below cannot tell 0298's WITH
  -- CHECK from a trigger that raises 42501 on this row or this actor — and the
  -- babysitter's control cannot help, because it is a different row and a
  -- different actor. Moving it back leaves the fixture as the refusal expects.
  begin
    update public.invites set family_id = host_fam2 where id = own_row and family_id = host_fam;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('HOST CONTROL FAILED: the host moved the invite into a second family they DO manage on %s rows, not 1 — so the caught 42501 on the move-out below would be a refusal with no attribution', n));
    else
      update public.invites set family_id = host_fam where id = own_row and family_id = host_fam2;
      get diagnostics n = row_count;
      if n <> 1 then
        failures := array_append(failures, format('HOST CONTROL FAILED: moving the invite back landed on %s rows, not 1 — the fixture the move-out below runs on is not the one it expects', n));
      end if;
    end if;
  exception when others then
    failures := array_append(failures, format('HOST CONTROL FAILED: the host''s move of the invite between two families they DO manage raised %s: %s — a guard trigger on this row or actor, or a denial on family_id, would read exactly like the WITH CHECK refusal below', sqlstate, sqlerrm));
  end;

  -- …and WITH CHECK must stop even a manager moving one out of their family.
  --
  -- A WITH CHECK violation RAISES (42501); it does not quietly affect 0 rows,
  -- which is the difference between USING and WITH CHECK and the reason this
  -- assertion is written as a caught exception rather than a row count. The
  -- first draft counted rows and mis-reported the fix as broken.
  begin
    update public.invites set family_id = '00000000-0000-4000-8000-00000000bf02' where token = 'tok-sitter';
    failures := array_append(failures, 'a manager moved an invite into a family they do not manage — WITH CHECK is missing again');
  exception when insufficient_privilege then null;
  end;

  perform set_config('role','postgres', true);

  -- The structural cause, pinned: a policy with USING and no WITH CHECK reuses
  -- USING for the write, which is how one column of constraint became none.
  select count(*) into n from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'invites'
     and p.polcmd = 'w' and p.polwithcheck is null;
  if n <> 0 then
    failures := array_append(failures, 'invites_update has no WITH CHECK again — Postgres will reuse USING and the invitee branch constrains one column');
  end if;

  -- …and the predicate is still the one 0298 wrote. The count above is zero
  -- for a DROPPED policy too (nothing to count), and a policy re-written to ask
  -- a different question keeps its WITH CHECK, so pin the shape 0298 states:
  -- exactly ONE policy governs UPDATE on `invites` (FOR UPDATE or FOR ALL,
  -- permissive or restrictive — a RESTRICTIVE one added later would be a second
  -- row here and a second mechanism the assertions above could not see), it is
  -- `invites_update`, it is permissive, and each half asks
  -- `can_manage_family(family_id)` and asks nothing about the email.
  select count(*),
         bool_and(p.polname = 'invites_update' and p.polpermissive
                  and pg_get_expr(p.polqual, p.polrelid)      like '%can_manage_family(family_id)%'
                  and pg_get_expr(p.polwithcheck, p.polrelid) like '%can_manage_family(family_id)%'
                  and pg_get_expr(p.polqual, p.polrelid)      not ilike '%email%'
                  and pg_get_expr(p.polwithcheck, p.polrelid) not ilike '%email%')
    into n, shape_ok
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname = 'invites' and p.polcmd in ('w','*');
  if n <> 1 then
    failures := array_append(failures, format('%s policies govern UPDATE on invites, expected exactly one (invites_update) — a second policy is a second mechanism the assertions above could not tell from 0298''s', n));
  elsif not coalesce(shape_ok, false) then
    failures := array_append(failures, 'the one UPDATE policy on invites is not the shape 0298 installed (invites_update, permissive, asking can_manage_family(family_id) on both sides and nothing about the email)');
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'invite grant check failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK invites: the same invitee CAN rewrite role and family_id on an invite in a household she manages (control), and on her own invite she cannot change what it grants; she joins as what she was offered; the host CAN move it between two households they manage (control) and cannot move it out; invites_update is the only UPDATE policy and still asks can_manage_family on both sides';
end $$;

rollback;
