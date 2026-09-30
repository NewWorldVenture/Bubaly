# Admin digest: route integration of the delivery engine (draft)

Status on 2026-09-30: a **draft**, stacked on #699 (engine, adapter and migration `0471`).
- **Off by default.** `/api/cron/admin-digest` behaves exactly as before unless `ADMIN_DIGEST_DELIVERY_ENGINE=1`. No environment sets it.
- **Needs `0471`,** which is not applied to any production database (PROD-DB-0177 blocks every migration there).
- **Nothing here sends email.** Every test uses a synthetic Resend over a stubbed `fetch`.
- **Duplicate admin digests are not fixed in production.** That needs the gates in §6, then database and route verification in a real environment.

## 1. What the flag switches on

| Piece | File | What it does |
|---|---|---|
| Occurrence | `lib/admin/digest-occurrence.ts` | Maps "now" to one scheduled slot and its window (§2). |
| Recipients | same | Trims, lowercases and de-duplicates the #685 list before the engine sees it (§3). |
| Provider | `lib/admin/digest-provider.ts` | Resend over `fetch`. It posts the row's stored bytes verbatim under the row's key, honours the engine's abort signal, reads a bounded answer and classifies it with the engine's tested `classifyResendResponse`. |
| Route logic | `lib/admin/digest-engine-route.ts` | Reads the slot's window, builds the digest, freezes or loads the plan, runs the engine on the `0471` store, and answers with counts only: no address, key or body. |
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
3. **Late activity inside a frozen window.** A row written after the slot's plan was frozen, but timestamped inside its window, is in **no** digest. The next window starts at the slot. The route reports it as `planMismatch.payloadChanged`, and the frozen bytes are still what is sent. Is that acceptable, or should late rows roll into the next digest?
4. **Schedule changes.** If the cron expression changes, `ADMIN_DIGEST_SCHEDULE` must change with it; the test fails until it does. A slot boundary that moves mid-day would create a new occurrence.

## 3. Recipients: open decisions

**Implemented:**
- The #685 reader, which fails closed on an unreadable list, then normalisation.
- An address the engine cannot use (not one plain address, or more than 200 recipients) **refuses the whole occurrence** before anything is stored or sent: `502 plan_refused`, and the message names the rule, not the address. This follows #685's fail-closed stance, and it means **no admin** gets that slot's digest while one bad row exists in `super_admins`.

**Open decisions:**
1. **Refuse vs drop.** Should one bad address block every admin, or be dropped and reported?
2. **An admin removed after the freeze is still sent** that slot's digest on a retry. The stored plan wins; only `planMismatch.recipientsRemoved` (a count) reports it. There is a test pinning this current behaviour. Fixing it needs a fenced `withdraw` step in a later migration.
3. **An admin added after the freeze** does not get that slot's digest (`recipientsAdded` is reported). They get the next one.

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
| Every admin accepted | 200 | `ok: true, complete: true, statuses, sentThisRun, planMismatch` |
| Anything not yet accepted (retryable, leased, parked, storage error) | 502 | `ok: false`, the same counts, plus `needsAttention`, `refused` and `storageErrors`. A retry resumes the same occurrence and is always safe. |
| No activity in the window / no recipients | 200 | `sent: 0`, `reason`, and nothing frozen |
| Feed or recipient read failed | 502 | `reason`, and nothing frozen |
| An unusable plan | 502 | `reason: plan_refused`, and nothing frozen |
| Flag on, no Resend key | 503 | `reason: email_provider_not_configured` |

## 6. Gates before the flag is set anywhere, in order

1. **#699 merged,** including the shared `migration-version-safety` pin, which is the coordinator's call.
2. **The PROD-DB-0177 migration-ledger remedy,** then `0471` applied and checked with `docs/audit/an-admin-digest-reaches-each-admin-once-check.sql`.
3. **This draft reviewed and merged,** with the §2 and §3 decisions recorded.
4. **`CRON_SECRET` set,** only after the other email crons' preconditions in the scheduler report are handled.
5. **A preview or staging run with the flag on,** a real database, and a Resend test key or sandbox domain. Verify one delivery per admin per slot, and verify a retry.
6. **Only then,** production. The scheduler prototype's route change (key `admin-digest/<until>/…`) **must not** ship alongside, because its keys never deduplicate against the engine's.

## 7. Evidence (local; Node 24.21, synthetic data)

| Test file | Result | What it covers |
|---|---|---|
| `tests/admin-digest-occurrence-and-provider.test.ts` | 19/19 | the slot agrees with both schedulers; late and early ticks; month and year boundaries; normalisation; the adapter's verbatim bytes, key, signal, classification, bounded read, throws and missing key |
| `tests/admin-digest-route-engine.test.ts` | 18/18 | route end to end on the in-memory store: flag off, other values and no key; each admin once; late tick; two invocations at once; next slot; empty slot; accept-then-500 and lost-request retries; a receipt-write failure then retry after the lease; key conflict; duplicate, invalid and unreadable recipients; the removed-admin and late-activity open decisions |
| `tests/admin-digest-route-engine-postgres.test.ts` (`DIGEST_DELIVERY_PG=1`) | 5/5 with the restart command | the same route on real `0471` through the adapter: each admin once with DB receipts; three invocations at once on real row locks; accept-then-500 retry from the database alone; an immediate restart between failure and retry; nothing reaches the database for an unusable plan |

**Mutation proof** (scratch runner): each of 12 route safeguards was removed on its own, and the tests caught every one:
- the flag default;
- the slot window;
- slot-labelled rendering;
- normalisation;
- non-2xx when incomplete;
- no key means nothing frozen;
- the key header;
- verbatim bytes;
- the abort signal;
- classification;
- the slot rule;
- a refused plan answering non-2xx.

**Not shown:** the production database, a real provider, a real scheduler, or any environment with the flag on.
