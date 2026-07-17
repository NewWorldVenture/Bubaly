-- FamilyOS :: 0219 — lock admin_users + support_tickets RLS to service-role only
--
-- CRITICAL tenant-isolation fix (PLA-0590 / LB-011). Migration 0010 created both
-- tables with the comment "RLS: only service-role (admin console) reads/writes"
-- but wrote the policy as:
--     create policy "service_role_all" ... using (true) with check (true);
-- with NO `to service_role` clause — so it defaults to `TO public`, applying to
-- the `authenticated` (and `anon`) roles with an always-true qual. Because the
-- Supabase client talks to PostgREST as `authenticated`, ANY signed-in user could:
--   • read every family's SUPPORT TICKETS (requester name/email + issue text = PII
--     across all tenants), and
--   • read the entire ADMIN ROSTER (admin_users: emails, admin_role, permissions,
--     status) and — via `with check (true)` — INSERT/UPDATE/DELETE admin_users rows
--     (tamper with the admin team list).
-- The admin console only ever touches these tables through the service-role client
-- (createServiceClient, behind an isSuperAdmin gate), and service_role has BYPASSRLS
-- — so scoping the policy to service_role restores the intended "admin-only" access
-- WITHOUT changing any app behaviour. Client roles get no policy ⇒ default deny.
--
-- Additive + idempotent (drop policy if exists → recreate `to service_role`).

alter table public.support_tickets enable row level security;
drop policy if exists "service_role_all" on public.support_tickets;
create policy "service_role_all" on public.support_tickets
  to service_role
  using (true) with check (true);

alter table public.admin_users enable row level security;
drop policy if exists "service_role_all" on public.admin_users;
create policy "service_role_all" on public.admin_users
  to service_role
  using (true) with check (true);
