-- Bubaly :: 0336 - only a manager adds, edits or bins a home asset
--            (but logging a service visit stays every member's job)
--
-- ── The defect ──────────────────────────────────────────────────────────────
--
-- `home_assets` carries the appliances and equipment the household runs on.
-- 0004_rls.sql gave it the role-blind four:
--
--   home_assets_select  FOR SELECT USING      (is_family_member(family_id))
--   home_assets_insert  FOR INSERT WITH CHECK (is_family_member(family_id))
--   home_assets_update  FOR UPDATE USING/CHECK(is_family_member(family_id))
--   home_assets_delete  FOR DELETE USING      (is_family_member(family_id))
--
-- The application disagrees with that in three independent places, all in
-- components/modules/home-module.tsx, which computes `const manager =
-- isManager(role)` at :79 and then:
--
--   :207      renders "Add Asset" only `{manager && (...)}`
--   :344      renders the per-asset delete button only `{manager && (...)}`
--   :467-468  renders the warranty_until field `disabled={!manager}` and hides
--             the Save button unless `manager` — `manager` is threaded into
--             WarrantyModal at :370/:380 deliberately, for this one purpose
--
-- There is no server action for asset create/update/delete at all. All three
-- writes are issued from the browser on the caller's own RLS-bound
-- `createClient()`, so a hidden button is the entire boundary. A server action
-- would not have been one either — children have real logins, and a request to
-- /rest/v1/home_assets never passes through app/ — but here there is not even
-- that. The rule exists only in JSX.
--
-- ── Measured, on the replayed database, inside BEGIN … ROLLBACK ─────────────
--
-- Acting as a `child` member of a seeded family via
--   set_config('role','authenticated',true)
--   set_config('request.jwt.claim.sub','…a55e2',true)
-- WHOAMI confirmed current_user=authenticated, is_family_member=t,
-- can_manage_family=f. Grants were checked first so a block could only be RLS:
-- `authenticated` holds SELECT, INSERT, UPDATE and DELETE on the table.
--
--   PRE-FIX child asset INSERT ............................ SUCCEEDED
--   PRE-FIX child warranty_until UPDATE ................... 1 row
--   PRE-FIX child last_serviced_on UPDATE (legitimate) .... 1 row
--   docs_for_asset BEFORE delete .......................... 1
--   PRE-FIX child asset DELETE ............................ 1 row
--   manual documents row AFTER delete ..................... 0
--   asset survives AFTER delete ........................... 0
--
-- The last three lines are the sharp end. `home_assets` has no `deleted_at`
-- column, so a child's DELETE is a hard delete, and 0007 declared
-- `documents.asset_id … ON DELETE CASCADE`: the attached manual's row went with
-- the appliance. (`home_warranties.asset_id`, `home_service_records.asset_id`
-- and `maintenance_tasks.asset_id` are ON DELETE SET NULL, so the warranty and
-- the service history survive but lose their link to the thing they describe.)
--
-- ── Consequence, sized honestly ─────────────────────────────────────────────
--
-- Not an escalation into another family's data — family scoping holds
-- throughout — and not money. Two real effects:
--
--   (a) forged rows ARE read by screens, not merely stored: the Home &
--       Maintenance list (home-module.tsx:90), /dashboard/home/assets/[id],
--       the digital-twin projection (lib/twin/project-server.ts:87 →
--       lib/twin/project.ts:323), the purchases advisor
--       (lib/services/purchases/index.ts:55) and AI insights
--       (app/api/ai/insights/route.ts:316). A planted "Gaming PC, $9,999.99"
--       is treated as a real household asset by the family and the assistant.
--   (b) delete is irreversible, and takes the DB rows for the asset's uploaded
--       manuals and warranty PDFs with it.
--
-- ── Every writer of `home_assets`, enumerated by bare table name ────────────
--
-- across app/, lib/, components/, hooks/, mobile/, scripts/ and supabase/.
-- FIVE application writers, ALL on the caller's own RLS-bound client. There is
-- NO createServiceClient() / service-role writer of this table anywhere in the
-- application:
--
--   1. components/modules/home-module.tsx:547   INSERT, browser createClient()
--      — UI-gated by `manager` at :207.
--   2. components/modules/home-module.tsx:180   DELETE, browser createClient()
--      — UI-gated by `manager` at :344.
--   3. components/modules/home-module.tsx:399   UPDATE warranty_until, browser
--      createClient() — field disabled and Save hidden when !manager.
--   4. app/(app)/dashboard/home/actions.ts:129  UPDATE last_serviced_on, on the
--      caller's own server client (ctx() → createServer()). NO role gate. Any
--      member reaches it from /dashboard/home/service, a page gated only by
--      requirePlanLevel(1); components/home/service-client.tsx has no role
--      check at all.
--   5. lib/services/home/index.ts:367           UPDATE last_serviced_on, on
--      `scope.db` — the caller's own client. NO role gate. Reached by the AI
--      tool home.createServiceRecord (lib/ai/tools/home.ts), capability
--      'create', which ROLE_DEFAULTS grants to `child`; home_maintenance is
--      not in a child's sensitiveDomains (lib/trust/engine.ts).
--
-- Everything else that names the table is a SELECT: lib/home/queries.ts:26,
-- lib/home/asset-detail.ts:345, lib/twin/project-server.ts:87,
-- lib/services/purchases/index.ts:55, app/api/ai/insights/route.ts:316,
-- lib/services/home/index.ts:272 and :496,
-- app/(app)/dashboard/home/actions.ts:150. scripts/seed*.mjs and
-- supabase/seed*.sql are service-role seeding scripts, not request paths.
--
-- ── Why THIS guard shape, and not a blanket manager-only rule ───────────────
--
-- This is the CENSUS-002 line, and it is not hypothetical here. Writers 4 and 5
-- are legitimate non-manager writers on their own client: a child who logs a
-- service visit, from the page or through the assistant, updates
-- `last_serviced_on`. A blanket manager-only UPDATE policy would have returned
-- 42501 for every child who ever logged a visit — exactly the mistake that
-- autopilot_suggestions was. So UPDATE is NOT made manager-only.
--
-- Instead, three guards of three different shapes, each cut to its writer:
--
--   INSERT  restrictive policy, manager-only. Writer 1 is the only one, and it
--           is UI-gated to managers.
--   DELETE  restrictive policy, manager-only. Writer 2 is the only one, and it
--           is UI-gated to managers.
--   UPDATE  a BEFORE UPDATE trigger, not a policy: a non-manager may change
--           `last_serviced_on` and nothing else.
--
-- UPDATE needs a trigger because neither alternative can express the rule. An
-- RLS WITH CHECK sees only the NEW row, so it cannot ask which column CHANGED;
-- and column-level GRANTs are per database role, while every member — parent
-- and child alike — arrives as `authenticated`. A trigger is the only place
-- that holds OLD and NEW at once.
--
-- The trigger compares the whole row minus `last_serviced_on` and minus the
-- `updated_at` housekeeping stamp that trg_set_updated_at maintains. Comparing
-- the whole row rather than listing the manager-only columns means a column
-- added to this table in future is manager-only until someone decides
-- otherwise, which is the safe direction to fail.
--
-- RESTRICTIVE for the reason 0254 gives and 0310/0318/0322/0323/0325 restate: a
-- restrictive policy ANDs with the union of the permissive ones, so no later
-- `FOR ALL` can grant past it, and 0004's policies stay exactly as 0004 wrote
-- them for the source-level ratchets that read them.
--
-- ── What does NOT change ────────────────────────────────────────────────────
--
--   * READS. `home_assets_select` is untouched. Every member still sees every
--     asset — that is what the list, the detail page, the twin, the purchases
--     advisor and AI insights all render, and narrowing SELECT would blank a
--     child's Home page in order to fix a write.
--   * A member logging a service visit. Writers 4 and 5 keep working, from the
--     page and from the assistant. This is asserted in both the probe and the
--     closing check, not assumed.
--   * The service role and anything running without an authenticated session —
--     seeds, migrations, service-client code. The restrictive policies are
--     `TO authenticated`, and the trigger exempts them explicitly.
--   * `anon` keeps SELECT. Only its write grants go, for 0290's reason: these
--     guards are `TO authenticated` and are simply absent for an anonymous
--     request, so the grant layer is where anon is answered.
--
-- ── Two side effects, disclosed rather than discovered later ────────────────
-- Both found by an adversarial re-check of this migration on the replayed
-- database, and both judged not blocking. Written down because the next reader
-- meeting either one deserves to find it here rather than infer it.
--
--   1. The BEFORE UPDATE trigger also fires on FOREIGN KEY REFERENTIAL
--      ACTIONS. `home_assets.home_id` is `ON DELETE SET NULL`, and the
--      RI-driven UPDATE runs under the CALLER's identity, so a non-manager
--      deleting a `homes` row now gets 42501 with this trigger's message,
--      which names an asset rather than a home. Measured: as a child,
--      `delete from public.homes where id = …` -> 42501; as the parent, 1 row.
--      Sized honestly — NO application path writes `homes` at all (the only
--      two references in the tree are SELECTs, in lib/ai/context/slices/home.ts
--      and lib/twin/project-server.ts) and the table carries `deleted_at`, so
--      nothing in the product hard-deletes a home. What this incidentally
--      closes is a REST-only path, with a misleading error string.
--      The sibling FK is SAFE and was checked: deleting an `auth.users` row
--      that is `created_by` on an asset still succeeds, because GoTrue runs as
--      `supabase_auth_admin` with no JWT claims and the trigger's
--      `auth.uid() is null` clause exempts it.
--   2. A non-manager UPSERT that touches ONLY `last_serviced_on` is refused,
--      because a restrictive INSERT `WITH CHECK` is also applied to the
--      `ON CONFLICT DO UPDATE` path. Latent: no writer in the tree upserts
--      this table. Measured as a child:
--      `insert … on conflict (id) do update set last_serviced_on = excluded…`
--      -> 42501, while the plain UPDATE of the same column succeeds.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent, and guarded by to_regclass so it no-ops on a tree without the
-- table.

-- ── 1 & 2. INSERT and DELETE are a manager's ────────────────────────────────
do $$
begin
  if to_regclass('public.home_assets') is null then
    return;
  end if;

  drop policy if exists home_assets_manager_insert_guard on public.home_assets;
  create policy home_assets_manager_insert_guard on public.home_assets
    as restrictive for insert to authenticated
    with check (public.can_manage_family(family_id));

  drop policy if exists home_assets_manager_delete_guard on public.home_assets;
  create policy home_assets_manager_delete_guard on public.home_assets
    as restrictive for delete to authenticated
    using (public.can_manage_family(family_id));
end
$$;

-- ── 3. UPDATE: last_serviced_on is the member's, the rest is the manager's ──
do $$
begin
  if to_regclass('public.home_assets') is null then
    return;
  end if;

  create or replace function public.home_asset_manager_field_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $guard$
  begin
    -- The member's half: a service visit moves `last_serviced_on` and nothing
    -- else. `updated_at` is excluded because trg_set_updated_at maintains it,
    -- not the caller. Everything else on the row — name, brand, model,
    -- purchase_price, warranty_until, condition, family_id, … — is compared,
    -- so a column added to this table later is manager-only by default.
    if to_jsonb(new) - 'last_serviced_on' - 'updated_at'
       is not distinct from
       to_jsonb(old) - 'last_serviced_on' - 'updated_at' then
      return new;
    end if;

    -- The trusted server: service role, or a migration/seed/backfill running
    -- without an authenticated session. RLS policies skip these; a trigger does
    -- not, so it has to say so itself.
    if current_user = 'service_role'
       or coalesce(auth.role(), '') = 'service_role'
       or auth.uid() is null then
      return new;
    end if;

    -- A manager of the family the row is in, and of the family it is moving to
    -- if those differ — otherwise a manager of B could pull A's furnace into B.
    if public.can_manage_family(old.family_id)
       and public.can_manage_family(new.family_id) then
      return new;
    end if;

    raise exception
      'only a family manager may change a home asset beyond its last_serviced_on date'
      using errcode = '42501';
  end;
  $guard$;

  comment on function public.home_asset_manager_field_guard() is
    'Guards home_assets UPDATE (0336). The application states a manager-only rule over assets in components/modules/home-module.tsx (Add :207, Delete :344, warranty_until disabled={!manager} :467), but two legitimate NON-manager writers update this table on the caller''s own client: saveServiceRecordAction (app/(app)/dashboard/home/actions.ts:129) and lib/services/home/index.ts:367, behind the child-allowed AI tool home.createServiceRecord. A manager-only UPDATE policy would therefore 42501 every child who logs a service visit, so UPDATE is guarded by column instead: a non-manager may move last_serviced_on and nothing else. INSERT and DELETE have no legitimate non-manager writer and are restrictive manager-only policies.';

  drop trigger if exists trg_home_asset_manager_field_guard on public.home_assets;
  create trigger trg_home_asset_manager_field_guard
    before update on public.home_assets
    for each row execute function public.home_asset_manager_field_guard();
end
$$;

-- `anon` is never a family member, so it has no business writing this table at
-- all; the guards above are `TO authenticated` and would simply be absent for
-- an anonymous request. SELECT is left untouched.
revoke insert, update, delete, truncate on public.home_assets from anon;

-- A migration that silently created nothing is worse than one that failed: the
-- probe would be asserting a boundary that only looks present.
do $$
begin
  if to_regclass('public.home_assets') is null then
    raise notice '0336: no public.home_assets in this tree — nothing to guard.';
    return;
  end if;

  if has_table_privilege('anon', 'public.home_assets', 'INSERT') then
    raise exception '0336: anon still holds INSERT on home_assets';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'home_assets'
      and permissive = 'RESTRICTIVE' and cmd = 'INSERT'
      and policyname = 'home_assets_manager_insert_guard'
  ) then
    raise exception '0336: the restrictive INSERT guard on home_assets was not created';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'home_assets'
      and permissive = 'RESTRICTIVE' and cmd = 'DELETE'
      and policyname = 'home_assets_manager_delete_guard'
  ) then
    raise exception '0336: the restrictive DELETE guard on home_assets was not created';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.home_assets'::regclass
      and tgname = 'trg_home_asset_manager_field_guard'
      and not tgisinternal
  ) then
    raise exception '0336: the home_assets UPDATE field guard was not created';
  end if;

  -- The whole point of the trigger is the carve-out. If it ever stops naming
  -- last_serviced_on it has become the blanket rule this migration refuses.
  if (select prosrc from pg_proc where proname = 'home_asset_manager_field_guard') not like '%last_serviced_on%' then
    raise exception '0336: the UPDATE guard no longer exempts last_serviced_on — a child logging a service visit would break';
  end if;

  raise notice '0336 OK: a manager adds and bins an asset and owns every field of it but last_serviced_on, which any member still writes when they log a service visit.';
end
$$;
