-- ============================================================================
-- 0260_trust_ledger_lockdown.sql — the trust ledger becomes evidence, and
-- emergency elevation becomes time-boxed.
-- ----------------------------------------------------------------------------
-- Two holes in 0093_trust_engine.sql, found by the Phase 8 completion audit:
--
--   1. trust_audit_logs is the record of every decision Bubaly made and every
--      approval a parent gave — the thing §4 calls "a complete audit trail".
--      0093 lets ANY active member INSERT into it (`trust_audit_insert`) and
--      SELECT all of it (`trust_audit_read`). So a child's session could file
--      rows claiming a parent approved a bank transfer, and could read the
--      reasoning of every decision, which quotes account balances, medical
--      appointment titles and document names back at them. An audit trail that
--      its subjects can write is not an audit trail.
--
--      Every legitimate writer is server code holding the service role
--      (lib/trust/server.ts, lib/ai/tools/execute.ts, lib/services/approvals,
--      the emergency action) — the service role bypasses RLS, so dropping the
--      member INSERT policy costs nothing and closes forgery entirely.
--      Reads narrow to the people who can act on what they show.
--
--   2. emergency_sessions is described by 0093's own header as "time-boxed
--      elevation" and has no expiry: an activation with `ended_at` still null
--      elevates the named domains to `allow` ahead of every deny, policy and
--      risk tier, forever. One tap that nobody remembers to end permanently
--      disables approval for money, medical and documents.
--
-- ADDITIVE + IDEMPOTENT: policies are dropped and recreated, the column and
-- index are `if not exists`, the backfill is bounded to rows still open. Safe
-- to re-run.
-- ============================================================================

-- ─── 1. trust_audit_logs: append-only, and written only by the server ───────
-- No INSERT policy at all. The service-role writers are unaffected by RLS;
-- an authenticated session now has no way to author a decision record.
drop policy if exists trust_audit_insert on public.trust_audit_logs;

-- Reads: the people who set the policies and answer the approvals. A child or
-- guest sees nothing rather than the family's finances explained.
drop policy if exists trust_audit_read on public.trust_audit_logs;
create policy trust_audit_read on public.trust_audit_logs
  for select to authenticated using (public.can_manage_family(family_id));

-- There is still no UPDATE or DELETE policy: the ledger stays append-only.

-- ─── 2. emergency_sessions: elevation that ends by itself ───────────────────
alter table public.emergency_sessions
  add column if not exists expires_at timestamptz not null default (now() + interval '4 hours');

comment on column public.emergency_sessions.expires_at is
  'When this elevation stops applying, whether or not anyone ended it. The trust engine treats a session past this instant as over.';

-- Sessions opened before this migration have no expiry of their own; give them
-- one measured from when they were activated, so an old forgotten activation
-- is already expired rather than newly extended by four hours.
update public.emergency_sessions
   set expires_at = activated_at + interval '4 hours'
 where ended_at is null
   and expires_at > activated_at + interval '4 hours';

-- The loader asks for "open and not yet expired"; index both halves.
drop index if exists idx_emergency_sessions_active;
create index if not exists idx_emergency_sessions_active
  on public.emergency_sessions(family_id, expires_at)
  where ended_at is null;
