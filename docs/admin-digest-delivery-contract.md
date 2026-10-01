# Admin digest: per-recipient delivery contract

Status on 2026-09-30:
- `lib/admin/digest-delivery.ts` exists, and its tests pass against an in-memory store and a fake provider.
- **The PostgreSQL store exists, but is not applied to production.** It is migrations `0471` and `0474` plus `lib/admin/digest-delivery-store.ts`, tested on disposable local databases and in CI's replay.
- **No route uses it by default.** `/api/cron/admin-digest` still sends the way it did unless `ADMIN_DIGEST_DELIVERY_ENGINE=1` (docs/admin-digest-route-integration.md); no environment sets it.
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

### Duties the engine cannot enforce

These came out of an adversarial review of the engine. Each one belongs to the route wiring or to an operator. None is solved here.

- **Normalise recipients before the plan.**
  - `readSuperAdminRecipients` lowercases table addresses but does not trim them.
  - `validatePlan` refuses the **whole occurrence** with a `TypeError` for any of these: a duplicate after trimming, an address that is not one plain address, or more than 200 recipients. Nothing is stored or sent.
  - The route must trim, lowercase and dedupe first. It must also decide whether one bad address refuses the occurrence or is dropped and reported; that is a policy choice. Either way it catches the `TypeError` and answers non-200.
- **Pass the allowlist half of eligibility (`EngineDeps.eligibility`).** Since `0474`, a recipient removed after the freeze is **withdrawn, not sent**:
  - Eligibility is the code/config allowlist ∪ `super_admins`. It is decided at each send's **admission**, inside `beginSend`, for a first send, a retry and a resume alike.
  - The caller answers `allowlisted(recipientKey)` at that moment. The store reads `super_admins` itself, after its row lock, so a removal committed before the admission is always seen.
  - **Ordering boundary:** a removal committed after an admission was granted cannot stop that one dispatch, which must still start before the grant's `dispatchBy`. Every later admission is refused.
  - An unreadable `super_admins`, or an allowlist that throws, fails the admission: nothing is sent and nothing is withdrawn.
- **Do not rotate `RESEND_API_KEY` while any row is `unknown` inside its window.**
  - Resend documents 24-hour key retention, but not whether a key is scoped per API key or per team.
  - If it is per API key, a retry after rotation is a new key, and the provider sends a second copy.
  - 401/403 are retryable because an operator can fix them. That fix must not be a rotation while ambiguous rows are open.
- **Reconciliation is manual, and there is no store step for it yet.**
  - Resend documents no lookup by idempotency key, and an ambiguous row holds no message id. A person checks Resend's logs by recipient, time and subject.
  - `needs_reconciliation` is terminal, and 0471's triggers keep it that way. Recording the answer needs a later, fenced `reconcile` step.
- **`sendEmail` answers `{ ok: true, skipped: true }` when no API key is set.** A provider adapter must map that to a retryable refusal, never to `accepted` or `unknown`.
- **The scheduler prototype's route change must not ship alongside this.** Its key is `admin-digest/<until>/<sha256(raw address)>`; the engine's is `bubaly/admin-digest/v1/<sha256(occurrence)>/<sha256(normalised address)>`. The two never deduplicate each other, so running both inside 24 hours sends twice.

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
| `withdrawn` | The recipient was on neither the allowlist nor `super_admins` at a send's admission (0474). Bytes, key, attempts, the retention anchor and ambiguity are kept. | Terminal. Settled for the occurrence if it was never ambiguous; if an earlier attempt may have been accepted, it needs attention and the occurrence is not complete. Adding the admin back does not revive it; they get the next occurrence. |

**Lease expiry.** When a lease expires, the row's `sendStartedAt` mark decides what happened:
- **Mark present.** The worker may have reached the provider, so the row is `unknown`, ambiguous and sticky.
- **Mark absent.** It cannot have reached the provider, so the row is retried as not sent.

**The mark is checked at the last moment.** `beginSend` is refused in four cases, and a refused `beginSend` sends nothing:
- **`withdrawn`** (0474): the recipient is no longer eligible. Decided after the fence and before every other check; the row is withdrawn for good.
- **`lease_expired`:** the lease has no more than the send deadline left, so another worker could claim mid-send.
- **`retention_passed`:** an ambiguous row reached the cut-off after it was claimed. It is parked.
- **`fenced_out`:** another claim superseded this one.

