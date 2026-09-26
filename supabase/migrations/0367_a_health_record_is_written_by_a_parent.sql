-- Bubaly :: 0326 - the two health tables 0309 did not reach
--
-- 0309 gated `medications` and `medication_schedules` behind restrictive
-- manager guards and named the class in its own header:
--
--   "This is the shape this series keeps finding — a class fixed where somebody
--    remembered and left open where nobody did."
--
-- It then listed the neighbours it had checked — `medical_profiles`,
-- `health_providers`, `insurance_policies` — and found them already enforced.
-- `immunizations` and `health_visits` are not in that list. Both kept
-- 0068/0069's `FOR ALL TO authenticated USING (is_family_member(family_id))`.
--
-- They are not a distant corner of the product. /dashboard/medical renders
-- MedicalRecordsModule, HealthVisitsModule and ImmunizationsModule one under the
-- other, so the same page carries three panels and two different boundaries: the
-- free-text `medical_profiles.immunizations` blob is manager-only, and the
-- structured `immunizations` ledger that 0069 wrote to REPLACE it is not.
-- `lib/ai/context/policy.ts` names both tables as sensitive — "vaccination
-- records" (line 61) and "visit notes" (line 57).
--
-- And unlike medications, this was never even a hidden button.
-- medications-module.tsx declares `canEdit = isManager(role)`; neither
-- immunizations-module.tsx nor health-visits-module.tsx carries any role check
-- at all, so the Edit and Delete controls render for a child and work.
--
-- Measured on a replayed database, acting as a child of the family:
--   * REWROTE a sibling's mental-health visit `outcome` — the column 0068
--     documents as "diagnosis / what happened / notes";
--   * DELETED that visit outright;
--   * back-dated a sibling's MMR `date_given` and cleared `next_due_date`, which
--     is what `dueStatus()` turns into the overdue badge and what 0069 wrote the
--     table for ("school/camp/travel forms");
--   * DELETED the vaccination record.
--   See docs/audit/health-record-boundary-check.sql.
--
-- ── what is deliberately left open ──────────────────────────────────────────
--
-- Reading. Every family member sees the family health hub; that is the product,
-- and the probe asserts it as a positive control. Per-member READ scoping for
-- these tables is tracked separately as M23 and is a product decision, not this
-- migration's business.
--
-- `medication_doses` — the "I took it" tick — stays writable by any member,
-- exactly as 0309 left it and for 0309's reason. Re-asserted in the probe so
-- this migration cannot quietly take it away.
--
-- Restrictive guards, 0254's mechanism: they AND with the union of the
-- permissive policies, so no permissive policy — present or added later,
-- whatever it is called — can grant past them.

do $$
begin
  if to_regclass('public.immunizations') is not null then
    drop policy if exists immunizations_manager_insert_guard on public.immunizations;
    create policy immunizations_manager_insert_guard on public.immunizations
      as restrictive for insert to authenticated
      with check (public.can_manage_family(family_id));

    drop policy if exists immunizations_manager_update_guard on public.immunizations;
    create policy immunizations_manager_update_guard on public.immunizations
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));

    drop policy if exists immunizations_manager_delete_guard on public.immunizations;
    create policy immunizations_manager_delete_guard on public.immunizations
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id));
  end if;

  if to_regclass('public.health_visits') is not null then
    drop policy if exists health_visits_manager_insert_guard on public.health_visits;
    create policy health_visits_manager_insert_guard on public.health_visits
      as restrictive for insert to authenticated
      with check (public.can_manage_family(family_id));

    drop policy if exists health_visits_manager_update_guard on public.health_visits;
    create policy health_visits_manager_update_guard on public.health_visits
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));

    drop policy if exists health_visits_manager_delete_guard on public.health_visits;
    create policy health_visits_manager_delete_guard on public.health_visits
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id));
  end if;
end
$$;
