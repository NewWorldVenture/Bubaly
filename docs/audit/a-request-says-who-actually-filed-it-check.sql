-- ── A wallet request names the member who actually filed it (0333) ──────────
--
-- `parent_approvals` (0088) is the wallet approval inbox. 0251 split 0088's
-- `FOR ALL … is_family_member` and left UPDATE/DELETE to `can_manage_family`,
-- so the filer cannot decide what they filed. 0252 pinned the INSERT to the
-- undecided state — `status = 'pending'`, `decided_by IS NULL`,
-- `decided_at IS NULL`. Both hold, and this probe asserts they still do.
--
-- What neither pinned is `requested_by`: the one column that says WHOSE ask it
-- is. It is the same residue `audit_logs.actor_id` carried before 0320 and
-- `wallet_audit_logs.actor_user_id` before 0328 — on a replayed database a
-- child could file a 5000-cent allowance request signed with the PARENT's uid,
-- with a sibling's, or with nobody's at all.
--
-- Sized as 0333 sizes it, and no larger: nothing in the product SELECTs this
-- column today, so no screen shows a parent the wrong name. The defect is the
-- stored record — a money-domain row whose only statement of who asked can be
-- written by someone other than the person who asked. Filing itself stays open
-- to every member, deliberately: asking a parent for money is the feature.
--
-- Asserts, in both directions:
--
--   1. a child can STILL file a request in their own name — `requestAllowance
--      Action` and `requestSpendAction` carry no manager gate by design, and a
--      boundary that stops the honest caller is the wrong boundary;
--   2. a child CANNOT file one signed with the parent's uid;
--   3. nor with a SIBLING's uid — the forgery is not only upward;
--   4. nor with `requested_by` null, which would read as an anonymous ask in a
--      money queue;
--   5. a PARENT cannot sign for the child either — this is identity, not role,
--      exactly as 0320 decided for `audit_logs`;
--   6. 0252's born-undecided pin survives: nobody may file a row that is
--      already approved and stamped with a decider;
--   7. 0251's decision boundary survives: the child who filed it cannot
--      approve it;
--   8. reads stay `is_family_member` — a child still sees the household queue,
--      which is what /wallet renders;
--   9. `anon` holds no INSERT (0290's argument, reaffirmed by 0322 and 0328);
--  10. NEGATIVE CONTROL: drop the restrictive guard and require the forgery to
--      succeed again. A probe never shown to fail is decoration.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-request-says-who-actually-filed-it-check.sql

\set FR '00000000-0000-4000-8000-00000000df10'
\set UP '00000000-0000-4000-8000-00000000df11'
\set UK '00000000-0000-4000-8000-00000000df12'
\set US '00000000-0000-4000-8000-00000000df13'

begin;

insert into auth.users (id, email) values (:'UP','df-parent@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UK','df-kid@example.com')     on conflict do nothing;
insert into auth.users (id, email) values (:'US','df-sibling@example.com') on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FR','Filed Request House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000df14',:'FR',:'UK','Kid','child',true) on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000df15',:'FR',:'US','Sibling','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FR' and user_id = :'UP';

-- A genuine pending ask, written the way requestAllowanceAction writes one.
insert into public.parent_approvals (id, family_id, kind, ref_type, amount_cents, status, requested_by, note)
  values ('00000000-0000-4000-8000-00000000df16', :'FR', 'allowance_request', 'child_wallets',
          2000, 'pending', :'UK', 'Saved up for a bike');

grant select, insert on public.parent_approvals to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-00000000df10';
  parent_u  constant uuid := '00000000-0000-4000-8000-00000000df11';
  kid_u     constant uuid := '00000000-0000-4000-8000-00000000df12';
  sib_u     constant uuid := '00000000-0000-4000-8000-00000000df13';
  genuine   constant uuid := '00000000-0000-4000-8000-00000000df16';
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. The designed child action. requestSpendAction carries no manager gate.
  begin
    insert into public.parent_approvals (family_id, kind, ref_type, amount_cents, status, requested_by, note)
      values (fam, 'spend_request', 'child_wallets', 1500, 'pending', kid_u, 'New football');
  exception when insufficient_privilege then
    failures := array_append(failures,
      'a child can no longer file a request IN THEIR OWN NAME — asking a parent for money is the feature, and this boundary broke it');
  end;

  -- 2. The forgery upward: an ask the parent never made, signed as the parent.
  begin
    insert into public.parent_approvals (family_id, kind, ref_type, amount_cents, status, requested_by, note)
      values (fam, 'allowance_request', 'child_wallets', 5000, 'pending', parent_u, 'Please top me up');
    failures := array_append(failures,
      'a child filed a money request in the PARENT''s name — the stored record names someone who never asked');
  exception when insufficient_privilege then null;
  end;

  -- 3. And sideways: the sibling never asked for this either.
  begin
    insert into public.parent_approvals (family_id, kind, ref_type, amount_cents, status, requested_by, note)
      values (fam, 'allowance_request', 'child_wallets', 5000, 'pending', sib_u, 'From your brother');
    failures := array_append(failures,
      'a child filed a money request in a SIBLING''s name — the forgery is not only upward');
  exception when insufficient_privilege then null;
  end;

  -- 4. The anonymous ask, which is not a state the product produces.
  begin
    insert into public.parent_approvals (family_id, kind, ref_type, amount_cents, status, requested_by, note)
      values (fam, 'allowance_request', 'child_wallets', 5000, 'pending', null, 'No name on it');
    failures := array_append(failures,
      'a child filed a money request with NO requester at all — an anonymous row in a money queue');
  exception when insufficient_privilege then null;
  end;

  -- 5. Identity, not role: a parent may not sign for the child.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.parent_approvals (family_id, kind, ref_type, amount_cents, status, requested_by, note)
      values (fam, 'spend_request', 'child_wallets', 900, 'pending', kid_u, 'blamed on the child');
    failures := array_append(failures,
      'a PARENT filed a request in the child''s name — the pin is a role check, not an identity check');
  exception when insufficient_privilege then null;
  end;

  -- The parent's own over-threshold ask still works (positive control).
  begin
    insert into public.parent_approvals (family_id, kind, ref_type, amount_cents, status, requested_by, note)
      values (fam, 'spend_request', 'child_wallets', 40000, 'pending', parent_u, 'School trip deposit');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not file a request in their own name');
  end;

  -- 6. 0252's born-undecided pin. The restrictive guard only ANDs; if this
  --    ever leaves the permissive policy, a pin on the requester would not
  --    notice, so it is asserted here rather than assumed.
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    insert into public.parent_approvals (family_id, kind, ref_type, amount_cents, status, requested_by, decided_by, decided_at, note)
      values (fam, 'spend_request', 'child_wallets', 7500, 'approved', kid_u, parent_u, now(), 'Already approved, honest');
    failures := array_append(failures,
      'a child filed a request BORN APPROVED and stamped with a decider — 0252''s pin has regressed');
  exception when insufficient_privilege then null;
  end;

  -- 7. 0251's decision boundary: the filer does not decide what they filed.
  begin
    update public.parent_approvals set status = 'approved', decided_by = kid_u, decided_at = now()
     where id = genuine;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a child DECIDED %s of their own money request(s) — 0251 has regressed', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 8. Reads stay open to the household, deliberately: /wallet renders the
  --    queue for whoever is signed in.
  select count(*) into n from public.parent_approvals where id = genuine;
  if n = 0 then
    failures := array_append(failures,
      'a child can no longer READ the household approval queue — that is a change of decision, not this migration''s');
  end if;

  -- 9. The grant layer, which a `to authenticated` policy cannot reach.
  perform set_config('role','postgres', true);
  if has_table_privilege('anon', 'public.parent_approvals', 'INSERT') then
    failures := array_append(failures, 'anon holds INSERT on parent_approvals');
  end if;

  -- ── Negative control: prove this probe can SEE the defect ────────────────
  -- Drop 0333's restrictive guard and require the forgery to work again. The
  -- outer rollback undoes this along with everything else.
  drop policy if exists parent_approvals_requester_guard on public.parent_approvals;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    insert into public.parent_approvals (family_id, kind, ref_type, amount_cents, status, requested_by, note)
      values (fam, 'allowance_request', 'child_wallets', 5000, 'pending', parent_u, 'Please top me up');
  exception when insufficient_privilege then
    failures := array_append(failures,
      'with 0333''s guard removed the child STILL could not sign as the parent — this probe is decoration, not a boundary');
  end;

  perform set_config('role','postgres', true);
  select count(*) into n from public.parent_approvals
   where family_id = fam and requested_by = parent_u and note = 'Please top me up';
  if n = 0 then
    failures := array_append(failures,
      'with the guard removed no forged row landed — this probe has never been shown to fail');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a wallet request does not say who filed it:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-request-says-who-actually-filed-it: OK (a member files only in their own name, nobody signs for anyone else, no anonymous asks, rows are still born undecided, the filer still cannot decide, reads stay household-wide, anon holds no INSERT, negative control reproduced the forgery)';
end $$;

rollback;
