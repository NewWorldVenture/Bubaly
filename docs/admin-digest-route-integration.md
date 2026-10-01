# Admin digest: route integration of the delivery engine (draft)

Status on 2026-10-01: a **draft**, stacked on #699 (engine, adapter and migration `0471`), with migration `0474` added here.
- **Off by default.** `/api/cron/admin-digest` behaves exactly as before unless `ADMIN_DIGEST_DELIVERY_ENGINE=1`. No environment sets it.
- **Needs `0471` and `0474`,** neither of which is applied to any production database (PROD-DB-0177 blocks every migration there).
- **Nothing here sends email.** Every test uses a synthetic Resend over a stubbed `fetch`.
- **Duplicate admin digests are not fixed in production.** That needs the gates in §6, then database and route verification in a real environment.

## 1. What the flag switches on

| Piece | File | What it does |
|---|---|---|
| Occurrence | `lib/admin/digest-occurrence.ts` | Maps "now" to one scheduled slot and its window (§2). |
| Recipients | same | Trims, lowercases and de-duplicates the #685 list before the engine sees it (§3). |
| Provider | `lib/admin/digest-provider.ts` | Resend over `fetch`. It posts the row's stored bytes verbatim under the row's key, honours the engine's abort signal, reads a bounded answer and classifies it with the engine's tested `classifyResendResponse`. |
| Route logic | `lib/admin/digest-engine-route.ts` | Reads the slot's window, builds the digest, freezes or loads the plan, runs the engine on the `0471` + `0474` store with the code/config allowlist as the application's half of eligibility (§3), and answers with counts only: no address, key or body. |
| Route | `app/api/cron/admin-digest/route.ts` | One branch after cron authorization, taken only when the flag is `"1"`. |

With the flag on and no `RESEND_API_KEY`, the route answers `503 email_provider_not_configured` and freezes nothing.

## 2. Scheduling: PROPOSED, needs a decision

**Proposal (implemented).**
- An occurrence is the **most recent `30 12 * * *` slot at or before now**. That is the schedule in both `vercel.json` and `scripts/cron-dispatch.mjs`, and a test pins that they agree.
- Its window is the 24 hours that **end at the slot**. The digest is labelled by the slot's date, not the clock, so every tick renders the same bytes.

