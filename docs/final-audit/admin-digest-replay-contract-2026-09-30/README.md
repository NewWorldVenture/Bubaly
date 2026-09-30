# Admin digest replay: characterization and the unmet idempotency contract

Evidence for **API-96040DFB5635** (`GET /api/cron/admin-digest`) and **JOB-EF2453D9F633** (`/api/cron/admin-digest`).

**Status: UNRESOLVED.** Duplicate delivery is **not fixed**. This change adds tests and evidence only:
- no product code, shared helper, migration, schedule or setting was changed;
- `finalaudit.md` was not edited;
- no email was sent and no provider was called.

| | |
|---|---|
| Tested source | `main` at `231e8140ea8394c2106c37f617b33b5fb5e8e569` |
| Handler | `app/api/cron/admin-digest/route.ts`, blob `7d139eea`, last changed in `b7187368` (2026-09-27) |
| Date | 2026-09-30 |

## What was already covered (checked first)

No test executed the handler before this change.

| File | What it covers | Kind |
|---|---|---|
| `tests/admin-digest.test.ts` | `buildAdminDigest`, `buildHeadline`, `digestSubject`, `renderAdminDigestHtml`, `summarizeDigestDelivery` | pure-function unit tests |
| `tests/admin-digest.test.ts` | The route's source text contains `readAll<DigestRow>(`, `{ max: 20_000 }`, `if (feedError)` before `buildAdminDigest(` with `{ status: 502 }`, and `summary.ok ? 200 : 502` | static source checks |
| `tests/a-mirrored-cron-must-be-idempotent.test.ts` | Lists admin-digest in `KNOWN_DOUBLE_SEND`: both schedulers name `30 12 * * *`, and the route source has no dedupe marker | static; schedules and source text |
| `tests/a-late-tick-drops-a-cron.test.ts` | The dispatcher's 5-minute look-back (mentions the admin-digest duplicate) | dispatcher only |

**Gaps before this change:**
- Paging, the truncation → 502 path and the partial-failure → 502 mapping were pinned only as source text, never run.
- Nothing measured how many emails a repeat, a concurrent run or a retry produces.
- Nothing exercised refusal, the empty-recipient branch, a recipient-lookup failure, or a provider that accepts and then times out.

## How to run

```bash
# Characterization of current behaviour: collected by `npm test`; every case passes.
npx vitest run tests/admin-digest-replay-contract.test.ts

# The desired contract: NOT collected by `npm test`. The control passes; C1–C6 fail on current main.
npx vitest run --dir docs/final-audit/admin-digest-replay-contract-2026-09-30
```

The saved outputs are `characterization-output.txt` (19/19 pass) and `desired-contract-output.txt` (1 pass, 6 fail). Both runs also pass or fail identically under `TZ=America/Los_Angeles`.

**What is real in both files:**
- the handler, `lib/server/cron-auth.ts`, `lib/supabase/read-all.ts`, `allSuperAdminEmails`, `superAdminEmails`, `lib/admin/digest.ts`;
- `sendEmail` down to its `fetch`.

**What is fake:**
- **Database:** `tests/helpers/in-memory-supabase.ts`, with `maxRows` standing in for PostgREST's `db-max-rows`.
- **Clock:** `Date` only.
- **Translations:** identity, so error bodies carry keys.
- **Resend:** a stub for global `fetch`. It records each POST (recipient, subject, HTML, `Idempotency-Key` header) and whether it accepted it, and it fails the test on any other URL.
- **Recipients:** two, a built-in admin (**admin-1**) and one `super_admins` row (**admin-2**). Addresses are aliased so no output prints one.

## Measurements (current `main`)

"Attempted" counts calls that reached the fake provider. "Accepted" counts messages the **fake** provider accepted, which is this test's stand-in for delivery; no inbox delivery was demonstrated and no real provider was called. Counts are given as admin-1 / admin-2.

