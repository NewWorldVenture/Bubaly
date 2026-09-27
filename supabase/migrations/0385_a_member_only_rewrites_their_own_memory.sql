-- Bubaly :: 0385 - a member only rewrites their own memory
--            (family_facts UPDATE and DELETE get the rule the service applies)
--
-- ── The defect ──────────────────────────────────────────────────────────────
--
-- `lib/services/memory/index.ts factForWrite` and `forgetFact` have carried a
-- member rule since the knowledge module shipped — keyed on `member_id` then,
-- on `member_id` or authorship now (`mayChangeFact`, see "The rule"):
--
--   if (!mayChangeFact(scope, data))
--     return fail('Only a parent or adult can change a memory about someone else.')
--
-- The database did not. 0264_ai_surface_role_privacy.sql narrowed
-- `family_facts` by CATEGORY only:
--
--   family_facts_update  USING/CHECK ( is_family_member(family_id)
--     and (category not in ('medical','account') or can_manage_family(family_id)) )
--   family_facts_delete  USING       ( the same )
--
-- so on the seven ordinary categories — about, preference, contact, sizes,
-- important, date, other — any member of the household may UPDATE or DELETE
-- any row, including the household-level facts (member_id null, the Add form's
-- default "The family") a parent entered for everyone.
--
-- A server action was never the boundary here. `components/modules/
-- knowledge-base-module.tsx:54-57` and `life-events-module.tsx:80` already read
-- `family_facts` from the browser on the caller's own RLS-bound
-- `createClient()`, so the same client can issue
-- `.from('family_facts').update({ value: … }).eq('id', …)` and never pass
-- through `app/`. Children and teens have real logins; a TypeScript check is a
-- product rule, and RLS is the only thing that cannot be routed around.
--
-- The route that made this reachable without any hand-written request at all
-- was `rememberConfirmed` (same file): it probes by (family_id, ilike label,
-- member_id) and UPDATEs whatever it finds, with no role and no member check.
-- Re-typing an existing label into Add therefore wrote a row the pencil refuses
-- — "Emergency contact: Grandma Ruth — 555 0101", entered by a parent for the
-- household, replaced by a member who may not edit it, and it is the row Bubaly
-- reads back when someone asks who to call. That half is fixed in the service
-- in the same change; this migration is the half a client cannot route around.
--
-- ── The rule ────────────────────────────────────────────────────────────────
--
-- The self half is 0272's and 0297's shape; the author half is what makes it
-- agree with the create path. It is exactly `mayChangeFact` in the service:
--
--   can_manage_family(family_id)
--     OR is_self_member(member_id)       -- a memory about me
--     OR created_by = auth.uid()          -- a memory I wrote
--
-- `public.is_self_member(uuid)` (0272, security definer, stable) is
-- `exists (select 1 from family_members where id = p_member_id
--          and user_id = auth.uid() and is_active)`, so a NULL member_id — a
-- household-level fact — is false on that branch for a non-manager.
--
-- WHY THE AUTHOR BRANCH. INSERT is open to every member on the ordinary
-- categories, and the Add form's default member is "The family" — so a teen
-- can file a household fact, or one about her sibling, and a self-only rule
-- would then refuse her the pencil, the restate and the trash on the very row
-- she just wrote: write, but never fix. Keyed on authorship too, whatever a
-- member may file she may also correct or forget, and a household fact a
-- PARENT wrote (created_by = the parent) is still out of her reach, which is
-- the row this migration exists for.
--
-- `created_by` is not pinned immutable here, and does not need to be for this
-- rule: USING only lets a member touch a row that is already about her or
-- already hers, so the most rewriting `created_by` can do is re-attribute a row
-- about her to herself — an end state she can reach anyway by forgetting it
-- and filing it again. It cannot reach a row that is neither.
--
-- 0264's category clause is carried through unchanged on every policy this
-- touches; this narrows and never widens.
--
-- UPDATE: applied to USING and to WITH CHECK, so a member can neither rewrite a
-- row that is not hers nor move a row a parent wrote about her out of her own
-- reach (re-pointing `member_id` at a sibling, or at the whole family) in the
-- same statement. `updateFact` asks the same of the incoming member_id, so the
-- app answers with its own sentence instead of reaching this as a 42501.
--
-- DELETE: the same rule. The RLS-bound browser client can DELETE the parent's
-- "Emergency contact" exactly as easily as it can rewrite it, and a boundary
-- on one verb of two is not a boundary. `forgetFact` already refuses a
-- non-manager everything outside this rule, and it is the only path that
-- deletes a `family_facts` row as a non-manager: `clearAiMemory` and
-- `confirmFact`'s rollback both run for managers only, and member/family
-- removal reaches this table through foreign-key actions, which RLS does not
-- see. Measured by docs/audit/a-member-only-rewrites-their-own-memory-check.sql.
--
-- SELECT and INSERT are deliberately untouched. SELECT stays open to the
-- household — a family reads its own memory. INSERT stays open because a
-- member filing a household-level fact is a real thing the form and the chat
-- tool both do, and the author branch above is what keeps that honest.
--
-- ── What this does NOT carry ────────────────────────────────────────────────
--
-- The SENSITIVE_TERMS half of `isSensitiveMemory` ("allergy", "password",
-- "bank", … in an ordinary category) is refused to a non-manager by the
-- service only. Nothing here mirrors it, so a direct insert from the browser
-- client with label "Allergies" in `important` still lands. It is left out on
-- purpose: PostgreSQL's ARE reads `\b` as a backspace (`\y` is its word
-- boundary), and the JS pattern is already narrower than it reads — its
-- trailing `\b` after the stems means "therapy", "pregnant" and "diagnosis" do
-- not match at all — so a hand translation would very likely refuse writes the
-- product allows today, as a raw 42501. The authorization half of this lead is
-- in the database; the content-classification half is a product rule.
--
-- Additive and replay-safe: `drop policy if exists` before `create policy`, and
-- nothing else on the table is dropped.