**Consequences, all tested:**
- A late tick (the GitHub dispatcher has run 6 h late) and a second scheduler for the same slot find the same occurrence, so each admin gets that slot's digest at most once.
- Windows abut, so no activity row is in two digests (#677 C5).
- Activity written after the slot goes to the next slot's digest.

**Open decisions:**
1. **Catch-up across slots.** A tick only ever works on the *current* slot. If a whole slot is missed (an outage past the next slot), or its failed rows are never retried within the slot, that slot's digest is **never sent**; nothing resumes an older occurrence. The engine can resume one (`resumeDigestOccurrence`). Whether to do that, how far back, and with what staleness limit is a product and scheduler decision.
2. **Retries within a slot need another tick.** An incomplete run answers non-2xx, but neither Vercel cron nor the GitHub dispatcher retries on its own today (see the scheduler report). Whether to add a same-slot retry tick, and how often, belongs to the scheduler work.
3. **The feed is read so that no row is counted twice** (implemented; review P2). OFFSET paging could re-read a row when another became visible between pages, and freeze an invented count. The read is keyset: newest first by `(created_at, id)`, each page strictly after the last row read, de-duplicated by id.
   - **Late-arrival policy:** a row that becomes visible mid-read is counted only if it sorts after the cursor; otherwise it is left for a retry, which reports `planMismatch.payloadChanged`.
   - The route's feed is not one database snapshot. Every counted row exists and is counted once.
4. **Late activity inside a frozen window.** A row written after the slot's plan was frozen, but timestamped inside its window, is in **no** digest. The next window starts at the slot. The route reports it as `planMismatch.payloadChanged`, and the frozen bytes are still what is sent. Is that acceptable, or should late rows roll into the next digest?
5. **Schedule changes.** If the cron expression changes, `ADMIN_DIGEST_SCHEDULE` must change with it; the test fails until it does. A slot boundary that moves mid-day would create a new occurrence.

## 3. Recipients

**Implemented:**
- The #685 reader, which fails closed on an unreadable list, then normalisation.
- An address the engine cannot use (not one plain address, or more than 200 recipients) **refuses the whole occurrence** before anything is stored or sent: `502 plan_refused`, and the message names the rule, not the address. This follows #685's fail-closed stance, and it means **no admin** gets that slot's digest while one bad row exists in `super_admins`.

**Open decisions:**
1. **Refuse vs drop.** Should one bad address block every admin, or be dropped and reported?
2. **An admin added after the freeze** does not get that slot's digest (`recipientsAdded` is reported). They get the next one.

**An admin removed after the freeze is withdrawn, not sent (implemented in `0474`, as proposed under owner review 5372985996).** This is the fix for that activation hold; the hold stands until this is reviewed.
- **Eligibility** is the code/config allowlist (`superAdminEmails()`: built-in plus `SUPER_ADMIN_EMAILS`) ∪ `super_admins`. It is decided at **dispatch admission**, inside `admin_digest_begin_send`, for a first send, a retry and a resume alike.
  - The route answers the allowlist half, read again at every admission, so a `SUPER_ADMIN_EMAILS` change is seen by the next send.
  - The database reads `super_admins` itself, **after the row lock**, so a removal committed before the admission is always seen.
- **An ineligible row** becomes a terminal `withdrawn` under the live fence. Its bytes, key, attempts, retention anchor and ambiguity are kept, so a send that may already have been accepted is never relabelled as undelivered. A stale worker is fenced out before eligibility is read, so it cannot withdraw.
- **What the route answers:**
  - a withdrawn row that was never ambiguous is settled: the slot can be `complete` (200) with it, counted under `statuses.withdrawn`;
  - a withdrawn row an earlier attempt may have reached counts in `needsAttention`, and the slot is not complete (502).
- **An unreadable `super_admins`** at admission fails that admission: nothing is sent and nothing is withdrawn (502, `storageErrors`).
- **Ordering boundary:** a removal committed after an admission was granted cannot stop that one dispatch. It must still start before the grant's `dispatchBy` (lease minus the send deadline: under 5 minutes with the values in §4). Every later admission is refused.
- **Withdrawal is final for the occurrence.** Adding the admin back does not revive the row; they get the next slot's digest.
- **Matching a table row** (review 5373785714). The database matches a `super_admins` address trimmed of what JavaScript's `trim` removes, with **ASCII letters only** lowercased. It never uses collation-dependent `lower()`:
  - under libc `C.UTF-8` (this repository's test cluster), ICU `tr-TR` and PostgreSQL 17's builtin `C.UTF-8` (`pg_c_utf8`), `lower()` turns U+0130 into a plain "i";
  - so a row `admİn@…` would have admitted a removed `admin@…`;
  - a test writes the rows straight into the table, as legacy or service-role data would be. It reproduces that with the old predicate in each folding collation, and shows the fix withdraws the removed admin with zero provider calls under libc `C.UTF-8`, ICU `und` and ICU `tr-TR`, plus builtin `pg_c_utf8` on PostgreSQL 17.

  An address that differs from the frozen recipient only in non-ASCII case cannot be proved equal, so it does not match and is withdrawn. **Operator rule:** store `super_admins` addresses lowercased. The production database's collation is not visible from here; the match does not depend on it.

## 4. Retry policy and timing: PROPOSED values

| Setting | Value | Why |
|---|---|---|
| `leaseMs` | 5 min | Long enough for one send and its receipt; short enough that a crashed run's rows are retried by the next tick. Must be shorter than retention − margin (enforced). |
| `sendTimeoutMs` | 15 s | Same as `sendEmail`'s deadline. |
| `maxAttempts` | 5 | Counts claims. After that, a row that was never ambiguous is `exhausted`, and a possibly sent one is `needs_reconciliation`. |
| retention / margin | 24 h / 1 h | Resend's documented key lifetime, and a margin that must exceed the send deadline plus clock skew. |

**Operator rules** (from the delivery contract's §1):
- no `RESEND_API_KEY` rotation while any row is `unknown` inside its window;
- reconciliation of parked rows is manual, and nothing records its answer yet.

## 5. The route's answers

| Situation | Status | Body (counts only) |
|---|---|---|
| Every admin accepted, or withdrawn with nothing possibly sent (§3) | 200 | `ok: true, complete: true, statuses, sentThisRun, planMismatch` |
| Anything not yet settled (retryable, leased, parked, withdrawn after a possible send, storage error) | 502 | `ok: false`, the same counts, plus `needsAttention`, `refused` and `storageErrors`. A retry resumes the same occurrence and is always safe. |
| No activity in the window / no recipients | 200 | `sent: 0`, `reason`, and nothing frozen |
| Feed or recipient read failed | 502 | `reason`, and nothing frozen |
| An unusable plan | 502 | `reason: plan_refused`, and nothing frozen |
| Flag on, no Resend key | 503 | `reason: email_provider_not_configured` |

## 6. Gates before the flag is set anywhere, in order

1. **#699 merged,** including the shared `migration-version-safety` pin, which is the coordinator's call. This draft adds `0474`, so the pin moves again (to `0475`); that hunk is the coordinator's too.
2. **The PROD-DB-0177 migration-ledger remedy,** then `0471` and `0474` applied and checked with `docs/audit/an-admin-digest-reaches-each-admin-once-check.sql` and `docs/audit/a-removed-admin-is-not-sent-the-digest-check.sql`.
3. **This draft reviewed and merged,** with the open §2 and §3 decisions recorded.
4. **`CRON_SECRET` set,** only after the other email crons' preconditions in the scheduler report are handled.
5. **A preview or staging run with the flag on,** a real database, and a Resend test key or sandbox domain. Verify one delivery per admin per slot, and verify a retry.
6. **Only then,** production. The scheduler prototype's route change (key `admin-digest/<until>/…`) **must not** ship alongside, because its keys never deduplicate against the engine's.

## 7. Evidence (local; Node 24.21, PostgreSQL 16, synthetic data)

| Test file | Result | What it covers |
|---|---|---|
| `tests/admin-digest-occurrence-and-provider.test.ts` | 22/22 | the slot agrees with both schedulers; late and early ticks; month and year boundaries; normalisation; the adapter's verbatim bytes, key, signal, classification, bounded read, release of an unread oversized answer, throws and missing key |
| `tests/admin-digest-route-engine.test.ts` | 23/23 | route end to end on the in-memory store, which reads the same `super_admins` rows at each admission: flag off, other values and no key; each admin once; late tick; two invocations at once; next slot; empty slot; accept-then-500 and lost-request retries; a receipt-write failure then retry after the lease; key conflict; keyset paging with late rows; duplicate, invalid and unreadable recipients; **an admin removed after the freeze withdrawn on the retry, or before the first send; an allowlisted admin never withdrawn by the table; an admin dropped from `SUPER_ADMIN_EMAILS` withdrawn**; late activity |
| `tests/admin-digest-delivery-engine.test.ts` | 126/126 | the engine and the in-memory store contract, now with 10 contract and 11 engine withdrawal cases, plus a check that a table match implies the engine's identity: removal before the first send, between attempts, between claim and admission, after a granted admission (the boundary), with an earlier possible send, an unreadable table, a throwing allowlist, a stale worker, and a restart |
| `tests/admin-digest-delivery-postgres.test.ts` (`DIGEST_DELIVERY_PG=1`) | 78/78 on PostgreSQL 16.13 and 79/79 on 17.11, both with the restart command | the contract suite on real `0471` + `0474`; the match under libc `C.UTF-8`, ICU `und`, ICU `tr-TR` and (17 only) builtin `pg_c_utf8`, with each collation's settings asserted and the old `lower()` predicate as a counterfactual; the differential with random admission answers and `super_admins` changes (it reaches grants, withdrawals and fenced refusals); a removal and an addition committed while an admission waits for the row lock; only the 7-argument `begin_send` exists; a NULL allowlist answer; a withdrawn row the owner cannot reopen; an unreadable `super_admins`; an engine retry that withdraws |
| `tests/admin-digest-route-engine-postgres.test.ts` (`DIGEST_DELIVERY_PG=1`) | 7/7 with the restart command | the route on real `0471` + `0474` through the adapter: each admin once with DB receipts; three invocations at once on real row locks; accept-then-500 retry from the database alone; an immediate restart between failure and retry; **an admin removed after the freeze withdrawn by the database at the retry's admission**; an unreadable `super_admins` sends nothing; nothing reaches the database for an unusable plan |
| `docs/audit/a-removed-admin-is-not-sent-the-digest-check.sql` and the updated 0471 probe | pass on a full local migration replay | what CI's Database job runs |

**Mutation proof** (scratch runners). Each safeguard was removed on its own, and the tests or the probe caught every one:
- **route, 12/12:** the flag default; the slot window; slot-labelled rendering; normalisation; non-2xx when incomplete; no key means nothing frozen; the key header; verbatim bytes; the abort signal; classification; the slot rule; a refused plan answering non-2xx.
- **0474 SQL, 12/12:**
  - the eligibility check itself; reading it after the row lock (caught by the lock-wait test only, as one probe session cannot show it);
  - claim refusing `withdrawn`; the guard keeping `withdrawn` settled; the fence checked before eligibility;
  - trimming; the Unicode whitespace class (PostgreSQL's `\s` alone misses it); lowercasing;
  - withdrawal keeping ambiguity; dropping the 6-argument function; refusing a NULL allowlist answer; reading the table on every admission.
- **0474 matching, 3/3** (review 5373785714): collation-dependent `lower()`, which the CI probe also catches under libc `C.UTF-8`; no ASCII folding; full Unicode folding in the TypeScript mirror.
- **0474 TypeScript, 8/8:** the engine asking the allowlist; a possibly sent withdrawal not counting as settled and needing a person; `decideBeginSend` withdrawing; the route's allowlist; the route passing it; the adapter sending the answer it was given; the adapter refusing a non-boolean.

**Not shown:** the production database, a real provider, a real scheduler, or any environment with the flag on.
