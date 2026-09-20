-- Bubaly :: 0322 - the five wallet side-tables whose only manager is a server action
--
-- 0088_family_wallet.sql created fourteen wallet tables in one DO loop and gave
-- every one of them the same policy:
--
--   CREATE POLICY "Members manage %1$s" ON public.%1$I
--     FOR ALL TO authenticated
--     USING (public.is_family_member(family_id))
--     WITH CHECK (public.is_family_member(family_id))
--
-- `FOR ALL` covers INSERT, UPDATE and DELETE, and `is_family_member` answers
-- "is this user in the household" and ignores role. Nine of the fourteen have
-- since been narrowed — 0254 and 0290 the ledger, 0300 entitlements, 0304 the
-- invest decision, 0306 the allowance instructions, 0316 the chore payout. These
-- five were not, and each of them has a server action that already claims to be
-- manager-only:
--
--   babysitter_profiles     app/(app)/wallet/actions.ts  saveBabysitterAction,
--                                                        archiveBabysitterAction
--   babysitter_payments     app/(app)/wallet/actions.ts  recordBabysitterPaymentAction
--   gift_links              app/(app)/wallet/actions.ts  createGiftLinkAction
--   gift_payments           app/(app)/wallet/actions.ts  approveGiftAction,
--                                                        dismissGiftAction
--   compliance_disclosures  app/(app)/wallet/actions.ts  activateFamilyWalletAction
--
-- Every one of those opens with `if (!isManager(ctx.active.role)) return …`.
-- That gate is real and it is also not a boundary: children hold real logins and
-- real JWTs, every Supabase project ships PostgREST reachable, and a request to
-- /rest/v1/gift_payments never passes through app/ at all. This is the same
-- sentence 0318 had to write about the Guardian tables, and the same repair.
--
-- Measured on a replayed database with all 334 migrations applied, acting as a
-- child of the family, each of these returned 1 row affected:
--
--   update babysitter_profiles set rate_cents = 1            -> UPDATE 1
--   update babysitter_payments set amount_cents = 999999     -> UPDATE 1
--   delete from compliance_disclosures                       -> DELETE 1
--   insert into gift_links (…) values (…)                    -> INSERT 1
--   update gift_payments set status = 'completed'            -> UPDATE 1
--
-- The last is the one that costs money rather than tidiness. `gift_payments` is
-- the queue a parent approves from; `wallet_approve_gift` (0205) is the only
-- thing that actually credits a wallet and it checks `can_manage_family`, so a
-- child flipping status to 'completed' does NOT mint anything. What it does is
-- clear the row out of /wallet/gift, which reads `.eq('status','pending')`: a
-- real grandparent's gift is marked settled and silently never credited, and
-- nobody is told. `compliance_disclosures` is the other end of the same idea —
-- it records who accepted the wallet terms, when, and from which IP, which is
-- exactly the kind of record whose value is that the subject could not have
-- written or removed it.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- Reads. /wallet/babysitters and /wallet/gift are read by the RLS-bound server
-- client as whoever is signed in, and nothing role-gates those pages; narrowing
-- SELECT would empty them for a teen and is a product decision, not this
-- migration's business. Only writes move.
--
-- The public gift flow is untouched: app/gift/actions.ts and app/gift/[token]/
-- page.tsx both use `createServiceClient()`, which bypasses RLS entirely, so a
-- grandparent submitting a pledge is unaffected. `wallet_approve_gift` and
-- `guardian_review_suggestion` are SECURITY DEFINER and likewise unaffected.
--
-- ── why RESTRICTIVE rather than replacing the permissive policy ─────────────
-- 0254's mechanism, reaffirmed by 0306 and 0310: a restrictive policy ANDs with
-- the union of the permissive ones, so no future permissive policy can grant
-- past it. Replacing "Members manage …" would be undone by the next `FOR ALL`
-- someone adds out of habit — which is precisely how all five got here.
--
-- ── and the grant layer, for the same reason 0290 closed it ─────────────────
-- These guards are `TO authenticated`, and a restrictive policy only ANDs with
-- requests made AS a role it names. For an ANONYMOUS request they are simply
-- absent, so the grant layer is the only thing left — and Supabase's default
-- privileges hand `anon` arwdDxt on every table in `public` from the moment it
-- is created. Not exploitable as it stands (no permissive policy names anon, so
-- RLS refuses the insert for want of one), and this does not claim otherwise;
-- what it restores is the defence in depth 0290 already argued for on the ledger
-- tables, so that one future policy written `TO public` cannot open a path no
-- restrictive guard would catch. SELECT is deliberately left alone, exactly as
-- 0290 left it.
--
-- Idempotent: policies are dropped and recreated by name; the revokes are
-- no-ops when already applied.

-- ── manager-only writes on all five ─────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'babysitter_profiles', 'babysitter_payments', 'gift_links', 'gift_payments',
    'compliance_disclosures'
  ] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated '
      || 'with check (public.can_manage_family(family_id))', t || '_manager_insert_guard', t);

    -- UPDATE carries both halves. Without WITH CHECK a manager could move a row
    -- into another family; without USING a non-manager could still match rows to
    -- attempt the update.
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
revoke insert, update, delete, truncate on public.babysitter_profiles    from anon;
revoke insert, update, delete, truncate on public.babysitter_payments    from anon;
revoke insert, update, delete, truncate on public.gift_links             from anon;
revoke insert, update, delete, truncate on public.gift_payments          from anon;
revoke insert, update, delete, truncate on public.compliance_disclosures from anon;

do $$
declare
  open_tables text[];
  missing     text[];
  tbls constant text[] := array[
    'babysitter_profiles', 'babysitter_payments', 'gift_links', 'gift_payments',
    'compliance_disclosures'
  ];
begin
  select array_agg(t order by t) into open_tables
  from unnest(tbls) as t
  where has_table_privilege('anon', 'public.' || t, 'INSERT');
  if open_tables is not null then
    raise exception '0322: anon still holds INSERT on wallet side-table(s): %', open_tables;
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
    raise exception '0322: restrictive manager guard missing on: %', missing;
  end if;

  raise notice '0322 OK: five wallet side-tables are manager-written; anon holds no write on any of them.';
end
$$;
