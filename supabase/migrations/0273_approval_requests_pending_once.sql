-- 0273_approval_requests_pending_once.sql — one pending approval per request,
-- however many times the phone sends it.
--
-- `openApprovalRequest` is an unguarded INSERT and nothing on this table stops a
-- second identical row. So a chat message that gets resent — a flaky connection
-- mid-answer, a double-tapped send, a reloaded tab, Bubaly's own retry — files
-- TWO pending approvals for one intent. A parent sees two identical cards,
-- approves both because they look like the same thing they wanted, and the
-- resource is written twice.
--
-- That is where a gated family's duplicate actually comes from. The tool ledger's
-- idempotency reservation cannot help here at all: `executeTool` returns
-- `pending_approval` at step 3, BEFORE the reservation at step 4 — so for every
-- family that turned approvals on, the protection §30 describes has never been
-- reached.
--
-- `dedupe_key` is a hash the application computes over what makes two requests
-- the same action: domain, capability, who asked, and the full payload. It is
-- NULLABLE and the index is partial on both counts:
--
--   * `where status = 'pending'` — a decided request is history. Asking again
--     for something already approved is a new request, and must be allowed.
--   * `where dedupe_key is not null` — every existing row has none, and a caller
--     that supplies none keeps exactly today's behaviour rather than colliding
--     with every other keyless row in the family.
--
-- Additive and idempotent.

alter table public.approval_requests add column if not exists dedupe_key text;

comment on column public.approval_requests.dedupe_key is
  'Application-computed hash of (domain, capability, asker, payload). Two pending rows in one family may not share it — see 0273.';

create unique index if not exists approval_requests_pending_once
  on public.approval_requests (family_id, dedupe_key)
  where status = 'pending' and dedupe_key is not null;
