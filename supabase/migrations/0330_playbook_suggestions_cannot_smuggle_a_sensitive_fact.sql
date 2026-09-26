-- Bubaly :: 0330 - a playbook suggestion cannot smuggle a sensitive fact
--
-- `family_playbook_suggestions` (0126_family_playbook.sql:44-58) carries four
-- policies written through one `format()` loop:
--
--   %1$s_select  FOR SELECT  USING      (is_family_member(family_id))
--   %1$s_insert  FOR INSERT  WITH CHECK (is_family_member(family_id))
--   %1$s_update  FOR UPDATE  USING/WITH CHECK (is_family_member(family_id))
--   %1$s_delete  FOR DELETE  USING      (is_family_member(family_id))
--
-- Role-blind on all four verbs, and never narrowed since: 0265's header says
-- "No policy changes: 0264 owns this table's RLS", and 0264 does not mention
-- this table at all. Its `category` CHECK admits every value `family_facts`
-- admits, including `'medical'` and `'account'`.
--
-- ── the escalation, measured on a replayed database (341 migrations) ────────
--
-- `family_facts_insert` (0264_ai_surface_role_privacy.sql:115) is
--
--   is_family_member(family_id)
--   and (category not in ('medical','account') or can_manage_family(family_id))
--
-- so a child cannot write a medical or account fact. Acting as a `child`
-- member of the family, in one rolled-back transaction:
--
--   insert into family_facts (category='medical', …)              -> REFUSED (42501)
--   insert into family_playbook_suggestions (category='medical',
--     label='Allergy', value='Peanuts are fine now',
--     evidence='You told me last week', confidence=95)            -> INSERT 1
--
-- then, as the PARENT, exactly what `confirmFact` runs
-- (lib/services/memory/index.ts:711-727 — it copies the suggestion's OWN
-- `member_id`, `category`, `label`, `value`, its `evidence` into `notes`, its
-- `confidence` and its `expires_at`):
--
--   insert into family_facts select family_id, member_id, category, label,
--     value, 'Learned by Bubaly — '||evidence, …  from the suggestion  -> INSERT 1
--
--   family_facts now holds:  medical | Allergy | Peanuts are fine now
--   and the child reading family_facts for that family:               0 rows
--
-- The insert passes because it runs in the parent's session. `confirmFact` IS
-- manager-gated (`if (!canManage(scope))`) and that gate is not the defect — it
-- does exactly what it promises. The defect is that nothing stopped the child
-- authoring its input, and the parent did precisely what the product asked of
-- them. This is AUTHZ-006 (`guardian_suggestions` → `guardian_review_suggestion`)
-- and AUTHZ-009 (`wallet_goals` → `wallet_fund_goal`) for the third time, now
-- in the memory domain — and `family_facts_select` hides the result from the
-- child, so they are writing into a surface they cannot read.
--
-- ── every writer was read before anything was restricted ───────────────────
--
-- Three writers, and NOT ONE of them writes a sensitive category:
--
--   1. lib/services/memory/index.ts:361  `rememberUnconfirmed` INSERT, on the
--      caller's own RLS-bound client, role-blind — a child chatting with Bubaly
--      files cards and must keep doing so. It is reached only through
--      `rememberFact`, whose `!fromPerson` branch is guarded four lines earlier
--      by `isSensitiveMemory({category,key,content})`: "Medical and account
--      details are only saved when a person enters them directly." So the
--      service can never put 'medical' or 'account' in this table.
--
--   2. app/(app)/dashboard/playbook/playbook-actions.ts:146
--      `refreshPlaybookAction` UPSERT, also on the caller's own client, also
--      role-blind — components/modules/playbook-module.tsx fires it from the
--      Refresh button for any member. Its rows come from `learnPlaybook`
--      (lib/playbook/learn.ts), which emits exactly two categories:
--      `'preference'` (meal, grocery, favourite, travel) and `'date'`
--      (tradition). Nothing else.
--
--   3. supabase/seed_playbook_all_families.sql and seed_pillar3_playbook.sql —
--      'preference' and 'date' only, and they run as the migration role.
--
-- So a member-authored suggestion in an ORDINARY category is the product, and
-- this migration leaves it completely alone. That is the CENSUS-002 lesson:
-- a blanket manager guard here would have broken the memory inbox and the
-- playbook refresh for every child in the household.
--
-- ── and every UPDATE writer, because UPDATE needed a different shape ───────
--
--   lib/services/memory/index.ts:743   `confirmFact`   -> { status:'accepted', fact_id }   manager-gated
--   lib/services/memory/index.ts:774   `forgetFact`    -> { status:'dismissed' }           NOT role-gated
--   playbook-actions.ts:183  `dismissSuggestionAction` -> { status:'dismissed' }           NOT role-gated
--
-- Dismissing is open to every member on purpose, so a blanket manager UPDATE
-- guard would be wrong for the same reason 0326 refused one on `chore_disputes`.
-- And a restrictive UPDATE policy cannot help either: `WITH CHECK` sees only the
-- NEW row, so "a member may not move a row INTO a sensitive category" and "a
-- member may still dismiss a sensitive card a manager wrote" are indistinguish-
-- able to it. Hence a BEFORE trigger, which can compare OLD with NEW.
--
-- What the trigger guards is the set of columns `confirmFact` copies —
-- `category`, `member_id`, `label`, `value`, `evidence`, `signature`,
-- `confidence`, `expires_at` — on a row that is sensitive before or after the
-- write. Every writer above changes `status` and `fact_id` and nothing else, so
-- the cost to the product is zero, and a child can still dismiss a medical card
-- off their own inbox. Rewriting the `value` a parent is about to confirm is
-- the AUTHZ-006 half all over again and is what closes here.
--
-- ── what does NOT change, and must be read as a finding, not an omission ───
--
-- SELECT. Every member still sees every card: the playbook module, the
-- needs-you cards (lib/home/needs-sources.ts) and `listMemories` all read this
-- table on the RLS-bound client as whoever is signed in. `family_facts_select`
-- DOES hide sensitive categories from a child, so the asymmetry survives — but
-- narrowing reads would change what the inbox shows a teen, which is 0322's
-- line ("Only writes move") and a product decision, not this migration's. After
-- this file a sensitive card can only be put there by a manager or a seed in
-- the first place.
--
-- PROVENANCE, which is the second half of AUTHZ-013 and is NOT repairable here.
-- `confirmFact` derives the `family_facts.source` that 0265 created:
--
--   source: suggestion.signature.startsWith(AI_SIGNATURE_PREFIX)
--             ? 'ai_conversation'   // "you said it and I kept it"
--             : 'ai_inferred'       // "Bubaly worked it out"
--
-- `signature` is a dedupe key the row's own author writes, so the author picks
-- which of those a parent's click stamps. SQL cannot fix that, and pinning the
-- column would be a fix in appearance only: `memorySignature` is
-- `sha256(member|category|label)` truncated to 32 hex — a public function of
-- columns already in the row, so anyone who can insert the row can compute the
-- digest. It authenticates nothing. Nor can the prefix be made manager-only:
-- `rememberUnconfirmed` writes `ai_memory:` signatures in the session of
-- whoever is talking to Bubaly, children included, so that guard would silence
-- the memory inbox for exactly the people it is for.
--
-- The fix belongs where the trust is placed, and it is an APPLICATION change:
-- `confirmFact` must stop reading provenance off `signature`. Either
--   (a) `family_playbook_suggestions` gains a server-stamped provenance column
--       that a client role cannot set to the conversational value — written by
--       a SECURITY DEFINER RPC called from `rememberUnconfirmed`, which is the
--       only code that knows a person actually said the thing in a turn — and
--       `confirmFact` reads THAT; or
--   (b) `confirmFact` writes the conservative `'ai_inferred'` for every card it
--       confirms, and `'ai_conversation'` is reserved for facts the service
--       writes itself.
-- This is the sentence 0327 had to write about `autopilot_suggestions.payload`:
-- RLS cannot tell the honest row from the hand-crafted one, because both are
-- authored by the same member on the same client with the same columns.
--
-- `label`, `value` and `evidence` on an ORDINARY card stay member-written too —
-- that is the inbox working — and a fact in an ordinary category is one the
-- child could have written into `family_facts` directly, so there is no
-- boundary being walked around there.
--
-- ── why RESTRICTIVE, and why `to authenticated, anon` ──────────────────────
-- 0254's mechanism, reaffirmed by 0306, 0310 and 0322: a restrictive policy
-- ANDs with the union of the permissive ones, so no future permissive policy
-- can grant past it — and 0126 wrote its four through a loop, which is exactly
-- the habit that would re-open this. The role list names both client roles
-- because 0126's own policies carry no `TO` clause at all (they are `TO
-- public`, so an `anon` request matches them); a `to authenticated` guard, as
-- 0322 used, would simply be absent from that request. Naming the two roles
-- rather than writing `TO public` keeps the guard away from the migration and
-- service roles, which own and bypass this table.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Additive + idempotent: policies and the trigger are dropped and recreated by
-- name; 0126's four permissive policies are not touched.

do $$
begin
  if to_regclass('public.family_playbook_suggestions') is null then
    return;
  end if;

  -- ── 1. authoring: family_facts_insert's own rule, word for word ──────────
  drop policy if exists family_playbook_suggestions_sensitive_insert_guard
    on public.family_playbook_suggestions;
  create policy family_playbook_suggestions_sensitive_insert_guard
    on public.family_playbook_suggestions
    as restrictive for insert to authenticated, anon
    with check (
      category not in ('medical', 'account')
      or public.can_manage_family(family_id)
    );

  -- ── 2. removal: 0264 gates family_facts DELETE on the same rule ──────────
  -- `clearAiMemory` is the only path in app/ or lib/ that deletes from this
  -- table and it opens `if (!canManage(scope))`, so a manager's clear is
  -- unaffected. Erasing a medical card a parent has not yet read is not the
  -- escalation this file is about, but it costs nothing to close and 0264
  -- already drew the line there for the fact it becomes.
  drop policy if exists family_playbook_suggestions_sensitive_delete_guard
    on public.family_playbook_suggestions;
  create policy family_playbook_suggestions_sensitive_delete_guard
    on public.family_playbook_suggestions
    as restrictive for delete to authenticated, anon
    using (
      category not in ('medical', 'account')
      or public.can_manage_family(family_id)
    );
end $$;

-- ── 3. editing: the columns a confirm copies, on a sensitive card ──────────
do $$
begin
  if to_regclass('public.family_playbook_suggestions') is null then
    return;
  end if;

  create or replace function public.playbook_suggestion_sensitive_guard()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public
  as $fn$
  declare
    sensitive boolean;
    touches_confirmed_fields boolean;
  begin
    -- Sensitive before the write or after it: a member may neither create a
    -- medical card by renaming a preference one, nor launder a manager's
    -- medical card into an ordinary category to get at its text.
    sensitive :=
      old.category in ('medical', 'account')
      or new.category in ('medical', 'account');
    if not sensitive then
      return new;
    end if;

    -- Exactly what confirmFact copies into family_facts
    -- (lib/services/memory/index.ts:711-727). `status` and `fact_id` are
    -- deliberately absent: dismissing a card is open to every member
    -- (dismissSuggestionAction and forgetFact carry no role gate) and a guard
    -- that took that away would leave a child unable to clear their own inbox.
    touches_confirmed_fields :=
      new.category   is distinct from old.category
      or new.member_id  is distinct from old.member_id
      or new.label      is distinct from old.label
      or new.value      is distinct from old.value
      or new.evidence   is distinct from old.evidence
      or new.signature  is distinct from old.signature
      or new.confidence is distinct from old.confidence
      or new.expires_at is distinct from old.expires_at;

    if not touches_confirmed_fields then
      return new;
    end if;

    -- The trusted server on the same terms 0222, 0295 and 0326 use: the
    -- service role, and a migration or seed running with no session.
    if current_user = 'service_role'
       or coalesce(auth.role(), '') = 'service_role'
       or auth.uid() is null
       or public.can_manage_family(new.family_id) then
      return new;
    end if;

    raise exception
      'a medical or account suggestion may only be written by a family manager'
      using errcode = '42501';
  end;
  $fn$;

  comment on function public.playbook_suggestion_sensitive_guard() is
    'confirmFact copies a suggestion''s own category/member_id/label/value/evidence/confidence/expires_at into family_facts, in the confirming parent''s session, past a family_facts_insert policy that bars a non-manager from the medical and account categories. This guards those columns on a sensitive card rather than the table, because dismissing a card is open to every member (dismissSuggestionAction and forgetFact have no role gate) and a blanket UPDATE guard would take a child''s own inbox away from them. Authoring is closed by family_playbook_suggestions_sensitive_insert_guard.';

  drop trigger if exists trg_playbook_suggestion_sensitive_guard
    on public.family_playbook_suggestions;
  create trigger trg_playbook_suggestion_sensitive_guard
    before update on public.family_playbook_suggestions
    for each row execute function public.playbook_suggestion_sensitive_guard();
end $$;

-- ── a migration that silently created nothing is worse than one that failed ─
do $$
declare
  missing text[] := '{}';
begin
  if to_regclass('public.family_playbook_suggestions') is null then
    return;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'family_playbook_suggestions'
      and policyname = 'family_playbook_suggestions_sensitive_insert_guard'
      and permissive = 'RESTRICTIVE'
  ) then
    missing := array_append(missing, 'restrictive INSERT guard');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'family_playbook_suggestions'
      and policyname = 'family_playbook_suggestions_sensitive_delete_guard'
      and permissive = 'RESTRICTIVE'
  ) then
    missing := array_append(missing, 'restrictive DELETE guard');
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.family_playbook_suggestions'::regclass
      and tgname = 'trg_playbook_suggestion_sensitive_guard'
      and not tgisinternal
  ) then
    missing := array_append(missing, 'BEFORE UPDATE trigger');
  end if;

  -- 0126's four permissive policies must still be there: this file narrows the
  -- table, it does not take it over, and a member filing an ordinary card is
  -- the product.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'family_playbook_suggestions'
      and policyname = 'family_playbook_suggestions_insert' and permissive = 'PERMISSIVE'
  ) then
    missing := array_append(missing, '0126 permissive INSERT policy (it must survive)');
  end if;

  if array_length(missing, 1) is not null then
    raise exception '0330: missing on family_playbook_suggestions: %', array_to_string(missing, ', ');
  end if;

  raise notice '0330 OK: a medical or account playbook suggestion is a manager''s to author and to edit; ordinary cards are untouched.';
end $$;
