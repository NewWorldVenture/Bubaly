-- Bubaly :: 0309 - who may change what a child is told to take
--
-- components/modules/medications-module.tsx declares `canEdit = isManager(role)`
-- and then writes `medications` and `medication_schedules` STRAIGHT FROM THE
-- BROWSER with the viewer's own JWT (lines 205, 216, 223, 236, 251). There is no
-- server action in between. `canEdit` only decides whether a button renders
-- (284, 368, 399, 419), and a hidden button is not a boundary.
--
-- Its neighbours in the same area ARE enforced: `medical_profiles`,
-- `health_providers` and `insurance_policies` each carry three manager-checked
-- write policies. The three medication tables carry none. This is the shape this
-- series keeps finding — a class fixed where somebody remembered and left open
-- where nobody did.
--
-- What these columns reach is not a display. lib/server/notifications.ts reads
-- `medications.{name,dosage,member_id,is_active}` and
-- `medication_schedules.{time_of_day,days_of_week,starts_on,ends_on}` to raise
-- the family's "dose due today" reminder, so these rows decide what a parent is
-- told to administer and when — and `is_active = false` drops the medication
-- from that read entirely, so nobody is told at all.
-- app/api/ai/health/coach/route.ts feeds `dosage` and `instructions` to a model
-- as fact.
--
-- Measured on a replayed database with every migration applied, acting as a
-- child of the family, with both controls passing: the child CHANGED their own
-- prescribed dosage from 10 mg to 40 mg, REWROTE the instructions, DEACTIVATED
-- the medication so the reminder stops, MOVED the dosing schedule to 23:59 one
-- day a week, and DELETED a schedule and a medication outright. See
-- docs/audit/medication-record-boundary-check.sql.
--
-- ── what is deliberately left open ──────────────────────────────────────────
--
-- `medication_doses` — the "I took it" tick — stays writable by any member, and
-- the probe asserts that as a positive control. The module leaves dose logging
-- ungated for everyone (lines 166-172), exactly as a child may tick their own
-- chore done. This migration is about the prescription, not the tick.
--
-- Restrictive guards, 0254's mechanism: they AND with the union of the
-- permissive policies, so no permissive policy — present or added later,
-- whatever it is called — can grant past them.

do $$
begin
  if to_regclass('public.medications') is not null then
    drop policy if exists medications_manager_insert_guard on public.medications;
    create policy medications_manager_insert_guard on public.medications
      as restrictive for insert to authenticated
      with check (public.can_manage_family(family_id));

    drop policy if exists medications_manager_update_guard on public.medications;
    create policy medications_manager_update_guard on public.medications
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));

    drop policy if exists medications_manager_delete_guard on public.medications;
    create policy medications_manager_delete_guard on public.medications
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id));
  end if;

  if to_regclass('public.medication_schedules') is not null then
    drop policy if exists medication_schedules_manager_insert_guard on public.medication_schedules;
    create policy medication_schedules_manager_insert_guard on public.medication_schedules
      as restrictive for insert to authenticated
      with check (public.can_manage_family(family_id));

    drop policy if exists medication_schedules_manager_update_guard on public.medication_schedules;
    create policy medication_schedules_manager_update_guard on public.medication_schedules
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));

    drop policy if exists medication_schedules_manager_delete_guard on public.medication_schedules;
    create policy medication_schedules_manager_delete_guard on public.medication_schedules
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id));
  end if;
end
$$;
