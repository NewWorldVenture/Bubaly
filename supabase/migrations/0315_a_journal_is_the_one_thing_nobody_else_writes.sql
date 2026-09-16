-- ============================================================================
-- 0315 — a journal is the one thing nobody else writes
--
-- `journal_entries` resolves to a single policy:
--
--     "Members manage journal_entries"  FOR ALL
--       using      (is_family_member(family_id))
--       with check (is_family_member(family_id))
--
-- so every member of a household can read, edit, DELETE and FORGE every other
-- member's journal. The module is a `'use client'` component talking to
-- PostgREST with the anon key, so there is no server action in front of it and
-- RLS is the only boundary there is.
--
-- TWO PLACES IN THIS CODEBASE ALREADY CALL THIS DATA PRIVATE, and neither is
-- the database:
--
--   components/modules/journal-module.tsx:3
--     "Personal Journal — private reflection + growth … scoped to the
--      signed-in member."
--   lib/ai/context/policy.ts:69
--     { table: 'journal_entries', reason: 'private journals' }
--
-- The same shape this whole sweep keeps finding: a boundary stated where a
-- reader can see it and absent from the layer that enforces it.
--
-- The two writes that need no product decision:
--
--   * DELETE. `journal-module.tsx:47` deletes by id alone —
--     `.delete().eq('id', id)` — with no author check of any kind, exactly like
--     the locator check-in `remove(id)` that 0324 closed. The policy is the only
--     gate and it says any member may delete any entry.
--   * INSERT. `with check (is_family_member(family_id))` does not pin
--     `member_id`, so a child can write an entry INTO a parent's journal.
--
-- Not touched: SELECT. Whether a parent may read a young child's journal is a
-- household policy question, not a defect, and it is filed rather than guessed
-- — see audit/claude-1.md. Worth recording for whoever decides it: BOTH readers
-- in the product already scope to the signed-in member
-- (`journal-module.tsx:52` and `app/api/ai/journal/route.ts:30`, each
-- `.eq('member_id', …)`), so narrowing SELECT to self would be a no-op for
-- every code path that exists today. The only question is whether a manager
-- should keep oversight.
--
-- "Self" is spelled DIFFERENTLY for insert than for update/delete, and the
-- difference is the whole point.
--
-- Both columns are nullable, and `is_self_member(null)` is false, so keying on
-- `member_id` alone would strand a legacy row that has none — un-editable and
-- un-deletable by anybody. 0324 solved that for `safety_check_ins` with
-- `is_self_member(member_id) or created_by = auth.uid()`.
--
-- That disjunction is WRONG here, and the probe caught it on the first run: on
-- INSERT a child sets `member_id` to the parent and `created_by` to themselves,
-- the second branch is true, and the forged entry lands in the parent's journal
-- — the exact hole the rule was written to close. `created_by` describes who
-- typed it; `member_id` describes whose journal it is, and only the second one
-- is the question being asked.
--
-- So: INSERT demands BOTH (it is yours, and you are writing it). UPDATE and
-- DELETE take the disjunction, where it is safe — it can only widen to rows the
-- caller themselves created, and it is the only thing that reaches a row whose
-- `member_id` is null.
-- ============================================================================

do $$
declare
  -- Whose journal it is. The only question INSERT should ask.
  mine      text := 'public.is_self_member(member_id)';
  -- …widened, for update and delete only, to reach a legacy row with no
  -- member_id. It can only ever admit a row the caller created.
  mine_or_orphan text := '(public.is_self_member(member_id) '
                      || 'or (member_id is null and created_by = auth.uid()))';
begin
  execute 'alter table public.journal_entries enable row level security';

  -- The single FOR ALL policy is replaced by one policy per command, so the
  -- read can stay family-wide while the writes narrow.
  execute 'drop policy if exists "Members manage journal_entries" on public.journal_entries';

  execute 'drop policy if exists journal_entries_read on public.journal_entries';
  execute 'create policy journal_entries_read on public.journal_entries '
       || 'for select to authenticated using (public.is_family_member(family_id))';

  -- A journal entry is written as yourself, about yourself.
  execute 'drop policy if exists journal_entries_insert on public.journal_entries';
  execute format(
    'create policy journal_entries_insert on public.journal_entries '
    || 'for insert to authenticated '
    || 'with check (public.is_family_member(family_id) and %s and created_by = auth.uid())', mine);

  -- USING and WITH CHECK are the SAME expression on purpose. 0311 exists
  -- because an UPDATE policy that guards the row you may touch and not the row
  -- you turn it into lets you rewrite `member_id` and hand the entry to someone
  -- else — or take theirs.
  execute 'drop policy if exists journal_entries_update on public.journal_entries';
  execute format(
    'create policy journal_entries_update on public.journal_entries '
    || 'for update to authenticated using (public.is_family_member(family_id) and %s) '
    || 'with check (public.is_family_member(family_id) and %s)', mine_or_orphan, mine_or_orphan);

  execute 'drop policy if exists journal_entries_delete on public.journal_entries';
  execute format(
    'create policy journal_entries_delete on public.journal_entries '
    || 'for delete to authenticated using (public.is_family_member(family_id) and %s)', mine_or_orphan);
end $$;

-- ── The sweep, by shape ─────────────────────────────────────────────────────
-- No permissive write policy may survive on this table that is not one of the
-- three above. Narrowing by NAME is how 0217 left six wallet tables behind.
do $$
declare
  stray text;
begin
  select string_agg(p.polname, ', ') into stray
  from pg_policy p
  where p.polrelid = 'public.journal_entries'::regclass
    and p.polpermissive
    and p.polcmd in ('a', 'w', 'd', '*')
    and p.polname not in ('journal_entries_insert', 'journal_entries_update', 'journal_entries_delete');

  if stray is not null then
    raise exception '0315: a permissive write policy still stands on journal_entries: %', stray;
  end if;
end $$;
