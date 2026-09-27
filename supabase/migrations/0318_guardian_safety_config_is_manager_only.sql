-- ── A child may not rewrite the safety screening that protects them ─────────
--
-- AUTHZ-005. guardian_contacts holds per-contact TRUST LEVELS and
-- guardian_member_profiles holds each member's call/message ROUTING PROFILE.
-- Together they decide whether an incoming call or text from a given number is
-- screened, blocked, allowed straight through, or escalated to a parent. They
-- are the configuration of the AI Call Guardian — the surface whose entire
-- purpose is protecting a child from scam and grooming contact.
--
-- 01370_ai_call_guardian.sql gave both tables:
--
--   select : is_family_member(family_id)
--   ALL    : is_family_member(family_id)        <-- any member, including a child
--
-- `FOR ALL` covers INSERT, UPDATE and DELETE. So the policy that decides who may
-- change a child's protection asks only whether the caller is in the household —
-- and the child is in the household.
--
-- The application already knows this. app/(app)/guardian/actions.ts says so in
-- its own header, verbatim:
--
--   "RLS on the guardian tables is family-scoped (any member), and children have
--    real logins, so these server actions are the authorization boundary: only a
--    family manager (parent/adult) may change safety config."
--
-- Both halves of that sentence are true, and together they are the defect. The
-- server actions do gate on isManager. But a server action is not a boundary
-- against someone holding a JWT: children have real logins, every Supabase
-- client ships with PostgREST reachable, and a direct request to
-- /rest/v1/guardian_contacts never passes through app/ at all. A teen who wants
-- an unscreened line to a stranger does not need to defeat the UI — they need
-- one HTTP request that sets that contact's trust level to trusted, or flips
-- their own routing profile out of screening.
--
-- 0215 hardened the routing RULES table and stopped there; contacts and profiles
-- kept the original policy, which is why this survived that pass.
--
-- The repair makes RLS agree with the sentence the code already wrote down.
-- Reads are unchanged — a child may still SEE their own configuration, which is
-- honest and is what the Guardian screens in the app render from. Writes now
-- require can_manage_family(), the repo's existing manager predicate
-- (0003_functions_triggers.sql: role in ('parent','adult') and is_active), which
-- is the same set as isManager() in lib/constants/roles.ts. Nothing is granted
-- that a manager did not already have through the server actions.
--
-- Split into explicit INSERT/UPDATE/DELETE rather than another `FOR ALL`, so a
-- future reader cannot mistake a write policy for a read one the way `FOR ALL`
-- invited here. UPDATE carries both USING and WITH CHECK: without WITH CHECK a
-- manager could move a row to another family, and without USING a non-manager
-- could still match rows to attempt the update.

-- guardian_contacts — per-contact trust levels.
drop policy if exists "Family member can manage guardian_contacts" on public.guardian_contacts;

drop policy if exists guardian_contacts_insert on public.guardian_contacts;
create policy guardian_contacts_insert on public.guardian_contacts
  for insert to authenticated
  with check (public.can_manage_family(family_id));

drop policy if exists guardian_contacts_update on public.guardian_contacts;
create policy guardian_contacts_update on public.guardian_contacts
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

drop policy if exists guardian_contacts_delete on public.guardian_contacts;
create policy guardian_contacts_delete on public.guardian_contacts
  for delete to authenticated
  using (public.can_manage_family(family_id));

-- guardian_member_profiles — per-member call/message routing.
drop policy if exists "Family member can manage guardian_member_profiles" on public.guardian_member_profiles;

drop policy if exists guardian_member_profiles_insert on public.guardian_member_profiles;
create policy guardian_member_profiles_insert on public.guardian_member_profiles
  for insert to authenticated
  with check (public.can_manage_family(family_id));

drop policy if exists guardian_member_profiles_update on public.guardian_member_profiles;
create policy guardian_member_profiles_update on public.guardian_member_profiles
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

drop policy if exists guardian_member_profiles_delete on public.guardian_member_profiles;
create policy guardian_member_profiles_delete on public.guardian_member_profiles
  for delete to authenticated
  using (public.can_manage_family(family_id));