| Scenario | Calls | Status codes | Handler says | Attempted | Accepted | DB writes |
|---|---|---|---|---|---|---|
| **Sequential repeat**, same 12:30 instant | 2 | 200, 200 | `sent 2` twice | 2 / 2 | **2 / 2** (identical subject and HTML) | 0 |
| **Repeat in the dispatcher window**: Vercel 12:30, GitHub 12:33 | 2 | 200, 200 | `total 1`, then `total 2` | 2 / 2 | **2 / 2**; the 08:00 row is reported in both | 0 |
| **Concurrent**: both workers finish reading before either sends | 2 | 200, 200 | `sent 2` each | 2 / 2 | **2 / 2** | 0 |
| **One recipient refused** after the other succeeded, then a retry | 2 | 502, 200 | `sent 1, failed 1`, then `sent 2` | 2 / 2 | **2** / 1 | 0 |
| **Network error before acceptance** for one recipient, then a retry | 2 | 502, 200 | as above | 2 / 2 | **2** / 1 | 0 |
| **Accepted, then the client timed out** for one recipient, then a retry | 2 | 502, 200 | `sent 1, failed 1` (the fake provider accepted both) | 2 / 2 | **2 / 2** | 0 |
| **Partial-delivery status**: none, one or both refused | 3 | 200, 502, 502 | `ok true/false/false`; `sent 2/1/0`; `failed 0/1/2` | 3 / 3 | 2 / 1 | 0 |
| **Unauthorised**: no header; wrong secret; no `Bearer`; secret unset with `Bearer undefined`, `Bearer ` or the right token | 6 | 401 ×6 | — | 0 | 0 | 0 reads |
| **Quiet day** (no rows in the last 24 h) | 1 | 200 | `sent 0, total 0` | 0 | 0 | `super_admins` not read |
| **Empty recipients** (lookup replaced) | 1 | 200 | `sent 0, total 2, reason: no super-admin recipients` | 0 | 0 | — |
| **Duplicate recipient** (env and table, different case) | 1 | 200 | `recipients 2` | 1 / 1 | 1 / 1 | — |
| **No `RESEND_API_KEY`** | 1 | 200 | `ok true, sent 0, skipped 2` | 0 | 0 | — |
| **Paging**: 2,345 rows, all tied on `created_at` and `title`, under a 1,000-row server cap | 1 | 200 | `total 2345` | 1 / 1 | 1 / 1 | 4 feed reads |
| **Exactly 20,000 rows** | 1 | 200 | `total 20000` | 1 / 1 | 1 / 1 | — |
| **20,001 rows** (over `max`) | 1 | 502 | `notificationFeedUnavailable` | 0 | 0 | `super_admins` not read |
| **Feed page 1 fails** | 1 | 502 | `notificationFeedUnavailable` | 0 | 0 | — |
| **Feed page 3 fails** (after two good pages) | 1 | 502 | `notificationFeedUnavailable` | 0 | 0 | 3 feed reads |
| **`super_admins` read returns an error** | 1 | **200** | `ok true, sent 1, recipients 1` | 1 / 0 | 1 / 0 | — |
| **`super_admins` read throws** | 1 | **200** | `ok true, sent 1, recipients 1` | 1 / 0 | 1 / 0 | — |

## Current behaviour vs the desired contract

| | Current `main` (characterized, passing) | Desired contract (`tests/desired-contract.test.ts`, failing) |
|---|---|---|
| Unit of work | "The last 24 h before now." Nothing identifies an occurrence. | One scheduled occurrence: `(route, 12:30 UTC of day D)`. |
| Second call for the same occurrence | Sends again: 2 per admin (**C1**). | Sends nothing: 1 per admin. |
| Two concurrent calls | Both send: 2 per admin (**C2**). | Exactly one worker holds the claim and sends: 1 per admin. |
| Retry after a partial failure | Re-sends to everyone, so the admin who had it gets 2 (**C3**). | Retries only recipients without an accepted receipt. |
| Accepted, then timed out | Reported `failed`; the retry re-sends with no key (**C4**). | Recorded as *unknown*; exactly one retry to that recipient, with the same non-empty `Idempotency-Key` and the same request payload; others are not re-sent. |
| Window between runs | Overlapping or gapped, depending on when the call lands; a row can appear in two digests (**C5**). | Contiguous: `[previous occurrence, this occurrence)`, so each row appears in one digest. |
| Recipient list unreadable | Swallowed; answers **200 ok** having emailed only the built-in admin (**C6**). | Not a clean success: fail or report degraded, so the scheduler or operator can see it. |
| Records written | None, before or after a send. | A durable claim per occurrence and a receipt per recipient (see below). |

