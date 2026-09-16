-- ============================================================
-- Migration 0313: the household binder's "sensitive" flag reaches the database
--
-- `household_info` is the family binder — wifi passwords, alarm codes, gate
-- codes, meter numbers. The table carries `is_sensitive boolean` and the UI
-- honours it: components/modules/binder-module.tsx masks such a value behind an
-- eye toggle, labelled "Mask by default".
--
-- The mask is the only thing that was honouring it. The policy was a single
--
--     "Members manage household_info"  FOR ALL  USING is_family_member(family_id)
--
-- so the raw row came back to every member — children included — through the
-- browser's anon client. The eye toggle hides a value the client already holds.
-- Measured against a replayed schema, a child read
-- `Home wifi password = hunter2-alarm-4417` in the clear.
--
-- `lib/ai/context/policy.ts` lists this table with the reason "rows flagged
-- is_sensitive (alarm codes, wifi keys)", so the intent is written down in two
-- places — a column and a policy list — and enforced in neither.
--
-- THIS IS 0266's SHAPE, AND ITS ARGUMENT. That migration put the document
-- vault's sensitivity predicate into the database because "the Files and
-- Documents modules query through the browser anon client and never reach" the
-- service that filtered correctly. Identical here, and this one is simpler:
-- there is no category list to mirror, because the family sets the flag itself.
--
-- BOTH HALVES MATTER, for 0266's reason. `using` stops a non-manager reading or
-- touching a row that is already sensitive; `with check` stops them writing a
-- row INTO or OUT OF that state — without it a child could clear the flag,
-- read the value, and set it back.
--
-- An ordinary binder row is untouched: any member still reads, adds and edits
-- the bin day. Only the rows the family marked sensitive become manager-only.
--
-- Audit C1-S6-06.
-- ============================================================

alter table public.household_info enable row level security;

drop policy if exists "Members manage household_info" on public.household_info;

drop policy if exists household_info_select on public.household_info;
create policy household_info_select on public.household_info
  for select using (
    public.is_family_member(family_id)
    and (not is_sensitive or public.can_manage_family(family_id))
  );

drop policy if exists household_info_insert on public.household_info;
create policy household_info_insert on public.household_info
  for insert with check (
    public.is_family_member(family_id)
    and (not is_sensitive or public.can_manage_family(family_id))
  );

drop policy if exists household_info_update on public.household_info;
create policy household_info_update on public.household_info
  for update
  using (
    public.is_family_member(family_id)
    and (not is_sensitive or public.can_manage_family(family_id))
  )
  with check (
    public.is_family_member(family_id)
    and (not is_sensitive or public.can_manage_family(family_id))
  );

drop policy if exists household_info_delete on public.household_info;
create policy household_info_delete on public.household_info
  for delete using (
    public.is_family_member(family_id)
    and (not is_sensitive or public.can_manage_family(family_id))
  );
