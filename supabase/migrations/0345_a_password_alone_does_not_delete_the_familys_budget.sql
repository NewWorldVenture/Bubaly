-- Bubaly :: 0345 - a password alone does not delete the family's budget
--
-- Two-step sign-in (lib/auth/mfa.ts, lib/auth/require-aal2.ts) is an OPT-IN
-- control a family turns on so that a stolen password cannot reach the money.
-- A session is `aal1` (password only) or `aal2` (password plus a fresh code),
-- and nine money pages send an `aal1` manager to /auth/step-up:
--
--   app/(app)/dashboard/{savings,budgets,expenses,bills,autopay,payments,
--                        subscriptions,money-timeline,family-cfo}/page.tsx
--
-- Until now that was the WHOLE enforcement. A grep of every migration for
-- `aal` / `assurance` found no policy reading the JWT's `aal` claim anywhere in
-- the schema, so the database had no view of step-up at all. The permissive and
-- restrictive write policies these tables do carry — 0275:79-92, superseding
-- 0267:68-95 — are `public.can_manage_family(family_id)`, which is a ROLE
-- (`role in ('parent','adult')`, 0003:22). A parent on an `aal1` session
-- satisfies it completely. That is precisely the caller `needsStepUp`
-- (lib/auth/mfa.ts:102-104) exists to stop.
--
-- Why a page guard is not a boundary here. The threat the control is bought for
-- is someone who HAS the password and not the authenticator: an ex-partner, a
-- teen who watched it typed, a phished credential. That person signs in
-- successfully and holds a valid `aal1` session — and the anon key plus the
-- session's own JWT are enough to talk to PostgREST directly:
--
--   DELETE /rest/v1/budgets?id=eq.<id>        Authorization: Bearer <aal1 jwt>
--
-- No page renders, no server action runs, and before this migration the
-- database said yes. The same hole is open through the browser on
-- /dashboard/billing, where three writes go straight to PostgREST from the
-- client rather than through a server action (components/modules/
-- billing-module.tsx deleteBill / markBillPaid / deleteAccount).
--
-- ── what this migration does ────────────────────────────────────────────────
--
-- One helper that mirrors `needsStepUp` exactly, and a RESTRICTIVE write guard
-- per table that uses it. Restrictive, so it ANDs with whatever permissive
-- policy a household's drift has left behind and cannot be satisfied by adding
-- a broad policy beside it.
--
-- The helper's "only if a factor is enrolled" half is what keeps this opt-in:
-- a family that never set up an authenticator has no verified factor, the
-- helper answers true, and nothing about their money changes. This is the same
-- rule `sessionStrength` applies — only a session that CAN reach `aal2` is ever
-- asked to.
--
-- ── deliberately NOT covered, and why ──────────────────────────────────────
--
-- SELECT is untouched. Reads of these tables happen far outside the money area
-- on the session client (the home dashboard, the daily brief, search), and
-- those surfaces have no step-up entry point to offer — an assurance guard on
-- SELECT would empty widgets across the app with no way for the family to
-- clear it. Step-up stays a WRITE boundary in the database and a page boundary
-- for reading, which is what the nine guarded pages already implement.
--
-- `transactions` and `financial_accounts` are NOT in the table list, though the
-- same argument applies to them. Both are also written by the wallet hub
-- (app/(app)/wallet/hub-actions.ts:61,132,168-169) on the session client, and
-- /wallet is not a step-up area: a guard here would fail its writes closed with
-- "Could not add the account" and no path to enter a code. Closing those two
-- needs /wallet to gain a step-up entry point first. Their server actions ARE
-- gated in TypeScript as of this change (app/(app)/dashboard/billing/
-- actions.ts moneyScope), so the remaining exposure on them is a crafted
-- PostgREST request, which is recorded rather than quietly closed.
--
-- ── what the owner should know before applying ─────────────────────────────
--
-- Two live paths write these three tables on a SESSION client and are therefore
-- newly subject to the code, for managers who have enrolled an authenticator
-- and have not entered a code this session:
--
--   1. The money pages and their server actions. These are already step-up
--      guarded in TypeScript, so the guard here only catches a request that
--      skipped the page — which is the point.
--   2. The chat assistant's immediate tool path (lib/ai/actions.ts runAction →
--      executeTool with the caller's own client) for `finances.updateBudget` and
--      `finances.createSavingsGoal`. Those two would answer "Could not save that
--      budget." instead of offering a step-up link, until that path learns to
--      read the verdict the way app/api/privacy/export/route.ts does. The AI
--      RUN executor is unaffected: it writes with the service role
--      (lib/ai/runs/executor.ts, lib/ai/runs/store.ts), which RLS exempts.
--
-- A refused write surfaces honestly rather than silently on all three tables:
-- Postgres FILTERS an update/delete a restrictive policy refuses, and every
-- caller here already asks for its rows back and treats zero as a refusal
-- (lib/services/finances/index.ts `.select(...).maybeSingle()` → "could not be
-- found"; components/finance/bills-view.tsx and components/modules/
-- billing-module.tsx `.select('id')` + `wroteNoRows`). See
-- tests/a-refused-write-is-not-a-success.test.ts.
--
-- Replay-safe: `drop policy if exists` before each `create policy`, and
-- `create or replace` for the helper.

-- ── the helper ──────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER because `authenticated` has no read on auth.mfa_factors.
-- STABLE, not IMMUTABLE: it reads the request's claims and a table.
--
-- A token with no `aal` claim at all answers false for an enrolled user. That
-- is the same fail-closed direction lib/auth/require-aal2.ts takes when the
-- level cannot be read (decideAal2, reason 'assurance_unreadable'): a level we
-- could not establish is not a level we grant.
create or replace function public.session_cleared_step_up()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    (not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid() and f.status = 'verified'
    ))
    or coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

comment on function public.session_cleared_step_up() is
  'True when this session may write money: either the user has no verified authenticator (two-step is off for them) or the session reached aal2. Mirrors needsStepUp in lib/auth/mfa.ts.';

-- Postgres grants EXECUTE on a new function to PUBLIC, and a SECURITY DEFINER
-- function is not one to leave that way even when, as here, it answers only
-- about the caller's own auth.uid(): revoked from PUBLIC and anon, granted to
-- the role whose writes the guards below actually evaluate (0341:324-327 is
-- the pattern).
revoke all on function public.session_cleared_step_up() from public, anon;
grant execute on function public.session_cleared_step_up() to authenticated;

-- ── the guards ──────────────────────────────────────────────────────────────
do $$
declare
  t text;
  -- The money tables written ONLY from the step-up-guarded money area. See the
  -- header for why `transactions` and `financial_accounts` are not here.
  money_tables text[] := array['budgets', 'savings_goals', 'bills'];
begin
  foreach t in array money_tables loop
    if to_regclass('public.' || t) is null then
      raise exception 'Required money table missing: %', t;
    end if;
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %1$s_step_up_insert_guard on public.%1$I', t);
    execute format(
      'create policy %1$s_step_up_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.session_cleared_step_up())',
      t);

    execute format('drop policy if exists %1$s_step_up_update_guard on public.%1$I', t);
    execute format(
      'create policy %1$s_step_up_update_guard on public.%1$I as restrictive for update to authenticated using (public.session_cleared_step_up()) with check (public.session_cleared_step_up())',
      t);

    execute format('drop policy if exists %1$s_step_up_delete_guard on public.%1$I', t);
    execute format(
      'create policy %1$s_step_up_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.session_cleared_step_up())',
      t);
  end loop;
end $$;
