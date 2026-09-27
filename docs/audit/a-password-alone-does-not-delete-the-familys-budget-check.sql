-- ── A password alone does not write the family's budget, goals or bills (0382)
--
-- Two-step sign-in is an opt-in control: a parent enrols an authenticator so a
-- stolen password cannot reach the money. Before 0382 that was enforced only
-- by nine money PAGES calling requireAal2; the database had no view of the
-- session's `aal` claim, so an `aal1` session (password, no code) could
-- `DELETE /rest/v1/budgets?id=eq.<id>` with the anon key and its own JWT, and
-- `can_manage_family` — a ROLE check — said yes.
--
-- Asserts, in both directions:
--
--   1. a parent WITH a verified factor, on an aal1 session, cannot insert,
--      update or delete a budget, a savings goal or a bill;
--   2. a token carrying NO `aal` claim at all is refused the same way — a level
--      that cannot be read is not a level that is granted (decideAal2's
--      'assurance_unreadable');
--   3. the same parent on an aal2 session writes all three — the positive
--      control, and the reason the refusals in 1 are the assurance rule and not
--      a role, a grant or an invisible row;
--   4. a parent who never enrolled (and one whose only factor is UNVERIFIED)
--      is not touched: aal1 is all they can ever have, and that is what keeps
--      this opt-in rather than a lock-out;
--   5. anon cannot EXECUTE the SECURITY DEFINER helper;
--   6. NEGATIVE CONTROL: drop ONLY the budgets guards and require the aal1
--      delete to land again.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-password-alone-does-not-delete-the-familys-budget-check.sql

\set FS '00000000-0000-4000-8000-000000038200'
\set UE '00000000-0000-4000-8000-000000038201'
\set UN '00000000-0000-4000-8000-000000038202'
\set UU '00000000-0000-4000-8000-000000038203'

begin;

insert into auth.users (id, email) values (:'UE','step-up-enrolled@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UN','step-up-never@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'UU','step-up-unverified@example.com') on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FS','Step-up House',:'UE') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UE','Enrolled parent','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UN','Never-enrolled parent','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UU','Half-enrolled parent','parent',true) on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'FS';

-- The factor lib/auth/mfa.ts counts (factor_type totp, status verified), and an
-- abandoned enrolment it does not.
insert into auth.mfa_factors (user_id, factor_type, status) values (:'UE', 'totp', 'verified');
insert into auth.mfa_factors (user_id, factor_type, status) values (:'UU', 'totp', 'unverified');

do $$
declare
  n        int;
  failures text[] := '{}';
  fam      constant uuid := '00000000-0000-4000-8000-000000038200';
  enrolled constant uuid := '00000000-0000-4000-8000-000000038201';
  never    constant uuid := '00000000-0000-4000-8000-000000038202';
  half     constant uuid := '00000000-0000-4000-8000-000000038203';
  budget   uuid;
  goal     uuid;
  bill     uuid;
begin
  insert into public.budgets (family_id, category, amount) values (fam, 'Groceries', 600.00) returning id into budget;
  insert into public.savings_goals (family_id, name, target_amount, current_amount)
    values (fam, 'Summer trip', 2000.00, 500.00) returning id into goal;
  insert into public.bills (family_id, name, amount, due_date, autopay)
    values (fam, 'Mortgage', 1800.00, current_date + 7, true) returning id into bill;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- ── 1. Enrolled, password only ──────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', enrolled::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);

  delete from public.budgets where id = budget;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent deleted a budget'); end if;
  update public.savings_goals set current_amount = 0 where id = goal;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent emptied a savings goal'); end if;
  update public.bills set autopay = false where id = bill;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent switched off autopay'); end if;
  begin
    insert into public.budgets (family_id, category, amount) values (fam, 'Fun money', 9999.00);
    failures := array_append(failures, 'an aal1 session of an ENROLLED parent created a budget');
  exception when insufficient_privilege then null;
  end;

  -- ── 2. No aal claim at all ──────────────────────────────────────────────
  perform set_config('request.jwt.claims', '{}', true);
  delete from public.budgets where id = budget;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'a token with NO aal claim deleted an enrolled parent''s budget — an unreadable level was treated as cleared'); end if;

  -- ── 3. The same parent, code entered ────────────────────────────────────
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  update public.budgets set amount = 650.00 where id = budget;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not adjust its own budget (%s rows) — so the refusals in 1 prove nothing', n)); end if;
  update public.savings_goals set current_amount = 550.00 where id = goal;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not update its own savings goal (%s rows)', n)); end if;
  update public.bills set autopay = true where id = bill;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not update its own bill (%s rows)', n)); end if;
  begin
    insert into public.budgets (family_id, category, amount) values (fam, 'Holidays', 300.00);
  exception when insufficient_privilege then
    failures := array_append(failures, 'an aal2 session could not create a budget');
  end;

  -- ── 4. Never enrolled, and enrolment abandoned ──────────────────────────
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);
  perform set_config('request.jwt.claim.sub', never::text, true);
  update public.budgets set amount = 700.00 where id = budget;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('a parent who NEVER enrolled was refused a budget change on aal1 (%s rows) — step-up is meant to be opt-in', n)); end if;
  perform set_config('request.jwt.claim.sub', half::text, true);
  update public.budgets set amount = 710.00 where id = budget;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('a parent whose only factor is UNVERIFIED was refused on aal1 (%s rows) — mfa.ts does not count that factor', n)); end if;

  perform set_config('role','postgres', true);

  -- ── 5. The grant layer ──────────────────────────────────────────────────
  if has_function_privilege('anon', 'public.session_cleared_step_up()', 'EXECUTE') then
    failures := array_append(failures, 'anon may EXECUTE session_cleared_step_up (SECURITY DEFINER)');
  end if;

  -- ── 6. Negative control ─────────────────────────────────────────────────
  drop policy if exists budgets_step_up_delete_guard on public.budgets;
  drop policy if exists budgets_step_up_update_guard on public.budgets;
  drop policy if exists budgets_step_up_insert_guard on public.budgets;
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', enrolled::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);
  delete from public.budgets where id = budget;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format('with the budgets guards dropped the aal1 delete touched %s row(s) — this probe has never been shown to fail', n));
  end if;
  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'a password alone still writes the family''s money:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-password-alone-does-not-delete-the-familys-budget: OK (an enrolled parent on aal1, or on a token with no aal claim, cannot insert, update or delete a budget, goal or bill; the same parent on aal2 can; never-enrolled and unverified-only parents are untouched; anon cannot call the helper; negative control reproduced the delete)';
end $$;

rollback;
