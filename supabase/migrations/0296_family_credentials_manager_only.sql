-- ============================================================
-- Migration 0296: the family password vault is for adults
--
-- public.family_credentials holds Wi-Fi passwords, account logins, PINs and
-- card details. `secret` is plaintext `text`. All four of its policies, since
-- 0119, have read:
--
--     using (public.is_family_member(family_id))
--
-- is_family_member answers "is this user in the family" and ignores role
-- entirely:
--
--     select 1 from public.family_members
--     where family_id = p_family_id and user_id = auth.uid() and is_active
--
-- Children are real auth users in this product. child-login-actions.ts creates
-- one through admin.auth.admin.createUser and then sets family_members.user_id
-- to it — its own comment says "Link the member to the new auth user so they
-- ARE this member on sign-in." So a child signs in, auth.uid() is theirs,
-- is_family_member returns true, and all four policies pass.
--
-- The vault page carries no role check, requireAal2 is a no-op for children,
-- and the module reads through the browser client. RLS was the only boundary,
-- and it was not one: every child could read, change or delete every stored
-- password.
--
-- 0266 fixed exactly this shape for the document vault. This is the same fix,
-- for the table that holds the passwords.
--
-- can_manage_family is `role in ('parent','adult') and is_active`, so no adult
-- loses access. Only children do, which is the entire point. If the owner wants
-- the vault narrowed further — parents only — that is a second, additive
-- decision and not this migration's business.
--
-- Idempotent: the policies are dropped and recreated by name.
-- ============================================================

drop policy if exists family_credentials_select on public.family_credentials;
create policy family_credentials_select on public.family_credentials
  for select using (public.can_manage_family(family_id));

drop policy if exists family_credentials_insert on public.family_credentials;
create policy family_credentials_insert on public.family_credentials
  for insert with check (public.can_manage_family(family_id));

drop policy if exists family_credentials_update on public.family_credentials;
create policy family_credentials_update on public.family_credentials
  for update using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

drop policy if exists family_credentials_delete on public.family_credentials;
create policy family_credentials_delete on public.family_credentials
  for delete using (public.can_manage_family(family_id));
