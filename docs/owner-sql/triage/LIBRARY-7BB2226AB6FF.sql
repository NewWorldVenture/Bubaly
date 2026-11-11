-- LIBRARY-7BB2226AB6FF :: a member's audit entry cannot say the assistant wrote it
--
-- OWNER ITEM. Nothing applies this file; the owner reviews and applies it.
--
-- WHAT
--   Narrow the member INSERT policy on public.audit_logs (audit_insert, last
--   set by 0380) so a row written from a member's session cannot carry
--   metadata.actor = 'ai' or 'system'. A member's row either has no
--   metadata.actor (lib/server/audit.ts writes none) or says 'member'.
--
-- WHY
--   0380 pins family membership and actor_id = auth.uid(), and nothing about
--   the metadata. Any member with a login (a teen or a child included) can
--   therefore insert, straight through the API, a row with their own actor_id
--   and metadata {"actor":"ai","title":"<any text>"}. /family/activity read
--   that as a line by Bubaly. The application now always names the member on
--   such a line ("Bubaly, for Sam"), so a planted line is attributed to its
--   author; this policy stops the row being written at all.
--
-- BEFORE APPLYING (order matters)
--   The assistant acts inside a member's session, and
--   lib/services/activity/index.ts (appendHouseholdTrail) writes its trail
--   entry on that session with metadata.actor = 'ai'. Under this policy that
--   insert is refused (it is best-effort, so the change still commits and the
--   entry is logged as dropped). Move that write to the service role for any
--   scope whose actorKind is not 'member' FIRST, deploy it, and only then
--   apply this. The pull request that added this file carries the exact diff.
--
-- HOW TO VERIFY (as a signed-in child of a family, against a scratch database)
--   1. insert into public.audit_logs (family_id, actor_id, action, resource, metadata)
--        values (<family>, auth.uid(), 'delete', 'photos', '{"actor":"ai","title":"x"}');
--      -> refused: new row violates row-level security policy
--   2. the same with '{"actor":"system","title":"x"}' -> refused
--   3. the same with '{"actor":"member","title":"x"}' -> lands
--   4. the same with metadata null, and with '{}' -> lands
--   5. docs/audit/audit-actor-check.sql and docs/audit/household-trail-check.sql
--      still pass (a row naming another actor, or none, is still refused).
--   6. With the application change above deployed: ask the assistant to add a
--      calendar event, and /family/activity shows "Bubaly, for <you>".

do $$
begin
  if to_regclass('public.audit_logs') is not null then
    drop policy if exists audit_insert on public.audit_logs;
    create policy audit_insert on public.audit_logs
      for insert to authenticated
      with check (
        public.is_family_member(family_id)
        and actor_id = auth.uid()
        and coalesce(metadata ->> 'actor', 'member') = 'member'
      );
  end if;
end
$$;
