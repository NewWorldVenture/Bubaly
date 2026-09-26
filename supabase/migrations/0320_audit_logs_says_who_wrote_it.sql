-- ── S-04 An audit trail its subjects can sign for each other ─────────────────
--
-- `audit_insert` on `public.audit_logs` (0004, restated by 0118) pins `family_id`
-- and nothing else:
--
--   with check (family_id is null or public.is_family_member(family_id))
--
-- `actor_id`, `action`, `resource`, `resource_id` and `metadata` are all free.
-- So any member can file a row attributing an action to anyone — a child writes
-- `actor_id = <the parent's uid>, action = 'delete', resource =
-- 'wallet_transactions'` and `/family/activity` renders it as the parent's doing.
-- And the `family_id is null` branch lets any authenticated user write rows that
-- belong to no household, which no RLS reader can see and which
-- `app/(app)/admin/security/page.tsx` renders with the SERVICE client: twenty-five
-- inserts from one child session replace the platform's security feed with
-- fabricated events attributed to whoever they chose. That page states, as a
-- posture claim, "Append-only audit log — Sensitive actions are recorded
-- permanently". It is append-only and it is read-restricted. What it was not is
-- AUTHENTIC.
--
-- This exact defect was found on the sibling table and fixed there.
-- `0260_trust_ledger_lockdown.sql` says of `trust_audit_logs`: "a child's session
-- could file rows claiming a parent approved a bank transfer … An audit trail
-- that its subjects can write is not an audit trail." 0260 solved it by dropping
-- the member INSERT policy outright, because every legitimate writer there held
-- the service role.
--
-- That is NOT true here, and the difference is why this migration pins rather
-- than drops. `audit_logs` has fourteen callers on the caller's own cookie-bound
-- client — onboarding, family actions, concierge calls, workload, independence,
-- the assistants surface — and `docs/audit/household-trail-check.sql` states the
-- intent deliberately: "ANY member may append … while only a parent or adult may
-- read it back." A trail a child cannot write has holes in it for the person
-- doing the work. What the policy never asserted is that the row says who
-- actually appended it — and every one of those fourteen callers already passes
-- `actorId` = its own `ctx.user.id`, so pinning it costs the honest callers
-- nothing. Same shape as `parent_approvals_insert` on the neighbouring table.
--
-- The `family_id is null` branch goes too. Exactly one client-side caller used
-- it — the onboarding reset row, when the user has no active family — and that
-- call now writes with the service client it already held, which is the correct
-- client for a row the server authors about itself. Every other null-family
-- writer (the admin actions, the benchmarks export) was already on the service
-- role and is unaffected: service_role bypasses RLS, so crons and the run
-- executor keep writing `actor_id = null` system rows exactly as before.
--
-- READS are unchanged: `audit_select` stays `can_manage_family(family_id)`.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).

drop policy if exists audit_insert on public.audit_logs;

create policy audit_insert on public.audit_logs
  for insert to authenticated
  with check (
    public.is_family_member(family_id)
    and actor_id = auth.uid()
  );
