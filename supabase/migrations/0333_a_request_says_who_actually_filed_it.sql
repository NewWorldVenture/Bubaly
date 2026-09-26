-- Bubaly :: 0333 - a wallet request says who actually filed it
--
-- `parent_approvals` (0088, the wallet approval inbox) is otherwise well pinned.
-- 0251 split 0088's `FOR ALL … is_family_member` into four policies and left
-- UPDATE and DELETE to `can_manage_family`, so a child cannot decide their own
-- request. 0252 then pinned the INSERT to the undecided state:
--
--   parent_approvals_insert  FOR INSERT TO authenticated
--     WITH CHECK (is_family_member(family_id)
--                 AND status = 'pending'
--                 AND decided_by IS NULL
--                 AND decided_at IS NULL)
--
-- Filing is the DESIGNED child action — `requestAllowanceAction` and
-- `requestSpendAction` (app/(app)/wallet/actions.ts) carry no `isManager` gate,
-- deliberately, because asking a parent for money is the whole feature — so
-- `amount_cents` and `note` are legitimately the child's to write.
--
-- THE RESIDUE is the one column that says whose ask it is. `requested_by` is
-- unpinned, exactly as `audit_logs.actor_id` was before 0320 and
-- `wallet_audit_logs.actor_user_id` was before 0328. Measured on a replayed
-- database with all 345 migrations applied, acting as a child of the family:
--
--   insert into parent_approvals
--     (family_id, kind, ref_type, ref_id, amount_cents, status, requested_by, note)
--   values (<fam>, 'allowance_request', 'child_wallets', <wallet>, 5000,
--           'pending', <the PARENT's uid>, 'Please top me up')      -> INSERT 1
--
-- and the same row with a SIBLING's uid, and with `requested_by` null.
--
-- ── the size of it, stated smaller than the brief that sent me ─────────────
-- The brief said the forged name lands "in the inbox a parent reads while
-- deciding". It does not, and the difference is worth writing down. NOTHING in
-- the product selects this column: the wallet inbox
-- (components/wallet/wallet-dashboard.tsx `PendingApproval`), the home and
-- needs-you decision cards (lib/briefing/decisions.ts), the reminder generator
-- (lib/server/notifications.ts), the assistant (lib/assistant/tools.ts) and the
-- admin wallet count all read `id, kind, amount_cents, created_at` and no more,
-- and `decideSpendRequestAction` / `decideAllowanceRequestAction` select
-- `status, kind, ref_type, ref_id, amount_cents, note` — they never branch on
-- the requester. So no screen today shows a parent the wrong name.
--
-- What is actually defective is the stored record: a money-domain row whose
-- only statement of who asked for the money can be written by someone other
-- than the person who asked, and is never corrected afterwards. That is the
-- same defect class as AUDIT-002, and the reason to close it now is the one
-- AUTHZ-015 gives about the dialler — the column is already there, the honest
-- moment to pin it is before something reads it, not after.
--
-- It is NOT escalation, and this migration does not claim it is. The money is
-- guarded elsewhere and stays guarded: 0252 forces the row to be born pending
-- and undecided, 0251 leaves UPDATE to managers so the filer cannot decide it,
-- and `wallet_decide_spend` / `wallet_decide_allowance` (0205) are SECURITY
-- DEFINER and refuse unless `auth.uid() = p_actor_id` and the caller
-- `can_manage_family`.
--
-- ── why a bare `= auth.uid()` is the right predicate here ──────────────────
-- Checked before writing a line of SQL, because a pin on the wrong column type
-- silently breaks every insert:
--
--   information_schema.columns  parent_approvals.requested_by  uuid, nullable
--   pg_constraint  parent_approvals_requested_by_fkey
--                    FOREIGN KEY (requested_by) REFERENCES auth.users(id)
--
-- A USER id, not a `family_members.id`, so `requested_by = auth.uid()` is the
-- comparison — not the `exists (… fm.id = … and fm.user_id = auth.uid())`
-- shape 0252 needed for `ai_requests.requested_by_member_id`.
--
-- And there is no on-behalf-of flow to accommodate. Every writer of this table
-- was read: `requestSpendAction` (actions.ts:772) and `requestAllowanceAction`
-- (actions.ts:901) are the only two, both on `createServer()` — the caller's
-- own cookie-bound client — and both pass `requested_by: ctx.user.id`. A parent
-- filing a spend request over the threshold goes through the same line and
-- names themselves, truthfully. Nothing in the codebase files a request in
-- another member's name, so this is identity rather than role: a manager cannot
-- sign for a child either, exactly as 0320 decided for `audit_logs`. The
-- remaining SQL writers are `wallet_decide_spend` / `wallet_decide_allowance`,
-- which only UPDATE, and SEED_ALL, which runs as the owner and bypasses RLS.
--
-- NULL is refused with everything else. No client writer leaves the column
-- unset, and an anonymous ask in a money queue is not a state the product
-- produces. Service-role writers (none today) bypass RLS and are unaffected.
--
-- ── why RESTRICTIVE rather than restating parent_approvals_insert ──────────
-- 0320 and 0328 replaced their permissive policies, because in both cases the
-- policy was theirs to restate. This one is not: `parent_approvals_insert`
-- belongs to 0252, and tests/ai-insert-authority.test.ts and
-- tests/ai-runtime-schema.test.ts are source-level ratchets that read 0251 and
-- 0252 and assert what that policy contains. Recreating it here would leave
-- those tests describing a policy that is no longer the live one — the drift
-- 0255's own test guards against with "a later policy of the same name replaces
-- the earlier one outright". A restrictive policy ANDs with the union of the
-- permissive ones (0254's mechanism, reaffirmed by 0306, 0310 and 0322), so
-- 0252's three conditions stay exactly where the tests can see them, and no
-- future permissive INSERT written out of habit can grant past this one —
-- which matters on a table AUTHZ-011 already lists among the 125 with split
-- role-blind write policies.
--
-- READS are unchanged: `parent_approvals_select` stays
-- `is_family_member(family_id)`, so a child still sees the household's queue,
-- and UPDATE/DELETE stay `can_manage_family`.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

do $$
begin
  if to_regclass('public.parent_approvals') is null then
    return;
  end if;

  drop policy if exists parent_approvals_requester_guard on public.parent_approvals;
  create policy parent_approvals_requester_guard on public.parent_approvals
    as restrictive for insert to authenticated
    with check (requested_by = auth.uid());
end $$;

-- The guard names `authenticated`, and a restrictive policy only ANDs with a
-- request made AS a role it names — for an anonymous request it is simply
-- absent, leaving the grant layer as the last line. Supabase's default
-- privileges hand `anon` arwdDxt on every table in `public` at creation, and
-- this one still carried them. Not exploitable as it stands (no permissive
-- policy names anon, so RLS refuses the insert for want of one), and this does
-- not claim otherwise; closed for the reason 0290, 0322 and 0328 give — one
-- future policy written `TO public` would otherwise find the grant waiting.
-- SELECT is deliberately left alone.
revoke insert, update, delete, truncate on public.parent_approvals from anon;

do $$
declare
  insert_check text;
  update_qual  text;
begin
  if to_regclass('public.parent_approvals') is null then
    return;
  end if;

  if has_table_privilege('anon', 'public.parent_approvals', 'INSERT') then
    raise exception '0333: anon still holds INSERT on parent_approvals';
  end if;

  -- A migration that silently created nothing is worse than one that failed:
  -- the probe would be asserting a boundary that only looks present.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'parent_approvals'
      and policyname = 'parent_approvals_requester_guard'
      and permissive = 'RESTRICTIVE' and cmd = 'INSERT'
      and with_check like '%requested_by = auth.uid()%'
  ) then
    raise exception '0333: the restrictive requester guard is missing from parent_approvals';
  end if;

  -- This guard only ANDs. If 0252's conditions ever leave the permissive
  -- policy, the row can be born decided again and no restrictive pin on the
  -- requester would notice — so fail loudly here rather than pass quietly.
  select with_check into insert_check from pg_policies
   where schemaname = 'public' and tablename = 'parent_approvals'
     and policyname = 'parent_approvals_insert';
  if insert_check is null
     or insert_check not like '%is_family_member(family_id)%'
     or insert_check not like '%status = ''pending''%'
     or insert_check not like '%decided_by IS NULL%'
     or insert_check not like '%decided_at IS NULL%' then
    raise exception '0333: parent_approvals_insert no longer carries 0252''s born-undecided conditions: %',
      coalesce(insert_check, '<policy missing>');
  end if;

  -- And 0251's decision boundary must survive this edit: the filer must still
  -- not be able to decide what they filed.
  select qual into update_qual from pg_policies
   where schemaname = 'public' and tablename = 'parent_approvals'
     and policyname = 'parent_approvals_update';
  if update_qual is null or update_qual not like '%can_manage_family(family_id)%' then
    raise exception '0333: parent_approvals_update is no longer manager-only: %',
      coalesce(update_qual, '<policy missing>');
  end if;

  raise notice '0333 OK: a parent_approvals row names the member who actually filed it; filing stays open to every member, decisions stay with managers, reads unchanged.';
end $$;