Together these stop a worker that stalled after its claim from sending late.

**A granted mark is an admission receipt, `{ ok: true, dispatchBy }`.** The provider call must **start** before `dispatchBy`:
- lease expiry minus the send deadline, so the call ends while the lease holds;
- for an ambiguous row, also no later than the first mark plus retention minus margin, so the request reaches the provider before it can forget the key. A row only ever definitively refused has nothing to duplicate.

The engine re-reads its own clock **after** the store answers, in the same synchronous step as the provider call: there is no await between the check and the call, so other queued work cannot spend the budget between them. At or past `dispatchBy` it sends nothing (`dispatch_deadline_passed`), so a mark whose answer arrived late cannot send late. The row keeps its mark and is treated as possibly sent.

**Clock skew.** `dispatchBy` is database time and the engine compares it with the application's clock. Skew between the two must stay well inside both `leaseMs − sendTimeoutMs` and `retentionSafetyMarginMs − sendTimeoutMs`. NTP-level skew does; the defaults are 5 min, 1 h and 15 s.

**Storage bounds: one admitted bound, not two.** 0471 limits `payload_json` to 600,000 and `provider_message_id` to 200 characters, counted as PostgreSQL's `length()` counts them (in code points). The engine applies the same numbers, in the same unit, before anything is stored:
- `freezePlan` refuses a plan whose stored bytes for any recipient exceed `MAX_PAYLOAD_JSON_CHARS`. The 512 KiB HTML byte bound alone is not enough: 300,000 quote characters are 300,000 bytes but serialize to more than 600,000 characters.
- A provider id longer than `MAX_PROVIDER_MESSAGE_ID_CHARS` is **not a receipt**, in both `checkResult` and `decideCompletion`. The row stays `unknown` and is retried under the same key, and the id is never truncated.
- The adapter refuses to send such an id to 0471, whose `left(v_mid, 200)` would truncate it.
- A test asserts that 0471 declares the same two numbers.

**Residual, needs coordination:** a direct privileged call to `admin_digest_complete` with a longer id would still be truncated by the SQL. Making the SQL refuse it too needs a schema change, which I've put to the coordinator.

**Policy bounds.** `validateConfig` refuses, and 0471's functions refuse again, two policies:
- a retention longer than the verified 24 hours;
- a lease of `retention − margin` or more. A worker that dies after its mark holds the row until the lease lapses, so a longer lease would park every such crash instead of retrying it.

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
4. **The fence is a counter.** `fence` increments on every successful claim. `complete` also requires the claim's mark: a claim that never marked a send owns no provider answer.
   - `beginSend` and `complete` are each one `UPDATE … WHERE status = 'in_flight' AND fence = $fence RETURNING`.
   - Zero rows means `fenced_out`, and nothing is written.
   - **A NULL fence never matches.** In SQL, `fence <> NULL` is NULL, and an `IF` on NULL skips its refusal. So 0471 refuses a NULL fence as bad input (`22023`) and compares with `is distinct from`. The adapter sends only a non-negative safe integer. A stale integer such as `0` still reaches the database, which answers `fenced_out`.
   - Owner equality alone is not enough: the same owner can re-claim after its own lease lapsed.
