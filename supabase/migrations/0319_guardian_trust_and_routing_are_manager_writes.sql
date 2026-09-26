-- Bubaly :: 0319 - Guardian trust, routing profiles and learning are manager writes
--
-- AUTHZ-005 (finalaudit.md), open since 2026-09-12 and held only by a no-SQL
-- rule in that cycle.
--
-- 0215 moved guardian_routing_rules to manager-only writes and said why: the
-- app already refuses non-managers, but a table that is `is_family_member` FOR
-- ALL lets a signed-in child do over PostgREST what the app will not. It left
-- the tables beside it alone, and they decide the same things:
--
--   guardian_contacts         a caller's trust level. A child marks a number
--                             "trusted" and it rings straight through, past
--                             screening; or marks a parent's number blocked.
--   guardian_member_profiles  each member's routing mode, context and the
--                             Guardian phone assigned to them.
--   guardian_suggestions      what the learning loop proposes. Review goes
--                             through guardian_review_suggestion (SECURITY
--                             DEFINER, checks the reviewer), but a member could
--                             still write, reword or delete the queue directly.
--
-- Every app write to these three goes through a server action gated by
-- isManager (parent or adult), which is exactly can_manage_family, on the
-- user's own client — so managers keep every path they have today. Service-role
-- writers (webhooks, the learning cron) bypass RLS and are unaffected.
--
-- guardian_communications is deliberately NOT changed. Its member INSERT
-- ("Service can insert guardian_communications", which in fact admits any
-- family member) is relied on by the signed-ingress design: the receipt and
-- recovery E2E suites file member-written rows on purpose and prove that signed
-- intake never trusts them. Whether members should be able to write that
-- history at all is recorded in finalaudit.md for the owner.
--
-- SELECT stays open to members on all three, as 0215 left it.
-- Pinned by docs/audit/guardian-manager-write-check.sql.

do $$
declare
  t text;
begin
  foreach t in array array['guardian_contacts', 'guardian_member_profiles', 'guardian_suggestions'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'Family member can manage ' || t, t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_manage_family(family_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_manage_family(family_id))', t || '_delete', t);
  end loop;

end
$$;
