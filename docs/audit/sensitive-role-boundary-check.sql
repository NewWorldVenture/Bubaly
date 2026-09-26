-- ── 0297: three sensitive tables answer to role, not just to membership ─────
--
-- lib/ai/context/policy.ts lists 66 tables a child must not see. The database
-- disagreed with that list on 58 of them. 0297 fixes the three that need no
-- product decision; this proves those three, and proves them the way the vault
-- probe had to be taught to prove things — by first checking that the
-- impersonation TOOK. A probe that cannot tell "denied because child" from
-- "denied because unauthenticated" passes against a broken policy too.
--
-- NEGATIVE CONTROL, and it runs FIRST, before every refusal below
-- ---------------------------------------------------------------------------
-- Checking that `auth.uid()` is the child proves the SESSION is the child. It
-- does not prove the child's session could have written or read anything at
-- all, and that is the second half of the attribution. Every refusal below is
-- either a catch of `insufficient_privilege` or an assertion of ZERO ROWS, and
-- neither one names its own cause:
--
--   * the INSERT in 3 catches 42501 and credits social_account_tokens_insert's
--     WITH CHECK — but a missing or revoked table GRANT raises 42501, a
--     column-level revoke on `access_token_enc` raises 42501, a dead
--     `auth.uid()` raises 42501, and so does a guard trigger, which is how this
--     repository refuses writes in 0223, 0305, 0326 and 0331. Nothing but
--     `trg_set_updated_at` is attached to these three tables today; the point of
--     the control is that the day one IS attached, this probe goes red instead
--     of carrying on green over a WITH CHECK loosened back to
--     `is_family_member`;
--   * the UPDATE and DELETE in 2 and the count in 3 assert ZERO ROWS, and a row
--     this session simply cannot SEE produces zero rows just as readily as a
--     USING clause does. 3's count would read 0 against a revoked SELECT, a
--     column denial, or a policy that refuses everyone — which is why 3 seeds a
--     token row deliberately, and why the control reads one back in the family
--     the child DOES manage before 3 reads zero in the family they do not.
--
-- MECHANISM: RLS policies, not a trigger, a CHECK, a unique index or a GRANT.
-- How that was established, since it decides what shape the control takes:
-- `grep -n "create trigger" supabase/migrations/*.sql` matches these three
-- tables exactly once, at 01051_child_logins.sql:30, and that is
-- `trg_set_updated_at`; `driver_licenses` and `social_account_tokens` get the
-- same one from the table loops in 0037 and 0034. No migration REVOKEs anything
-- on any of the three, and docs/audit/pg-bootstrap.sh runs `alter default
-- privileges in schema public grant all on tables to anon, authenticated,
-- service_role` BEFORE the first migration, so all three carry full DML for
-- `authenticated` and RLS is the only thing holding the line. The three
-- predicates, from 0297:
--
--   child_logins           "Managers manage child_logins" FOR ALL,
--                          USING and WITH CHECK can_manage_family(family_id)
--   social_account_tokens   all four policies, can_manage_family(family_id)
--   driver_licenses         is_family_member(family_id)
--                             and (can_manage_family(family_id)
--                                  or is_self_member(member_id))
--
-- and `can_manage_family` is `role in ('parent','adult') and is_active` (0003),
-- so role is the one thing each keys on.
--
-- GOVERNING MIGRATION: 0297, and it is the LAST one, not the first. The policy
-- names were grepped across supabase/migrations and the last hit taken, because
-- replaying an old migration from memory is how this audit once credited a
-- guard a later migration had replaced — 0297 itself dropped the child_logins
-- policy 01051 created and re-made it on a different predicate under the same
-- name. `child_logins` appears in 01051, 01371 and 0297 (01371 is the sign-in
-- throttle and names no policy; both sort before 0297); `social_account_tokens`
-- appears after 0297 only in 0321, which adds an index; `driver_licenses`
-- appears after 0297 only in 0335, and only inside a comment.
--
-- So the control is the same child, through the same predicates, with the
-- answer the other way, and it must LAND:
--
--   * a SECOND family this same child IS a manager of ('parent' there, 'child'
--     here), where they UPDATE and DELETE a child_logins row and read and
--     INSERT a social_account_tokens row — the same statements 2 and 3 are
--     refused, with only `can_manage_family`'s answer changed;
--   * their OWN licence in THIS family, which flips `is_self_member(member_id)`
--     and leaves the rest of driver_licenses_select untouched. That read is
--     asserted again at 1 below; it is run here as well because a control that
--     runs after the refusal it explains has not explained it yet.
--
-- The control's UPDATE names the SAME COLUMN the write under test names
-- (`username`, not some other column), and the control's INSERT names the SAME
-- five columns, and that is load-bearing rather than tidy: a column-level
-- `revoke update (username) on child_logins from authenticated` sails straight
-- past a control that touches a different column, and would then kill the
-- takeover below as a bare `permission denied`, red with the attribution thrown
-- away. Postgres checks column privileges against the SET list and not against
-- the values, so writing those same columns in the family the child DOES
-- manage is the whole of that proof.
--
-- The adult's section at the bottom does not cover any of this. It proves the
-- policies let SOMEBODY through; it says nothing about whether the CHILD's
-- session could have written a row anywhere — which is exactly how the
-- document-vault probe passed for a release while the teen could not INSERT a
-- document at all.
--
-- A failed control does not report the boundary as held and does not report it
-- as broken. It reports it as UNPROVEN, and the build is red either way.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/sensitive-role-boundary-check.sql
--
-- Re-runnable: both fixture families' rows are cleared before each run.
do $$
declare
  fam    uuid := 'f0297000-0000-4000-8000-00000000fa01';
  par    uuid := 'f0297000-0000-4000-8000-00000000c001';
  adult  uuid := 'f0297000-0000-4000-8000-00000000c002';
  kid    uuid := 'f0297000-0000-4000-8000-00000000c003';
  sib    uuid := 'f0297000-0000-4000-8000-00000000c004';
  -- The negative control's own household: a SECOND family the SAME `kid`
  -- manages. New UUIDs in the probe's anchor style, grepped across docs/audit
  -- and supabase/migrations first and found nowhere — run-probes.sh runs all 65
  -- probes against ONE database in sequence, so a reused UUID would silently
  -- rewrite what some other probe is asserting.
  ctl_fam  uuid := 'f0297000-0000-4000-8000-00000000fa02';
  ctl_ward uuid := 'f0297000-0000-4000-8000-00000000c005';
  ctl_ward_m uuid; ctl_acct uuid;
  ctl_err text;
  par_m uuid; adult_m uuid; kid_m uuid; sib_m uuid;
  lic_par uuid; lic_kid uuid; acct uuid;
  n int; refused boolean;
