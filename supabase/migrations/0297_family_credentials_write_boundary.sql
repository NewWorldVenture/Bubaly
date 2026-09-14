-- ── O-01 A child could read, change and delete the family's card PIN ────────
--
-- `family_credentials` is the "Wi-Fi & Passwords" vault. Its `category` check
-- constraint allows 'card' and 'pin', so the table is designed to hold bank
-- card numbers and PINs, and `secret` is plain `text` — not an `_enc` column
-- like `sync_tokens.refresh_token_enc` or `social_account_tokens.access_token_enc`,
-- which this same schema encrypts at rest.
--
-- Every one of its four policies was `is_family_member(family_id)`. Proved
-- against a replay of all 309 migrations: a member with role 'child', on an
-- `aal1` session (password only, no second factor), READ the stored PIN in
-- plaintext, UPDATED it, and DELETED the row. Nothing in the application stands
-- in the way either — `components/modules/passwords-module.tsx` has no role
-- check of any kind and writes with the caller's own client, so RLS is the only
-- boundary there has ever been.
--
-- WRITES are the half with no product ambiguity, and this migration fixes only
-- that half. No design intends a child to silently change or destroy the
-- parents' bank-card entry; it is the same defect as F20's chore board and the
-- same shape as the money tables' manager-gated writes (Phase 7 tranche J).
-- `can_manage_family` is the predicate every other governance table in this
-- schema uses — family_members, subscriptions, medical_profiles — so this makes
-- the vault consistent rather than special.
--
-- READS are deliberately LEFT ALONE. The page is called "Wi-Fi & Passwords" and
-- 'wifi' is a category, so some entries are plainly meant to be family-wide;
-- deciding WHICH is a product question, and the unused `member_id` column
-- suggests the intended shape. Narrowing reads on a guess would break a real
-- use case. Recorded in finalaudit.md as O-02 for the owner.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).

drop policy if exists family_credentials_insert on public.family_credentials;
drop policy if exists family_credentials_update on public.family_credentials;
drop policy if exists family_credentials_delete on public.family_credentials;

create policy family_credentials_insert on public.family_credentials
  for insert to authenticated
  with check (public.can_manage_family(family_id));

create policy family_credentials_update on public.family_credentials
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

create policy family_credentials_delete on public.family_credentials
  for delete to authenticated
  using (public.can_manage_family(family_id));
