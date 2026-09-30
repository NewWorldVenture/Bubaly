# Admin digest: per-recipient delivery contract

Status on 2026-09-30:
- `lib/admin/digest-delivery.ts` exists, and its tests pass against an in-memory store and a fake provider.
- **No route uses it.** `/api/cron/admin-digest` still sends the way it did.
- **Nothing is stored in a database.** No migration exists or is proposed as a file (the proposed schema is §5).
- Duplicate admin digests are **not** fixed in production.

This document is what the next two pieces must meet: a PostgreSQL store adapter and the route wiring.

## 1. What the caller owns, and what it passes in

The engine does not schedule. The caller (the cron route, later) decides and passes:

| Input | Meaning | Caller's duty |
|---|---|---|
| `occurrenceId` | Stable for every retry of one digest, e.g. `admin-digest:<scheduled instant>` | The same occurrence always gets the same id. The window policy (#677 C5: no activity row in two digests) is the caller's, not the engine's. |
| `window` | `{ start, end }`, recorded only | Chosen by the caller's scheduler. |
| `recipients` | Frozen list of addresses | Read with `readSuperAdminRecipients` (#685), which fails closed. An unreadable or empty list never reaches the engine; the engine also refuses an empty list. |
| `payload` | Exactly `{ from, subject, html }` | Rendered once. It is non-secret by construction: no headers and no credentials, and any other field is refused. |

`deliverDigestOccurrence(plan)` stores the plan the first time it sees the occurrence. On every later call the **stored** plan is used. A recomputed plan with a different body or different recipients is reported in `planMismatch` and is never merged or sent. `resumeDigestOccurrence(id)` continues from stored state alone.

## 2. Per-recipient states

| Status | Meaning | Next |
|---|---|---|
| `pending` | Frozen, never claimed | Claim |
| `in_flight` | Claimed under a lease, fence *n* | `complete`, or lease expiry (below) |
| `failed` | The provider answered and did not accept; the answer can be retried (429, 401/403); and **no** earlier attempt was ambiguous | Claim, any time, same key and bytes |
| `unknown` | Might have been accepted: timeout, network error, 5xx, 409 `concurrent_idempotent_requests`, 2xx without an id, lost receipt; or a retryable refusal after an earlier ambiguous attempt | Claim, same key and bytes, **only while** `now < firstSendAt + retention − margin` |
| `accepted` | A 2xx **with** a message id | Terminal. Never sent again. |
| `rejected` | Final refusal (400, 422), nothing possibly accepted before it | Terminal, needs attention |
| `conflict` | 409 `invalid_idempotent_request`: the key was used for other bytes | Terminal, needs attention. The key is never changed. |
| `exhausted` | `maxAttempts` used, nothing ever possibly accepted | Terminal, needs attention |
| `needs_reconciliation` | Possibly accepted, and a retry is no longer safe (retention passed, attempts used up, or a final refusal after an ambiguous attempt) | Terminal. A person checks the provider by key. |

**Lease expiry.** When a lease expires, the row's `sendStartedAt` mark decides what happened:
- **Mark present.** The worker may have reached the provider, so the row is `unknown`, ambiguous and sticky.
- **Mark absent.** It cannot have reached the provider, so the row is retried as not sent.

**The mark is checked at the last moment.** `beginSend` is refused in three cases, and a refused `beginSend` sends nothing:
- **`lease_expired`:** the lease has no more than the send deadline left, so another worker could claim mid-send.
- **`retention_passed`:** an ambiguous row reached the cut-off after it was claimed. It is parked.
- **`fenced_out`:** another claim superseded this one.

Together these stop a worker that stalled after its claim from sending late.

**Keys.** A key is `bubaly/admin-digest/v1/<sha256(occurrenceId)[0,32]>/<sha256(recipient)[0,32]>`:
- It is a function of occurrence and recipient only.
- It contains no address.
- It fits Resend's rule (and #692's check): printable ASCII, 1–256 characters.

**Bytes.** The stored `payloadJson` is `{"from","to","subject","html"}` in that order. This is byte-identical to the body `sendEmail` builds when there is no `reply_to`.

## 3. Database adapter requirements (exact)

A PostgreSQL `DigestDeliveryStore` must meet all of these. It must also pass `tests/helpers/digest-delivery-store-contract.ts` against the local Supabase stack. The in-memory store passing that suite proves only the **rules**, not durability or isolation.

1. **`freeze` is one transaction.** Insert the occurrence and every delivery row, or nothing. Use `INSERT … ON CONFLICT (occurrence_id) DO NOTHING` on the occurrence and insert deliveries only if that insert won. In the same transaction, return what is stored. A concurrent loser must get the winner's plan, never a mix of the two.
2. **`claim` is one transaction on one row.** Take `SELECT … FOR UPDATE` on `(occurrence_id, recipient_key)`, evaluate exactly `decideClaim`, write `next`, and commit. A refusal that parks a row (`exhausted`, `needs_reconciliation`) is also written. `READ COMMITTED` plus the row lock is enough; no advisory locks and no `app_settings`.
3. **The database clock decides.** Lease expiry, the new lease and the retention cut-off are all evaluated with the database's clock.
   - **Which clock:** `clock_timestamp()` read **after** the row lock is taken. `now()` is the transaction's start and can lag behind a lock wait.
   - **One function:** read it through a single function, e.g. `admin_digest_now()`, so the local test harness can pin it for the contract suite.
   - **Never the caller's time:** no timestamp the caller sends is used.
   - **Parameters:** retention, margin, lease, send deadline and max attempts are passed in, not hard-coded. The engine refuses a retention longer than the verified 24 hours.
4. **The fence is a counter.** `fence` increments on every successful claim.
   - `beginSend` and `complete` are each one `UPDATE … WHERE status = 'in_flight' AND fence = $fence RETURNING`.
   - Zero rows means `fenced_out`, and nothing is written.
   - Owner equality alone is not enough: the same owner can re-claim after its own lease lapsed.
5. **`beginSend` commits before the provider call.** In one step it:
   - evaluates `decideBeginSend`: fence, remaining lease against the send deadline, and the retention cut-off for ambiguous rows;
   - sets `send_started_at`;
   - sets `first_send_at` only if it is null.

   A refusal that parks a row (`retention_passed`) is written in that same step. The adapter returns only after the commit (`synchronous_commit` on, the default).
6. **Frozen means immutable.** `recipient_key`, `idempotency_key`, `payload_json` and `payload_hash` never change after insert. Enforce this with a trigger, not only in code. `idempotency_key` is unique across the table. `payload_hash = sha256(payload_json)` is checked on insert.
7. **Every predicate names the occurrence.** Each read and write is keyed by `(occurrence_id, recipient_key)`. The same recipient in two occurrences is two independent rows; the contract suite checks this.
8. **Row invariants are checks.** `status = 'in_flight'` if and only if there is a lease. `status = 'accepted'` if and only if `provider_message_id` is set. `send_started_at` is set only while `in_flight`. `ambiguous` is never reset from true to false.
9. **Access.** RLS on and no policies. Revoke all from `anon` and `authenticated`. Functions are `security definer`, with `search_path = public` and execute revoked from `public`, `anon` and `authenticated`. Only the service role calls them.
10. **Errors surface.** Any error or timeout is thrown to the engine, never swallowed as "not found". The engine treats each failure per step: it sends nothing without a durable claim and mark, and reports a receipt it could not confirm as `receipt_write_unconfirmed`, with the provider's message id.

What the contract suite **cannot** show with the in-memory store: crash durability, isolation under real concurrent transactions, and clock behaviour. Those need the PostgreSQL run in requirement 3 plus a kill-mid-transaction test on the local stack.

## 4. Provider adapter requirements

The engine takes a `DigestEmailProvider` whose `send` returns one classified outcome. For Resend, `classifyResendResponse` (tested) maps HTTP status and body:

| Resend answer | Outcome | Engine |
|---|---|---|
| 2xx with `id` | `accepted` | Receipt; never resent |
| 2xx without `id` | `unknown` | Ambiguous |
| 409 `invalid_idempotent_request` | `payload_conflict` | `conflict`; never re-keyed |
| 409 `concurrent_idempotent_requests`, or another 409 | `in_progress` / `unknown` | Ambiguous |
| 429 | `rejected`, retryable | `failed` |
| 401, 403 | `rejected`, retryable (an operator can fix the key or the domain) | `failed`, bounded by `maxAttempts` |
| Other 4xx (400 `invalid_idempotency_key`, 422) | `rejected`, final | `rejected`, or `needs_reconciliation` if an earlier attempt was ambiguous |
| 5xx, timeout, network error, a throw | `unknown` | Ambiguous |

**#692's `sendEmail` (merged 2026-09-30) is not enough on its own.** It sends the `Idempotency-Key` header, but answers only `{ ok }`, which cannot carry a message id or tell a conflict from a refusal. The adapter must read the status and body (bounded), then classify them here. It must:
- send `payloadJson` verbatim as the body;
- send the row's key unchanged;
- honour the abort signal.

**Retention.** `RESEND_KEY_RETENTION_MS` is 24 hours, from Resend's documentation re-checked on 2026-09-30. Recommended margin: 1 hour, which must exceed the send deadline plus clock skew. Re-verify before changing provider or value. What Resend does with a key after a refused request is undocumented. The engine never relies on it: a refusal is retried with the same key, and the 24-hour window is anchored on the first send of any kind.

## 5. Proposed schema (proposal only, no migration number)

**No migration will be added** until the coordinator reserves a number. Main ends at `0464`. `0465` and NWV's locale work must be coordinated first. This also cannot reach production before the PROD-DB-0177 migration-ledger remedy.

```sql
create table public.admin_digest_occurrences (
  occurrence_id  text primary key check (occurrence_id ~ '^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$' and length(occurrence_id) <= 200),
  window_start   timestamptz not null,
  window_end     timestamptz not null check (window_end > window_start),
  recipient_keys text[] not null check (cardinality(recipient_keys) between 1 and 200),
  payload_hash   text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  engine_version integer not null,
  frozen_at      timestamptz not null default now()
);

create table public.admin_digest_deliveries (
  occurrence_id       text not null references public.admin_digest_occurrences (occurrence_id) on delete restrict,
  recipient_key       text not null check (recipient_key ~ '^[0-9a-f]{64}$'),
  idempotency_key     text not null unique check (length(idempotency_key) between 1 and 256),
  payload_json        text not null,
  payload_hash        text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status              text not null check (status in ('pending','in_flight','failed','unknown','accepted','rejected','conflict','exhausted','needs_reconciliation')),
  attempts            integer not null default 0 check (attempts >= 0),
  fence               bigint  not null default 0 check (fence >= 0),
  lease_owner         text,
  lease_expires_at    timestamptz,
  send_started_at     timestamptz,
  first_send_at       timestamptz,
  ambiguous           boolean not null default false,
  provider_message_id text,
  last_error          text check (last_error is null or length(last_error) <= 200),
  updated_at          timestamptz not null default now(),
  primary key (occurrence_id, recipient_key),
  check ((status = 'in_flight') = (lease_owner is not null and lease_expires_at is not null)),
  check ((status = 'accepted') = (provider_message_id is not null)),
  check (send_started_at is null or status = 'in_flight'),
  check (not ambiguous or first_send_at is not null)
);
-- + trigger: payload_json, payload_hash, idempotency_key, recipient_key, occurrence_id are immutable;
--   payload_hash = encode(sha256(convert_to(payload_json, 'UTF8')), 'hex') on insert; ambiguous never true → false.
-- + RLS on, no policies; revoke all from anon, authenticated.
-- + security-definer functions (execute revoked from public, anon, authenticated), each mirroring one rule:
--   admin_digest_freeze(p_occurrence jsonb, p_deliveries jsonb) returns jsonb
--   admin_digest_claim(p_occurrence_id text, p_recipient_key text, p_owner text, p_lease_ms int,
--                      p_max_attempts int, p_retention_ms bigint, p_margin_ms bigint) returns jsonb   -- decideClaim
--   admin_digest_begin_send(p_occurrence_id text, p_recipient_key text, p_fence bigint, p_min_lease_ms int,
--                           p_retention_ms bigint, p_margin_ms bigint) returns text  -- decideBeginSend: ok | fenced_out | lease_expired | retention_passed
--   admin_digest_now() returns timestamptz  -- clock_timestamp(); the one clock the local test harness pins
--   admin_digest_complete(p_occurrence_id text, p_recipient_key text, p_fence bigint,
--                         p_result jsonb, p_max_attempts int) returns boolean                          -- decideCompletion
```

## 6. What is and is not claimed

- **Claimed and tested:**
  - A confirmed accepted recipient is never sent again.
  - Every retry uses the same key and the same bytes.
  - Ambiguous outcomes stop at retention − margin.
  - Conflicts are parked and never re-keyed.
  - Stale workers are fenced out.
  - Crashes before the mark are retried as not sent; crashes after it are retried as ambiguous.
  - Storage failures send nothing without a durable claim and mark.
- **Not claimed:**
  - Exactly-once delivery. The provider's key deduplication, inside its window, is what makes an ambiguous retry harmless.
  - Anything about PostgreSQL durability or isolation.
  - Anything about production. It is not wired, and production cron is not running (see the scheduler report).
