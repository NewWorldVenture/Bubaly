-- Bubaly :: 0325 - the dashboard settings, the layouts and the digital twin
--
-- Three tables from the same census as 0322/0323, all three carrying their
-- origin migration's permissive `FOR ALL TO authenticated USING
-- (is_family_member(family_id))`. Two are straight manager surfaces. The third
-- is NOT, and getting that one wrong would take a feature away from the people
-- it was built for — so it gets a narrower rule rather than the same stamp.
--
-- ── 1. family_digital_twin_profiles — manager-only, stated twice ────────────
--
-- lib/family/actions.ts carries
--
--   // Sensitive surfaces only managers (parent/adult) may modify.
--   const MANAGER_ONLY = new Set([… 'family_digital_twin_profiles' ]);
--
-- and refuses a non-manager on create, update and delete; lib/services/memory/
-- index.ts gates `resetMemberTraits` on `canManage(scope)`; and app/(app)/
-- dashboard/family-digital-twin/page.tsx renders the QuickAdd form only
-- `if (manager)`. Three statements of the rule, none of them in the database.
--
-- The row holds `strengths`, `notes`, `ai_insights`, `stress_baseline`,
-- `responsibilities` and `preferences` — read by `loadFamilyContext` and handed
-- to the AI surfaces as what Bubaly knows about a person. A child writing their
-- own `ai_insights` is editing the brief every assistant answer is built from,
-- and a child writing a SIBLING's is worse. Measured as a child of the family
-- on a replayed database: `update family_digital_twin_profiles set ai_insights
-- = …` -> UPDATE 1.
--
--   One honest cost, stated rather than discovered later. lib/autopilot/scan.ts
--   also touches this table — it merges `metadata.autopilot_traits` for each
--   member — and POST /api/autopilot/scan runs that pass on the CALLER's
--   RLS-bound client, which any entitled member may trigger. Those writes are
--   explicitly best-effort in the code (`if (updateError) console.error(…)`,
--   inside a try/catch commented "non-fatal: trait persistence is an
--   enhancement, not required for the scan"), so a scan a child triggers still
--   completes; it just no longer persists learned traits. The nightly cron
--   (app/api/cron/autopilot-scan/route.ts) runs the same pass on the SERVICE
--   client, which bypasses RLS, so the traits are still learned. That is the
--   whole of the change in behaviour and it is a degradation of an enhancement,
--   not a broken flow.
--
-- ── 2. family_dashboard_settings — the flags the gate itself reads ──────────
--
-- `saveDashboardSettingsAction` (app/(app)/dashboard/customize-actions.ts) is
-- the only writer and opens `if (!isManager(ctx.active.role))`. The row holds
-- exactly two things: `allow_child_customization` and `lock_to_family_default`.
--
-- Those are the flags `canCustomizeDashboard(isManager, settings)` consults
-- before letting anyone save a personal layout. A child who can write this row
-- does not have to break the customization rule — they can simply turn it off:
--
--   update family_dashboard_settings
--      set allow_child_customization = true, lock_to_family_default = false
--                                                              -> UPDATE 1
--
-- and the parent's decision is gone. A permission flag stored where the subject
-- of the permission can write it is not a permission flag.
--
-- ── 3. dashboard_layouts — NOT a manager table, and must not become one ─────
--
-- The same file's `saveFamilyDefaultLayoutAction` and `resetAllLayoutsAction`
-- ARE manager-only. `saveDashboardLayoutAction` and `resetDashboardLayoutAction`
-- are NOT: they are gated by `canCustomizeDashboard(isManager(role), settings)`,
-- which a family may leave open to children on purpose — that is the feature.
--
-- The table separates the two cases itself. `scope` is 'family' or 'user'
-- (CHECK constraint, 0195), the family default is written as
-- `{ scope: 'family', user_id: null }` and a personal layout as
-- `{ scope: 'user', user_id: <the signed-in user> }`, deduped by the
-- `(family_id, user_id, device_context) NULLS NOT DISTINCT` index. So the rule
-- the application actually states is:
--
--   scope = 'family'  -> a manager
--   scope = 'user'    -> a manager (resetAllLayoutsAction clears everyone's),
--                        or the member whose own row it is
--
-- and that is what the guard below says. A blanket `can_manage_family` here
-- would stop a teen arranging their own home screen, which is not a defect
-- anyone reported — it is the product.
--
-- Two things this guard deliberately does NOT encode. It does not consult
-- `allow_child_customization` / `lock_to_family_default`: those are a live
-- product setting rather than an authorization boundary, and when a family is
-- locked `effectiveSavedKeys` (lib/dashboard/permissions.ts) returns the FAMILY
-- keys regardless of any personal row, so a personal row written while locked
-- changes nothing that renders. And it does not pin `created_by`/`updated_by`;
-- what matters here is whose layout the row IS, which is `user_id`.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- Reads, on all three. components/dashboard/ai-home-dashboard.tsx reads
-- `dashboard_layouts` for the whole family in one query (both scopes) and picks
-- the caller's row client-side, and reads `family_dashboard_settings` on the
-- same RLS-bound client; `familyDashSettings()` in customize-actions.ts does
-- the same before deciding whether to allow a save; /dashboard/family-digital-
-- twin renders every member's profile to every member. Narrowing SELECT on any
-- of them would blank a page for a child in order to fix a write. Only writes
-- move.
--
-- RESTRICTIVE for the reason 0254 gives and 0310/0318/0322/0323 restate: a
-- restrictive policy ANDs with the union of the permissive ones, so no later
-- `FOR ALL` can grant past it. `anon`'s writes are revoked for 0290's reason —
-- these guards are `TO authenticated` and are simply absent for an anonymous
-- request. SELECT is left alone.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

-- ── the two straight manager tables ─────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['family_digital_twin_profiles', 'family_dashboard_settings'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated '
      || 'with check (public.can_manage_family(family_id))', t || '_manager_insert_guard', t);

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

-- ── dashboard_layouts: the family default is a manager's, your own is yours ─
do $$
begin
  if to_regclass('public.dashboard_layouts') is null then
    return;
  end if;

  drop policy if exists dashboard_layouts_scope_insert_guard on public.dashboard_layouts;
  create policy dashboard_layouts_scope_insert_guard on public.dashboard_layouts
    as restrictive for insert to authenticated
    with check (
      public.can_manage_family(family_id)
      or (scope = 'user' and user_id = auth.uid())
    );

  -- Both halves again: USING decides which rows a member may touch, WITH CHECK
  -- what they may leave behind — without it a member could hand their own row
  -- to `scope = 'family'` and become the family default.
  drop policy if exists dashboard_layouts_scope_update_guard on public.dashboard_layouts;
  create policy dashboard_layouts_scope_update_guard on public.dashboard_layouts
    as restrictive for update to authenticated
    using (
      public.can_manage_family(family_id)
      or (scope = 'user' and user_id = auth.uid())
    )
    with check (
      public.can_manage_family(family_id)
      or (scope = 'user' and user_id = auth.uid())
    );

  -- resetDashboardLayoutAction removes the caller's own row; resetAllLayoutsAction
  -- removes every member's, and is manager-only in the application.
  drop policy if exists dashboard_layouts_scope_delete_guard on public.dashboard_layouts;
  create policy dashboard_layouts_scope_delete_guard on public.dashboard_layouts
    as restrictive for delete to authenticated
    using (
      public.can_manage_family(family_id)
      or (scope = 'user' and user_id = auth.uid())
    );
end
$$;

revoke insert, update, delete, truncate on public.family_digital_twin_profiles from anon;
revoke insert, update, delete, truncate on public.family_dashboard_settings    from anon;
revoke insert, update, delete, truncate on public.dashboard_layouts            from anon;

do $$
declare
  open_tables text[];
  missing     text[];
  tbls constant text[] := array[
    'family_digital_twin_profiles', 'family_dashboard_settings', 'dashboard_layouts'
  ];
begin
  select array_agg(t order by t) into open_tables
  from unnest(tbls) as t
  where has_table_privilege('anon', 'public.' || t, 'INSERT');
  if open_tables is not null then
    raise exception '0325: anon still holds INSERT on: %', open_tables;
  end if;

  select array_agg(t order by t) into missing
  from unnest(tbls) as t
  where not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = t
      and permissive = 'RESTRICTIVE' and cmd = 'UPDATE'
      and policyname in (t || '_manager_update_guard', 'dashboard_layouts_scope_update_guard')
  );
  if missing is not null then
    raise exception '0325: restrictive write guard missing on: %', missing;
  end if;

  raise notice '0325 OK: the twin and the dashboard settings are manager-written; a layout is a manager''s or its own owner''s.';
end
$$;
