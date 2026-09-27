-- Bubaly :: 0324 - the Pay-ID and the savings goal, both still on 0088's policy
--
-- 0322 narrowed five of `0088_family_wallet.sql`'s fourteen tables. Two more of
-- that DO loop's children were missed, and both are worse than the five:
--
--   CREATE POLICY "Members manage %1$s" ON public.%1$I
--     FOR ALL TO authenticated
--     USING (public.is_family_member(family_id))
--     WITH CHECK (public.is_family_member(family_id))
--
-- `FOR ALL` covers INSERT, UPDATE and DELETE; `is_family_member` asks whether
-- the caller lives in the household and ignores role entirely.
--
-- ── 1. pay_handles — a redirect an outsider follows ─────────────────────────
--
-- Writers: `claimPayHandleAction` (app/(app)/wallet/actions.ts) and
-- `releasePayHandleAction`, both opening `if (!isManager(ctx.active.role))`.
--
-- What makes it the sharpest of the two is the READER. `app/pay/[handle]/
-- page.tsx` resolves /pay/<handle> with `createServiceClient()` — RLS OFF,
-- because the visitor is not signed in — reads the row's `child_wallet_id`,
-- finds that wallet's newest active `gift_links` row and redirects there:
--
--     const { data: ph } = await supabase.from('pay_handles')
--       .select('family_id, child_wallet_id, is_active').eq('handle', handle)…
--     q = ph.child_wallet_id ? q.eq('child_wallet_id', ph.child_wallet_id) : q;
--     if (link?.token) redirect(`/gift/${link.token}`);
--
-- So the row a child could rewrite decides where a GRANDPARENT lands. Measured
-- on a replayed database with all 336 migrations applied, acting as a child:
--
--   update pay_handles set child_wallet_id = <my own wallet>
--     where handle = 'siblingpay'                            -> UPDATE 1
--
-- and the next person to type the sibling's Pay ID funds the child's wallet
-- instead. `is_active = false`, or a delete, is the same defect in its duller
-- denial-of-service form: the Pay ID a family printed on a card stops working,
-- and `releasePayHandleAction` frees a globally unique handle for anyone on the
-- platform to claim. Nothing here moves money by itself — the gift flow still
-- goes through `wallet_approve_gift` (0205, SECURITY DEFINER, manager-checked)
-- — what moves is WHOSE wallet a stranger is invited to pay into.
--
-- ── 2. wallet_goals — the confused deputy, in the money domain ──────────────
--
-- Writers: `createGoalAction` and `fundGoalAction`, both manager-gated.
--
-- `wallet_fund_goal` (0208) is SECURITY DEFINER and does its checks properly:
--
--   if auth.uid() is null or p_actor_id is distinct from auth.uid()
--      or not public.can_manage_family(p_family_id) then … 'forbidden'
--
-- and then reads the goal row and uses ITS OWN fields. `v_goal.child_wallet_id`
-- chooses which child's Save bucket is locked and debited; `v_goal.title` lands
-- in the ledger row's description and in the `wallet_audit_logs` line the
-- parent reads afterwards. Measured, in one transaction:
--
--   as the child:  insert into wallet_transactions …            -> refused (0217)
--   as the child:  insert into wallet_goals (child_wallet_id = <sibling's>,
--                                            title = 'New bike')  -> INSERT 1
--   as the parent: select wallet_fund_goal(fam, <goal>, 5000, parent)
--                                                               -> {"ok": true}
--   result:        the SIBLING's Save balance went 5000 -> 0
--
-- This is AUTHZ-006's shape with money at the end of it: the child never wrote
-- the ledger they were forbidden, they wrote the row that told a privileged
-- function what to write there, and the parent did exactly what the product
-- asked of them. Separately and more cheaply, `saved_cents` and `status` are
-- plain columns on the same open policy, so a child could also mark a goal
-- reached without a penny moving.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- Reads, on both. /wallet/goals, /wallet/children/[childId], /wallet/treasury
-- and the three /api/ai/* wallet surfaces all read these tables on the
-- RLS-bound client as whoever is signed in, and a child is supposed to see
-- their own savings goal and their own Pay ID — that is the feature. /pay/
-- <handle> reads with the service role and is unaffected by RLS in either
-- direction. Narrowing SELECT to fix a write would be a regression, so only
-- writes move.
--
-- `wallet_fund_goal`, `wallet_approve_gift` and the rest of 0205/0208 are
-- SECURITY DEFINER owned by the migration role and keep working unchanged;
-- what changes is who may author their input.
--
-- RESTRICTIVE rather than a replacement, as 0254/0310/0322: a restrictive
-- policy ANDs with the UNION of the permissive ones, so no future `FOR ALL`
-- written out of habit can grant past it — which is precisely how both of these
-- tables are still here after six passes of narrowing their siblings.
--
-- The `anon` grant goes for the reason 0290 gives: these guards are `TO
-- authenticated` and a restrictive policy only ANDs with a request made AS a
-- role it names, so for an anonymous request they are simply absent and
-- Supabase's default `arwdDxt` would be the only thing left. SELECT is left
-- alone, exactly as 0290 left it — /pay/<handle> uses the service role, not
-- anon, so nothing public depends on the anon grant.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent: policies are dropped and recreated by name; the revokes are
-- no-ops when already applied.

do $$
declare
  t text;
begin
  foreach t in array array['pay_handles', 'wallet_goals'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated '
      || 'with check (public.can_manage_family(family_id))', t || '_manager_insert_guard', t);

    -- UPDATE carries both halves. Without WITH CHECK a manager could move a row
    -- into another family; without USING a non-manager could still match rows
    -- to attempt the update.
    execute format('drop policy if exists %I on public.%I', t || '_manager_update_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated '
      || 'using (public.can_manage_family(family_id)) '
      || 'with check (public.can_manage_family(family_id))', t || '_manager_update_guard', t);

    execute format('drop policy if exists %I on public.%I', t || '_manager_delete_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated '
      || 'using (public.can_manage_family(family_id))', t || '_manager_delete_guard', t);
  end loop;
end
$$;

-- ── close the anon grant these `to authenticated` guards cannot reach ───────
revoke insert, update, delete, truncate on public.pay_handles  from anon;
revoke insert, update, delete, truncate on public.wallet_goals from anon;

do $$
declare
  open_tables text[];
  missing     text[];
  tbls constant text[] := array['pay_handles', 'wallet_goals'];
begin
  select array_agg(t order by t) into open_tables
  from unnest(tbls) as t
  where has_table_privilege('anon', 'public.' || t, 'INSERT');
  if open_tables is not null then
    raise exception '0324: anon still holds INSERT on: %', open_tables;
  end if;

  -- A migration that silently created nothing is worse than one that failed:
  -- the probe would be asserting a boundary that only looks present.
  select array_agg(t order by t) into missing
  from unnest(tbls) as t
  where not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = t
      and policyname = t || '_manager_update_guard' and permissive = 'RESTRICTIVE'
  );
  if missing is not null then
    raise exception '0324: restrictive manager guard missing on: %', missing;
  end if;

  raise notice '0324 OK: Pay-ID handles and savings goals are manager-written; anon holds no write on either.';
end
$$;