begin
  insert into public.families (id, name) values (fam, '0297 boundary') on conflict do nothing;
  insert into auth.users (id, email) values
    (par,'p0297@example.test'), (adult,'a0297@example.test'),
    (kid,'k0297@example.test'), (sib,'s0297@example.test')
  on conflict do nothing;

  delete from public.driver_licenses       where family_id = fam;
  delete from public.social_account_tokens where family_id = fam;
  delete from public.social_accounts       where family_id = fam;
  delete from public.child_logins          where family_id = fam;
  delete from public.family_members        where family_id = fam;

  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (fam,par,'Parent','parent',true)  returning id into par_m;
  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (fam,adult,'Adult','adult',true)  returning id into adult_m;
  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (fam,kid,'Kid','child',true)      returning id into kid_m;
  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (fam,sib,'Sibling','child',true)  returning id into sib_m;

  insert into public.driver_licenses (family_id, member_id, holder_name, license_number, state)
    values (fam, par_m, 'A Parent', 'PARENT-LICENCE-PII', 'CA') returning id into lic_par;
  insert into public.driver_licenses (family_id, member_id, holder_name, license_number, state)
    values (fam, kid_m, 'A Teen',   'TEEN-LICENCE',       'CA') returning id into lic_kid;
  insert into public.social_accounts (family_id, user_id, platform, status, health, scopes)
    values (fam, par, 'instagram', 'connected', 'ok', '{}') returning id into acct;
  insert into public.social_account_tokens (family_id, account_id, platform, provider_account_id, access_token_enc)
    values (fam, acct, 'instagram', 'seeded', 'SEEDED-OAUTH-TOKEN');
  insert into public.child_logins (family_id, member_id, user_id, username, created_by)
    values (fam, kid_m, kid, 'k0297-kid', par), (fam, sib_m, sib, 'k0297-sibling', par);

  -- ── the negative control's household ────────────────────────────────────
  -- `kid` is filed here as 'parent', so can_manage_family(ctl_fam) answers YES
  -- for the very user can_manage_family(fam) answers NO for. The ward is a
  -- member of ctl_fam only, with a login and a token row of its own, so the
  -- control can never collide with the sibling row the takeover targets, with
  -- fam's seeded token, or with the row the adult adds at the bottom. Seeded
  -- here, as the owner, BEFORE the session becomes the child — the mistake the
  -- document-vault probe made was to let the actor under test create the rows it
  -- was then tested against.
  insert into public.families (id, name) values (ctl_fam, '0297 control house') on conflict do nothing;
  insert into auth.users (id, email) values (ctl_ward, 'w0297@example.test') on conflict do nothing;

  delete from public.social_account_tokens where family_id = ctl_fam;
  delete from public.social_accounts       where family_id = ctl_fam;
  delete from public.child_logins          where family_id = ctl_fam;
  delete from public.family_members        where family_id = ctl_fam;

  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (ctl_fam,kid,'Kid (a manager HERE)','parent',true);
  insert into public.family_members (family_id,user_id,display_name,role,is_active)
    values (ctl_fam,ctl_ward,'Ward','child',true)            returning id into ctl_ward_m;

  insert into public.social_accounts (family_id, user_id, platform, status, health, scopes)
    values (ctl_fam, ctl_ward, 'instagram', 'connected', 'ok', '{}') returning id into ctl_acct;
  -- One seeded token, so the control's READ has something to find. A control
  -- that counted rows in an empty table would pass whatever the policy said —
  -- the same defect the seeded row at 3 below exists to avoid.
  insert into public.social_account_tokens (family_id, account_id, platform, provider_account_id, access_token_enc)
    values (ctl_fam, ctl_acct, 'instagram', 'control-seeded', 'CONTROL-SEEDED-TOKEN');
  insert into public.child_logins (family_id, member_id, user_id, username, created_by)
    values (ctl_fam, ctl_ward_m, ctl_ward, 'k0297-control-ward', kid);

  -- ── as the child ────────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', kid::text, true);
  if auth.uid() is distinct from kid then
    raise exception '0297: impersonation failed — auth.uid() is %, expected the child; this probe is not testing what it claims', auth.uid();
  end if;

  -- ══ NEGATIVE CONTROL — the same child, the same predicates, the other answer
  -- It runs HERE, first, ahead of every refusal it gives meaning to. Rationale,
  -- the mechanism it is attributed to and the evidence for 0297 being the
  -- governing migration are in the header block. Each leg captures its own
  -- failure instead of letting a raw 42501 abort the block, because the whole
  -- value of the control is the diagnosis it carries.

  -- (0) The control's own premise, stated rather than assumed: this one session
  --     is a manager in ctl_fam and not in fam. A seed whose roles are wrong
  --     would fail the legs below for a reason that is not the boundary's, and
  --     the reader would go looking for a revoked GRANT that was never there.
  if not public.can_manage_family(ctl_fam) then
    raise exception '0297 boundary UNPROVEN (control 0): can_manage_family says this child does NOT manage the control household, so the legs below are not the other answer to the same question — check the ctl_fam seed roles';
  end if;
  if public.can_manage_family(fam) then
    raise exception '0297 boundary UNPROVEN (control 0): can_manage_family says this child DOES manage the household under test, so every refusal below would be a policy failure misread as a boundary — check the fam seed roles';
  end if;

  -- (a) driver_licenses_select, with only is_self_member(member_id) flipped.
  ctl_err := null;
  begin
    select count(*) into n from public.driver_licenses where id = lic_kid;
  exception when others then
    n := -1; ctl_err := format('%s: %s', sqlstate, sqlerrm);
  end;
  if n <> 1 then
    raise exception '0297 boundary UNPROVEN (control a): this child cannot read their OWN licence — %. The zero rows asserted for the PARENT licence at 1 would then prove nothing about driver_licenses_select: a session that can read no driver_licenses row at all — a revoked SELECT, a column denial, a dead auth.uid() — reports zero just as readily',
      coalesce(ctl_err, format('%s row(s)', n));
  end if;

  -- (b) social_account_tokens_select, with only can_manage_family's answer
  --     changed: the family this child IS a manager of.
  ctl_err := null;
  begin
    select count(*) into n from public.social_account_tokens where family_id = ctl_fam;
  exception when others then
    n := -1; ctl_err := format('%s: %s', sqlstate, sqlerrm);
  end;
  if n <> 1 then
    raise exception '0297 boundary UNPROVEN (control b): in the family this child DOES manage they see % where 1 token row was seeded, so the zero rows asserted at 3 for the family they do NOT manage prove nothing about social_account_tokens_select',
      coalesce(ctl_err, format('%s row(s)', n));
  end if;

  -- (c) social_account_tokens_insert. THE SAME FIVE COLUMNS as the refused
  --     INSERT at 3 — a column-level revoke on access_token_enc is invisible to
  --     a control that writes a narrower list, and would then turn 3's catch
  --     into a pass it has not earned.
  ctl_err := null;
  begin
    insert into public.social_account_tokens (family_id, account_id, platform, provider_account_id, access_token_enc)
      values (ctl_fam, ctl_acct, 'instagram', 'child-manager-added', 'x');
    get diagnostics n = row_count;
  exception when others then
    n := -1; ctl_err := format('%s: %s', sqlstate, sqlerrm);
  end;
  if n <> 1 then
    raise exception '0297 boundary UNPROVEN (control c): this child was refused a social OAuth token row in the family they DO manage — %. The insufficient_privilege caught at 3 therefore proves only that something said no: a missing table GRANT, a revoke on access_token_enc and a guard trigger all raise 42501 too',
      coalesce(ctl_err, format('%s row(s) stored', n));
  end if;

  -- (d) "Managers manage child_logins" for UPDATE. THE SAME COLUMN the takeover
  --     at 2 writes — `username`, the value the child sign-in derives both the
  --     synthetic email and the password from.
  ctl_err := null;
  begin
    update public.child_logins set username = 'k0297-control-ward-renamed'
      where family_id = ctl_fam and member_id = ctl_ward_m;
    get diagnostics n = row_count;
  exception when others then
    n := -1; ctl_err := format('%s: %s', sqlstate, sqlerrm);
  end;
  if n <> 1 then
    raise exception '0297 boundary UNPROVEN (control d): this child''s UPDATE of `username` on a login row in the family they DO manage touched % — so the zero rows asserted at 2 prove nothing: a row this session cannot see, or cannot write, reports zero either way',
      coalesce(ctl_err, format('%s row(s)', n));
  end if;

  -- (e) The same policy for DELETE. This is also the control's own cleanup: the
  --     row does not outlive the control, because child_logins' unique index on
  --     lower(username) is GLOBAL and a stray row in a second family is exactly
  --     the quiet contamination that turns one unattributed check into one false
  --     failure in a later probe. On the paths above the block raises instead,
  --     which rolls the whole DO statement back — seed included.
  ctl_err := null;
  begin
    delete from public.child_logins where family_id = ctl_fam and member_id = ctl_ward_m;
    get diagnostics n = row_count;
  exception when others then
    n := -1; ctl_err := format('%s: %s', sqlstate, sqlerrm);
  end;
  if n <> 1 then
    raise exception '0297 boundary UNPROVEN (control e): this child''s DELETE of a login row in the family they DO manage removed % — so the zero rows asserted for the sibling delete at 2 prove nothing about can_manage_family',
      coalesce(ctl_err, format('%s row(s)', n));
  end if;
  -- ══ end of control. Everything below is now a refusal with an attribution ══

  -- 1. A parent's licence number is not a child's to read. Their own still is.
  select count(*) into n from public.driver_licenses where id = lic_par;
  if n <> 0 then
    raise exception '0297: a child reads a PARENT driver licence (% row(s)) — licence numbers are plaintext', n;
  end if;
  select count(*) into n from public.driver_licenses where id = lic_kid;
  if n <> 1 then
    raise exception '0297: a teenager cannot read their OWN licence (% rows) — the fix went too far', n;
  end if;

  -- 2. A sibling's login row is not a child's to rewrite or delete. The child
  --    sign-in derives BOTH the synthetic email and the password from
  --    username, so a rename or a delete locks that sibling out for good.
  update public.child_logins set username = 'hijacked' where member_id = sib_m;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0297: a child rewrote % sibling login row(s) — that sibling can no longer sign in', n;
  end if;
  delete from public.child_logins where member_id = sib_m;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception '0297: a child deleted % sibling login row(s)', n;
  end if;

  -- 3. OAuth tokens for the family's social accounts are adults-only.
  -- One token row exists (seeded above as the owner). If this assertion ran
  -- against an empty table it would pass whatever the policy said, which is the
  -- defect class this whole pass is about — so the row is seeded deliberately.
  select count(*) into n from public.social_account_tokens where family_id = fam;
  if n <> 0 then
    raise exception '0297: a child can read % social OAuth token row(s)', n;
  end if;
  refused := false;
  begin
    insert into public.social_account_tokens (family_id, account_id, platform, provider_account_id, access_token_enc)
    values (fam, acct, 'instagram', 'child-added', 'x');
  -- Only the RLS refusal counts. `when others` would let a renamed column here
  -- report the boundary as held while nothing was tested.
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0297: a child inserted a social OAuth token row';
  end if;

  -- ── as a non-parent adult: the fix must not lock the grown-ups out ──────
  perform set_config('request.jwt.claim.sub', adult::text, true);
  if auth.uid() is distinct from adult then
    raise exception '0297: impersonation failed — auth.uid() is %, expected the adult', auth.uid();
  end if;

  select count(*) into n from public.driver_licenses where family_id = fam;
  if n <> 2 then
    raise exception '0297: an ADULT sees %/2 driver licences — can_manage_family admits parent AND adult', n;
  end if;
  select count(*) into n from public.child_logins where family_id = fam;
  if n <> 2 then
    raise exception '0297: an ADULT sees %/2 child logins', n;
  end if;
  update public.child_logins set username = 'k0297-kid-renamed' where member_id = kid_m;
  if not found then
    raise exception '0297: an ADULT cannot manage a child login — the fix is too strict';
  end if;
  insert into public.social_account_tokens (family_id, account_id, platform, provider_account_id, access_token_enc)
    values (fam, acct, 'instagram', 'adult-added', 'enc');
  select count(*) into n from public.social_account_tokens where family_id = fam;
  if n <> 2 then
    raise exception '0297: an ADULT sees %/2 social token rows (1 seeded + 1 they just added)', n;
  end if;

  reset role;
  raise notice '0297 OK: the same child CAN read their own licence and CAN read, insert, rename and delete in the family they manage (control); in the family they do not they are refused a parent licence, a sibling login and the OAuth tokens; parent and adult keep everything';
end $$;