5. **`beginSend` commits before the provider call.** In one step it:
   - evaluates `decideBeginSend`: fence, then eligibility (the caller's `allowlisted` or a `super_admins` row read after the lock; 0474), remaining lease against the send deadline, and the retention cut-off for ambiguous rows;
   - sets `send_started_at`;
   - sets `first_send_at` only if it is null;
   - returns the `dispatchBy` deadline, computed from the locked row.

   A refusal that settles or parks a row (`withdrawn`, `retention_passed`) is written in that same step. The adapter returns only after the commit (`synchronous_commit` on, the default).
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

## 5. Schema: migration `0471` (reserved by the coordinator on #699)

`supabase/migrations/0471_an_admin_digest_reaches_each_admin_once.sql` implements §3. Its tables, guard triggers, grants and the five functions (`admin_digest_freeze`, `_load`, `_claim`, `_begin_send`, `_complete`) are the SQL twins of the pure rules. `lib/admin/digest-delivery-store.ts` is the adapter.

**It is not applied to production.** PROD-DB-0177 blocks every migration there. The shared `docs/PENDING_PROD_MIGRATIONS.md` entry is proposed to the coordinator for reconciliation, not written here.

**`0474` (reserved by the coordinator on #710) extends it** for eligibility at admission, without rewriting 0471:
- a terminal `withdrawn` status, which the guard keeps settled and `admin_digest_claim` refuses;
- `admin_digest_begin_send` with a seventh argument, `p_allowlisted boolean` (NULL is bad input). It reads `super_admins` after the row lock, on every admission.
  - It matches an address trimmed of what JavaScript's `trim` removes, with **ASCII letters only** lowercased (`superAdminTableKey` in the engine is the same rule).
  - It does not use `lower()`, which follows the collation. Libc `C.UTF-8` and ICU `tr-TR` turn U+0130 into a plain "i", so one row could stand in for a different, removed admin (review 5373785714).
  - With ASCII-only folding, a match implies the engine's `trim().toLowerCase()` identity matches. An address that differs only in non-ASCII case cannot be proved equal, does not match, and is withdrawn: the safe side. So store addresses in `super_admins` lowercased;
- the six-argument 0471 `begin_send` is dropped, so nothing can reach a dispatch without the check.

**Evidence:**
- **CI.** `docs/audit/an-admin-digest-reaches-each-admin-once-check.sql` runs on the full migration replay: access refusals, freeze-once, the fence (a NULL fence included), a completion needing a mark, retention parking and frozen identity. `docs/audit/a-removed-admin-is-not-sent-the-digest-check.sql` adds 0474: the one `begin_send` signature, withdrawal under the live fence, the normalised match, the allowlist, ambiguity kept, an unreadable `super_admins`, a stale fence, and a withdrawn row that stays withdrawn.
- **Disposable database.** `tests/admin-digest-delivery-postgres.test.ts` needs `DIGEST_DELIVERY_PG=1` and a local cluster; the `docs/audit/verify-pg.sh` harness is the default. It runs:
  - the store contract suite against PostgreSQL;
  - a differential check in which random steps, applied to the TypeScript rules and to the SQL, must agree after every step;
  - 40 concurrent claims from 40 connections;
  - a clock-after-lock test, with its `now()` counterfactual;
  - backend death mid-claim and mid-receipt;
  - an immediate-mode server restart, which needs `DIGEST_DELIVERY_PG_RESTART_CMD`;
  - two engines at once, and an engine crash then restart;
  - access and immutability;
  - 0474: a removal, and an addition, committed while an admission waits for the row lock are both seen; an engine retry after a removal withdraws instead of sending.

## 6. What is and is not claimed

- **Claimed and tested:**
  - A confirmed accepted recipient is never sent again.
  - Every retry uses the same key and the same bytes.
  - Ambiguous outcomes stop at retention − margin.
  - Conflicts are parked and never re-keyed.
  - Stale workers are fenced out.
  - Crashes before the mark are retried as not sent; crashes after it are retried as ambiguous.
  - Storage failures send nothing without a durable claim and mark.
  - A worker that stalls between its claim and its mark cannot send after its lease, or after the retention cut-off.
  - A recipient on neither the allowlist nor `super_admins` at a send's admission is withdrawn, not sent, on a first send, a retry or a resume; a stale worker cannot withdraw.
- **Tested on local PostgreSQL 16:**
  - atomic claims under 40 concurrent connections;
  - a claim decided on the clock read after its row lock;
  - no partial state when a backend dies mid-claim or mid-receipt;
  - a committed receipt surviving an immediate-mode restart;
  - the SQL rules agreeing with the TypeScript rules step for step;
  - the access refusals and frozen identity above.
- **Not claimed:**
  - Exactly-once delivery. The provider's key deduplication, inside its window, is what makes an ambiguous retry harmless.
  - That a removal stops a dispatch already admitted. It cannot: the boundary is the admission, and that dispatch is bounded by its `dispatchBy`.
  - Any behaviour of the production database. Neither 0471 nor 0474 is applied there.
  - Anything about production at all. It is not wired, and production cron is not running (see the scheduler report).