do $$
begin
  if to_regprocedure('public.is_self_member(uuid)') is null then
    raise exception '0385: public.is_self_member(uuid) is missing — the self rule has nothing to evaluate';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0385: public.can_manage_family(uuid) is missing — the manager rule has nothing to evaluate';
  end if;
end
$$;

alter table public.family_facts enable row level security;

drop policy if exists family_facts_update on public.family_facts;
create policy family_facts_update on public.family_facts
  for update to authenticated
  using (
    public.is_family_member(family_id)
    and (category not in ('medical', 'account') or public.can_manage_family(family_id))
    and (public.can_manage_family(family_id) or public.is_self_member(member_id) or created_by = auth.uid())
  )
  with check (
    public.is_family_member(family_id)
    and (category not in ('medical', 'account') or public.can_manage_family(family_id))
    and (public.can_manage_family(family_id) or public.is_self_member(member_id) or created_by = auth.uid())
  );

drop policy if exists family_facts_delete on public.family_facts;
create policy family_facts_delete on public.family_facts
  for delete to authenticated
  using (
    public.is_family_member(family_id)
    and (category not in ('medical', 'account') or public.can_manage_family(family_id))
    and (public.can_manage_family(family_id) or public.is_self_member(member_id) or created_by = auth.uid())
  );

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
declare
  q text;
  c text;
  d text;
begin
  select pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid)
    into q, c
    from pg_policy pol
    where pol.polrelid = 'public.family_facts'::regclass
      and pol.polname = 'family_facts_update';
  select pg_get_expr(pol.polqual, pol.polrelid)
    into d
    from pg_policy pol
    where pol.polrelid = 'public.family_facts'::regclass
      and pol.polname = 'family_facts_delete';

  if q is null then
    raise exception '0385: family_facts_update is missing after the create';
  end if;
  if c is null then
    raise exception '0385: family_facts_update has no WITH CHECK, so member_id could be re-pointed';
  end if;
  if d is null then
    raise exception '0385: family_facts_delete is missing after the create';
  end if;

  if q not like '%is_self_member%' or c not like '%is_self_member%' or d not like '%is_self_member%' then
    raise exception '0385: family_facts_update/delete do not carry the self rule on every side';
  end if;
  if q not like '%created_by = auth.uid()%' or c not like '%created_by = auth.uid()%' or d not like '%created_by = auth.uid()%' then
    raise exception '0385: family_facts_update/delete do not carry the author rule on every side — a member could file a fact she then cannot fix';
  end if;
  -- 0264's gate must survive this narrowing, not be replaced by it.
  if q not like '%medical%' or c not like '%medical%' or d not like '%medical%' then
    raise exception '0385: family_facts_update/delete lost 0264 medical/account gate';
  end if;

  raise notice '0385 OK: a parent or adult changes or forgets any memory; everyone else only the ones about themselves or that they wrote — in the database, not only in the service.';
end
$$;