**C1–C6 fail on current main.** The control case (one on-time run → 1 per admin) passes, so the failures come from the handler, not from the fixture. These are the acceptance tests for a fix. Move them into `tests/`, adapting imports and fixtures to the fixed route where needed, but keep every behavioural requirement and do not weaken any assertion.

## What the scheduler needs to meet that contract

1. **A durable claim per occurrence**, keyed `(route, scheduled_for)`, taken before any send. It needs:
   - an owner token and a lease that outlives the function's maximum duration;
   - a finish that is fenced by the owner, so a worker that lost its lease writes nothing.
   A second call for a finished occurrence sends nothing. A concurrent call is refused while the lease is live. This closes C1 and C2.
2. **A high-water mark:** the last completed occurrence. The window is `[that occurrence, this occurrence)`, not `now − 24h`. This closes C5, and keeps a late or missed day from being lost or double-counted.
3. **A receipt per recipient**, keyed `(occurrence, recipient)`, written as `pending` before the send. It then becomes one of:
   - `accepted`, with the provider's message id;
   - `failed`, for a clean refusal or a network error before acceptance;
   - `unknown`, for a timeout after the request was sent.
   A retry sends only to `pending`, `failed` and `unknown` receipts. This closes C3.
   The receipt also stores the **rendered payload** (subject and HTML) the first attempt sent, and a retry resends exactly that. A fixed window does **not** freeze its inputs: a row can be committed late inside the window, and a template, a title or a recipient's name can change between attempts. So a retry that re-renders can legitimately differ.
4. **A stable idempotency key** per `(occurrence, recipient)`, sent as the `Idempotency-Key` header. `sendEmail` has no way to pass one today, so this is a small shared-helper change and not part of this PR. Resend's documented rules (re-checked 2026-09-30):
   - the key must be 1–256 characters, otherwise 400 `invalid_idempotency_key`;
   - the key is kept for 24 hours;
   - the same key with the same payload returns the original response, which carries the email ID, and sends nothing new;
   - the same key with a **different** payload returns 409 `invalid_idempotent_request`;
   - while the first request is still running, the key returns 409 `concurrent_idempotent_requests`, which is a distinct, retryable condition.

   Source: https://resend.com/docs/dashboard/emails/idempotency-keys#possible-responses

   With a frozen payload (item 3), a retry under the same key is identical to the original, and the provider can fold it. Only a success response, which carries an email ID, establishes that the provider accepted a message.
   - A 409 `invalid_idempotent_request` under the sender's own key is a **payload conflict**, not proof of delivery. It does not establish that the intended frozen message was accepted, so the receipt stays **unresolved** (an error, reported) until it is reconciled against the frozen original request and an actual successful receipt. The sender must neither infer "sent" nor rotate to a fresh key, since a new key would bypass the provider's protection and could send a second copy.
   - A 409 `concurrent_idempotent_requests` is retried later under the same key.

   Resend does not document whether a key is kept for a request it *refused*, and that was not measured here. This closes C4 only within the 24-hour retention and only while the provider honours the key.
5. **Honest status:**
   - an unreadable recipient list is not `200 ok` (C6);
   - `unknown` receipts are reported separately from `failed`.

**Delivery guarantee, stated honestly:**
- With 1–5 in place: **at least once per recipient**, and **effectively once** while the provider honours the key.
- A crash after the provider accepted a message but before the receipt was written, retried after the key expires, can still duplicate.
- Exactly-once is not claimed.

