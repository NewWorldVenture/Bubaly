-- Bubaly :: 0329 - a record ABOUT someone is not that person's to rewrite
--
-- Two tables whose own schemas separate the SUBJECT from the AUTHOR, and whose
-- policies know about neither. They need DIFFERENT fixes, and the reason they
-- differ is written into each table's own header.
--
-- ── behavior_logs (0073) — a parenting tool ─────────────────────────────────
--
-- The column comments say it outright:
--
--   member_id  uuid REFERENCES public.family_members(id) …,  -- the child
--   logged_by  uuid REFERENCES auth.users(id) …
--
-- and the migration header calls it "per-child behavior observations … Powers
-- parenting insights: balance score, trends, streaks, and AI tips." It carries
-- `kind = 'concern'` notes and a signed `points` column.
--
-- Its only policy was `FOR ALL … is_family_member`. Measured as a signed-in
-- child: deleted a "concern" a parent had logged about them, and inserted
-- `points = 99` in their own favour. The `points` column is an invitation to
-- exactly that, and `components/modules/behavior-module.tsx` carried no role
-- check of any kind, so it was not even a hidden button.
--
-- Manager-gated writes, by 0254's restrictive mechanism and 0309's shape. This
-- is the same call 0309 made for prescriptions and 0326 for the vaccination
-- ledger: the record is an adult's observation, and the person observed is not
-- its author.
--
-- ── care_log (0032) — a shared family log ───────────────────────────────────
--
-- This one is NOT the manager class, and treating it as one would break the
-- feature. 0032's header says the log exists "so the whole family can see who
-- last checked in and how they're doing", so family-wide reads AND family-wide
-- inserts are the stated intent — any sibling may record a visit to a
-- grandparent, and that is the point.
--
-- What is not intended is one member REWRITING another's entry. `logged_by` is
-- documented as "the family member who performed/recorded the care", and an
-- entry whose author or subject can be changed afterwards records nothing.
-- Measured: a child rewrote a sibling's note and wellbeing score, then
-- reassigned its authorship to themselves.
--
-- So care_log gets the 0322/0323 treatment instead — the one this series wrote
-- for marketplace reviews, which is the same problem: a thing written BY
-- somebody, editable BY anybody. UPDATE and DELETE belong to the author, or to
-- a family manager for moderation; `member_id` and `logged_by` are immutable
-- through the shared `public.columns_are_immutable()` trigger, so not even a
-- manager may rewrite who recorded what.
--
-- ── what is deliberately left alone ─────────────────────────────────────────
--
-- READS on both stay family-wide. Whether a child should be able to see the
-- "concern" entries logged about them is a real question about a real family —
-- some households would want that transparency and some would not — and it
-- belongs to whoever owns the product, not to this file. The probe asserts both
-- logs stay readable so the decision has to be made deliberately to change it.
--
-- Additive and idempotent. Audit C1-S8-09.

-- ── behavior_logs — the parent writes it ────────────────────────────────────
do $$
begin
  if to_regclass('public.behavior_logs') is not null then
    drop policy if exists behavior_logs_manager_insert_guard on public.behavior_logs;
    create policy behavior_logs_manager_insert_guard on public.behavior_logs
      as restrictive for insert to authenticated
      with check (public.can_manage_family(family_id));

    drop policy if exists behavior_logs_manager_update_guard on public.behavior_logs;
    create policy behavior_logs_manager_update_guard on public.behavior_logs
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));

    drop policy if exists behavior_logs_manager_delete_guard on public.behavior_logs;
    create policy behavior_logs_manager_delete_guard on public.behavior_logs
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id));
  end if;
end
$$;

-- ── care_log — anyone may add one; it stays the author's ────────────────────
alter table public.care_log enable row level security;

-- Permissive policies are OR'd, so the FOR ALL policy goes first or the rules
-- below it are decoration. (C1-S6-09's lesson.)
drop policy if exists "Members can manage care_log" on public.care_log;
drop policy if exists care_log_select on public.care_log;
drop policy if exists care_log_insert on public.care_log;
drop policy if exists care_log_update on public.care_log;
drop policy if exists care_log_delete on public.care_log;

create policy care_log_select on public.care_log
  for select to authenticated
  using (public.is_family_member(family_id));

-- Unchanged in substance: any family member records care. 0032's whole point.
create policy care_log_insert on public.care_log
  for insert to authenticated
  with check (public.is_family_member(family_id));

create policy care_log_update on public.care_log
  for update to authenticated
  using (
    public.is_self_member(logged_by)
    or public.can_manage_family(family_id)
  )
  with check (public.is_family_member(family_id));

create policy care_log_delete on public.care_log
  for delete to authenticated
  using (
    public.is_self_member(logged_by)
    or public.can_manage_family(family_id)
  );

-- The predicate above reads `logged_by`, so without this a manager — or the
-- author themselves — could satisfy `using`, change `logged_by`, and hand the
-- entry to somebody else. C1-S6-08 was exactly that, and 0321 showed the
-- `with check` mirror of a predicate does not always close it; a trigger does.
drop trigger if exists care_log_authorship_is_immutable on public.care_log;
create trigger care_log_authorship_is_immutable
  before update on public.care_log
  for each row execute function public.columns_are_immutable('member_id', 'logged_by');
