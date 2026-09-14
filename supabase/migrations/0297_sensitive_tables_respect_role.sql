-- ============================================================
-- Migration 0297: three tables the code calls sensitive, where RLS disagreed
--
-- lib/ai/context/policy.ts carries SENSITIVE_TABLES — a curated, reviewed list
-- of 66 tables whose own header says "§4 says a child must not inspect
-- household finances or confidential documents". That list governs what an AI
-- context slice may read. It does not govern the database, and the database
-- disagrees with it: 58 of those 66 tables are readable by ANY family member,
-- children included, because their policies gate on is_family_member, which
-- answers "is this user in the family" and ignores role.
--
-- Most of those 58 need a product decision rather than a migration — a child
-- SHOULD see their own wallet, their own medications, their own sleep log, and
-- a blanket manager-only sweep would break the app. They are recorded in the
-- audit instead of changed here.
--
-- These three are not ambiguous, and each is fixed the way this repository has
-- already fixed the same shape before (0266 documents, 0272 RSVPs, 0296 the
-- password vault).
--
-- ── 1. child_logins ──────────────────────────────────────────────────────
-- Its own ALL policy is NAMED "Managers manage child_logins" and is gated on
-- is_family_member. The name documents an intent the predicate never enforced,
-- so any child could UPDATE or DELETE any sibling's login row. Measured against
-- a replayed database: a child rewrote 1 sibling row and deleted 1.
--
-- That is not a cosmetic disclosure. app/(auth)/actions.ts signs a child in
-- with
--
--     email:    syntheticChildEmail(row.username)
--     password: deriveChildPassword(sec, row.username, pin)
--
-- so the username is an INPUT to the credential derivation. Rename a sibling's
-- row and their PIN no longer derives their account; delete it and the lookup
-- finds nothing. Either way that sibling is locked out of the product until an
-- adult repairs it through the service-role flow. One child could do it to
-- another.
--
-- The separate "Members can view child_logins" SELECT policy is left alone: it
-- is a deliberate, separately-named product choice, and narrowing it is not
-- this migration's business. Only the policy that claims to be manager-only is
-- made manager-only.
--
-- ── 2. social_account_tokens ─────────────────────────────────────────────
-- policy.ts files this under "Credentials and tokens — absolute, no exception"
-- with the reason "OAuth tokens". It holds access_token_enc / refresh_token_enc
-- for the family's connected social accounts, and every policy was
-- is_family_member. There is no per-member semantics here and no reading a
-- child needs: the table has no member_id, only account_id. Manager-only,
-- exactly as 0296 did for the password vault.
--
-- ── 3. driver_licenses ───────────────────────────────────────────────────
-- policy.ts reason: "licence numbers". license_number is plaintext text, and
-- all four policies were is_family_member, so any child read every adult's
-- licence number. Measured: a child selected 'D1234567-PARENT-PII'.
-- /dashboard/auto/licenses guards with requirePlanLevel(1), which checks the
-- family's PLAN and never the caller's role, so the page is reachable too.
--
-- This one keeps first-person access, because a teenager with a licence should
-- see their own: the shape is 0272's, is_self_member(member_id) or
-- can_manage_family(family_id). A licence row without a member_id belongs to
-- the household rather than a person, so it stays manager-only.
--
-- Idempotent throughout: policies are dropped and recreated by name.
-- ============================================================

-- ── 1. child_logins: the policy called "Managers manage" now requires one ──
drop policy if exists "Managers manage child_logins" on public.child_logins;
create policy "Managers manage child_logins" on public.child_logins
  for all
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

-- ── 2. social_account_tokens: OAuth tokens are adults-only ────────────────
drop policy if exists social_account_tokens_select on public.social_account_tokens;
create policy social_account_tokens_select on public.social_account_tokens
  for select using (public.can_manage_family(family_id));

drop policy if exists social_account_tokens_insert on public.social_account_tokens;
create policy social_account_tokens_insert on public.social_account_tokens
  for insert with check (public.can_manage_family(family_id));

drop policy if exists social_account_tokens_update on public.social_account_tokens;
create policy social_account_tokens_update on public.social_account_tokens
  for update using (public.can_manage_family(family_id))
          with check (public.can_manage_family(family_id));

drop policy if exists social_account_tokens_delete on public.social_account_tokens;
create policy social_account_tokens_delete on public.social_account_tokens
  for delete using (public.can_manage_family(family_id));

-- ── 3. driver_licenses: your own licence, or a manager's ──────────────────
drop policy if exists driver_licenses_select on public.driver_licenses;
create policy driver_licenses_select on public.driver_licenses
  for select using (
    public.is_family_member(family_id)
    and (public.can_manage_family(family_id) or public.is_self_member(member_id))
  );

drop policy if exists driver_licenses_insert on public.driver_licenses;
create policy driver_licenses_insert on public.driver_licenses
  for insert with check (
    public.is_family_member(family_id)
    and (public.can_manage_family(family_id) or public.is_self_member(member_id))
  );

drop policy if exists driver_licenses_update on public.driver_licenses;
create policy driver_licenses_update on public.driver_licenses
  for update using (
    public.is_family_member(family_id)
    and (public.can_manage_family(family_id) or public.is_self_member(member_id))
  ) with check (
    public.is_family_member(family_id)
    and (public.can_manage_family(family_id) or public.is_self_member(member_id))
  );

drop policy if exists driver_licenses_delete on public.driver_licenses;
create policy driver_licenses_delete on public.driver_licenses
  for delete using (
    public.is_family_member(family_id)
    and (public.can_manage_family(family_id) or public.is_self_member(member_id))
  );