A locally tested prototype of 1–2 (an `app_settings` cursor, no migration) and of the key header is in the separate scheduler-reliability hand-off. It is not in this PR. A per-recipient receipt table (3) would need a migration, whose number is not allocated here.

## Other findings from this run

- **A `super_admins` read error is invisible.**
  - `allSuperAdminEmails` destructures only `data`, so a PostgREST error resolves to "no table rows", and only a thrown error reaches its `catch`.
  - Either way the digest goes to the env/built-in list alone and the run answers **200 ok**.
  - Characterized in two tests, reproduced as C6.
- **No `RESEND_API_KEY` reports success.** The run answers `200 {ok: true, sent: 0, skipped: 2}` although nothing was sent. This matches the body recorded in JOB-EF2453D9F633.
- **An accepted-then-timed-out send is reported as `failed`.** The 502 invites a retry that duplicates the message for every recipient, not only the ambiguous one.
- **The empty-recipient branch is unreachable today:** `superAdminEmails()` always contains the built-in admin. The test reaches it only by replacing the lookup.
- **The paging holds under a server cap:**
  - 2,345 rows, all tied on `created_at` and `title`, are counted exactly in 4 reads (the last read is empty and proves the end).
  - 20,000 rows complete; 20,001 answer 502 before any recipient lookup or send.
  - A failure on page 3 discards the first two pages and sends nothing.

## Negative controls (the characterization has teeth)

Each change was made to the route in a scratch checkout only, and then reverted.

| Change to the handler | Result |
|---|---|
| Always answer 200 | 4 failed: both one-recipient-fails cases, accept-then-timeout, partial-delivery status |
| An in-process "already sent today" set in front of the send | 12 failed, including sequential repeat, repeat in the window, concurrent and both retry cases. The set persists across tests, hence the extra failures. |
| Read only the first page instead of paging | 3 failed: 2,345-row paging, the 20,000/20,001 ceiling, the page-3 failure |

**Controls on the contract tests themselves** (added after review at `05e86565`). Each was run in a scratch directory or checkout and then removed:

| Check | Result |
|---|---|
| **C4 on zero attempts to the ambiguous recipient.** The earlier assertions compared `undefined` with `undefined`. | The earlier assertions **passed** vacuously. The current ones **fail**: they require exactly two attempts, a non-empty string key, equal keys and an identical request payload. A retry with a different payload also fails, and the true contract case passes. |
| **C2 against a route that takes a claim before any read**, so the loser exits early | The earlier barrier, which needed both callers to reach the recipient read, **hung** until the test timed out. The current bounded barrier also opens when either call settles, or after 1 s, and C2 **passes** with one digest per admin. |
| C1–C6 on current main after these changes | All 6 still **fail** and the control passes. C4 now fails on the key assertion (`expected 'object' to be 'string'`) after confirming the retry happened, rather than on an absent attempt. |

## Limitations

- **Crashes and timeouts are modelled at the `fetch` boundary.** "Accepted, then timed out" is a `TimeoutError` thrown after the stub records acceptance. It is not a 15-second wait on the real `AbortSignal.timeout`. A process killed in the middle of the send fan-out, with some recipients sent and others not, was not injected separately.
- **Concurrency is a deterministic barrier** on the recipient read, the last read before the fan-out. It shows the worst case is reachable, not how often it happens. Separate processes interleave arbitrarily.
- **The fake database sorts stably,** so the tie test proves every row is counted across pages. It does not prove that `.order('id')` is needed: a nondeterministic server order is not modelled.
- **Resend is modelled from its documentation, not called.** Rate limits, bounces and key retention were not measured.
- **Nothing here touched production.** `finalaudit.md` records `CRON_SECRET` as unset in production, and the latest observed GitHub dispatch exits before dispatching. With the secret unset the route answers 401 to every call, as the unauthorised case shows, so today the digest does not run at all. Once the secret is set, both schedulers fire at 12:30 UTC and the sequential-repeat row above applies every day a GitHub tick lands in the 12:30–12:34 window.
