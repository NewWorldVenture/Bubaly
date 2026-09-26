-- Bubaly :: 0321 - an audit trail is append-only for the people it records
--
-- Three audit tables let any family member rewrite or erase them directly
-- against the API:
--
--   social_audit_logs    who connected, published and changed social access —
--                        the trail behind AUTHZ-003's restricted roles. The
--                        generic 0034 loop gave it member UPDATE and DELETE.
--   vacation_audit_logs  "Members manage vacation_audit_logs", FOR ALL.
--   sync_change_logs     "family member access", FOR ALL.
--
-- A trail the recorded can edit records nothing. No application code updates
-- or deletes any of them (every write is an INSERT), family deletion removes
-- them by foreign-key cascade (which RLS does not gate), and the service role
-- bypasses RLS for anything operational. So members keep SELECT and INSERT and
-- lose UPDATE and DELETE.
--
-- Not changed here: audit_logs and wallet_audit_logs were already insert-only
-- for members. Members can still INSERT into all five, because the app writes
-- them from members' own sessions; making them service-only means moving those
-- writers first, and is recorded in finalaudit.md.
--
-- Pinned by docs/audit/audit-trail-append-only-check.sql.

do $$
declare
  t text;
begin
  foreach t in array array['social_audit_logs', 'vacation_audit_logs', 'sync_change_logs'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    -- Whatever shape the member policy had (one FOR ALL, or one per command),
    -- replace it with exactly SELECT + INSERT.
    execute format('drop policy if exists %I on public.%I', 'Members manage ' || t, t);
    execute format('drop policy if exists %I on public.%I', 'family member access', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_family_member(family_id))', t || '_insert', t);
  end loop;
end
$$;
