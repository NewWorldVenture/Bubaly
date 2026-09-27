-- Bubaly :: 0416 - a private journal, and the insurance table that lost its twin
--
-- Two tables, one shape: the intent is written down in several places and the
-- policy does not carry any of it.
--
-- ── journal_entries ─────────────────────────────────────────────────────────
--
-- The product calls this "Personal Journal — private reflection". The module's
-- header says "scoped to the signed-in member". Its fetcher says
-- `.eq('member_id', memberId)`. And 0087 gave the table a column for it:
--
--   is_private boolean NOT NULL DEFAULT true
--
-- Four statements of intent, and the only policy is
--
--   CREATE POLICY "Members manage journal_entries" ON public.journal_entries
--     FOR ALL TO authenticated USING (public.is_family_member(family_id))
--                              WITH CHECK (public.is_family_member(family_id));
--
-- `is_private` is referenced NOWHERE in the application — not in a query, not
-- in a filter, not in a control. A grep of app/, components/ and lib/ returns
-- nothing. Every row is marked private by default and nothing honours it.
--
-- So the member scoping is a QUERY FILTER, not a boundary. One PostgREST call
-- reads every journal in the family, and edits or deletes them. Measured as a
-- signed-in child on a replayed schema: read a sibling's entry, rewrote it,
-- deleted it, and wrote a new one in the sibling's name.
--
-- This migration makes the column mean what it says. SELECT is self, OR a
-- family MANAGER when `is_private` is false — the owner-or-manager design
-- lib/trust/sharing-presets.ts records for M23, and the shape main's 0364
-- landed first for this table (docs/audit/private-journal-check.sql pins it: a
-- sibling never reads another member's entry, private or not; a parent reads
-- only an entry its owner marked not private). Until something sets the flag,
-- the effective rule is self-only, which is exactly what the UI has always
-- shown.
--
-- A private entry is NOT a parent's window. Whether a guardian should be able
-- to read a child's private journal is a real question about a real family,
-- and it belongs to whoever owns the product, not to this file; the flag is the
-- owner's deliberate act, and the probe asserts the parent is refused without
-- it.
--
-- `member_id` is nullable and self-insert now requires it. An entry with no
-- member was already invisible — the module's own fetcher matches on
-- `member_id`, so such a row could never be read back by anyone. Refusing to
-- write one is stricter than before and better than succeeding at nothing.
--
-- ── family_insurance_policies ───────────────────────────────────────────────
--
-- It holds `policy_number`, `premium_amount`, `agent_phone`, `claim_phone` and
-- `document_path`, and it is `FOR ALL … is_family_member`. Its twin
-- `insurance_policies` — the same class of data, named on the same deny-list
-- line in lib/ai/context/policy.ts, written from medical-records-module.tsx —
-- has had manager-gated INSERT/UPDATE/DELETE all along.
--
-- Two tables of policy numbers; one of them protected. This is the third time
-- this series has found that exact pattern (0309 → medications vs its
-- neighbours; 0414 → the structured immunization ledger vs the free-text blob
-- it replaced), and the fix is the same each time: make them agree, in the
-- direction of the one that is already guarded. `insurance-module.tsx` carries
-- no role check of any kind, so the UI half ships with this migration.
--
-- Reading stays family-wide on both, exactly as `insurance_policies` already
-- does. Additive and idempotent. Audit C1-S8-07.

-- ── journal_entries — an entry belongs to whoever wrote it ──────────────────
alter table public.journal_entries enable row level security;

-- Permissive policies are OR'd; the FOR ALL policy has to go or every rule
-- below it is decoration.
drop policy if exists "Members manage journal_entries" on public.journal_entries;
drop policy if exists journal_entries_select on public.journal_entries;
drop policy if exists journal_entries_insert on public.journal_entries;
drop policy if exists journal_entries_update on public.journal_entries;
drop policy if exists journal_entries_delete on public.journal_entries;

create policy journal_entries_select on public.journal_entries
  for select to authenticated
  using (
    public.is_family_member(family_id)
    and (
      public.is_self_member(member_id)
      -- The column, finally load-bearing: an entry its owner marked not private
      -- is readable by a family MANAGER — not by a sibling — which is 0364's
      -- rule and main's probe's. Nothing sets it false today, so this branch
      -- grants nothing yet and is here so sharing an entry is a feature rather
      -- than a migration.
      or (is_private = false and public.can_manage_family(family_id))
    )
  );

create policy journal_entries_insert on public.journal_entries
  for insert to authenticated
  with check (
    public.is_family_member(family_id)
    and public.is_self_member(member_id)
    and exists (
      select 1 from public.family_members m
       where m.id = journal_entries.member_id and m.family_id = journal_entries.family_id
    )
  );

-- `using` AND `with check`. C1-S6-08's lesson: an ownership test in `using`
-- alone governs the row you started from. The predicate reads `member_id`,
-- which is the column an attacker would change, so `with check` is what refuses
-- handing your entry to somebody else.
create policy journal_entries_update on public.journal_entries
  for update to authenticated
  using (public.is_self_member(member_id))
  with check (
    public.is_self_member(member_id)
    and public.is_family_member(family_id)
  );

create policy journal_entries_delete on public.journal_entries
  for delete to authenticated
  using (public.is_self_member(member_id));

-- ── family_insurance_policies — agreeing with its twin ──────────────────────
alter table public.family_insurance_policies enable row level security;

drop policy if exists "Members manage family_insurance_policies" on public.family_insurance_policies;
drop policy if exists family_insurance_policies_select on public.family_insurance_policies;
drop policy if exists family_insurance_policies_insert on public.family_insurance_policies;
drop policy if exists family_insurance_policies_update on public.family_insurance_policies;
drop policy if exists family_insurance_policies_delete on public.family_insurance_policies;

create policy family_insurance_policies_select on public.family_insurance_policies
  for select to authenticated
  using (public.is_family_member(family_id));

create policy family_insurance_policies_insert on public.family_insurance_policies
  for insert to authenticated
  with check (public.can_manage_family(family_id));

create policy family_insurance_policies_update on public.family_insurance_policies
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

create policy family_insurance_policies_delete on public.family_insurance_policies
  for delete to authenticated
  using (public.can_manage_family(family_id));
