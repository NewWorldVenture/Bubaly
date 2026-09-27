# Claude-4 — QA · Features · Flows · Performance · Edge cases

Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-4 and by nobody else.
<!-- Two sessions wrote this file; both sides of the merge are kept. -->
## STATUS (top of file — updated by whichever Claude-4 run is current)

CURRENT: Session 3 (relaunched on Sonnet after an Opus rate-limit on session 2;
  session 1's findings below — C-4-01..13 and the "## Findings" block starting
  at the old line 909 — stand; session 2 is the one that produced Pass F-K in
  `finalaudit.md`, which I read and did not duplicate). This session ran a
  further sweep for NEW vacuous-test instances, flow dead-ends, division-by-zero
  edge cases and pagination gaps not already covered, per the brief.
COMPLETED (this session):
  - Confirmed still-OPEN as of this session (not re-reported, just dated):
    F-F01 (caller `max` truncates a read, `error: null`) — `lib/supabase/read-all.ts:93-95`
    still returns `{ rows: rows.slice(0, options.max), error: null }` on a
    reached caller ceiling; `admin/wallet/reconciliation/page.tsx` still passes
    `{ max: 20000 }`, `economy/page.tsx` still `{ max: 5000 }`.
    F-F02 (Greenwich-day bug survivors) — `app/(app)/kids/page.tsx:22` still
    reads `new Date(); start.setHours(0,0,0,0)`.
    RESEND_API_KEY still absent from `FEATURE_ENV` in `lib/health/status.ts`;
    `notification-emails.ts` still destructures only `{ ok }`, never `skipped`.
    `family_code` still has zero read call sites outside display/copy —
    grepped fresh, same result as session 2.
    No `family_members` trigger exists yet guarding the last manager.
  - New vacuous-guard sweep of `docs/audit/*.sql` (Pass G's sweep re-run, one
    session later, to catch anything added since): 22 files now exist (was a
    smaller set at G1-time going by the fix list). `grep -l "when others"` now
    also matches `family-credentials-boundary-check.sql` and
    `sensitive-role-boundary-check.sql` in addition to G1's three — read both in
    full: in both, the only `when others` text is inside a COMMENT explaining
    G1's lesson; the live `exception when` clauses are already narrowed to
    `insufficient_privilege`. Not vacuous. Also confirmed the 4 files that do
    NOT match the CI runner's `*-check.sql` glob (`money-boundary-state.sql`,
    `migration-ledger-state.sql`, `money-policy-diagnostic.sql`,
    `demo-mode-teardown.sql`) are deliberately named outside it — each opens
    with "READ ONLY, changes nothing" / "paste into the Supabase SQL editor",
    i.e. operator tools, not CI gates that look like they run but don't. Sound.
  - Confirmed `docs/audit/pg-bootstrap.sh` (run before `run-probes.sh` in
    `ci.yml`'s `database` job) applies "the anchor account and SEED_ALL" before
    any probe runs — the empty-database class (F-020, this repo's worst
    instance) stays closed for the whole probe suite, not just the migration
    replay.
  - Swept ~50 average/percentage calculators across `lib/**` and
    `components/modules/**` (`.reduce(...) / xs.length` shape) for an
    empty-array edge case (a new/single-member family with no logged data yet
    is the realistic trigger). Every site checked — `lib/sleep/coach.ts`,
    `lib/family/safety.ts`, `lib/home/utilities.ts`,
    `lib/medications/adherence.ts`, `lib/workload/balance.ts`,
    `components/modules/health-module.tsx`,
    `components/modules/family-signals-module.tsx`, and 6 more in the money/
    school/career/sleep/marketplace libs — guards on `.length` (or `>= 2`,
    `>= 3` where a single point is statistically meaningless) before every
    division. No NaN-rendering finding here; recorded so a future pass doesn't
    re-run the same sweep.
  - Checked candidate N+1 sites outside those already fixed (missions, weekly
    digest): `lib/server/push.ts` fan-out memoizes `membersOf(familyId)` in a
    `Map` before the per-notification loop — not an N+1, a genuine cache hit
    the second time a family recurs in a batch. `messages-module.tsx`'s
    per-message `read_by` update loop is a **fallback only** (RPC
    `mark_conversation_read` is tried first; the loop runs only if the RPC
    itself fails) and is capped at `.slice(-100)`. Both sound.
  - Checked `app/(app)/guardian/history/page.tsx` and
    `app/(app)/admin/audit/page.tsx` for the PostgREST 1,000-row cap
    (F-008/F-011/F-013's class) outside the cron surface Pass H already closed:
    guardian history uses real `.range()` pagination; admin audit self-declares
    a bounded 1,000-row window in a comment ("admin-scale auditing would page
    server-side, flagged here rather than hidden") rather than hiding the cap.
    Both sound.
  - Traced the chore -> approval -> reward -> wallet path
    (`app/(app)/missions/actions.ts` `finalizeApproval`,
    `app/(app)/dashboard/rewards/actions.ts`,
    `supabase/migrations/0295_reward_redemption_decision_guard.sql`): the money
    side (`0217`/`0205`, service-role only) and the points/badge side
    (`reward_redemptions`, explicitly documented in 0295 as "mints no money…
    the points economy is separate from the wallet") are two different systems
    by design, not a dead-ended flow. `decideRedemptionAction` does not check
    the requester's point total before a manager approves — read this as
    parent-discretion-by-design (0295's own comment says the points system is
    non-monetary), not reported as a defect: no user-facing copy promises a
    hard balance check, so I could not tie it to a broken contract. Flagging
    the reasoning here rather than asserting a bug I couldn't pin down.
  - Read `finalizeOnboardingAction` (`app/onboarding/actions.ts:317+`): explicit
    double-submit/idempotency handling (adopts an auto-provisioned family,
    treats a repeat submit as idempotent) with real reasoning in the comments.
    Sound.
  - Re-verified 3 TODOs that looked like dead UI on first grep and are not:
    `app/(app)/money/actions.ts:129` (Trust Engine gate, live code, not a stub),
    `app/(app)/dashboard/concierge/runs/page.tsx:15-20` (explicitly offers NO
    Undo button rather than an inert one, specifically to avoid the "wired to
    nothing" class this audit hunts for), `components/family/invite-form.tsx`
    (presets intentionally don't promise a delegation the schema can't yet
    carry; says so in a header comment).
  - Spot-checked `tests/move-date-recalculation-api.test.ts`: a flat single-
    assertion-per-`it` scan flagged several `it` blocks as "one assertion
    only, and it's `.not.toHaveBeenCalled()`" — read in full, every one calls a
    shared `expectFailure(response, status, code)` helper first (which asserts
    the real HTTP status/body), so the flat scan undercounted; not vacuous.
  - Spot-checked `tests/public-bucket-objects-are-unguessable.test.ts`,
    `tests/reward-redemption-write-path.test.ts` (session 2 already covered the
    latter's subject; re-read to confirm): both build real offender lists from
    source and assert `toEqual([])`, or exercise the in-memory Supabase fake and
    assert on resulting table rows — not on a mock's own return value. Sound.
NEXT: nothing further planned this session. If resumed: the mock-return-value
  and constant-substitution vacuity patterns (brief patterns 2-3) were sampled
  but not exhaustively swept across all ~1,250 files — a scripted AST-level
  check (which test bodies only assert equality with a literal that appears
  verbatim in a `mockResolvedValue`/`mockReturnValue` call in the same `it`)
  would be more reliable than the regex heuristics used here and is the
  natural next tool to build.
FILES-EXAMINED (this session, beyond the list already in the file):
  lib/supabase/read-all.ts, app/(app)/kids/page.tsx, lib/health/status.ts,
  lib/server/notification-emails.ts, lib/email.ts, components/family/family-module.tsx
  references, docs/audit/*.sql (all 22), docs/audit/run-probes.sh,
  docs/audit/pg-bootstrap.sh (referenced), .github/workflows/ci.yml:135-225,
  lib/server/push.ts, components/modules/messages-module.tsx,
  app/(app)/guardian/history/page.tsx, app/(app)/admin/audit/page.tsx,
  app/(app)/missions/actions.ts, app/(app)/dashboard/rewards/actions.ts,
  supabase/migrations/0295_reward_redemption_decision_guard.sql,
  app/onboarding/actions.ts, app/(app)/money/actions.ts,
  app/(app)/dashboard/concierge/runs/page.tsx, components/family/invite-form.tsx,
  tests/move-date-recalculation-api.test.ts,
  tests/public-bucket-objects-are-unguessable.test.ts, and the ~15 lib/component
  files listed above in the divide-by-zero sweep.
BLOCKERS: none. No live database or running app in this sandbox, same as prior
  sessions — everything above is static/source verification.
LAST-UPDATE: 2026-09-14

---

Findings only below this line, in each session's own historical format:

```
[CLAUDE-4][SEVERITY][AREA] Title
File:     path/to/file.ts:line
Problem:  what is wrong
Evidence: what proves it (command output, code, a live response)
Impact:   who is hurt and how
Fix:      recommended change
Status:   OPEN | VERIFIED | FIXED | BLOCKED
```

SEVERITY: CRITICAL | HIGH | MEDIUM | LOW

---

## Baseline established this pass

Full suite, twice, from a clean tree at `022a052d`:

```
TZ=UTC                  Test Files  1 failed | 1181 passed (1182)
                             Tests  1 failed | 13586 passed (13587)   Duration 195.86s
TZ=America/Los_Angeles  Test Files  2 failed | 1180 passed (1182)
                             Tests  2 failed | 13585 passed (13587)   Duration 195.51s
```

The UTC failure is the known `tests/api-ai-runs.test.ts > 401s anonymous callers`
5 s timeout (not re-reported; see C-4-05 for its siblings). The extra Los Angeles
failure is C-4-04 — a real production defect, not a test-only assumption.

I ran no mutation experiments against the working tree (other workers are live in
it), so every "this test cannot fail" claim below is argued from the test's own
text, not from a deleted line.

---

## C-4-01

```
[CLAUDE-4][HIGH][MONEY] A caller-chosen `max` truncates a read and reports success,
so the ledger reconciler reconciles a prefix of the ledger and says it balances
File:     lib/supabase/read-all.ts:93
          app/(app)/admin/wallet/reconciliation/page.tsx:23,28
          app/(app)/economy/page.tsx:28
          app/(app)/admin/wallet/page.tsx:34
          app/(app)/wallet/treasury/page.tsx:40
          app/(app)/wallet/activity/page.tsx:35
```

**Problem.** `readAll` exists to defeat PostgREST's silent 1,000-row cap (F-013).
It has two exits, and they are not symmetric. Hitting the *default* ceiling
returns an error. Hitting a *caller-supplied* `max` returns `error: null`:

```ts
// lib/supabase/read-all.ts:93
if (options.max !== undefined) return { rows: rows.slice(0, options.max), error: null };
return {
  rows,
  error: { message: `readAll stopped at ${ceiling} rows; the query is probably not terminating.` },
};
```

So a call site that passes `{ max: 20000 }` cannot distinguish "the table has
14,000 rows" from "the table has 400,000 rows and you were handed the first
20,000". The header of the same file argues the case against exactly this:

> "the caller simply receives 1,000 rows and believes that is the table… For a
> nightly job that iterates every household, it is silent data loss."

The cap was moved from 1,000 to 20,000. It was not removed, and no signal was
added.

**Evidence — the reconciler's own comment states the failure mode it still has:**

```ts
// app/(app)/admin/wallet/reconciliation/page.tsx:21-28
// This page RECONCILES the ledger, so reading part of it is worse than not
// reading it at all: `.limit(20000)` returned 1,000 rows (PostgREST caps at
// db-max-rows) and every discrepancy past that went unreported.
readAllAsQuery((from, to) => supabase.from('wallet_buckets')…, { max: 20000 }),
readAllAsQuery((from, to) => supabase.from('wallet_transactions')
  .select('id, child_wallet_id, bucket_id, direction, amount_cents, status, type, reverses_id, created_at')
  .order('created_at', { ascending: false })
  .order('id')
  .range(from, to), { max: 20000 }),
```

Two things make this worse than a plain truncation:

1. The read is **platform-wide** — `createServiceClient()`, no `family_id`
   filter. 20,000 is a total across every family on the platform, not per
   household. `app/(app)/admin/wallet/page.tsx:34` reads the same table
   platform-wide at `{ max: 10000 }`.
2. It is ordered `created_at DESC`, so the rows dropped are the **oldest**. A
   ledger reconciled from its newest 20,000 rows is not incomplete, it is
   arithmetically wrong: every child whose opening balance was built before the
   cut-off reconciles against a partial history. The UI then renders
   `adminWalletReconciliation…everythingReconciles` ("Everything reconciles")
   off that prefix.

`app/(app)/economy/page.tsx:28` has the same shape on the child-facing side, and
also documents the invariant it breaks:

```ts
// Balances are summed from these rows, so a capped read is a wrong balance.
readAllAsQuery((from, to) => supabase.from('currency_transactions')
  .select('currency_id, member_id, direction, amount').eq('family_id', familyId)
  .order('id').range(from, to), { max: 5000 }),
```

At 5,001 lifetime `currency_transactions` rows a family's children silently start
showing understated coin balances, and the page has no way to know.

**Impact.** Money and coin balances that are wrong rather than missing, on both
the admin reconciliation surface (the tool whose entire job is detecting
exactly this) and the children's economy page. Nothing logs, nothing errors, and
the failure arrives on a schedule set by how long the family has been a customer.

**Fix.** Make the caller-max exit reportable. `readAll` should answer
`{ rows, error, truncated: boolean }` (or return the sentinel error for both
ceilings and let callers opt out), and the money call sites must treat
`truncated` as a read failure — the reconciler especially, whose correct
behaviour at the cap is the `ErrorState` it already renders for `readError`, not
a green "everything reconciles". Separately, the two platform-wide admin reads
should be scoped or aggregated in SQL (`sum()` in a view) rather than paged into
Node.

Status: **VERIFIED** (code read; no live database available to demonstrate the
cap being hit)

---

## C-4-02

```
[CLAUDE-4][HIGH][KIDS/CORRECTNESS] "Today" is the server's today on eleven
server-rendered surfaces — the F-017 defect, on the pages the guard cannot see
File:     app/(app)/kids/page.tsx:22-23
          app/(app)/guardian/page.tsx:20-21
          lib/server/notifications.ts:35-36
          lib/home/home-data.ts:72-73
          components/dashboard/family-dashboard.tsx:23
          components/dashboard/personal-dashboard.tsx:23
          lib/chores/dashboard.ts:171-172
          lib/family/signals.ts:46
          app/(app)/dashboard/moments/page.tsx:47
          app/api/ai/wallet/route.ts:41, app/api/ai/wallet/child/[childId]/route.ts:52,
          app/api/ai/invest/route.ts:38, app/api/ai/relationship/route.ts:40
```

**Problem.** F-017 fixed the family display. Its fix comment names the defect
precisely:

```ts
// app/(app)/display/page.tsx:122-126
// This screen hangs on a wall in the family's kitchen, so its day has to turn
// over at THEIR midnight. `setHours(0,0,0,0)` is the SERVER's midnight, which
// on a UTC host is 17:00 in California — the display would flip to tomorrow's
// schedule in the middle of the afternoon, every day.
const todayDate = dayKeyInTz(now, tz);
const bounds = zonedDayBoundsMs(todayDate, tz);
```

The same `setHours(0,0,0,0)` is still live on eleven other **server-rendered**
surfaces. The child's own dashboard:

```ts
// app/(app)/kids/page.tsx:22-23, 28  — `export const dynamic = 'force-dynamic'`
const start = new Date(); start.setHours(0, 0, 0, 0);
const end = new Date(start.getTime() + 86400000);
…
supabase.from('calendar_events').select('id, title, starts_at, all_day')
  .eq('family_id', familyId)
  .gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString())
```

And the text of every notification the platform sends:

```ts
// lib/server/notifications.ts:34-38
const d = new Date(iso);
const today = new Date(); today.setHours(0, 0, 0, 0);
const day = d.toDateString() === today.toDateString()
  ? 'today'
  : d.toDateString() === new Date(today.getTime() + 24 * HOUR).toDateString()
    ? 'tomorrow'
    : …
```

I confirmed none of these files is a client component (`head -3 | grep -c "use
client"` returns 0 for every one), so the clock is the host's, which on Vercel is
UTC.

**Why the F-017 guard does not catch it.** `tests/family-day-not-greenwich-day.test.ts`
flags exactly one signature — `toISOString().slice(0, 10)` sitting next to a
filter on a **DATE** column (test lines 72, 90-98). These sites use
`setHours(0,0,0,0)` against **timestamptz** columns. Both halves of the guard's
pattern miss, so it reports clean. The guard's own header calls itself "a floor
rather than a proof"; this is what is under the floor.

**Impact.** For a family in California, the kids page's "today" runs 17:00
yesterday → 17:00 today: a child opening it after 5pm sees tomorrow's events and
loses today's, every day. Australia/Sydney is worse (41.7% of the day wrong, per
the guard's own table). Notification copy tells a Pacific family an 8pm event is
"tomorrow", because 20:00 PT is 03:00 UTC the next day.

**Fix.** Route each through `dayKeyInTz` / `zonedDayBoundsMs` from
`lib/services/scope.ts`, as `app/(app)/display/page.tsx` already does — the
family zone is on `families.timezone` and every one of these call sites already
has a `familyId`. Then widen `tests/family-day-not-greenwich-day.test.ts` to flag
`setHours(0, 0, 0, 0)` in any non-`'use client'` file under `app/` and `lib/`,
which is the pattern that actually got through.

Status: **VERIFIED**

---

## C-4-03

```
[CLAUDE-4][HIGH][PERF] /missions issues up to 240 sequential storage round trips
per page render, when the batch call is already used elsewhere in the repo
File:     app/(app)/missions/page.tsx:70-77
```

**Problem.** A nested `await`-in-loop over rows, on a `force-dynamic` page:

```ts
// app/(app)/missions/page.tsx:69-77
const items: ReviewItem[] = [];
for (const s of subs) {
  …
  for (const path of (s.media_paths ?? []).slice(0, 4)) {
    const { data } = await supabase.storage.from('chore-proof').createSignedUrl(path, 600);
    if (data?.signedUrl) mediaUrls.push(data.signedUrl);
  }
```

`subs` is bounded at 60 (`.limit(60)`, line 30) and each carries up to 4 media
paths, so the worst case is **240 serialised HTTP round trips to Supabase
Storage** before the first byte of HTML is sent. Nothing about the loop is
order-dependent — `mediaUrls` is a per-submission array assembled immediately
after.

**Evidence that the batch API is available and already in use:**

```ts
// app/(app)/admin/marketing/assets/page.tsx:53
const { data: urls, error: signedError } = await supabase.storage.from(BUCKET).createSignedUrls(imagePaths, 3600);
```

`createSignedUrls` (plural) takes the whole path array. `/missions` is the only
loop of this shape left; the other four `createSignedUrl` call sites in the repo
sign exactly one path each.

**Impact.** The parent approval queue — which holds pending proofs, disputes and
AI safety flags — is the slowest page in the authenticated app, and gets slower
in proportion to how many submissions are waiting. At 50 ms per round trip the
worst case is 12 s of pure serialised I/O.

**Fix.** Collect every path first (`subs.flatMap(s => (s.media_paths ?? []).slice(0, 4))`),
one `createSignedUrls(allPaths, 600)`, then map results back by path. One round
trip instead of up to 240.

Status: **VERIFIED**

---

## C-4-04

```
[CLAUDE-4][MEDIUM][CORRECTNESS] A requested local time that does not exist in the
SERVER's zone is silently shifted, whatever zone the family is in
File:     lib/voice/command-router.ts:105,122-128
          lib/time/zoned.ts:123-125
          lib/capture/parse.ts:50-51,109,117
Found by: TZ=America/Los_Angeles npx vitest run
```

**Problem.** `classifyVoiceCommand` bridges to `lib/capture/parse.ts` (which does
its arithmetic with runtime-local `getHours`/`setHours`) by re-expressing the
instant as a fake wall-clock Date:

```ts
// lib/time/zoned.ts:123-125
export function asWallClockIn(instant: Date, timezone: string): Date {
  const p = localPartsAt(instant, timezone);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
}
```

`new Date(y, m, d, h, min)` is interpreted in the **runtime's** zone. When the
family's wall-clock time does not exist in the runtime's zone, the engine
normalises it forward and the wall-clock fields read back changed. Demonstrated
directly:

```
$ TZ=America/Los_Angeles node -e "const d=new Date(2026,2,8,2,30); console.log(d.toString(), d.getHours(), d.getMinutes())"
Sun Mar 08 2026 03:30:00 GMT-0700 (Pacific Daylight Time) 3 30
$ TZ=UTC node -e "const d=new Date(2026,2,8,2,30); console.log(d.toString(), d.getHours())"
Sun Mar 08 2026 02:30:00 GMT+0000 (Coordinated Universal Time) 2
```

`command-router.ts:122-128` then reads those corrupted fields back out and
resolves them in the family's zone, so the 02:30 the family asked for has already
become 03:30 before `instantForLocalTime` ever sees it.

**Evidence — the existing test proves it, and the assertion is zone-independent:**

```ts
// tests/assistant-capture-fidelity.test.ts:98-105
it('moves an appointment to the first minute that exists on the spring-forward morning', () => {
  // New York jumps 02:00 -> 03:00 on 8 March 2026, so 02:30 never happens.
  const eve = new Date('2026-03-07T18:00:00Z');
  const route = classifyVoiceCommand('add furnace service tomorrow at 2:30am', eve, NY);
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: NY, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(route.startsAt as Date);
  expect(local).toBe('03:00');
});
```

The test passes `NY` explicitly and formats the answer in `NY`, so its expected
value cannot depend on the host. It passes under `TZ=UTC` and fails under
`TZ=America/Los_Angeles`:

```
AssertionError: expected '03:30' to be '03:00'
 ❯ tests/assistant-capture-fidelity.test.ts:104:19
```

`lib/time/zoned.ts` itself is clean — `zonedLocalToInstant` and
`instantForLocalTime` are pure and host-independent. The defect is in the
`asWallClockIn` → `parse.ts` → read-fields-back round trip.

**Impact.** Production runs UTC, which observes no DST, so this does not fire
today — it is latent, and it fires the moment anything runs on a DST-observing
host (a self-hosted deploy, a developer machine, a CI runner that is not UTC).
The larger point is that the wall-clock bridge is not host-independent, and
`asWallClockIn`'s own docstring claims it is ("Hand it one of these and its
'today', 'tomorrow' and 'next Friday' are the family's, not the runtime's").

**Fix.** Two parts. (a) Carry the wall-clock fields as plain numbers
(`{year, month, day, minutes}`) across the bridge rather than round-tripping them
through a runtime-zone `Date`; `instantForLocalTime` already takes exactly that
shape. (b) Pin the suite so this class cannot hide again: `test.env = { TZ: 'UTC' }`
in `vitest.config.ts` makes the run hermetic, and a second CI job at a
DST-observing zone is what would have caught it.

Status: **VERIFIED**

---

## C-4-05

```
[CLAUDE-4][MEDIUM][FLAKE] 96 tests share the exact shape of the known
api-ai-runs 5-second timeout, and no timeout is configured anywhere
File:     vitest.config.ts:18-22 (no testTimeout)
          tests/api-ai-requests.test.ts (21 blocks), tests/api-ai-route.test.ts (17),
          tests/api-ai-runs.test.ts (17), tests/wishlists-actions-boundary.test.ts (11),
          tests/ai-voice-routes-auth.test.ts (9), tests/module-actions-write-boundary.test.ts (7),
          tests/run-actions-gates.test.ts (5), tests/home-actions-write-boundary.test.ts (3),
          + 4 files with 1-2 each
```

**Problem.** The known flake is not "a slow assertion". It is a **cold dynamic
import of an App Router module performed inside a test bound by the default 5 s
timeout**:

```
 FAIL  tests/api-ai-runs.test.ts > GET /api/ai/runs/[id] > 401s anonymous callers
Error: Test timed out in 5000ms.
 ❯ tests/api-ai-runs.test.ts:173:3
    173|   it('401s anonymous callers', async () => {
    174|     getUserContext.mockResolvedValue(null);
    175|     const { GET } = await import('@/app/api/ai/runs/[id]/route');
```

Whichever `it()` reaches that route first pays the transform cost of its entire
dependency graph, inside the test's own budget. The suite-wide numbers say how
large that budget pressure is:

```
Duration  195.86s (transform 56.19s, setup 0ms, import 245.80s, tests 103.38s)
```

`import` (245 s) exceeds wall-clock duration — imports are the dominant cost and
they run concurrently across workers, competing for the same CPU.

I enumerated every `it()` block containing `await import('@/app/…')`: **96 blocks
across 12 files.** `grep -n "testTimeout\|}, [0-9]\{4,\})"` over
`vitest.config.ts` and the four largest of those files returns nothing — no
global timeout, no per-test timeout anywhere. `tests/api-ai-requests.test.ts`
and `tests/api-ai-route.test.ts` are the same shape and the same size as the file
that already fails; they are one scheduling accident from failing too. The
failure is also not load-only: it reproduced on both of my full runs.

**Impact.** A red suite that is red for a reason unrelated to any defect teaches
everyone to ignore red. The next real regression in these twelve files lands next
to a failure that is already being scrolled past.

**Fix.** Hoist the route import to module scope (or a `beforeAll`) in each of the
twelve files, so the transform cost is paid outside any test's budget — the
mocks are already hoisted by `vi.mock`, so there is no ordering obstacle. Set
`test.testTimeout` explicitly in `vitest.config.ts` as a backstop rather than
relying on the 5 s default.

Status: **VERIFIED**

---

## C-4-06

```
[CLAUDE-4][MEDIUM][QA] A test named "fails closed" only forbids two shapes of
error handling, so deleting the error handling entirely makes it pass
File:     tests/seed-failure-safety.test.ts:9-18
```

**Problem.** The whole file:

```ts
describe('seed write failure safety', () => {
  it('fails closed instead of continuing after an insert or cleanup error', () => {
    const scripts = readdirSync(scriptsDir)
      .filter((name) => /^seed.*\.mjs$/i.test(name) && name !== 'seed-client.mjs')
      .map((name) => ({ name, source: readFileSync(resolve(scriptsDir, name), 'utf8') }));

    for (const { name, source } of scripts) {
      expect(source, name).not.toMatch(/if\s*\(\s*error\s*\)[^{\n]*console\.error/);
      expect(source, name).not.toMatch(/if\s*\(\s*error\s*\)\s*\{[^}]{0,240}\b(?:return|break)\b/);
    }
  });
});
```

Every assertion is negative. The property in the test's name — "fails closed" —
is never asserted. The test can only observe a *particular wrong* handler
(`if (error) console.error`, `if (error) { … return }`); it cannot observe a
**missing** one, which is the more likely regression and the one that produces
the same outcome. Removing an error check makes this test *more* green, not less.

**Evidence.** `scripts/seed-notifs.mjs` is two lines of write:

```js
// scripts/seed-notifs.mjs:30-31
const {data,error}=await sb.from('notifications').insert(rows).select('id');
if(error)throw new Error(`Seed insert failed for notifications: ${error.message}`);
```

Delete line 31 and the seed script silently continues past a failed insert —
precisely the defect the test is named for — and both assertions still pass,
because neither forbidden shape is present.

Second, smaller issue: the file list comes from `readdirSync` with no
non-emptiness check. It currently matches 7 scripts, so it is not vacuous today,
but a rename of the `seed*.mjs` convention turns the whole file into a
zero-iteration loop that reports success.

**Impact.** A seeding run that half-applies and reports success. This is the
class the finalaudit's F-004 / F-015 are already about — a probe that cannot
catch the defect it exists for.

**Fix.** Assert the positive: for each script, every `.insert(`/`.upsert(`/
`.delete(` must be followed within N lines by a `throw` or `process.exit(1)`.
Add `expect(scripts.length).toBeGreaterThan(5)` so an empty glob fails.

Status: **VERIFIED**

---

## C-4-07

```
[CLAUDE-4][MEDIUM][COVERAGE] 37 of 51 money, kids, economy and missions server
actions are not named by any test
File:     app/(app)/wallet/actions.ts, app/(app)/wallet/hub-actions.ts,
          app/(app)/wallet/invest/actions.ts, app/(app)/money/actions.ts,
          app/(app)/economy/actions.ts, app/(app)/missions/actions.ts
```

**Problem.** I extracted every exported action from those six files (51 total)
and counted test files naming each (`rg -l "\b<name>\b" tests`). Zero hits for:

```
activateFamilyWalletAction  activateTreasuryAction     addAccountAction
addCardAction               addFundsAction             addPassAction
addRewardAction             addTransactionAction       archiveBabysitterAction
awardTokensAction           claimPayHandleAction       createCardRevealAction
createCurrencyAction        createGiftLinkAction       createGoalAction
createRewardAction          decideInvestOrderAction    deleteWalletRowAction
disputeSubmissionAction     generatePlanAction         issueCardAction
placeInvestOrderAction      prepareCardRevealAction    recordBabysitterPaymentAction
refreshConnectStatusAction  releasePayHandleAction     requestSpendAction
saveAllowanceRuleAction     saveBabysitterAction       saveWalletRuleAction
setCardFrozenAction         setCurrencyActiveAction    setRewardActiveAction
startConnectOnboardingAction submitProofAction         toggleAllowanceRuleAction
updateCardControlsAction
```

The 14 that *are* named are named by exactly 1-3 files each.

**This is not "there are no tests for money."** There are ~60 wallet/economy/kids
test files, and they are good — but they are almost all *boundary* tests that
`readFileSync` the action file and assert on its text. `tests/wallet-money-action-boundaries.test.ts`
is representative: it never imports or invokes an action, it asserts that certain
strings appear in the source.

That catches deletion of a guard. It cannot catch a guard that is present but
wrong — filtering on the wrong variable, an `if` whose branches are swapped, an
allocation that rounds the wrong way. The three highest-consequence untested
actions are the ones that move money without going through a database RPC:
`addFundsAction` (credits a child's ledger directly, C-4-08),
`awardTokensAction` (mints family currency), `placeInvestOrderAction`.

**Impact.** The money surface's test suite is a deletion detector, not a
behaviour detector, for 73% of its actions.

**Fix.** Not 37 new files. Pick the ~8 that write a ledger or mint value —
`addFundsAction`, `awardTokensAction`, `placeInvestOrderAction`,
`decideInvestOrderAction`, `recordBabysitterPaymentAction`, `createGoalAction`,
`submitProofAction`, `requestSpendAction` — and give each an invoked test with a
stubbed Supabase chain (the pattern in `tests/assistant-engine.test.ts:9-25` is
already there to copy), asserting the rows actually written rather than the
source text that writes them.

Status: **VERIFIED**

---

## C-4-08

```
[CLAUDE-4][MEDIUM][MONEY] addFundsAction is the one money mutator that writes the
ledger directly, with no idempotency and no atomic RPC
File:     app/(app)/wallet/actions.ts:117-179
```

**Problem.** Every other money-moving action in the file delegates to a
database RPC — `transferWallets` → `wallet_transfer`, `decideSpend` →
`wallet_decide_spend`, `decideAllowance` → `wallet_decide_allowance`,
`fundGoal` → `wallet_fund_goal`, `approveGift` → `wallet_approve_gift`
(`lib/wallet/server.ts:43-117`). `payChoreRewardAction` documents its own
guard: *"Idempotent per assignment via a marker on the assignment row."*

`addFundsAction` does neither:

```ts
// app/(app)/wallet/actions.ts:169-171
const { error: txErr } = await supabase.from('wallet_transactions').insert(rows);
if (txErr) return actionFailure(txErr, t('actions.couldNotAddThoseFunds'));
```

There is no request key, no natural-key probe, no marker row and no RPC. A second
delivery of the same request credits the child a second time. The repo has the
machinery for this and uses it elsewhere — `lib/services/idempotency.ts`
(`makeKey`, `withIdempotency`, migration 0256's partial unique indexes) — but
`KEYED_TABLES` is `['calendar_events', 'family_reminders', 'todo_items',
'chore_assignments', 'meal_plans', 'grocery_items']` (`lib/services/idempotency.ts:118-120`).
`wallet_transactions` and `currency_transactions` are not on it. The one class of
write where a duplicate is unrecoverable is the one class not keyed.

**Mitigating, and why it is not enough.** Both call sites
(`components/wallet/wallet-dashboard.tsx:550`,
`components/wallet/child-detail-view.tsx:493`) submit through a `<Button
loading={loading}>`, and `components/ui/button.tsx:35` sets `disabled={disabled || loading}`.
So an ordinary double-click is blocked *in that tab*. That is a client-side
guard on a server-side invariant: it does not cover two tabs, a back-then-resubmit,
or a retried server-action POST.

**Impact.** A child's wallet is credited twice. The ledger is immutable by design
(`wallet_audit_log` is append-only, per `tests/wallet-audit-log-append-only.test.ts`),
so the correction is a compensating debit a parent has to notice and request.

**Fix.** Either route it through a `wallet_add_funds` RPC like its five
siblings, or add `wallet_transactions` to `KEYED_TABLES` and wrap the insert in
`withIdempotency` keyed on `(childWalletId, amountCents, description, actor,
minute)`.

Status: **VERIFIED**

---

## C-4-09

```
[CLAUDE-4][MEDIUM][PERF] Unbounded concurrent fan-out to an external drive-time
provider, one request per event
File:     lib/schedule/intelligence.ts:207-219
```

**Problem.**

```ts
const located = events.filter((e) => !e.all_day && e.location && e.location.trim() && Number.isFinite(Date.parse(e.starts_at)));
const results = await Promise.all(located.map((e) =>
  fetcher({ eventId: e.id, title: e.title, location: e.location!.trim(), startsAt: e.starts_at })));
```

`located` is derived from the caller's event list with no cap, and every element
becomes a simultaneous outbound request. There is no concurrency limit, no
per-request timeout visible at this layer, and no dedupe on `location` — a
family with the same address on ten events pays for ten lookups.

**Impact.** A busy week fans out to dozens of simultaneous third-party map calls
from a single request, which is both a latency cliff (the slowest one decides the
page) and a rate-limit exposure.

**What would confirm the severity.** I did not trace every caller of
`buildScheduleIntelligence` to a concrete upper bound on `events`, so I cannot
state the worst case. That is the one thing missing: walk the callers and record
the largest `events.length` any of them can pass.

**Fix.** Dedupe by `location` before fetching, and bound concurrency (a simple
`pLimit(6)`-style chunked loop). Both are small and neither changes the result.

Status: **OPEN** (mechanism verified, blast radius unmeasured)

---

## C-4-10

```
[CLAUDE-4][LOW][FEATURE] Two buttons in the message header exist only to say the
feature does not exist
File:     components/modules/messages-module.tsx:698-701
```

**Problem.**

```tsx
<button onClick={() => toastError(tr('messagesModule.videoCallingIsnTAvailable'))} aria-label={tr('messages.startVideoCall')}
  className="rounded-lg p-1.5 text-muted hover:text-fg"><Video className="h-4 w-4" /></button>
<button onClick={() => toastError(tr('messagesModule.voiceCallingIsnTAvailable'))} aria-label={tr('messages.startVoiceCall')}
  className="rounded-lg p-1.5 text-muted hover:text-fg"><Phone className="h-4 w-4" /></button>
```

They render unconditionally, are styled identically to the working "About this
chat" button beside them, carry affirmative labels ("Start video call"), and
their only effect is an **error** toast.

This contradicts a rule the repo states twice for itself:

```
// lib/constants/navigation.ts:228
No "coming soon" stubs: if a console section isn't built yet, it isn't listed.
// components/marketing/social-proof-band.tsx:7
no invented names, no "coming soon".
```

The other capability-gated surfaces do it correctly — `/wallet/cards` reads
`getMoneyCapabilities` and passes `caps.issuing` / `caps.physicalCards` down to
the view (`app/(app)/wallet/cards/page.tsx:38,90`) so the control is not offered
when it cannot work.

**Impact.** Small, but it is the one place in the signed-in app that advertises a
feature that does not exist, and an error toast is the harshest possible way to
say so.

**Fix.** Remove the two buttons until there is something behind them, matching
the navigation rule. If they must stay as a signal of intent, render them
`disabled` with a neutral tooltip rather than as live controls that error.

Status: **VERIFIED**

---

## C-4-11

```
[CLAUDE-4][LOW][UX] The proof-photo signing error is discarded, so a parent
reviewing a chore sees "no photo" instead of "could not load the photo"
File:     app/(app)/missions/page.tsx:75-76
```

**Problem.**

```ts
const { data } = await supabase.storage.from('chore-proof').createSignedUrl(path, 600);
if (data?.signedUrl) mediaUrls.push(data.signedUrl);
```

`error` is not destructured. A signing failure and "this submission has no
photo" render identically.

This is the same failure class the page guards against two blocks earlier, and
argues against in its own words:

```ts
// app/(app)/missions/page.tsx:32-36
// The approval queue is a parent's source of truth for pending kid proofs,
// disputes and AI SAFETY FLAGS. A dropped read error here would render the
// reassuring "All caught up! 🎉" empty state — a parent could miss a
// safety-flagged submission because the page falsely says there's nothing to
// review.
```

The submissions read fails closed. The media read that shows the parent what the
child actually did fails silent.

**Impact.** A parent approves or rejects a chore on the assumption that no photo
was submitted, when one was and the page could not sign it.

**Fix.** Capture the error, and render a per-item "couldn't load this photo"
marker rather than an empty gallery. This folds naturally into the
`createSignedUrls` batch change in C-4-03, which returns a per-path error.

Status: **VERIFIED**

---

## C-4-12

```
[CLAUDE-4][LOW][QA] The vitest config's JSX block is dead under vitest 4, its
comment asserts the opposite, and a .test.tsx file would never run
File:     vitest.config.ts:11-21
```

**Problem.** Two issues in one file.

(a) The config sets both `esbuild` and `oxc`, with a comment stating that `oxc`
is the no-op:

```ts
// vitest 2.x / vite 5 transforms with esbuild, so the JSX automatic runtime
// must be set under `esbuild` (the `oxc` key only applies to vitest 3+/rolldown
// and is a no-op here). … `oxc` is kept for forward-compat with vitest 3.
esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
oxc:     { jsx: { runtime: 'automatic' } },
```

The repo is on vitest 4.1.10, and every run prints:

```
Both esbuild and oxc options were set. oxc options will be used and esbuild
options will be ignored. The following esbuild options were set:
`{ jsx: 'automatic', jsxImportSource: 'react' }`
```

The situation is exactly inverted from what the comment says. It works — `oxc`
carries the automatic runtime — but the comment now misdirects anyone debugging
the "React is not defined" failure it was written to explain, and the warning is
noise on all 1,182 files.

(b) `include: ['tests/**/*.test.ts']` does not match `.test.tsx`. There are zero
`.test.tsx` files today, so nothing is being skipped — but the config gives no
error for one, so a component test written with that extension would be silently
collected by nobody and read as passing.

**Fix.** Drop the `esbuild` block and correct the comment to say vitest 4 uses
`oxc`. Widen to `tests/**/*.test.{ts,tsx}`. While in this file, add
`test.env = { TZ: 'UTC' }` (C-4-04) and an explicit `test.testTimeout`
(C-4-05).

Status: **VERIFIED**

---

## C-4-13

```
[CLAUDE-4][LOW][QA] Sixty-nine test blocks assert only the absence of a pattern,
so the behaviour they are named for can be deleted without failing them
File:     69 `it()` blocks across ~60 files; see list below
```

**Problem.** These blocks contain only `.not.toContain` / `.not.toMatch`
assertions against source text. Most are legitimate ratchets ("never reintroduce
X") paired with a positive test in the same file, and I am not proposing to
change those. The risk is the subset where the negative assertion is the *only*
statement of the property. I checked which files are negative end to end:

```
tests/database-error-boundaries.test.ts   3 assertions, all negative
tests/seed-failure-safety.test.ts         2 assertions, all negative
```

`seed-failure-safety` is C-4-06 and is the serious one.
`tests/database-error-boundaries.test.ts:35-42` is milder — `readFileSync` throws
if a route file is deleted, so deletion of the *file* is caught; but deletion of
all error handling from a route passes, and its `routes` array lists
`app/api/weekend/discover/route.ts`, `app/api/ai/meals/plan/route.ts` and
`app/api/ai/meals/nutrition/route.ts` **twice each**, which suggests the list was
assembled by hand and is not maintained against the route tree.

**Impact.** Low on its own. Recorded because it is the same family as the
finalaudit's F4 / F-004 / F-019, and because C-4-06 shows what it looks like when
a file has no positive counterpart at all.

**Fix.** For any `it()` whose assertions are entirely negative, add one positive
assertion naming what *should* be there. For `database-error-boundaries`, derive
the route list from a walk of `app/api/**/route.ts` rather than a hand-kept
array, and dedupe it.

Status: **VERIFIED**

---

## Checked and found healthy (no action)

Recorded so the next pass does not re-derive them.

- **Tautological assertions.** No `expect(true).toBe(true)`, `expect(1).toBe(1)`,
  `it.skip`, `describe.skip`, `it.todo`, `xit(` or `.only(` anywhere in
  `tests/**`. The one `.only`-looking hit is the string `'process.exit(1)'`
  inside an assertion.
- **Tests whose subject is stubbed out.** I checked every file for "all `@/…`
  imports are also `vi.mock` targets". One candidate,
  `tests/assistant-engine.test.ts`, is a false positive — the subject
  (`@/lib/ai/assistant-engine`) is imported unmocked at line 56 after the mocks.
  No real instances.
- **Tests anchored on a string that only appears in a comment.** Scripted across
  every `readFileSync` + `toContain` pair in the suite. One candidate,
  `tests/notification-write-boundary.test.ts:130`, is a false positive — all five
  files it checks contain a real `await notify(scope, {` call.
- **Vacuous globs.** Scripted for "iterates a `readdirSync` result and asserts
  inside the loop with no non-emptiness check". 28 candidates; I read the
  safety-relevant ones (`family-day-not-greenwich-day`, `no-limit-above-the-row-cap`,
  `route-access-is-total`) and each carries an explicit non-vacuity guard —
  `expect(cols.size).toBeGreaterThan(50)`, `expect(routes.size).toBeGreaterThan(40)`,
  and a "recognises the pattern it forbids" block. These are well built.
  `seed-failure-safety` (C-4-06) is the exception.
- **Double-approval of a pending request.** `decideSpendRequestAction` and
  `decideAllowanceRequestAction` both check `appr.status !== 'pending'` and then
  delegate to `wallet_decide_spend` / `wallet_decide_allowance`, so the
  read-then-write is closed inside the RPC, not in JS.
- **Expired / replayed invites.** `accept_invite` (migration 0136) takes
  `for update`, returns idempotently when the *same* user re-accepts, and still
  rejects a non-pending token, an expired token, and a different user's token.
  `components/auth/join-invite.tsx:28` guards the React strict-mode double effect
  with a ref. This flow is in good shape.
- **Deleted record still referenced.** Both child-facing pages tolerate a missing
  parent row (`app/(app)/missions/page.tsx:81` `chore?.title ?? 'Chore'`,
  `app/(app)/kids/page.tsx:77` `c?.title ?? 'Job'`).
- **Feature flags permanently off.** There are none — no boolean env flags in
  `app/`, `lib/` or `components/`. Capability gating is derived from live provider
  state (`getMoneyCapabilities`), not from flags.
- **`await` in a loop.** 51 sites found. All but the ones in C-4-03 are either
  cron/batch jobs (where sequential is the point) or chunked inserts iterating
  `i += 200` / `i += 500` (a bounded number of batched round trips, which is the
  fix pattern, not the defect).

---

## Method

- `finalaudit.md` read first; no finding here restates F1-F21 or F-001-F-020.
  C-4-01 and C-4-02 are *siblings* of F-013 and F-017 respectively — the same
  defect at a call site the accepted fix did not reach — and are written to say
  so explicitly.
- Two full suite runs (`TZ=UTC`, `TZ=America/Los_Angeles`), 195 s each.
- Four scripted sweeps over `tests/**` (mock-only subjects, comment-only anchors,
  vacuous globs, negative-only assertions) and one over `app/`+`lib/`
  (`await` inside a loop over rows). Scripts are in the scratchpad, not the repo.
- Every finding above was confirmed by reading the actual file. Nothing was
  inferred from a grep hit alone.

**What this pass could not reach.** No database and no running app, so every
claim is static or from the unit suite: I could not demonstrate C-4-01's cap
being hit, could not exercise a real double-submit against C-4-08, and did not
run the Playwright device matrix in `tests/e2e/`.

**No source code was modified.**

---

# Findings from the parallel audit session (merged 2026-09-13T23:51Z)

Two audit sessions ran against this repository at the same time. Both
wrote to this path, so git saw an add/add conflict. **Neither side is
discarded** — the rule is that no worker's findings are deleted, and that
applies across sessions as much as within one. The other session's file
follows verbatim; it uses a different finding format, which is left as it
was written rather than reformatted.

# Claude-4 — QA / Features / Flows / Performance / Edge Cases

CURRENT: Survey of the test corpus for vacuous guards (the repository's defining defect class).
COMPLETED: (none yet)
NEXT: vacuous-test sweep → E2E flow trace → edge cases → performance.
FILES-EXAMINED: (in progress)
BLOCKERS: none

CURRENT: Vacuous-guard sweep + scale/edge-case sweep. Auth-admin row ceiling found and confirmed.
COMPLETED:
  - Test-corpus survey: 1,194 test files; 3 skip markers (all conditional E2E gates); 0 `it.todo`;
    0 tautological `expect(true).toBe(true)`; 0 empty `catch {}` swallowing an assertion.
  - Loop-vacuity scan: 664 `expect()`-inside-`for..of` sites; 557 without an explicit non-emptiness
    guard, but 383 of those iterate a literal array (cannot be empty). 69 iterate a computed
    collection — each triaged; none is empty today (measured).
  - Comment-satisfaction scan: 501 test files read source with `readFileSync`; 1 real instance of an
    assertion satisfiable only by a comment (rest were my own scanner's false positives on YAML/MD).
  - SQL probes: 16 `*-check.sql`, globbed by `run-probes.sh`. Transaction/cleanup discipline measured.
  - N+1 scan over app/ + lib/ + components/: 75 sequential loops containing a Supabase round trip.
NEXT: end-to-end flow trace (signup -> family -> invite -> child login -> chore -> reward -> wallet);
  timezone/DST edge cases beyond F-017; empty-state and single-member-family edge cases.
FILES-EXAMINED: see per-finding paths, plus tests/ (corpus-wide scans), docs/audit/*.sql,
  app/api/cron/*, lib/server/notification-emails.ts, lib/network/compare-line-server.ts, vercel.json.
BLOCKERS: none. No live Supabase in this sandbox (127.0.0.1:54321 refused), so findings are
  established from the installed library's own contract + the repository's own contradicting call sites.
LAST-UPDATE: 2026-09-13

---

## Sweep 1 — feature gates that cannot fail

Method: extract every href literal passed to `requireFeature()`,
`refuseUnlessEntitled()`, `familyHasFeature()` and `resolveFeatureEntitlement()`
across `app/`, `lib/`, `components/` (worktrees under `.claude/` and `tests/`
excluded — an earlier pass of this scan reported 84 "readers" of one table and
every one of them was a `.claude/worktrees/` copy), and diff that set against the
100 `href` values in `lib/constants/feature-catalog.ts`.

81 distinct gate keys are in use. 79 resolve. **Two do not.**

---

### [CLAUDE-4][HIGH][FEATURES] Vacation Planner and Weekend Planner are gated with a key the catalog does not contain, so 21 gate call sites allow everyone

- **File:** `lib/constants/feature-catalog.ts:22-149` (the catalog) vs
  `app/(app)/dashboard/vacations/page.tsx:8`, `app/(app)/dashboard/vacations/new/page.tsx:8`,
  `app/(app)/dashboard/vacations/[id]/layout.tsx:16`, the eleven
  `app/(app)/dashboard/vacations/[id]/*/page.tsx` tabs,
  `app/(app)/dashboard/vacations/calendar/page.tsx:8`,
  `app/(app)/dashboard/vacations/reports/page.tsx:8`,
  `app/(app)/dashboard/weekend/page.tsx:8`,
  `app/api/vacations/ai/route.ts:37`, `app/api/vacations/weather/route.ts:22`,
  `app/api/weekend/discover/route.ts:35`
- **Problem:** `resolveFeatureEntitlement` (`lib/server/feature-entitlement.ts:63-66`)
  is explicit that an href absent from the catalog is **not gated**:

  ```ts
  const tier = byHref[href];
  if (tier === undefined) return { allowed: true, planLevel };
  ```

  `/dashboard/vacations` and `/dashboard/weekend` are absent. The catalog carries
  `F('trips', …, 'basic', '/dashboard/trips')` — a *different* route, a different
  page — and has no entry for either of these two. Every one of the 21 call sites
  therefore resolves `allowed: true` for every family on every plan, including a
  family whose trial has lapsed to Free.
- **Evidence:** bundled `lib/features/tiers.ts` + the catalog with esbuild and
  evaluated the resolver's own input map:

  ```
  $ node gate1.cjs
  /dashboard/vacations     => undefined
  /dashboard/weekend       => undefined
  /dashboard/trips         => "basic"
  /dashboard/chores        => "free"
  catalog has /dashboard/vacations? false
  catalog has /dashboard/weekend?   false
  ```

  `tiersByHref` is the only source `resolveFeatureEntitlement` consults, and
  `requireFeature` / `refuseUnlessEntitled` are both thin wrappers over it
  (`lib/supabase/auth.ts:246`, `lib/server/route-feature-gate.ts:39-40`). Neither
  page nor route carries any second gate — `grep -rn "requirePlanLevel\|planLevel"`
  over `app/(app)/dashboard/{weekend,vacations}` and `app/api/{weekend,vacations}`
  returns nothing.
- **Impact:** three ways.
  1. `lib/constants/navigation.ts:161,162` publishes both as `minLevel: 1`
     (Family Basic+), and `resolveItems` (`components/app/nav-shared.tsx:63-64`)
     decides locked/unlocked from `featureTiers[item.href]`, **not** from
     `minLevel` — so an undefined tier renders the item as a normal, unlocked
     link. A Free family sees "Vacation Planner" and "Weekend Planner", clicks
     through, and gets the whole 13-tab trip workspace the plan does not sell.
  2. `/api/vacations/ai` calls a model (`resolveProvider`, line 39 onward) with
     only a 20/window rate limit in front of it, and `/api/weekend/discover`
     fans out to Ticketmaster and SeatGeek on the deployment's own API keys.
     Both are billed per request and both are open to Free.
  3. The `/pricing` grid is generated from this same catalog
     (`app/(marketing)/pricing/page.tsx:46`), so neither feature appears on any
     published plan at all. The product sells neither and the code gives both
     away — the mirror image of Pass L.
- **Fix:** add the two missing rows to `FEATURE_CATALOG`, at the tier the nav
  already claims:
  `F('vacations', 'Vacation Planner', 'Family & Home', 'basic', '/dashboard/vacations')`
  and `F('weekend-planner', 'Weekend Planner', 'Family & Home', 'basic', '/dashboard/weekend')`.
  No call site changes. Then close the class: a test that asserts every href
  literal reaching `requireFeature`/`refuseUnlessEntitled` exists in
  `tiersByHref(resolveFeatureTiers({}))` — the scan above, as a guard.
- **Status:** FIXED by Claude-1 during this session (commit `c8a7d576`, "P-01:
  two features the product does not sell, and the code gave away"). Re-verified
  after the edit by re-running the same probe: `/dashboard/vacations` and
  `/dashboard/weekend` now both resolve to `"basic"`. The class guard is not yet
  written, and the companion finding below — the test that passed over this — is
  still OPEN.

---

### [CLAUDE-4][MEDIUM][TESTS] `tests/route-plan-gate.test.ts` asserts the gate's source text, so it passes over three routes where the gate does nothing

- **File:** `tests/route-plan-gate.test.ts:136-138`, assertion at `:147-150`
- **Problem:** the table-driven half of this suite reads each route's **source**
  and asserts a substring:

  ```ts
  const source = stripComments(read(route));
  expect(source).toContain('refuseUnlessEntitled(');
  for (const href of hrefs) expect(source).toContain(`'${href}'`);
  ```

  That is a check that the line was typed, not that it refuses anybody. Three of
  its twenty entries — `weekend/discover`, `vacations/ai`, `vacations/weather` —
  name hrefs the catalog does not contain, so at runtime the gate they assert
  returns `allowed: true` for every family. The test is green today and would
  stay green if the catalog were emptied.
- **Evidence:** the file's own first `describe` shows the shape that *would* have
  caught it — it drives `app/api/ai/savings/route.ts` against an in-memory
  Supabase seeded with a `free` and a `plus` family and asserts `403` /
  `needLevel: 1` / the rate limiter never being reached. Exactly one route
  (`ai/savings`) gets that treatment; the other nineteen get the substring check.
  Behavioural proof of the gap is in the finding above.
- **Impact:** this is the guard that exists specifically to stop an AI endpoint
  serving a family that is not entitled, and it is structurally incapable of
  seeing the case where the entitlement key is wrong — which is the only way the
  gate can be present and still not gate.
- **Fix:** keep the substring check (it is a cheap regression net for a deleted
  line) and add one assertion beside it that costs nothing:

  ```ts
  const byHref = tiersByHref(resolveFeatureTiers({}));
  for (const href of hrefs) expect(byHref[href]).toBeDefined();
  ```

  Revert the catalog fix and this goes red on three rows; with the fix it is
  green. Better still, extend the `savings` harness to run the whole `GATED`
  table — the mocks are already generic.
- **Post-fix confirmation:** the catalog defect was fixed during this session
  (commit `c8a7d576`). This suite was run before and after: **green both times,
  37 passed, identical output.** A guard whose result does not move when the
  defect it exists for is fixed was not measuring that defect.
- **Status:** OPEN

---

## Sweep 2 — the money spine: chore → approve → pay, and allowance runs

Traced first click to stored row on a **real 310-migration replay**
(`bash docs/audit/verify-pg.sh up`, 310/310 applied, 0 failed). Everything below
was raced on that database, two connections genuinely in flight.

Pass B / F-019 proved the *debit* side safe: `wallet_reserve_card_auth` holds
`FOR UPDATE`, and two simultaneous $8 authorizations against $10 yield exactly
one approval. **The credit side has no such lock, and nothing had raced it.**

---

### [CLAUDE-4][HIGH][MONEY] `runDueAllowancesAction` claims a rule with a blind update, so a parent tapping "Run now" twice pays the allowance twice — the cron beside it does not have this bug

- **File:** `app/(app)/wallet/actions.ts:328-330` (the claim) vs
  `app/api/cron/wallet-allowance/route.ts:79-87` (the correct claim)
- **Problem:** both paths do the same job — find rules with `next_run_on ≤ today`,
  advance the schedule, credit the wallet. The cron **claims** the rule:

  ```ts
  .update({ next_run_on: next, last_run_on: today })
  .eq('id', rule.id).eq('family_id', rule.family_id)
  .lte('next_run_on', today)          // ← the exclusivity guard
  .select('id').maybeSingle();
  if (!claimed) continue;             // another run won — do not double-pay
  ```

  and its own comment explains exactly why. The parent-initiated action, forty
  lines away in a different file, does not:

  ```ts
  .update({ next_run_on: next, last_run_on: today })
  .eq('id', rule.id).eq('family_id', familyId)
  .select('id').single();
  if (advanceError || !advancedRule) return actionFailure(…);
  // …then credits unconditionally
  ```

  With no predicate on `next_run_on`, both overlapping runs match the row, both
  get a row back, and both credit. The action's docstring claims the opposite:
  *"Idempotent with the Vercel cron — both act only on DUE rules, so if the cron
  already ran, nothing is due and this pays nothing (no double-pay)."* That holds
  only if the two are sequential.
- **Evidence:** one rule (`amount_cents = 1000`, `next_run_on = current_date − 1`)
  on the replayed database; each shape run twice, concurrently, from two psql
  connections with a 2-second overlap between the read and the write, the credit
  gated on the update's own `RETURNING` exactly as the code gates it on
  `claimed` / `advancedRule`:

  ```
  == CRON shape — UPDATE carries .lte('next_run_on', today) ==
  ledger_rows=1  cents_credited=1000
  == SERVER ACTION shape — UPDATE by id only ==
  ledger_rows=2  cents_credited=2000
  ```

  Same rule, same seconds, same ledger. The predicate is the entire difference.
- **Impact:** the child is paid twice for one period from the family's money, and
  `wallet_transactions` is an append-only ledger (`0088`, and
  `tests/wallet-audit-log-append-only.test.ts`) — so the correction is a manual
  reversal row, not a delete. Reachable without any exotic client:
  `components/wallet/allowance-view.tsx:48` is a plain button, and two tabs, a
  double-submit on a slow connection, or a parent tapping while the nightly cron
  is mid-run all produce the overlap. The window is as wide as one
  `creditChildWallet` round trip.
- **Fix:** one line — add `.lte('next_run_on', today)` to the action's update and
  treat a null result as "another run won", `continue` rather than
  `actionFailure`. That makes the action and the cron the same claim, which is
  what the docstring already says they are.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][TESTS] The allowance double-pay guard is pointed at one of the two places the pattern lives

- **File:** `tests/allowance-cron-idempotency.test.ts:11`
- **Problem:** the guard is a source-text assertion over a single hardcoded file:

  ```ts
  const SRC = readFileSync('app/api/cron/wallet-allowance/route.ts', 'utf8');
  expect(SRC).toMatch(/\.update\(\{\s*next_run_on[\s\S]{0,160}?\.lte\('next_run_on',\s*today\)/);
  expect(SRC).toMatch(/if\s*\(!claimed\)\s*continue/);
  ```

  Its header states the property in general terms — *"If two invocations overlap
  (Vercel cron re-fire / **manual trigger** / >maxDuration run), both must NOT
  credit the same period"* — and "manual trigger" is `runDueAllowancesAction`,
  which the test never opens. The property is asserted of the file, not of the
  behaviour, so the second implementation of the same claim was free to ship
  without one.
- **Evidence:** `grep -rn "next_run_on" app lib --include=*.ts` returns two
  claim sites; the test names one. The race above is the behaviour the test
  header describes, failing in the file the test does not read.
- **Impact:** this is the only guard on the allowance money path, and it is green
  over a live double-pay.
- **Fix:** make the scan cover both — glob every file that updates
  `allowance_rules.next_run_on` and assert each carries the `.lte('next_run_on', …)`
  predicate. Better, add the behavioural half: `tests/helpers/in-memory-supabase`
  already backs `tests/route-plan-gate.test.ts`; two interleaved
  `runDueAllowancesAction()` calls against one due rule must produce one credit.
  Revert the one-line fix above and that test goes red; with it, green.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][MONEY] `payChoreRewardAction` is a check-then-act with no constraint behind it, and its docstring names a marker that does not exist

- **File:** `app/(app)/wallet/actions.ts:186-215`
- **Problem:** the docstring says *"Idempotent per assignment via a marker on the
  assignment row."* There is no marker on the assignment row. The implementation
  is a SELECT followed, over a separate HTTP round trip, by an INSERT:

  ```ts
  const { data: existing } = await supabase
    .from('wallet_transactions').select('id')
    .eq('family_id', familyId).eq('related_type', 'chore_assignments')
    .eq('related_id', assignment.id).limit(1);
  if ((existing ?? []).length > 0) return { ok: false, error: … };
  …
  const res = await creditChildWallet(supabase, { … relatedType: 'chore_assignments', relatedId: assignment.id });
  ```

  `creditChildWallet` (`lib/wallet/server.ts:267`) then does a plain
  `.insert(rows)`. The supabase-js client has no transaction, so the two calls
  cannot be atomic; the only thing that could make them safe is a database
  constraint.
- **Evidence:** there is none, confirmed on the replayed catalogue rather than
  from the migration text:

  ```
  $ psql -c "select conname, contype from pg_constraint where conrelid='public.wallet_transactions'::regclass"
    …_amount_cents_check | c        (amount_cents >= 0)
    six FK constraints
    wallet_transactions_pkey | p     PRIMARY KEY (id)
  $ psql -c "select indexname from pg_indexes where tablename='wallet_transactions'"
    wallet_transactions_pkey | idx_wallet_txn_child | idx_wallet_txn_status | idx_wallet_txn_bucket
  $ psql -c "select tgname from pg_trigger where tgrelid='public.wallet_transactions'::regclass and not tgisinternal"
    trg_wallet_transactions_updated_at   (BEFORE UPDATE, set_updated_at)
  ```

  Nothing on `(related_type, related_id)`; no BEFORE INSERT trigger. Raced on the
  same database, both sessions reading `already_paid = 0` before either inserted:

  ```
  ledger_rows=2  cents_credited=1000      -- a 500-cent chore
  ```
- **Impact:** lower than the allowance case because
  `components/modules/chores-module.tsx:176` holds a `paying` flag, so a single
  tab cannot double-submit. Two tabs, the mobile client, or a retried server
  action can. The consequence is the same: an unreversible extra credit in an
  append-only ledger.
- **Fix:** a partial unique index is the real guard and costs one migration —
  `create unique index … on wallet_transactions (family_id, related_type, related_id, coalesce(bucket_id,'00000000-…'::uuid)) where related_type = 'chore_assignments'`
  (the composite is needed because `creditChildWallet` writes one row per bucket,
  so `related_id` alone is not unique by design). Then treat `23505` from the
  insert as "already paid" rather than as a failure. Either way, correct the
  docstring: it currently describes a mechanism that was never built.
- **Status:** OPEN

---

## Sweep 3 — features that are wired but cannot work

Method, and its first result was a false positive worth recording: a scan for
`.from('x')` with no matching `.insert/.update/.upsert/.delete` reported 41
"tables read but never written". Checking them one at a time, most were writable
after all —

- **19** are written through a *dynamic* table name the scan cannot see:
  `components/vacations/shared.tsx:130` does `.from(table).insert(...)` where
  `table` is a prop, which is how every `vacation_*` table is populated, and
  `lib/family/actions.ts:22` holds a `WRITABLE` allowlist keyed by table name
  that covers `family_routines`, `family_milestones`, `family_memories`,
  `family_emergency_contacts/plans`, `family_stress_signals` and five more;
- **7** are catalogs seeded by a migration `INSERT` (`invest_assets`,
  `social_providers`, `sync_providers`, `marketplace_circles`, …);
- **12** are written by RPCs or webhook handlers.

Three survive. Each is a feature that a family can reach and that cannot
produce a non-empty state on a production database.

---

### [CLAUDE-4][HIGH][FEATURES] The Experience Scorecard is in every family's sidebar and its only possible state is an empty state that tells them to run a SQL file

- **File:** `lib/constants/navigation.ts:218`,
  `app/(app)/dashboard/experience/page.tsx`,
  `components/modules/experience-scorecard-module.tsx:50-58` and `:87`
- **Problem:** the page reads `experience_audits` and rolls it up. **Nothing
  writes `experience_audits`** — not a server action, not a route handler, not a
  cron, not the `lib/family/actions.ts` `WRITABLE` allowlist, not a migration
  `INSERT`, not even `SEED_ALL.sql`. The only producer in the repository is
  `supabase/seed_experience_audits_one_family.sql`, a hand-run developer seed.
  So `card.auditedSurfaces` is always `0` and the module always renders its empty
  state — whose copy is:

  ```tsx
  description="Once surfaces are audited, this scorecard grades each one across the
  six premium dimensions and tracks the trend. Run
  seed_experience_audits_one_family.sql to populate a baseline."
  ```
- **Evidence:** every reference to the table in the repository, with test files,
  worktrees and `lib/database.types.ts` excluded:

  ```
  supabase/migrations/0144_experience_audits.sql   (DDL, indexes, 4 RLS policies)
  components/modules/experience-scorecard-module.tsx:22,50,51,54   (read only)
  tests/behavior-read-bounded.test.ts:42                            (asserts the read is bounded)
  supabase/seed_experience_audits_one_family.sql                    (dev seed)
  ```

  No writer. `PRODUCTION_DEPLOYMENT_CHECKLIST.md:83` — *"Legacy service-role seed
  scripts require a confirmed non-production seed scope"* — is the line that
  makes this permanent rather than a matter of remembering: the seeds are barred
  from production on purpose.
- **Impact:** `minLevel: 0`, so the entry is visible and unlocked to every family
  on every plan, in the "Family AI OS" group. A parent taps "Experience
  Scorecard" and is told to run a `.sql` file. That is a developer instruction
  shipped as product copy (it is also the one string in that module not passed
  through `t()`, so it is English in all eleven locales).
- **Fix:** decide which of the two this is and do that one.
  (a) It is an internal instrument — remove the nav entry and keep the page for
  super-admins, as `/dashboard/journeys` and `/dashboard/onboarding-funnel`
  already do (`isSuperAdmin()` → `notFound()`).
  (b) It is a product feature — then something has to write the rows: the six
  dimensions are all measurable from telemetry the app already has, and the
  scorecard would need a producer (a nightly pass, or a write at the end of each
  audited surface's render).
  Either way, delete the seed-file instruction from user-facing copy.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][FEATURES] The Family App Store installs apps that nothing in the product ever reads, from a catalog production never gets

- **File:** `app/(app)/dashboard/app-store/page.tsx`,
  `app/(app)/dashboard/app-store/actions.ts:18,32,44`,
  `supabase/migrations/0165_family_app_store.sql`
- **Problem:** three separate things are each individually true.
  1. **The install does nothing.** `installAppAction` upserts
     `family_app_installs`; `uninstallAppAction` deletes; a third action toggles
     `enabled`. The complete set of readers of that table is **one**:
     `app/(app)/dashboard/app-store/page.tsx:27`, which uses it to decide whether
     the button on that same page says "Install" or "Installed". No AI tool, no
     nav, no dashboard, no capability check anywhere consults a family's installs.
     The `enabled` column has no reader at all.
  2. **The catalog is empty in production.** `family_apps` has no `family_id` —
     it is global reference data — and no migration inserts a row. The only
     producer is `supabase/seed_family_apps.sql` / `SEED_ALL.sql`, whose own
     header calls it *"500-row test data"*, and which the deployment checklist
     bars from production.
  3. **The page is unreachable.** `/dashboard/app-store` appears in no nav group,
     no `PRIMARY_NAV`, no `MOBILE_TABS`, no `ALL_SERVICES_CATALOG`, and is not
     linked from any other page. A scan of all 353 static page routes for a path
     literal named anywhere outside the page's own folder leaves 22 candidates,
     of which 9 are `${BASE}`-template marketplace tabs, 4 are deliberate
     `redirect()` stubs, and this is one of the genuine remainder.
- **Evidence:**

  ```
  $ rg -n "family_app_installs" (excl. node_modules, .claude, mobile, *.test.*)
    app/(app)/dashboard/app-store/page.tsx:27      ← the only read
    app/(app)/dashboard/app-store/actions.ts:18,32,44
    supabase/migrations/0165_family_app_store.sql  (DDL/RLS)
    database-map.md:103, feature-inventory.md:12   (docs)
  $ rg -ci "insert into (public\.)?family_apps" supabase/migrations/*.sql → 0
  $ rg -n "app-store" lib/constants/*.ts components/app/*.tsx → (no output)
  ```
- **Impact:** a complete vertical — migration, RLS, catalog model, ranking and
  recommendation logic (`lib/appstore/catalog.ts`), three server actions, an
  optimistic install button — that on production shows an empty grid to anyone
  who guesses the URL, and whose one write has no consumer. `feature-inventory.md`
  lists it as a shipped feature.
- **Fix:** it is a product decision, not a code fix. If the App Store ships:
  seed `family_apps` from a **migration** (it is global reference data, which is
  what migrations are for), give installs a consumer, and add the nav entry +
  catalog row. If it does not: the page, the two tables and the actions should
  leave the tree, and `feature-inventory.md` should stop claiming it.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][FEATURES] The first-run brief's "dinner ideas" come from a catalog production has no way to populate

- **File:** `app/onboarding/actions.ts:81-102` (`fetchDinnerCandidates`),
  `lib/onboarding/dinner-ideas.ts`,
  `components/onboarding/onboarding-wizard.tsx:772`,
  `components/dashboard/home-outcome-card.tsx:55`
- **Problem:** same shape as `family_apps`. `meal_ideas` is a global catalog
  (`0139_meal_ideas.sql`, no `family_id`) whose comment says *"No client
  writes"*; nothing in the app writes it; no migration inserts a row; the only
  producer is `supabase/seed_meal_ideas.sql`. `fetchDinnerCandidates` is
  best-effort by design — *"if the table isn't migrated yet the brief just
  carries no dinner ideas (never blocks onboarding)"* — so an **empty** catalog
  is indistinguishable from a missing one and produces `[]` silently.
- **Evidence:** `rg -ci "insert into (public\.)?meal_ideas" supabase/migrations/*.sql`
  → 0. The catalog is the brief's only source: `lib/onboarding/dinner-ideas.ts`
  is a pure picker over the rows it is handed, and its header states the reason —
  *"A brand-new family has no recipes of its own, so the briefing's 3 dinner
  ideas come from the curated meal_ideas catalog."*
- **Impact:** this is the VALUE-FIRST payoff the onboarding wizard is built
  around (`previewCalendarImportAction`, *"the user sees their day/week come
  together before we ask them to configure anything"*). With an empty catalog the
  dinner block never renders, and
  `onboarding-wizard.tsx:772` shows the shape of the worst case:

  ```ts
  const hasBrief = !!brief && (brief.todayCount > 0 || brief.dinnerIdeas.length > 0
                               || brief.timeSavedMinutes > 0 || brief.conflicts.length > 0);
  ```

  A family that skips the calendar import — no events today, no conflicts, no
  minutes saved — has **all four** disjuncts false, so the "here is your first
  brief" card is not rendered at all and the wizard's final step is a plain
  "All set". The one term that would have carried it on its own is the one fed by
  the empty catalog. The same catalog feeds the home dashboard's weekly dinner
  ideas (`home-outcome-card.tsx:55`).
- **Fix:** move the curated catalog into a migration — it is reference data with
  no tenant, exactly like `invest_assets` (`0`-family, seeded by migration) and
  `social_providers`. That is a five-line change of file, not of content. And
  separate "catalog is empty" from "catalog is missing" in
  `fetchDinnerCandidates`, so an empty production catalog is visible in the logs
  instead of looking like a family with no ideas.
- **Status:** OPEN

---

## Sweep 4 — the three descriptions of one offer

There are **three** independent statements of who may use a destination, and no
two of them are read by the same code:

| statement | lives in | what it actually drives |
|---|---|---|
| `minLevel` | `lib/constants/navigation.ts` | **nothing to do with access** — only membership of `NAV_CATALOG`, the free tier's "add a destination" picker |
| `defaultTier` | `lib/constants/feature-catalog.ts` | the sidebar's locked/unlocked rendering (`resolveItems` → `featureAccessByTier`), `requireFeature`, `refuseUnlessEntitled`, **and** the published `/pricing` grid |
| `requirePlanLevel(n)` | eight page files | that page, and nothing else |

`resolveItems` (`components/app/nav-shared.tsx:59-68`) reads `featureTiers[item.href]`
and never looks at `item.minLevel`. Measured across the 135 distinct nav
destinations: **28 disagree** between `minLevel` and the tier that actually
gates. `tests/plans-and-gates-agree.test.ts` guards one direction of this
(a *pinned* route gated above free) and nothing guards the rest.

---

### [CLAUDE-4][HIGH][FEATURES] Home & Maintenance is sold as Family+, locked in the sidebar at Family+, and opened by the page at Family Basic

- **File:** `lib/constants/feature-catalog.ts` → `F('home-inventory', 'Home Inventory', 'Family & Home', 'plus', '/dashboard/home')`
  vs `app/(app)/dashboard/home/page.tsx:8` → `await requirePlanLevel(1)`
  (and the same at `home/diagnose:10`, `home/service:10`, `home/maintenance:14`,
  `home/warranties:10`, `home/pros:10`, `home/assets/[id]:80`)
- **Problem:** three sources, two answers.
  - `/pricing` is generated from `FEATURE_CATALOG`
    (`app/(marketing)/pricing/page.tsx:46`), so **Home Inventory is published as a
    Family+ feature**.
  - `resolveItems` resolves `/dashboard/home` to `plus`, so a **Family Basic**
    household sees "Home & Maintenance" greyed out with a padlock and gets the
    upgrade prompt on click.
  - The seven pages themselves ask for `requirePlanLevel(1)`, which **admits any
    Family Basic household** that reaches the URL. `requirePlanLevel` does not
    consult the catalog at all (`lib/supabase/auth.ts:215-227`): it reads
    `resolveFamilyPlanLevel` and compares to its literal argument.
- **Evidence:** every `requirePlanLevel` call site in `app/`, against the tier
  the catalog resolves for the same route:

  ```
  /dashboard/home/diagnose      page=1  catalog=2   MISMATCH
  /dashboard/home/service       page=1  catalog=2   MISMATCH
  /dashboard/home/maintenance   page=1  catalog=2   MISMATCH
  /dashboard/home               page=1  catalog=2   MISMATCH
  /dashboard/home/assets/[id]   page=1  catalog=2   MISMATCH
  /dashboard/home/warranties    page=1  catalog=2   MISMATCH
  /dashboard/home/pros          page=1  catalog=2   MISMATCH
  /dashboard/contact-center     page=2  catalog=—   MISMATCH   (next finding)
  /dashboard/auto{,/7 subpages} page=1  catalog=1   ok
  ```

  The eight `/dashboard/auto*` pages are the control: same helper, same shape,
  and they agree, so this is drift in one feature and not a property of
  `requirePlanLevel`.
- **Impact:** both directions are wrong at once, which is what makes it worth a
  HIGH rather than a tidy-up.
  - *Revenue:* a Family Basic household that types `/dashboard/home/maintenance`,
    follows an old link, or lands there from a search result gets the whole Plus
    Home vertical — assets, warranties, pros, maintenance, service history.
  - *Product:* that same household is shown a padlock on the sidebar entry for
    the feature the page will hand them, and told to upgrade.
  - *Consistency:* the AI route behind it disagrees with the page too —
    `tests/route-plan-gate.test.ts:125-127` gates `ai/home/diagnose`,
    `ai/home/find-pro` and `ai/home/forecast` on `'/dashboard/home'`, which
    resolves through the catalog to `plus`. So the **page** admits Basic and the
    **AI endpoint the page calls** refuses them: a Basic family opens a Plus
    screen and every AI button on it answers 403.
- **Fix:** pick the tier the product actually sells, then make one source say it.
  If Home is Plus (what `/pricing` publishes), change the seven pages to
  `requirePlanLevel(2)` — better, to `requireFeature('/dashboard/home')`, so the
  page reads the catalog like every other gated page does and cannot drift
  again. If Home is Basic, change `defaultTier` to `'basic'` and the pricing grid
  follows automatically. Then guard it: assert every `requirePlanLevel(n)` in
  `app/**/page.tsx` matches `tierToLevel(tiersByHref[route])` when the route is
  in the catalog — the scan above, as a test. It goes red on seven rows today.
- **Status:** OPEN

---

### [CLAUDE-4][MEDIUM][FEATURES] Operations Center is a permanent unlocked sidebar button that only produces a billing upsell — the Pass L shape, from the other direction

- **File:** `lib/constants/navigation.ts:203` (`/dashboard/contact-center`, `minLevel: 2`)
  vs `app/(app)/dashboard/contact-center/page.tsx:21`
  (`requirePlanLevel(FAMILY_EMAIL_MIN_PLAN_LEVEL)`, and
  `lib/constants/plans.ts:60` sets that to `2`)
- **Problem:** `/dashboard/contact-center` is not in `FEATURE_CATALOG`, so
  `featureTiers['/dashboard/contact-center']` is `undefined`, so
  `featureAccessByTier(undefined, planLevel)` returns `'visible'` — for every
  plan. `resolveItems` therefore pushes it with `locked: false` and `NavEntry`
  renders a normal `<Link>`, with no padlock, no greying, no upgrade prompt. The
  page then answers `redirect('/dashboard/billing?upgrade=1&need=2')`.

  The item's own `minLevel: 2` says exactly what should have happened and is not
  read by anything that renders it.
- **Evidence:** the chain is four short hops and each was read:
  `nav-shared.tsx:63` `const tier = featureTiers[item.href]` →
  `tiers.ts:107` `if (tier === undefined) return 'visible'` →
  `nav-shared.tsx:66` `locked: access === 'locked'` (false) →
  `nav-shared.tsx:115` renders `<Link href={item.href}>` →
  `auth.ts:224` `if (level < minLevel) redirect(...)`.
  The route scan over all eight `requirePlanLevel` pages found exactly one where
  the catalog has no tier, and this is it.
- **Impact:** every Free and Family Basic household carries a sidebar entry that
  looks live and cannot be used. This is the same defect Pass L closed for the AI
  Assistant — *"every free family had a permanent sidebar button that produced a
  billing upsell"* — approached from the other side: there the catalog was too
  strict, here it has no entry at all, and the visible result is identical.
- **Fix:** add the route to the catalog at the tier the plan sells
  (`F('contact-center', 'Operations Center', 'Family & Home', 'plus', '/dashboard/contact-center')`).
  The sidebar then renders the padlock and the upgrade sheet, `/pricing` lists it
  under Family+, and the page's own `requirePlanLevel(2)` becomes the belt to the
  catalog's braces. The same one-line class as the Vacation/Weekend finding
  above, so both are closed by the same guard: *every nav href that any page
  gates must have a catalog tier.*
- **Status:** OPEN

---

### [CLAUDE-4][LOW][FEATURES] Seven free features cannot be added to a free family's sidebar, because the picker filters on the field that no longer gates

- **File:** `lib/constants/navigation.ts:355-368` (`NAV_CATALOG`), filter
  `if ((item.minLevel ?? 0) === 0) push(...)`
- **Problem:** `NAV_CATALOG` is *"the pool of destinations a member can put in
  their curated sidebar … plus every other **free** (minLevel 0) module"*. It
  decides "free" from `minLevel`, which is the one of the three statements that
  does not gate anything. Where `minLevel` says 1 and the catalog says `free`,
  the family is entitled to the page and cannot pin it.
- **Evidence:** computed from the two modules directly, no grep:

  ```
  routes the catalog grants to Free: 41
  NAV_CATALOG (the "add a destination" picker): 66
  Free-tier routes a free family may open but CANNOT add to their sidebar:
      /dashboard/homework   /dashboard/medical   /dashboard/pantry
      /dashboard/school     /dashboard/signups   /dashboard/timetable
      /dashboard/voting                                    (7)
  ```

  Each of those seven pages calls `requireFeature('<its own route>')` and the
  catalog resolves every one of them to `free`, so a free family can open all
  seven today — from All Services, from a link, from search.
- **Impact:** small and entirely in the product's own disfavour: School,
  Homework, Timetable, Medical, Pantry, Signups and Group Voting are the
  everyday-use destinations a new family would most want on their sidebar, and
  they are the ones the picker hides. It is also the clearest single symptom that
  `minLevel` and `defaultTier` have drifted — 28 of 135 destinations disagree.
- **Fix:** build `NAV_CATALOG` from the same resolver everything else uses —
  `tiersByHref(resolveFeatureTiers({}))[href] === 'free'` — and delete `minLevel`
  from `NavItem`, since after that nothing reads it. If `minLevel` is meant to
  stay as documentation, a test that asserts `minLevel === tierToLevel(catalog tier)`
  for every nav destination turns 28 silent disagreements into one red build.
- **Status:** OPEN

---

## Sweep 5 — the gift spine, end to end

`/wallet/gift` (create link) → `/pay/<handle>` (resolve) → `/gift/<token>`
(public giver form) → `app/gift/actions.ts` (payment) → `approveGiftAction`
(credit). Both public prefixes are confirmed public in
`lib/auth/route-access.ts:48,58`, so these two pages render for anyone with the
URL and no session at all.

Most of it is careful — `/pay/[handle]` deliberately gives the same dead-end for
an unknown handle and a revoked one, and `/gift/[token]` distinguishes a missing
link from a failed read rather than telling a giver mid-payment that a valid
token is dead. One thing is not.

---

### [CLAUDE-4][MEDIUM][PRIVACY] A revoked gift link still shows the parent's message to anyone who kept the URL

- **File:** `app/gift/[token]/page.tsx:38-52` vs `:62`
- **Problem:** the page is explicit about the rule and then breaks it three lines
  later. Every identifying lookup is placed behind `active`:

  ```ts
  const active = !!link && link.is_active;
  let childName = 'a child';
  let familyName = 'a family';
  // An inactive capability must not disclose the household or child it used
  // to target. Keep all identifying lookups behind the active-link check.
  if (active && link?.child_wallet_id) { … childName = m.display_name … }
  if (active && link?.family_id)       { … familyName = fam.name … }
  ```

  and then the render does this, outside any `active` check:

  ```tsx
  <p className="mt-1 text-sm text-muted">{occasionLabel(link?.occasion ?? null)} · {familyName}</p>
  {link?.message && <p …>“{link.message}”</p>}
  ```

  `message` and `occasion` are read straight off the row whenever the row exists.
  `is_active` is not consulted for either.
- **Evidence:** `message` is parent-authored free text —
  `app/(app)/wallet/actions.ts:412-431` takes `message?: string | null` from the
  manager and stores it verbatim; there is no length limit and no sanitisation
  step. `occasion` is the same. `/gift` is in `PUBLIC`
  (`lib/auth/route-access.ts:48`), so the whole page renders with no session.
  The revocation path — `is_active: false` — is the only control a family has
  over a gift link once it has been shared, and it does not cover the one field
  the family wrote themselves.
- **Impact:** a family revokes a gift link because it went somewhere it should
  not have: a group chat, a forwarded email, an ex-partner. The name and the
  household are correctly withheld afterwards — and the sentence the parent
  typed, which is the field most likely to name the child, the birthday and the
  reason ("For Emma's 8th — she's been saving for a bike"), is still served to
  anyone holding the URL, forever. The page's own comment says this must not
  happen.
- **Fix:** move both fields behind the same flag the names already sit behind:
  `{active && link?.message && …}` and `occasionLabel(active ? link?.occasion : null)`.
  Better, narrow the query — select `message`, `occasion` and `suggested_cents`
  only in a second read taken after `is_active` is known, so an inactive link
  never loads the fields at all. Guard: render the page for a token whose
  `is_active` is false and assert the response body contains neither the message
  nor the occasion. The page is a server component with a service-role read, so
  the existing `tests/public-route-write-honesty.test.ts` harness is the shape to
  copy.
- **Note:** this is a public-surface privacy defect and may overlap Claude-3's
  area; recording it here because it was found by walking the gift spine, and it
  is a page rather than a `route.ts` (Pass F covered `route.ts` under public
  prefixes only).
- **Status:** OPEN

---

### [CLAUDE-4][LOW][FLOWS] "Add to grocery list" from a recipe treats a failed read as "you have no list" and offers to make a second one

- **File:** `components/modules/recipes-module.tsx:203-208`
- **Problem:**

  ```ts
  const { data: list } = await supabase
    .from('grocery_lists').select('id')
    .eq('family_id', familyId).eq('is_archived', false).is('archived_at', null)
    .order('created_at').limit(1).maybeSingle();
  if (!list) { setNewListName('Groceries'); setGroceryPrompt(recipe); return; } // offer to create one
  ```

  The error is destructured away. A transient failure — an expired token, an RLS
  blip, a dropped connection — yields `data: null`, which the next line reads as
  "this family has no grocery list", and the UI offers to create one. Accepting
  inserts a second `grocery_lists` row beside the one that already exists;
  nothing dedupes by name.
- **Evidence:** this is the class Pass E named ("reads whose error is discarded
  and whose absence is then treated as fact") and closed one instance of. The
  same file handles it correctly two functions later —
  `createListAndAdd` at `:215` destructures `error` and calls
  `describeDbError` — so the pattern is understood here and this call site was
  missed. The rest of the flow is sound: `addItemsToList` scales quantities by
  the servings adjuster (`:182`), dedupes by normalised name in the service, and
  reports how many it skipped.
- **Impact:** a duplicate "Groceries" list, which then splits the family's
  shopping in two — half the items on the list the recipe wrote to, half on the
  one the Grocery page opens (`:203` picks the **oldest** non-archived list via
  `.order('created_at')`, so the new one is not even the one it writes to next
  time). Recoverable, but confusing in exactly the way a shared list must not be.
- **Fix:** destructure the error, and on error toast `describeDbError(error)` and
  return without offering to create — the two states are different and only one
  of them should mint a row.
- **Status:** OPEN

---

## Sweep 6 — tests that assert the source text rather than the behaviour

Census over `tests/` (1,193 `*.test.ts(x)` files):

| | files | note |
|---|---|---|
| read a source file with `readFileSync` | 484 | 41% |
| …and import **no application module at all** — the assertions are entirely about file text | **350** | 29%, **1,233 test cases** |

That is not automatically bad: a "single write path" grep guard is a legitimate
architectural regression net, and several here are excellent
(`tests/plans-and-gates-agree.test.ts` reads copy out of `PLANS` and compares it
to `AI_MONTHLY_ALLOWANCE`, which is a real cross-module invariant). The hazard is
specific: a text guard cannot see a defect that is spelled correctly. This audit
found three instances in the money and entitlement paths alone, and one of them
is worse than blind.

---

### [CLAUDE-4][HIGH][TESTS] `tests/wallet-allowance-persistence.test.ts` pins the exact expression that causes the allowance double-pay — the one-line fix turns the suite red

- **File:** `tests/wallet-allowance-persistence.test.ts:13`
- **Problem:** the assertion is a character-for-character match on the defective
  line:

  ```ts
  expect(source).toContain(
    ".update({ next_run_on: next, last_run_on: today }).eq('id', rule.id).eq('family_id', familyId).select('id').single()"
  );
  ```

  That is the blind claim proved above to credit an allowance twice under two
  concurrent runs. The correct form — the one the cron already uses — is the same
  chain with `.lte('next_run_on', today)` inserted and `.single()` relaxed to
  `.maybeSingle()` (a claim that loses must return no row, not throw). Both edits
  break the substring.
- **Evidence:** the repository file was not modified. The source was read, the
  one-line fix applied **to a copy in scratch**, and the assertion re-evaluated
  against both:

  ```
  current source contains the pinned string:            True
  after the one-line claim fix, it still contains it:   False
  ```

  And the suite is green today:

  ```
  $ npx vitest run tests/wallet-allowance-persistence.test.ts \
                   tests/allowance-cron-idempotency.test.ts \
                   tests/route-plan-gate.test.ts
    Test Files  3 passed (3)
         Tests  30 passed (30)
  ```

  Thirty green cases across the three files that between them own the allowance
  money path, the chore money path and the AI entitlement gate — over two live
  defects and one of the fixes.
- **Impact:** this is the failure mode that makes a text guard dangerous rather
  than merely weak. A developer who finds the double-pay and fixes it correctly
  gets a red build, and the red build names *this* file — a "persistence
  boundaries" test with no obvious connection to concurrency. The likely
  resolutions are to revert the fix or to edit the expected string, and only one
  of those is right. Its sibling `tests/allowance-cron-idempotency.test.ts` — the
  file whose whole subject is *"both must NOT credit the same period"* — asserts
  the **correct** claim on the cron and never opens this file, so the two guards
  for one property are pointed at different implementations and disagree about
  which is right.
- **Fix:** the three cases in this file are each testing a real property —
  fails-closed on an unreadable rule set, rolls the schedule back when crediting
  fails, counts only after success. Assert the property, not the spelling:
  drive `runDueAllowancesAction()` against `tests/helpers/in-memory-supabase`
  (already used by `tests/route-plan-gate.test.ts`) with a seeded due rule, and
  assert one ledger credit for two interleaved calls, a restored `next_run_on` on
  a failed credit, and `ranCount === 0` when the credit fails. If a text assertion
  is kept for the claim predicate, assert `.lte('next_run_on'` is **present**,
  which is the direction that fails when someone removes the guard rather than
  when someone adds it.
- **Status:** OPEN

---

### [CLAUDE-4][INFO][TESTS] The three text-guard instances found in this audit, in one place

For Claude-1, since they are one class and want one decision:

| guard | asserts | what it is green over |
|---|---|---|
| `tests/wallet-allowance-persistence.test.ts:13` | the exact blind-update string | the allowance double-pay, **and it blocks the fix** |
| `tests/allowance-cron-idempotency.test.ts:11` | the cron file carries the claim predicate | the identical server action forty lines away, which does not |
| `tests/route-plan-gate.test.ts:147-150` | each route's source contains `refuseUnlessEntitled(` and the href literal | three routes whose href was absent from the catalog, so the gate allowed everyone |

The common repair is one line per file, and it is the same line each time:
after asserting the text, assert the thing the text is supposed to achieve —
resolve the href through `tiersByHref`, or run the function against the
in-memory client, or glob every file that performs the write rather than naming
one. Each of the three has a sibling in the same file that already does this
(`tests/route-plan-gate.test.ts`'s first `describe` drives the real route and
asserts a `403`), so the harness exists in every case.
- **Status:** OPEN

---

## Sweep 7 — the wallet balance is computed two ways, and only one of them is safe

A child's spendable balance is derived from the immutable ledger. Three places
derive it:

| where | how | bounded? | locked? |
|---|---|---|---|
| `wallet_reserve_card_auth` (`0155`) — Stripe card authorization | `sum(...)` in SQL | yes | `FOR UPDATE` on the bucket |
| `wallet_decide_spend` (`0205`) — a parent approving a held request | `sum(...)` in SQL | yes | `FOR UPDATE` on the bucket and the txn |
| `bucketBalanceCents` (`lib/wallet/server.ts:285`) — the in-app spend path | fetch every row, `reduce()` in JS | **no** | **no** |

F-019 raced the first of those and proved it right. The third had never been
raced, and it is the one a parent uses from the app.

---

### [CLAUDE-4][CRITICAL][MONEY] The in-app spend path reduces the ledger in JavaScript with no row bound and no lock — it overdraws a wallet two different ways

- **File:** `lib/wallet/server.ts:285-300` (`bucketBalanceCents`) and
  `:309-340` (`debitSpendBucket`), reached from
  `app/(app)/wallet/actions.ts:705,729` (`requestSpendAction`)
- **Problem — two independent defects in the same eight lines.**

  **(1) The read is unbounded.** `bucketBalanceCents` is:

  ```ts
  const { data: txns } = await supabase.from('wallet_transactions')
    .select('direction, amount_cents, status')
    .eq('family_id', params.familyId).eq('bucket_id', bucket.id);
  const available = (txns ?? []).reduce(…);
  ```

  No `.limit()`, no `.range()`, no `readAll`. `lib/supabase/read-all.ts` states
  the consequence in its own header, with the project's own measurement:
  *"PostgREST answers an unbounded `select()` with at most `db-max-rows` — 1,000
  on a default Supabase project — and says nothing about it… a table holding
  2,011 rows returns exactly 1,000 to an unbounded select."* `wallet_transactions`
  is append-only and grows forever: one row per bucket per credit, plus a hold
  and a settlement per card purchase.

  **(2) The check-then-write is not atomic.** `debitSpendBucket`'s only overdraw
  guard is `if (!params.requiresApproval && amount > available)`, computed from
  that read, followed by a plain `.insert(...)` over a separate HTTP round trip.
  No `FOR UPDATE`, no RPC, no constraint. This is the one spend path in the
  wallet that does not go through a locking SQL function.
- **Evidence — both raced/measured on the 310-migration replay.**

  *(1) truncation.* One spend bucket, one year of an active teen: 52 weekly
  `$20` allowance credits and 1,000 `$1` card debits — 1,052 rows.

  ```
  ledger rows in this one bucket:                                        1052
  TRUE balance — the SQL sum wallet_reserve_card_auth uses:              4000   ($40.00)
  what bucketBalanceCents() reduces if PostgREST returns db-max-rows:    9200   ($92.00)
  ```

  The credits are early in the heap and the debits are late, so the rows the cap
  discards are debits: the app reports **$92.00 available against a real $40.00**,
  and `debitSpendBucket` will approve any spend up to $92.

  *(2) concurrency.* Fresh bucket, seeded `$10.00`, two simultaneous `$8.00`
  direct (no-approval) spends, each session doing exactly what the two functions
  do — read the whole bucket, reduce, then insert:

  ```
  each session saw available = 1000
  each session saw available = 1000
   debits_posted | balance_cents
  ---------------+---------------
               2 |          -600
  ```

  Two approvals, balance **−$6.00**. This is the identical scenario F-019 ran
  against `wallet_reserve_card_auth`, where *"1 of 2 simultaneous $8
  authorizations approved against $10"*. Same money, same wallet, opposite
  answer, because this path has no lock.
- **Impact:** `requestSpendAction` sets
  `needsApproval = !manager || amount > threshold || decision.effect !== 'allow'`.
  A **parent** spending at or under the household's `require_approval_over_cents`
  (default `5000` = $50) with an allowing trust decision takes the
  `requiresApproval: false` branch, so the debit posts `completed` immediately
  with no second check anywhere — the RPC recheck in `wallet_decide_spend` only
  runs on the *approval* branch. So both defects land on the path that moves
  money without a second pair of eyes. Defect (1) is silent, permanent and grows
  with the family's history; defect (2) needs only two tabs or a double submit.
  `tests/wallet-overspend-probe.test.ts` and
  `docs/audit/wallet-overspend-check.sql` both exercise the **RPC**, not this.

  The action's own docstring is the claim both defects break —
  `app/(app)/wallet/actions.ts:682`: *"**Never overdraws: the requested amount
  must fit the current Spend balance.**"*

  Scope, checked rather than assumed: every other money movement in the wallet
  goes through a locking SQL function — `sendMoneyAction → transferWallets →
  wallet_transfer`, `fundGoalAction → fundGoal → wallet_fund_goal`,
  `decideSpendRequestAction → decideSpend → wallet_decide_spend`, the Stripe
  authorization through `wallet_reserve_card_auth`. `debitSpendBucket`'s
  no-approval branch is the single exception.
- **Fix:** make the third path the same as the other two — compute the balance in
  SQL under the bucket lock. There is already a function shaped for it: extend
  `0205`'s pattern with a `wallet_post_direct_spend(p_family, p_child_wallet,
  p_amount, …)` that takes `FOR UPDATE` on the bucket, re-sums, and inserts or
  returns `insufficient_funds` — then `debitSpendBucket`'s no-approval branch
  calls it and `bucketBalanceCents` is left to do what its name says: report a
  number for display. As an immediate, independent mitigation for (1), a balance
  read must never be an unbounded `.select()` — either `readAll(...)` it or, far
  better, `select('amount_cents.sum()')`/an RPC so the sum never crosses the
  wire. Guard: replay the 1,052-row probe above in CI (it needs no PostgREST —
  the divergence is `sum(all)` vs `sum(limit 1000)`), and add the two-connection
  race beside `docs/audit/wallet-concurrency-check.sql`, which already has the
  `dblink_send_query` harness for exactly this.
- **Status:** OPEN

---

### [CLAUDE-4][LOW][DEAD-CODE] `childSpendableCents` is exported, documented as the real-time card-authorization check, and called by nothing

- **File:** `lib/wallet/server.ts:113-135`
- **Problem:** its docstring says *"This is what a card authorization is checked
  against in real time."* It is not: card authorizations go through
  `reserveCardAuth` → `wallet_reserve_card_auth`, which does its own SQL sum
  under a lock. `rg -n "childSpendableCents"` across `app/`, `lib/`,
  `components/` and `tests/` returns the definition and nothing else.
- **Impact:** none today — it is dead. It matters because it carries the same
  unbounded read as `bucketBalanceCents` and a comment that would invite a future
  caller to trust it for a money decision.
- **Fix:** delete it, or if it is wanted for display, fix the comment and give it
  the bounded read.
- **Status:** OPEN

---

## Sweep 8 — date arithmetic at the edges

Executed, not reasoned: `lib/wallet/allowance.ts` and `lib/services/scope.ts`
bundled with esbuild and driven over month ends, both DST transitions, a leap
day, a year boundary and the ±14-hour zone extremes.

---

### [CLAUDE-4][LOW][EDGE-CASE] A monthly allowance set on the 31st moves to the 28th in February and never moves back

- **File:** `lib/wallet/allowance.ts:14-24` (`nextRunDate`), used by
  `saveAllowanceRuleAction` and by both allowance runners through `rollForward`
- **Problem:** the clamp is correct for one step and wrong as a series. It reads
  the day-of-month off `fromIso`, which on every run after the first is the
  **already-clamped** date:

  ```ts
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  ```

  The rule has no memory of the day the parent chose, so February's clamp is
  permanent.
- **Evidence:**

  ```
  nextRunDate(2026-01-31, monthly) -> 2026-02-28      (correct for one step)
  the series from 2026-01-31:
    2026-01-31 -> 2026-02-28 -> 2026-03-28 -> 2026-04-28 -> 2026-05-28 -> 2026-06-28 -> 2026-07-28
  ```

  Every other case checked is right: `2026-03-31 → 2026-04-30`,
  `2026-12-31 → 2027-01-31` (year rollover), `2024-01-29 → 2024-02-29` (leap),
  `2024-02-29 → 2024-03-29`. Weekly and biweekly are pure UTC-millisecond
  arithmetic and are unmoved by both 2026 DST transitions
  (`2026-03-05 → 2026-03-12`, `2026-10-29 → 2026-11-05`).
- **Impact:** small and permanent. A parent who sets "the last day of the month"
  gets it three days early for the rest of the child's life, and the drift is
  invisible — `next_run_on` simply says the 28th.
- **Fix:** store the intended day-of-month on the rule (or derive it from the
  rule's `created_at`) and clamp from that each time, rather than from the
  previous run date. Two lines, plus a column.
- **Status:** OPEN

---

### [CLAUDE-4][INFO][EDGE-CASE] The rest of the date arithmetic is right at every edge checked

- **Evidence:**

  ```
  addDaysToDayKey(2026-10-26, 7) -> 2026-11-02     (the DST week finalaudit measured; fixed-ms addition lands on 11-01 23:00)
  addDaysToDayKey(2026-02-27, 2) -> 2026-03-01     (non-leap month end)
  addDaysToDayKey(2024-02-27, 3) -> 2024-03-01     (leap month end)
  weekStartDayKey(2026-01-01)    -> 2025-12-29     (week start across a year boundary)

  instant 2026-09-14T01:30:00Z
    dayKeyInTz(America/Los_Angeles)   -> 2026-09-13
    dayKeyInTz(Asia/Tokyo)            -> 2026-09-14
    dayKeyInTz(Pacific/Kiritimati +14)-> 2026-09-14
    dayKeyInTz(Pacific/Midway    −11) -> 2026-09-13
  ```

  `rollForward` also behaves as documented under a long gap:
  a weekly rule six weeks overdue returns `{runs: 1, next: 2026-09-19}` at
  `maxRuns: 1` (what both runners pass) and `{runs: 7, …}` uncapped — it pays one
  period and discards the backlog rather than minting seven credits, which is
  what the header says it does.
- **Status:** VERIFIED

---

## What I traced and found CORRECT

Recorded at the same weight as the defects, because "we checked" and "we could
not see" must not read the same.

### [CLAUDE-4][INFO][FLOWS] The run/step state machine is consistent with the database that stores it

- `lib/ai/runs/states.ts` declares 14 run states and 14 step states. Checked
  against the **replayed** catalogue rather than the migration text:
  - `ai_plan_steps_status_check` — 14 values, exactly `STEP_STATES`.
  - `family_automation_runs_state_check` — 14 values, exactly `RUN_STATES`,
    `paused` included.
  - `ai_requests_status_check` — 13 values, **no `paused`**, which is the one
    place the two vocabularies differ. The executor handles it at the only
    boundary where it can bite: `executor.ts:1301`,
    `status: state === 'paused' ? 'blocked' : state`, with the reason written
    beside it. Nothing else writes a run state to `ai_requests`.
  - `completed` and `cancelled` have empty transition lists in both tables —
    one-way doors, so a finished run cannot silently re-execute its writes.
- No defect found. **VERIFIED**

### [CLAUDE-4][INFO][FLOWS] Every nav destination resolves to a real page

- All **183 distinct href literals** in `lib/constants/navigation.ts` (`APP_NAV_GROUPS`, `PRIMARY_NAV`
  and its `children`, `MOBILE_TABS`, `ADMIN_NAV`, `SIDEBAR_FOOTER_NAV`,
  `DASHBOARD_NAV`, `MARKETING_NAV`) and all **102 distinct `href` values** across the 105 entries of
  `FEATURE_CATALOG` were resolved against the 395 real `page.tsx` routes.
  **Zero dead links, in either list.** `ADMIN_NAV`'s promise — *"every entry here
  must point at a real, working page. No 'coming soon' stubs"* — holds.
- Of the 353 static page routes, 22 are never named as a path literal outside
  their own folder. Checked one by one: 9 are marketplace tabs reached through a
  `${BASE}/…` template in `components/marketplace/marketplace-nav.tsx`, 4 are
  deliberate `redirect()` de-duplication stubs with the reason in the file
  (`/admin/tiers`, `/dashboard/family-ai-assistant`,
  `/dashboard/family-knowledge-graph`, `/dashboard/family-memory`), 2 are
  super-admin analytics that gate themselves with `isSuperAdmin() → notFound()`
  (`/dashboard/journeys`, `/dashboard/onboarding-funnel`), and the remainder are
  reachable by URL by design. Only `/dashboard/app-store` is a genuine orphan,
  and it has its own finding above. **VERIFIED**

### [CLAUDE-4][INFO][FLOWS] The recipe → grocery list path scales and dedupes correctly

- `components/modules/recipes-module.tsx:180-200`: the servings adjuster is
  applied — `multiplier = (servingsOverride ?? recipe.servings) / recipe.servings`
  feeds `scaleQuantity` per ingredient — and the service skips ingredients already
  on the list by normalised name and reports how many it skipped
  (`groceryAddWasNoOp` / `describeGroceryAdd`). The one defect on this path is the
  discarded read error, recorded above. **VERIFIED**

### [CLAUDE-4][INFO][FLOWS] The Pay-ID resolver does not leak whether a handle exists

- `app/pay/[handle]/page.tsx` returns the identical "no active gift link" page for
  an unknown handle, a deactivated handle, and a handle whose links are all
  revoked — no timing branch, no distinct copy, no redirect that would reveal the
  difference. The page it forwards to is the one with the message-disclosure
  defect, which is a separate finding. **VERIFIED**

### [CLAUDE-4][INFO][PERFORMANCE] N+1 and unbounded-read sweeps found no new systemic defect beyond the wallet one

- **N+1:** 56 candidate sites (a query awaited inside a `for…of` or a
  `.map(async …)`). Read: the sync engines iterate pulled provider events (one
  round trip per event is inherent to the protocol), the marketing and autopilot
  runners are crons whose per-row isolation is deliberate and commented, and
  `lib/network/aggregate-server.ts` — which looks like the worst offender — turns
  out to batch every read through `buildContributionsBatch` and only loops for the
  per-family upsert, for stated isolation reasons. No page render path does a
  query per row.
- **Sequential awaits on a render path:** only 4 of 395 `page.tsx` files issue 6
  or more separately-awaited queries, and in three of them the queries are
  genuinely dependent (`app/gift/[token]` must read the link before it can read
  the wallet before it can read the member). `settleAll` is used in 155 files.
- **Unbounded reads:** 63 `.select()` calls on per-family growing tables lack a
  `.limit()`. All but one class are bounded by something else — a date window, an
  `.in(ids)`, a `count: 'exact', head: true`, or `maybeSingle()`. The exception is
  the wallet balance, which is the CRITICAL above. The rest of the list is worth
  a pass by the owner for *display* truncation (a family with more than
  `db-max-rows` documents or transactions silently sees a partial list), but no
  other one of them decides anything.
- **Notification fan-out at 12 members:** `lib/server/notifications.ts` emits one
  row per manager per expiring document and per schedule conflict, which is
  members × items — but every source list is bounded by a date window, and the
  dedupe read is chunked 50 ids at a time with the reason written out (a longer
  batch overflows the gateway's URI limit, returns empty, and re-inserts every
  candidate — *"observed exactly that, every run"*). Correct at 12 members.
- **VERIFIED**

---

## Summary — what was traced, what broke, what held

**Eight sweeps. 24 findings: 1 CRITICAL, 5 HIGH, 7 MEDIUM, 4 LOW, 7 INFO.**

Everything behavioural here was executed, not inferred. A throwaway Postgres 16
was bootstrapped with `bash docs/audit/verify-pg.sh up` — **310/310 migrations
applied, 0 failed** — and every money claim was raced on it with two connections
genuinely in flight. Pure modules (`lib/features/tiers.ts`,
`lib/wallet/allowance.ts`, `lib/services/scope.ts`, `lib/constants/navigation.ts`)
were bundled with esbuild and run. No source file was modified.

### The three things worth reading first

1. **`lib/wallet/server.ts:285/309` — the in-app spend path overdraws two ways.**
   The balance is the one number that has to be right, and it is derived three
   times: twice in SQL under a `FOR UPDATE` lock, once by fetching the whole
   ledger over PostgREST and reducing it in JavaScript. That third one has no row
   bound (**$92.00 reported against a real $40.00** on a 1,052-row bucket) and no
   lock (**two simultaneous $8 spends against $10 both posted; balance −$6.00**).
   The function's own docstring says "Never overdraws".
2. **`tests/wallet-allowance-persistence.test.ts:13` — a guard that blocks its own
   fix.** It asserts the exact text of the defective allowance update. Applying
   the one-line claim predicate that stops the double-pay makes the assertion
   fail. Proven by applying the fix to a copy in scratch and re-evaluating the
   assertion against both.
3. **Three descriptions of one offer.** `minLevel`, `defaultTier` and
   `requirePlanLevel(n)` all claim to say who may use a destination; 28 of 135
   nav destinations disagree, `resolveItems` reads only one of them, and the
   consequences run in both directions — Home & Maintenance is *sold* as Plus,
   *locked* at Plus, and *opened* at Basic; Operations Center is a permanent
   unlocked button that only produces a billing upsell.

### Method notes, including one I got wrong

- A `.from('x')` scan reported 41 tables "read but never written". **Nineteen of
  them were false** — written through a dynamic `.from(table)` where `table` is a
  React prop (`components/vacations/shared.tsx:130`) or an allowlist key
  (`lib/family/actions.ts:22`). An earlier version of the same scan reported 84
  readers of one table and every one was a `.claude/worktrees/` copy. Three
  candidates survived contact with the code, and all three are real.
- Every finding here names the file and line that was read. Where the claim is
  behavioural there is a command and its output.

### Traced and found correct

- **The run/step state machine** — 14 run states and 14 step states, checked
  against the *replayed* CHECK constraints, not the migration text. The single
  vocabulary difference (`ai_requests` has no `paused`) is handled at the one
  boundary where it can bite, with the reason written beside it. `completed` and
  `cancelled` are one-way doors in both tables.
- **Nav integrity** — 183 nav href literals and 102 catalog hrefs, all resolving
  to real pages. Zero dead links. `ADMIN_NAV`'s "no coming-soon stubs" promise
  holds. Of 353 static routes, 22 look unlinked and 21 are explained (template
  hrefs, deliberate redirect stubs, super-admin analytics); one is a genuine
  orphan and has a finding.
- **The Pay-ID resolver** — identical dead-end for an unknown handle, a revoked
  handle and a handle with no live link.
- **Recipe → grocery** — servings scaling applied, duplicates skipped by
  normalised name, the skip count reported.
- **The allowance cron** — claims each rule atomically with a `next_run_on`
  predicate, and the A/B race proves the predicate is what makes it safe. It is
  the *hand-run* twin that does not.
- **Date arithmetic** — right at both DST transitions, both month-end shapes, the
  leap day, the year boundary and ±14-hour zones. One real defect (the monthly
  clamp ratchets to the 28th and never returns) and nothing else.
- **Performance** — 56 N+1 candidates and 63 unbounded reads examined; all but the
  wallet balance are bounded by a date window, an `.in(ids)` or a `head: true`
  count, and no page render path issues a query per row.

### Where I would look next, with more time

- The remaining 62 unbounded reads on growing tables, for **display** truncation
  rather than decision truncation — a family past `db-max-rows` documents or
  transactions silently sees a partial list with no "and 400 more".
- The 350 source-text-only test files (1,233 cases). Three were checked and all
  three were green over something; the base rate matters and I did not measure it.
- `invite → accept → first render` as a *functional* flow. Claude-3 is on its
  security; nobody has walked what a second parent actually sees on arrival.
- A family of 12 against the per-member fan-out surfaces beyond notifications
  (the approvals queue, the activity feed, the family map).

---

## Note on the merge

A second session created `# Claude-4 — QA / Features / Flows / Performance / Edge Cases` as an empty template on `main`. It carried
no findings, so this file keeps the worker output above; nothing was lost.
<!-- Two sessions wrote this file; both sides of the merge are kept. -->
### [CLAUDE-4][HIGH][EDGE CASE] Three production paths read only the first 50 auth users, and one of them marks the rest delivered

- **File/path:**
  - `app/api/cron/weekly-digest/route.ts:38`
  - `app/api/cron/chore-reminders/route.ts:103`
  - `lib/server/notification-emails.ts:66`
- **Problem:** All three resolve recipient email addresses with a bare
  `await supabase.auth.admin.listUsers()`. That call is **paginated and defaults to 50 users per
  page**. None of the three passes `perPage`, and none follows the `nextPage` the call returns. Every
  user from the 51st onward is absent from the `emailByUserId` / `userMeta` map, and each site then
  treats "no email on file" as an ordinary skip.

  This is F-008's class (a silent row ceiling) on a surface F-008's fix could not reach. The fix for
  F-008 was `readAll()` over PostgREST `.range()`; the Auth Admin API is a different transport, so the
  `.limit(n > 1000)` sweep (F-013) and the `readAll` conversion both passed straight over it. The
  weekly digest shows this on adjacent lines — a comment at line 26 reads *"Every household, not the
  first thousand... families past that ceiling would silently never receive a digest"*, and twelve
  lines later the recipient lookup reintroduces exactly that ceiling at 50.

- **Evidence:**

  The installed client documents the default itself:

      $ sed -n '405,432p' node_modules/@supabase/auth-js/dist/main/GoTrueAdminApi.js
          * @param params An object which supports `page` and `perPage` as numbers, to alter the paginated results.
          * @remarks
          * - Defaults to return 50 users per page.
          * @example Paginated list of users
          *   const { data: { users }, error } = await supabase.auth.admin.listUsers({
          *     page: 1, perPage: 1000 })

  With no params the client sends empty `page`/`per_page` query values, so the server default applies
  (`GoTrueAdminApi.js:441-442`), and the response carries `nextPage` / `lastPage` / `total`
  (`:436`, `:450-458`) — the endpoint is unambiguously a page, not a table.

  The repository already knows this, which is the decisive evidence: of the six call sites, two
  paginate deliberately and three do not.

      $ grep -rn "listUsers(" app/ lib/ scripts/
      app/api/cron/weekly-digest/route.ts:38:   ...listUsers();                        <- page 1 only
      app/api/cron/chore-reminders/route.ts:103:...listUsers();                        <- page 1 only
      lib/server/notification-emails.ts:66:     ...listUsers();                        <- page 1 only
      app/(app)/admin/security/page.tsx:32:     ...listUsers({ perPage: 1000 })        <- explicit
      lib/server/health.ts:37:                  ...listUsers({ page: 1, perPage: 1 })  <- explicit, a liveness ping
      scripts/seed-personas.mjs:44:             ...listUsers({ page, perPage: 100 })   <- a real pagination loop

  What each site does with a missing address:

      weekly-digest/route.ts:89     if (!adminEmail) continue;            // not counted in `failed`
      chore-reminders/route.ts:118  if (!email) continue;                 // not counted in `failed`
      notification-emails.ts:94-99  if (emailOff.has(userId) || !meta?.email) {
                                      skipped += 1;
                                      resolvedIds.push(...ids);           // <-- marked delivered
                                      continue; }
      notification-emails.ts:114-115 await supabase.from('notifications')
                                       .update({ sent_at: nowIso }).in('id', resolvedIds);

- **Impact:** On any deployment with more than 50 auth users:
  - **Weekly digest** and **chore reminders** silently stop reaching most of the user base. Both
    respond `{ sent, failed }` with `failed === 0`, so the run is HTTP 200 and looks clean — the exact
    blindness Claude-1's cron-visibility fix was written to remove, reappearing one layer up.
  - **`notification-emails.ts` is the severe one.** A user past the page boundary has
    `!meta?.email` evaluate true, so their notifications are pushed into `resolvedIds` and written
    `sent_at = now()`. They are marked delivered while no email was ever sent, and because `sent_at`
    is the "already handled" marker, **they are never retried**. This is unrecoverable per
    notification, not merely a delayed send. It also masks itself in the return value: those rows land
    in `skipped`, the same bucket as a legitimate opt-out, so the count that would reveal it is
    indistinguishable from normal.
- **Recommended fix:** Resolve recipients by id instead of by listing. There is no
  `getUsersByIds`, so the two honest options are (a) a shared `listAllUsers()` helper that loops
  `page` until `nextPage` is null — the shape `scripts/seed-personas.mjs:44` already uses — or, better
  for the two cron routes which already know their recipient ids, (b)
  `admin.getUserById(id)` per recipient, or a join against `profiles`/`family_members` for the address
  if one is stored there. Separately, in `notification-emails.ts` split the `!meta?.email` branch out
  of the opt-out branch: an unknown address is a **failure** (leave `sent_at` null so the next run
  retries), not a settled skip. Whatever the helper, it must be proved load-bearing by seeding 51+
  users and asserting the 51st is reached — the current guard cannot (see the next finding).
- **Status:** OPEN — verified from the installed library's contract and the repository's own
  contradicting call sites. Not reproduced against a live GoTrue: no Supabase is reachable in this
  sandbox (`curl 127.0.0.1:54321/auth/v1/health` -> connection refused).

### [CLAUDE-4][MEDIUM][TESTING] The only guard on the two digest crons asserts that identifiers are spelled, not that anything works

- **File/path:** `tests/digest-cron-read-boundary.test.ts`
- **Problem:** The file that exists to protect the weekly-digest and chore-reminder read boundaries
  contains nine assertions, and every one of them is `expect(<file text>).toContain('<identifier>')`.
  It never imports, calls or renders either route. It is satisfied by the *word* appearing anywhere in
  the file — including inside a comment or a string.
- **Evidence:** the whole file is 22 lines; the assertions are:

      expect(chore).toContain('familiesError');
      expect(chore).toContain('authUsersError');
      expect(chore).toContain('let failed = 0;');
      expect(chore).toContain('{ status: failed === 0 ? 200 : 502 }');
      expect(weekly).toContain('familiesError');
      expect(weekly).toContain('authUsersError');
      expect(weekly).toContain('familyDataError');
      expect(weekly).toContain('adminMemberError');
      expect(weekly).toContain('{ status: failed === 0 ? 200 : 502 }');

  Reasoned through precisely, three separate real regressions leave it green:
  1. Delete the body of `if (authUsersError) { ... return 500 }` but keep the condition — the token
     `authUsersError` is still present, test passes, the route now proceeds with `authUsers` undefined.
  2. Change `if (ok) sent++; else failed++;` to `if (ok) sent++;` — `let failed = 0;` and the status
     ternary are both still present verbatim, test passes, every send failure becomes invisible.
  3. The pagination defect in the finding above: it is **structurally invisible** to this test. No
     string in it mentions recipients, pages or counts.

  Contrast with `tests/cron-failed-runs-are-visible.test.ts`, which Claude-1 proved load-bearing by
  reverting each of five fixes individually. The digest guard has never been through that.
- **Impact:** Two of the twenty-four scheduled jobs are covered only by a spell-checker. The risk is
  not that the guard is useless — it is that the coverage matrix counts it as covered, so nobody
  writes the behavioural test. That is the repository's recorded defect class exactly.
- **Recommended fix:** replace with a behavioural test of the kind the repo already writes elsewhere:
  stub `createServiceClient` and `sendReactEmail`, drive `GET()` with (a) an auth read error -> expect
  500, (b) one failing send -> expect 502 and `failed: 1`, (c) **51 users and 51 families -> expect 51
  sends**, which is the case that would have caught the finding above. Prove it load-bearing by
  reverting each branch in turn.
- **Status:** OPEN

### [CLAUDE-4][MEDIUM][PERFORMANCE] The weekly digest is an unbounded per-family serial loop on a route with no `maxDuration`

- **File/path:** `app/api/cron/weekly-digest/route.ts` (loop at `:48`);
  `app/api/cron/chore-reminders/route.ts`
- **Problem:** The digest reads **every** family via `readAll` (correctly unbounded, post-F-008) and
  then processes them one at a time. Per family: four reads in parallel via `settleAll`, then a
  sequential `adminMember` read, then `loadCompareLine` (1–3 further sequential reads), then one
  `sendReactEmail` network call. So each family costs 2–4 sequential round trips plus one email API
  call, and the loop has no concurrency, no batching and no checkpoint. Neither this route nor
  `chore-reminders` declares `maxDuration`, so both run under the platform default rather than a
  chosen budget.
- **Evidence:**

      $ grep -rn "maxDuration" app/api/cron/ | wc -l
      9                       # 9 of 24 routes choose a budget
      $ sed -n '1,16p' app/api/cron/weekly-digest/route.ts   | grep "export const"
      (no runtime/maxDuration export)
      $ sed -n '1,16p' app/api/cron/chore-reminders/route.ts | grep "export const"
      (no runtime/maxDuration export)

  Per-family sequential cost, counted from source:
  `route.ts:53-63` settleAll (4 reads, parallel) -> `:74-80` adminMember (1) ->
  `lib/network/compare-line-server.ts:18,31,39` (up to 3, each awaited in turn) -> `:93` sendReactEmail.

  The repository already solved this shape once and wrote down why —
  `app/api/cron/model-refresh/route.ts:33`: *"cron scales to thousands of families without blowing
  maxDuration. The dirty [queue]..."* — and `provider-sync`, `library-feeds`, `marketing` each carry
  `maxDuration = 300` with an explicit bounded batch. The digest is the same shape without the lesson.
- **Impact:** The run is killed mid-loop once the family count exceeds the budget. Because the loop
  always walks `families` in the same `order('id')` sequence and keeps no cursor, the **same prefix of
  families is served every week and the tail is never served at all** — a stable, invisible partition
  of the customer base. It compounds the finding above rather than duplicating it: pagination silently
  drops recipients, the timeout silently drops families.
- **Recommended fix:** give both routes an explicit `maxDuration`, bound the batch (a `digest_runs`
  cursor, or `last_digest_at` on `families` with `order('last_digest_at', { nullsFirst: true })`) so a
  killed run resumes where it stopped rather than restarting at the same families, and hoist the
  per-family `loadCompareLine` reads into one cohort query outside the loop. The bounded-batch pattern
  in `provider-sync` is the in-repo precedent to copy.
- **Status:** OPEN

---
---

# ═══ SESSION 4 (2026-09-14) — Claude-4, NEW GROUND ═══

Everything below this delimiter is from the third-session relaunch. Nothing
above it is edited. Scope handed to me: broken/incomplete features · the UNHAPPY
branches of each flow · edge cases · N+1 and index coverage · test quality
proven by mutation. Explicitly excluded (already fixed or owned elsewhere):
C-4-01/C-4-02 and PR #548's six, the 17 remaining server-midnight sites, the
Guardian typed layer and screening validation, `.env.example` drift, the
contact-centre double escalation, and the seven named RLS findings.

**New capability this session:** a live PostgreSQL 16 with all 314 migrations
replayed was already running on `127.0.0.1:54402` (database `bubaly`, 491
tables) — Claude-3's harness. I used it READ-ONLY (`EXPLAIN`, `pg_indexes`,
`pg_policy`, `pg_trigger`) and wrote nothing to it. That turned three index
claims from "grep says so" into "the planner says so", and — just as usefully —
**disproved one finding I had already written down** (see "Disproved" below).

---

## C-4-14

```
[CLAUDE-4][HIGH][FLOWS] The parent's Approve and Reject on a chore submission
                        fail in complete silence — seven ways
File:     app/(app)/missions/actions.ts:287-353
          app/(app)/missions/review-card.tsx:104-118
Problem:  `approveSubmissionAction` is typed `Promise<void>` and has SEVEN bare
          `return;` statements, one per failure mode, none of which tells the
          parent anything:

            293  if (!isManager(ctx.active.role)) return;          not a manager
            297  if (!submissionId) return;                        bad form data
            300  if (!submission) return;                          row gone / wrong family
            303  if (!assignment || !chore) return;                parent row deleted
            306  if (!await setSubmissionStatus(...)) return;      the status write FAILED
            310  if (disputeError) { rollback; return; }           the dispute write FAILED
            322  catch { rollback; return; }                       finalizeApproval THREW

          `revalidatePath('/missions')` and `revalidatePath('/kids')` are on the
          success path only (324-325). So on every one of those seven branches
          the server does nothing observable: no toast, no error, not even a
          re-render. The spinner stops and the card sits exactly where it was.

          `rejectSubmissionAction` (329), `disputeSubmissionAction` (355) and
          `createChoreAction` (385) are the same shape — five, five and three
          silent returns respectively. `disputeSubmissionAction` is the CHILD's
          "that's not fair" button.
Evidence: - Read all four function bodies end to end, not grepped. Every exit
            that is not the final `revalidatePath` pair is a bare `return;`.
          - Ruled out "the error surfaces elsewhere" three ways:
            (a) the signature. `Promise<void>` has no channel to carry a
                failure. The caller in review-card.tsx:104 is
                `start(async () => { await approveSubmissionAction(fd); })` —
                there is no value to inspect and it does not inspect one.
            (b) nothing throws out of these functions. `finalizeApproval` does
                throw, and line 317 catches it. `app/(app)/missions/error.tsx`
                exists but an error boundary can only catch a throw, and none
                escapes. I checked for `throw` in each body: none at top level.
            (c) no toast/router hook in review-card.tsx — the file imports
                `useTransition`, `useState`, icons, Badge, Avatar and the two
                actions. No `useToast`, no `useRouter`.
          - The CONTRAST is the proof this is a defect and not a house style:
            `submitProofAction` in the SAME FILE (line 100) returns
            `Promise<{ ok: boolean; error?: string }>` with eight distinct
            messages, and `app/(app)/kids/submit/[assignmentId]/submit-form.tsx`
            renders them (`{error && <p className="…text-danger">{error}</p>}`).
            The CHILD is told why their submission failed. The PARENT is told
            nothing when the approval fails.
          - Double-submit is NOT the gap here: `useTransition`'s `pending`
            disables all three buttons. That guard exists; the feedback does not.
Impact:   The chore → complete → approve → points → reward loop is the product's
          headline flow. A parent clicks Approve on a proof photo; if the wallet
          credit, the status write, or the dispute resolution fails, the child
          is never paid and the parent has no idea — the card just stays in the
          queue. They will click again, which re-runs the same failing path.
          Worst case is line 322: `finalizeApproval` threw AFTER the assignment
          row flipped to approved, the rollback ran, and the queue silently
          keeps the item — a reward that is owed, recorded nowhere, with no
          error anywhere a human will look.
Fix:      Change the four to `Promise<{ ok: boolean; error?: string }>` — the
          shape `submitProofAction` in the same file already uses — give each
          return its catalogue message, and have `ReviewCard` render it the way
          `SubmitProofForm` does. `createChoreAction` needs the same before it
          can be moved off `<form action={createChoreAction}>`.
Status:   OPEN
```

---

## C-4-15

```
[CLAUDE-4][HIGH][FEATURE/AUTHZ] The manager gate landed on ONE of the two
                        chore-creation actions; a child owns the other one
File:     app/(app)/missions/actions.ts:385-431   (ungated)
          app/(app)/missions/new/page.tsx:21      (page: requireUserContext only)
          app/(app)/missions/page.tsx:19          (page: requireFeature, plan not role)
          cf. app/(app)/dashboard/chores/actions.ts (gated, and TESTED)
Problem:  There are two independent server actions named `createChoreAction`.
          The one in `dashboard/chores/actions.ts` calls `refuseUnlessManager`
          twice and is locked in by `tests/chore-manager-only-writes.test.ts`.
          The one in `missions/actions.ts` — reached from `/missions/new` —
          has NO role check at all. It reads the form, inserts into `chores`,
          and inserts `chore_assignments`.

          Nothing behind it disagrees, either:
            chores_insert            WITH CHECK is_family_member(family_id)
            chores_update  / _delete USING      is_family_member(family_id)
            chore_assignments_*      is_family_member(family_id)   (all four)
          and neither page in front of it checks a role: `/missions/new` calls
          plain `requireUserContext()`, `/missions` calls `requireFeature()`
          which is a PLAN gate (lib/supabase/auth.ts:237-250 — plan level and
          `off`, no role anywhere).

          So a signed-in child can:
            · open /missions/new and mint a chore, choosing its `reward_mode`,
              `points`, `cash_cents`, `proof_required`, `requires_approval`
              and `auto_approve_score`, assigned to themselves or a sibling;
            · edit or DELETE any chore a parent created (chores_update/_delete);
            · open /missions and read the whole family review queue — every
              sibling's proof photos, every AI safety flag, every dispute
              reason — with Approve/Reject buttons that (per C-4-14) do nothing
              and say nothing.
Evidence: - Read `createChoreAction` (missions) in full: 47 lines, no
            `isManager`, no `refuseUnlessManager`, no role reference.
          - Live catalogue, not grep:
              psql … "select polname,polcmd,pg_get_expr(polqual,polrelid),
                      pg_get_expr(polwithcheck,polrelid) from pg_policy
                      where polrelid='public.chores'::regclass"
            → chores_insert `a` WITH CHECK is_family_member(family_id); update
              `w`, delete `d` both USING is_family_member(family_id). Same four
              for chore_assignments.
          - Ruled out a database trigger catching it:
              pg_trigger on chores / chore_assignments → trg_set_updated_at ×2
              and trg_chore_assignment_decision_guard. I read the guard's
              definition: it fires ONLY on `new.status in ('approved','rejected')`
              and it exempts `service_role`. It does not touch INSERT of a
              todo assignment and it does not touch `chores` at all.
          - Ruled out "the page is unreachable for a child": `/missions` has no
            role gate and `app/(app)/missions/layout.tsx` is `<AppFrame>` only.
            `family_members` shows what a role gate looks like when it is
            present — fm_insert/_update/_delete are all `can_manage_family`.
          - The precedent is in the repo and names this exact reasoning.
            `tests/chore-approval-authz.test.ts` locks the `isManager` line into
            `approveSubmissionAction` and `rejectSubmissionAction` — in THIS
            file — with the rationale "RLS on chore_submissions is family-scoped
            (any member, including the child who submitted), so the ONLY thing
            stopping a child … is the app-level manager gate in these server
            actions." That argument is true word-for-word of `chores` and
            `chore_assignments`, and the gate was never extended to them.
            `tests/chore-manager-only-writes.test.ts` then closed the identical
            hole on the dashboard board — and did not look at this file.
Impact:   A child can author the family's chore catalogue and its rewards, and
          can delete chores they were assigned (the chore, and the record that
          it was ever owed, both vanish — the exact harm that test calls out).
          The self-payment chain is reachable but not unconditional: a
          self-created chore with `proof_required: 'none'` and
          `auto_approve_score: 0` goes to `submitProofAction`, whose
          auto-approve branch runs `finalizeApproval` under the SERVICE ROLE
          (missions/actions.ts:216), which is precisely what the decision-guard
          trigger exempts — so `points_awarded`, `cash_awarded_cents`, XP,
          streak and badges are all written on the child's own say-so. The one
          remaining brake is the AI verdict (`lib/chores/ai.ts:80`), and the
          child controls the title, instructions and note it judges. Real cash
          still needs a parent to press Pay (`payChoreRewardAction` IS
          `isManager`-gated) — but that button pays `cash_awarded_cents`, which
          by then is a number the child chose.
Fix:      Add `if (!isManager(ctx.active.role)) return { ok:false, error: … }`
          to `createChoreAction` in `app/(app)/missions/actions.ts` (together
          with C-4-14's result type), add a manager check to
          `app/(app)/missions/new/page.tsx` and `app/(app)/missions/page.tsx`,
          and extend `tests/chore-approval-authz.test.ts` to cover
          `createChoreAction` in the file it already reads. The durable fix is
          the RLS half — `chores` and `chore_assignments` write policies moved
          to `can_manage_family` — which is Claude-3/Claude-1 territory and is
          flagged to them rather than claimed here.
Status:   OPEN
```

---

## C-4-16

```
[CLAUDE-4][HIGH][GUARDIAN/EDGE CASE] Two families may hold the same Guardian
                        number, and then every inbound call, SMS and WhatsApp
                        to it is dropped and marked handled
File:     app/(app)/guardian/actions.ts:277-286   (the clash check)
          app/api/guardian/inbound/voice/route.ts:70-79
          app/api/guardian/inbound/sms/route.ts:57-65
          app/api/guardian/inbound/whatsapp/route.ts:64-…
Problem:  `assignGuardianPhoneAction` takes a FREE-TEXT phone number from a
          parent (components/guardian/guardian-number-form.tsx:22-28 is a plain
          controlled input) and guards against a clash like this:

            .from('guardian_member_profiles').select('member_id')
            .eq('family_id', familyId)          ← scoped to ONE family
            .eq('guardian_phone', phone)
            .neq('member_id', input.member_id).maybeSingle()

          There is no global uniqueness — not in the app and not in the
          database. The three inbound Twilio webhooks then resolve the family
          the other way round, ACROSS all families, under the service role:

            .eq('guardian_phone', to).eq('is_active', true).maybeSingle()

          With two matching rows `maybeSingle()` returns `data: null` and a
          PGRST116 error. All three routes destructure `{ data: memberProfile }`
          and discard the error, so `!memberProfile` is taken to mean "unknown
          number": the SMS route calls `markGuardianCallbackProcessed` and
          answers 200, and the voice route sends the caller to voicemail.
Evidence: - Live catalogue: `select indexname, indexdef from pg_indexes where
            tablename='guardian_member_profiles'` → exactly three:
            `_pkey (id)`, `_family_id_member_id_key (family_id, member_id)`,
            and nothing else. No unique constraint on `guardian_phone`, no
            index on it.
          - The two sides genuinely disagree about scope. The writer uses
            `createServer()` (RLS-bound — it could not see another family even
            if the `.eq('family_id')` were removed); the readers use
            `createServiceClient()` (sms/route.ts:47), which sees every family.
            So this cannot be fixed in the action: only a database constraint
            can see both families at once.
          - `maybeSingle()`'s >1-row behaviour verified in the installed
            library, not assumed:
            node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts:519-531
              `if (this.isMaybeSingle && Array.isArray(data)) {
                 if (data.length > 1) { error = { code: 'PGRST116', … };
                                        data = null; status = 406 } … }`
            — so `data` is null and the discarded `error` is the only witness.
          - Ruled out "Bubaly provisions the number so a collision cannot
            happen": the value comes from `input.phone` typed by a parent and
            is only normalised to E.164 (actions.ts:264-274). Any parent can
            type any number, including one another family already uses — by
            mistake (their own mobile) or deliberately.
          - Ruled out an upstream guard: the routes' only checks before the
            lookup are the Twilio signature, `isValidGuardianEventId(smsSid)`
            and `!to`. Nothing counts profiles.
Impact:   Cross-tenant and silent. Family B typing a number family A already
          uses takes family A's Guardian offline — scam screening, elder-call
          routing, voicemail — with no error on either side, no log, and Twilio
          told 200 so nothing is retried. Guardian is a safety feature; the
          failure mode is "the call just never arrives".
Fix:      `create unique index concurrently uq_guardian_profiles_phone on
          public.guardian_member_profiles (guardian_phone) where guardian_phone
          is not null;` (attempted-not-forced, in the style of 0285's
          `uq_subscriptions_family` block, so it reports rather than deletes if
          duplicates already exist), surface the 23505 in
          `assignGuardianPhoneAction` as "that number is already in use", and
          stop discarding the read error in all three inbound routes —
          `if (profileError) return 503` so Twilio retries instead of the event
          being consumed. The index also fixes C-4-17's second instance.
Status:   OPEN
```

---

## C-4-17

```
[CLAUDE-4][MEDIUM][PERF] Three hot predicates have no usable index at all —
                        proven by the planner, not by reading migrations
File:     app/(auth)/actions.ts:125 and
          app/(app)/family/child-login-actions.ts:46   (child_logins.username)
          app/api/guardian/inbound/{voice,sms,whatsapp}/route.ts
                                                       (guardian_phone)
          lib/wallet/server.ts:171 and :190            (wallet_transactions.stripe_ref)
Problem:  Each of these is a service-role query (no RLS predicate to help the
          planner) on a table that spans every family on the platform, and each
          one has to scan the whole table.

          1. `child_logins` — EVERY child sign-in.
             The only username index is
             `create unique index idx_child_logins_username_lower … (lower(username))`
             (migration 01051:26). Both call sites query `.eq('username', …)`,
             which emits `username = $1`. An expression index on
             `lower(username)` cannot serve that predicate.
          2. `guardian_member_profiles.guardian_phone` — EVERY inbound call,
             SMS and WhatsApp. No index contains the column (see C-4-16).
          3. `wallet_transactions.stripe_ref` — the Issuing idempotency read in
             `debitCardSpend` and the `releaseCardHold` UPDATE. No index
             contains the column; `wallet_transactions` is the fastest-growing
             money table in the schema.
Evidence: Run against the replayed PG16 on 127.0.0.1:54402/bubaly, read-only.
          The test is deliberately hostile to my own claim: `enable_seqscan=off`
          charges a sequential scan 1e10, so if ANY index could serve the
          predicate the planner would take it.

            set enable_seqscan=off;
            explain select username from public.child_logins
              where username = 'alice' limit 1;
            →  Seq Scan on child_logins  (cost=1e10..1e10+16.50)
                 Filter: (username = 'alice'::text)

            -- control, same table, same session:
            explain select username from public.child_logins
              where lower(username) = 'alice' limit 1;
            →  Index Scan using idx_child_logins_username_lower (cost=0.15..8.17)
                 Index Cond: (lower(username) = 'alice'::text)

            set enable_seqscan=off;
            explain select id from public.guardian_member_profiles
              where guardian_phone='+15551234567' and is_active;
            →  Seq Scan on guardian_member_profiles (cost=1e10..1e10+13.25)

          `select indexdef from pg_indexes where tablename='wallet_transactions'`
          → `_pkey(id)`, `(family_id, child_wallet_id, created_at desc)`,
            `(family_id, status)`, `(bucket_id)`. `stripe_ref` appears in none.

          Ruled out: (a) case normalisation making the `lower()` index usable —
          `normalizeUsername` (lib/onboarding/child-login.ts:12) lowercases both
          on write and on read, so every stored value already equals its own
          `lower()`, and the planner STILL cannot use the expression index for a
          bare-column predicate; that is what the control query above shows.
          (b) RLS supplying the missing leading column — all three call sites
          use `createServiceClient()`, so no policy predicate is added.
          (c) the money case being a correctness bug as well — it is not: the
          Issuing webhook dedupes on the Stripe event id via `recordEvent`'s
          claim token (app/api/webhooks/money/route.ts:52-60), so the
          unindexed `stripe_ref` read is belt-and-braces, not the only guard.
          This is a cost finding, not a double-debit finding.

          The residual inventory, for completeness — 26 further equality
          predicates hit no index, but every one is an admin console page over a
          small table (`crm_lead_scores.band`, `subscriptions.status`,
          `marketing_*.status/deleted_at`, `sync_*`, `invites.status`,
          `profiles.email`) or a genuinely low-frequency route
          (`blog_subscribers.unsubscribe_token` — one-click unsubscribe, a
          compliance path worth an index but not a hot one). Method:
          every `.from('t')…eq/in/match('c')` chain in `app/` and `lib/`
          cross-referenced against every key column of every index in the live
          catalogue (`pg_index.indkey`, not just the leading column — the first
          pass used the leading column only and over-reported, see "Disproved").
Impact:   (1) is the worst: a full table scan of a platform-wide table on every
          child sign-in AND on every FAILED attempt, so the brute-force
          throttle's own bookkeeping is the cheap half of a request whose
          expensive half the attacker triggers for free. (2) sits inside
          Twilio's real-time window with a caller on the line. (3) grows without
          bound with transaction volume, and the `releaseCardHold` instance is
          an UPDATE, so it scans on the write path too.
Fix:      Three indexes, all additive and safe to run concurrently:
            create index concurrently … on public.child_logins (username);
              -- or change both call sites to `.eq('username', …)` against a
              -- normalised column with a plain unique index; the expression
              -- index can then be dropped. One or the other, not neither.
            create unique index concurrently … on public.guardian_member_profiles
              (guardian_phone) where guardian_phone is not null;   -- also C-4-16
            create index concurrently … on public.wallet_transactions
              (stripe_ref) where stripe_ref is not null;
Status:   VERIFIED (planner output above; no source or database modified)
```

---

## C-4-18

```
[CLAUDE-4][MEDIUM][FLOWS] A removed family member is silently handed a brand-new
                        empty family instead of being told they were removed
File:     lib/supabase/auth.ts:185-206      (requireUserContext)
          lib/server/ensure-family.ts:54-92 (ensureActiveFamily)
          components/modules/family-module.tsx:457 (the removal itself)
Problem:  Removing a member is `update({ is_active: false })` on their
          `family_members` row, issued straight from the client. Their session
          is untouched and nothing notifies them.

          On their next page load `getUserContext()` finds no ACTIVE membership
          and returns `needsFamily`. `requireUserContext` treats that as a
          brand-new signup — "Never trap a signed-in user in an onboarding
          loop" — and calls `ensureActiveFamily`, which checks only
          `.eq('is_active', true)` (ensure-family.ts:65), sees none, and
          provisions a NEW family via `ensure_family_for_user` with the user as
          its parent. They land on a dashboard that looks like theirs and is
          completely empty.
Evidence: - Read all three files end to end. The `is_active` filter in
            `ensureActiveFamily` is the whole of it: a deactivated membership is
            indistinguishable from never having had one.
          - Ruled out an interstitial: there is no "you were removed" screen,
            no check for an inactive membership anywhere on the path, and no
            notification write in the removal handler (family-module.tsx:455-457
            is `update` + a local state refresh, nothing else).
          - Ruled out the removal being manager-only-and-therefore-rare as a
            mitigation — it is correctly manager-only (pg_policy on
            `family_members`: fm_update/_delete/_insert are all
            `can_manage_family`), which makes this the NORMAL path, not an edge
            one. The super-admin console does the same at
            app/(app)/admin/actions.ts:164.
          - The one thing I could not settle from the code: whether the new
            family also starts a fresh 5-day trial. `computeEntitlement` keys
            off `families.trial_ends_at`, and `ensure_family_for_user` is an
            RPC I read only through its call site, so I am not claiming it.
Impact:   A removed co-parent, teen or caregiver sees no message, no
          explanation, and no trace of the family they were in — just an empty
          Bubaly that looks like a fresh install. Every support ticket this
          produces starts with "all my family's data is gone". The person who
          removed them also gets no confirmation that anything reached them.
Fix:      In `requireUserContext`, before provisioning, look for an INACTIVE
          membership (`family_members` where `user_id = …` with no `is_active`
          filter). If one exists, render a "you're no longer part of <family>"
          screen with sign-out and "start my own family" rather than silently
          provisioning. `ensureActiveFamily` already uses the service client, so
          the extra read is one query on a path that already runs several.
Status:   OPEN
```

---

## Disproved this session — recorded so nobody re-derives them

These looked like findings, and the evidence killed them. Each is here because
the wrong version is easy to re-derive from a grep.

- **"14 vacation tables are seq-scanned per concierge request."**
  `app/api/vacations/ai/route.ts:61-74` reads fourteen `vacation_*` tables
  filtering on `vacation_id` alone, and every index on those tables LEADS with
  `family_id`. That is not enough to conclude anything. The planner:
  `set enable_seqscan=off; explain select * from vacation_flights where
  vacation_id = …` → `Index Scan using idx_vacation_flights_trip`,
  `Index Cond: (vacation_id = …)`. Postgres will use a multi-column btree with
  a non-leading equality column. Worse for my draft finding: with the RLS
  predicate in place the plan is a nested loop whose inner Index Cond is
  `(family_id = family_members.family_id AND vacation_id = …)` — a fully
  indexed lookup. The route is fine, and "the leading column must match" is the
  wrong rule. My first sweep used it and over-reported by an order of magnitude;
  the numbers in C-4-17 come from the corrected sweep (any key column of any
  index) plus per-case `EXPLAIN`.
- **`tests/display-render.test.ts` — eight `it` blocks whose only assertion is
  `expect(() => render(…)).not.toThrow()`.** This matches the "test that cannot
  fail" shape exactly and is not one. The file's subject IS totality: a client
  component that throws during SSR is caught by the route error boundary and
  retried forever (the "Reconnecting…" loop the header documents), and React
  error boundaries cannot catch an SSR throw. `not.toThrow()` is the behaviour
  under test, not a weak stand-in for one. Sound as written.
- **A child stuck behind the trial paywall with no way forward.**
  `TrialPaywallGate` replaces the whole `(app)` tree for every member, and its
  Choose buttons POST to `/api/billing/checkout`, which is `isAdmin`-only. But
  the 403 body is `checkout.onlyAParentCanStart` = "Only a parent can start a
  subscription." (lib/i18n/messages/en-US.json:3002, present in every locale),
  the gate renders it through `toastError`, and both Log out (a real POST form,
  not a link) and Close account are available. It says the right thing.
  `closeAccountAction`/`reopenAccountAction` are both `isAdmin`-gated, so a
  child cannot close the family's account from that screen either.
- **`persistSubscription` drops a subscription event with no `family_id`.**
  `app/api/webhooks/stripe/route.ts:20` is `if (!familyId) return;` and the
  event is then marked processed — a family could pay and get nothing. I could
  not find a path that produces such an event: both places that create a
  subscription set it (`checkout/route.ts:95` and `change-plan/route.ts:176`
  pass `subscription_data: { metadata: { family_id } }`, and the in-place
  update at change-plan:122 re-sends `metadata: { family_id }`), and Stripe
  preserves subscription metadata across updates. Left alone.
- **A double-debit race on `debitCardSpend`'s unindexed `stripe_ref` read.**
  Read-then-insert with no unique constraint is the classic shape, but
  `/api/webhooks/money` claims every event through `recordEvent` first
  (route.ts:52-60) and an active concurrent delivery is acknowledged without
  repeating side effects. The idempotency is held one level up. Only the cost
  survives, and it is in C-4-17.
- **A second `subscriptions` row breaking `change-plan`.** `maybeSingle()` at
  change-plan/route.ts:96 errors on two rows and answers 503 forever, while the
  webhook was deliberately hardened for duplicates (update-then-insert). Real,
  but migration 0285 already states this in its own text ("`use-billing-
  subscription.ts` reads it with `.maybeSingle()`, which errors outright on a
  second row") and creates `uq_subscriptions_family` when it can. Present in the
  live catalogue. Not a new finding.
- **Missing double-submit guards.** Swept all 441 client components for "calls a
  server action, renders no `disabled=`". 121 candidates, and the money/reward
  ones are guarded: `ReviewCard` disables all three buttons on `useTransition`'s
  `pending`, `SubmitProofForm` disables on `pending`, `TrialPaywallGate` guards
  on `busy` and returns early. The double-submit risk is not where the damage
  is; the missing FEEDBACK is (C-4-14).
- **N+1 in request-path loops.** Re-ran the await-in-loop sweep over
  `app/(app)` and `app/api` excluding cron. Everything that survived reading is
  either a pure JS reduction the regex mistook for a query loop
  (`dashboard/moments/page.tsx:61`, `playbook-actions.ts`), a chunked
  `i += 500` insert, or already logged as C-4-03. The one new loop with real
  awaits, `app/(app)/wallet/actions.ts:80`, is one-time wallet provisioning
  bounded by family size and idempotent on retry (all three writes are upserts
  with an `onConflict` target). No new finding.
- **`grandparent-portal` fanning out per household.** `Promise.all` over
  `ctx.memberships` — bounded by how many families one grandparent belongs to,
  and the comment explains why it is per-household (failure isolation). Fine.

---

## Method (session 4)

- Read `audit/status.md` and my own file first; nothing here restates C-4-01…13
  or anything on PR #548's closed list.
- Live PG16 at `127.0.0.1:54402/bubaly` used READ-ONLY for every schema claim:
  `pg_indexes`, `pg_index.indkey`, `pg_policy`, `pg_trigger`,
  `pg_get_functiondef`, and `EXPLAIN` under `set enable_seqscan=off` so that a
  "no usable index" claim is the planner's and not mine. No `insert`, `update`,
  `create` or `drop` was issued — the harness belongs to Claude-3.
- Four scripted sweeps, all in the scratchpad, none in the repo: sequential
  independent awaits in server components; per-row async fan-out
  (`Promise.all(rows.map(async …))`); every `.from(t)…eq/in/match(c)` predicate
  against every index key column; `void` server actions with ≥2 bare returns;
  plus a client-component double-submit sweep and a weak-assertion sweep over
  all 1,194 test files.
- Every finding was then confirmed by reading the whole function or route, and
  each one carries the alternative I ruled out and how. Seven candidates died
  that way and are written up above rather than dropped.

**Not reached.** No running app and no browser, so the flow claims are from the
code and the schema, not from clicking. I did not mutate any source file to
prove a test vacuous — one shared working tree with three other workers in it
made that the wrong trade; where I needed non-vacuity I used the live catalogue
or the absence of any importing test instead (C-4-15 cites
`tests/chore-approval-authz.test.ts` reading the very file whose third action it
does not cover).

**No source code was modified. No database row was written.**

---

<!-- Two sessions appended to this file concurrently. Both blocks are kept in
     full and in the order they were written; neither displaces the other. -->

---
---

# Claude-4 — Session 3 (2026-09-14): the browser pass Pass F never had

> **Delimiter.** Everything above this line is earlier work and is not edited.
> This section is appended.

STATUS
- **CURRENT:** complete — runtime pass over the public surface of the production
  build serving at `http://localhost:3210`, using Chromium + Playwright. Pass F
  (`F-F01`–`F-F13`) was written entirely from source and `vitest`; **no browser
  had ever been run against this application.** This section is that run.
- **COMPLETED:**
  - Console errors, page errors, failed requests and **real transferred bytes**
    (Chrome DevTools Protocol `Network.loadingFinished.encodedDataLength`,
    cold cache, one fresh browser context per route) on 11 public routes.
  - Page-weight re-measurement against the `F-C01`–`F-C03` claims and the
    Verification Checklist item *"`/cookies` under 25 KB gzipped"*. **Contradicted
    — see C-4-14 and C-4-15.**
  - Error/loading states: `/nope`, a bad blog slug, malformed slugs on all six
    DB-backed marketing route families, path-traversal and whitespace slugs.
  - The three reachable flows — login, signup, contact — driven in a real
    browser: client validation, double-submit, pending state, and what the user
    actually sees when the backend fails.
  - Internal-link crawl over the public surface (37 unique internal hrefs).
  - Re-verified four still-OPEN Pass F findings that need no session.
- **NEXT:** nothing queued. C-4-14, C-4-15 and C-4-17 are the three that pay for
  themselves immediately and none of them needs an operator.
- **FILES-TOUCHED:** `audit/claude-4.md` (this file, appended) only. **No
  application source modified.** Throwaway scripts live in the session
  scratchpad, not in the repo.
- **BLOCKERS:** Supabase is stubbed with dummy credentials
  (`NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co`), so there is no
  session and `app/(app)` cannot be signed into. Every DB-backed surface renders
  empty or throws. **An empty list is not reported as a defect anywhere below.**
  Where the stub limited what could be seen, the finding says so and is marked
  BLOCKED rather than clean.
- **LAST-UPDATE:** 2026-09-14

## Method, and what it can and cannot see

Environment: `next-server (v15.5.25)` production build, one shared instance on
`:3210` (not rebuilt or restarted — other workers share it). Chromium 1194 via
the globally installed `playwright@1.56.1` (the repo's `playwright@1.61.0`
expects browser revision 1228, which is not present; `playwright install` was
not run, per instruction).

Two measurement notes that matter for reading the numbers below:

1. **Transferred bytes are CDP `encodedDataLength`**, i.e. what actually crossed
   the wire, gzipped, with a cold cache and a fresh browser context per route.
   This is a different quantity from the one Pass C reported. Pass C measured the
   **document** (`curl | gzip`); the numbers below are **document + JS + CSS +
   images**. Both are correct; they answer different questions, and the gap
   between them is C-4-14.
2. **Wall-clock TTFB is inflated by the stub.** Every server render that touches
   Supabase blocks on a DNS failure for `example.supabase.co` (~7 s per read
   through the agent proxy). Measured TTFB is therefore *not* a production
   number. It is still evidence of something real — how many blocking reads a
   render performs, and that none of them has a timeout — and that is how it is
   used (C-4-24), never as a claim about production latency.

Verified serving, matching the brief: `/` `/pricing` `/features` `/security`
`/faq` `/privacy` `/mobile` `/login` `/cookies` `/terms` `/contact` `/blog`
`/ai` `/how-it-works` `/acceptable-use` `/signup` `/welcome` → 200;
`/nope` → 404; `/dashboard` → 307 → `/login`.

---

## Measured page weight — the table Pass C did not have

Cold cache, one fresh context per route, CDP byte counts, KB = 1024 B.

| route | status | reqs | **total** | document | script | css | image |
|---|---:|---:|---:|---:|---:|---:|---:|
| `/` | 200 | 21 | **2388.5** | 65.0 | 412.0 | 32.5 | **1877.6** |
| `/pricing` | 200 | 27 | 546.1 | 35.3 | 425.5 | 32.5 | 42.2 |
| `/security` | 200 | 20 | 558.4 | 70.3 | 412.0 | 32.5 | 42.2 |
| `/features` | 200 | 20 | 538.9 | 50.8 | 412.0 | 32.5 | 42.2 |
| `/contact` | 200 | 21 | 533.4 | 26.3 | 431.0 | 32.5 | 42.2 |
| `/terms` | 200 | 22 | 523.4 | 32.2 | 412.0 | 32.5 | 42.2 |
| `/privacy` | 200 | 20 | 523.2 | 35.1 | 412.0 | 32.5 | 42.2 |
| `/faq` | 200 | 21 | 519.5 | 29.4 | 412.7 | 32.5 | 42.2 |
| `/cookies` | 200 | 20 | **515.8** | **27.7** | 412.0 | 32.5 | 42.2 |
| `/mobile` | 200 | 20 | 515.2 | 27.1 | 412.0 | 32.5 | 42.2 |
| `/login` | 200 | 27 | 606.9 | 14.1 | **516.6** | 32.5 | 42.2 |

Read the `/cookies` row against the Verification Checklist item
*"`/cookies` under 25 KB gzipped"*. The **document** is 27.7 KB, and the **page**
is 515.8 KB. Both halves of that are findings; the document half is C-4-19's
sibling below and the 412 KB of script is C-4-14.

Independent `curl` confirmation of the document figure, so it does not rest on
CDP's header accounting:

```
$ curl -s -H "Accept-Encoding: gzip, br" -o ck.gz http://localhost:3210/cookies
$ grep -i content-encoding h.txt        # Content-Encoding: gzip
$ stat -c%s ck.gz
26593                                    # 25.97 KiB / 26.6 KB
```

**Verdict on the checklist item:** *"`/cookies` under 25 KB gzipped"* **FAILS on
this build** — 26,593 bytes gzipped, over the gate on either definition of KB.
`finalaudit.md` `F-C03` records 20 KB gzipped measured *in production*; this is
the local production build, so the two are not the same artifact and this does
not prove the production number was wrong. It does mean the gate as written does
not currently pass, and nobody has re-measured it since.

---

## C-4-14

```
[CLAUDE-4][HIGH][PERF/DELIVERY] The whole en-US message catalogue still ships to
every public page — as a 246 KB JavaScript chunk. F-C03 fixed the RSC-payload
half of this and left the JavaScript half in place
File:     lib/i18n/messages.ts:11-21, :70
          components/i18n/locale-provider.tsx:13
URL:      http://localhost:3210/cookies  (and every other public route)
```

**Problem.** `F-C03` is indexed in Part 0 as *"the catalogue on every public
page — **all fixed and verified in production**"*, and its evidence is the
gzipped **document** falling from 266 KB to 20 KB. That fix is real and it holds.
But the catalogue reaches the browser by a **second** route that the fix never
touched: it is bundled as JavaScript.

`components/i18n/locale-provider.tsx` is a `'use client'` module. Line 13:

```ts
import { translate, type Messages } from '@/lib/i18n/messages';
```

`lib/i18n/messages.ts` statically imports all eleven catalogues at module top
level (`lib/i18n/messages/` is 6.4 MB on disk) and, at line 70, `translate()`
falls back through the English one:

```ts
const template = messages[key] ?? SOURCE_MESSAGES[key] ?? key;
```

`SOURCE_MESSAGES` is `en-US.json`. So the client bundle that provides `t()` to
every marketing component drags the entire English catalogue in with it. Webpack
tree-shakes the other ten (verified below — only en-US survives); en-US cannot be
shaken because `translate` references it.

**Evidence.** The largest single resource on `/cookies` — the page the
Verification Checklist names — is the chunk carrying the catalogue:

```
ROUTE /cookies TOTAL 528156 REQS 20
   246392 Script      200 /_next/static/chunks/19933-eb3487e0d0322831.js
    55865 Script      200 /_next/static/chunks/4bd1b696-bad92808725a934a.js
    47702 Script      200 /_next/static/chunks/31255-2e48f83e850421e0.js
    43228 Image       200 /_next/image?url=%2Fbrand%2Fbubaly-logo.png&w=1200&q=75
    33300 Stylesheet  200 /_next/static/css/efe55d1639ee1e52.css
    28336 Document    200 /cookies
```

246,392 bytes over the wire, 818,794 bytes on disk — **60% of the 412 KB of
script that every marketing page loads**, and nine times the document it is
delivered alongside.

Proof that the chunk *is* the catalogue, not a coincidence of shared strings —
every long value in `en-US.json` matched verbatim against the chunk text:

```
total keys 13456
long values (>25 chars): 4231   present in chunk 19933: 3923 = 92.7%
sample keys found: App.couldNotSetTheDefaultDashboard, App.couldNotSwitchActiveFamily,
                   App.couldNotVerifyFamilyMembership, acceptableUse.breakDisableOrOverloadThe, ...
```

And the same test run over **every** chunk in `.next/static/chunks`, for all
seven populated catalogues, 200 sampled long strings each:

```
en-US -> 19933-eb3487e0d0322831.js (193/200, 818794B)
        (de-DE, es-ES, fr-FR, it-IT, nl-NL, pt-PT: no chunk above threshold)
```

Sampling the chunk's own string literals returns exactly what `F-C03` said it had
removed from the cookie policy:

```
 5 "Could not load the family wallet. Refresh and try again."
 7 "AI is not configured (OpenAI API key missing)."
 5 "Relationship insights are temporarily unavailable from Supabase."
 4 "Too many billing requests. Please try again shortly."
 3 "No savings goals yet."     3 "Recent Transactions"
 3 "Webhook storage unavailable"
```

Wallet errors and admin-studio copy, on a cookie policy — `F-C03`'s own words for
the defect it closed.

**Why the guard cannot see it.** `tests/i18n-client-scope.test.ts` walks the
import graph and asserts that a route's declared **scope covers the keys its
client components ask for**. It says nothing about what lands in the client
*bundle*. A scope of 26 keys and a bundle of 13,456 both pass it. This is the
document's own recurring pattern — a guard that cannot see what it was named for
— in the delivery layer rather than the data layer.

**Impact.** Every first visit to any public page, and every crawl, pays 246 KB of
gzipped JavaScript that exists to translate 26 keys. It is parse-and-compile work
on the main thread, not just transfer, so it lands squarely on TBT/INP as well as
LCP. Also: the module's own header comment — *"the browser downloads one language
rather than eleven"* — is true of the RSC payload and false of the bundle, so the
file documents a property it does not have.

**Recommended fix.** Keep the English fallback out of the client-imported module.
Either (a) resolve it on the server: merge the scoped English strings into
`messages` inside `scopeMessages()` before handing the object to the provider, and
let the client `translate` be `messages[key] ?? key`; or (b) split `translate`
into a module with no catalogue imports and keep `SOURCE_MESSAGES` in a
server-only one. Then add the guard the current one is missing: assert that no
file under `.next/static/chunks` contains more than N strings from
`en-US.json` — the check that would have failed here, and would fail again.

**Status:** OPEN — contradicts the "fixed and verified" status of `F-C03` as
indexed in Part 0. The RSC-payload half of `F-C03` is **VERIFIED still fixed**
(the `/cookies` document is 27.7 KB, not 266 KB); the headline claim that the
catalogue no longer ships on every public page is **CONTRADICTED**.

---

## C-4-15

```
[CLAUDE-4][HIGH][PERF] The homepage downloads a 1.79 MB PNG to draw five ~24px
avatars, because it is a CSS background-image and so bypasses next/image entirely
File:     components/marketing/visual-mocks.tsx:93-107  (FACE_POSITIONS + FaceAvatar)
          public/images/family-ai-lifestyle.png
URL:      http://localhost:3210/
```

**Problem.** `FaceAvatar` renders each face by pointing a `background-image` at
the full-size hero photograph and cropping it with `background-size: 620% auto`
plus one of five `background-position` values:

```tsx
style={{
  backgroundImage: "url('/images/family-ai-lifestyle.png')",
  backgroundPosition: FACE_POSITIONS[index % FACE_POSITIONS.length],
  backgroundSize: '620% auto',
}}
```

A CSS `url()` is not a `next/image` request, so none of the optimisation applies:
no resize, no AVIF/WebP negotiation, no `srcset`. The raw file is fetched.

**Evidence.** Cold cache, CDP byte counts. The homepage is 2.39 MB and **77% of
it is this one file**:

```
ROUTE / TOTAL 2444844 REQS 21
  1879444 Image       200 /images/family-ai-lifestyle.png     <-- 77%
   246392 Script      200 /_next/static/chunks/19933-…js       (C-4-14)
    65598 Document    200 /
    43226 Image       200 /_next/image?url=%2Fbrand%2Fbubaly-logo.png&w=1200&q=75  (C-4-17)
```

The asset itself, and how it is served:

```
$ file public/images/family-ai-lifestyle.png
PNG image data, 1774 x 887, 8-bit/color RGB, non-interlaced       # 1,878,096 B

$ curl -sI http://localhost:3210/images/family-ai-lifestyle.png
Content-Type: image/png
Content-Length: 1878096
Cache-Control: public, max-age=0        <-- revalidated on every repeat visit
```

A photograph stored as a lossless RGB PNG, served uncompressed and uncacheable,
to produce five circular thumbnails roughly 24 px across. (The *hero* use of the
same file at `visual-mocks.tsx:418` is correct — it goes through `<Image fill
priority sizes=…>`. Only the avatar path is raw. The two share a URL, so the
browser fetches the raw file once and the optimised variant never runs.)

**Impact.** 1.79 MB is on the critical path of the marketing homepage. On a
typical 4G connection (~1.6 Mbps effective) that is roughly 9 seconds of transfer
for decoration. It is the single largest lever on this site's LCP and it is on
the page most visitors see first.

**Recommended fix.** Export the five faces as five small WebP/AVIF files (or one
small sprite) at the size they are displayed, and reference those. Re-encode the
hero itself to AVIF/WebP — a 1774×887 photograph belongs nowhere near 1.8 MB. Add
a `headers()` entry in `next.config.mjs` giving `/images/:path*` a long-lived
immutable `Cache-Control` (the config already does exactly this for `/sw.js`, so
the pattern is in the file).

**Status:** OPEN

---

## C-4-16

```
[CLAUDE-4][HIGH][SEO/EDGE CASE] getPost() discards the read error, so a Supabase
blip answers 404 for every published article — the exact failure the sibling
landing-page route documents itself as avoiding
File:     lib/blog/posts.ts:255-268
          app/(marketing)/blog/[slug]/page.tsx:108-109
Compare:  app/(marketing)/lp/[slug]/page.tsx:27-32
```

**Problem.** `getPost` destructures `{ data }` only — the PostgREST `error` is
never examined — and wraps the whole thing in a bare `catch` that returns
`undefined`:

```ts
export async function getPost(slug: string): Promise<BlogPost | undefined> {
  if (isSyntheticBlogSeedSlug(slug)) return undefined;
  try {
    const { data } = await anonClient().from('blog_posts').select('*')
      .eq('slug', slug).eq('published', true).maybeSingle();
    return data ? toPost(data) : undefined;
  } catch { return undefined; }
}
```

The page then does `if (!post) notFound()`. "The database did not answer" and
"there is no such article" are the same value, and both render **404** — a
permanent-gone signal, to a crawler, for a live article.

The repository already knows this is wrong and says so, four directories away, in
`app/(marketing)/lp/[slug]/page.tsx:27-32`:

> *"Distinguish 'genuinely not found' (→ 404) from a transient read failure. If we
> swallow the error and return null, a real published page 404s on a DB blip — a
> permanent-gone signal that de-indexes the page. Throw so it renders a retryable
> 5xx instead, and reserve `notFound()` for a truly missing slug."*

**Evidence.** Observed, with Supabase unreachable — the two routes behave
differently under the identical failure:

```
404 46605  /blog/this-post-does-not-exist      <- swallowed; indistinguishable from a real slug
500 39901  /lp/not-a-landing-page              <- throws, as its comment intends
500 39798  /p/zzz
500 39826  /features/zzz
500 39826  /glossary/zzz
500 39822  /compare/zzz
500 39988  /f/00000000-0000-0000-0000-000000000000
```

Confirmed server-side in the build's own error log:

```
[server-error] digest=1479015789 route=/lp/[slug] (GET /lp/not-a-landing-page, render)
  Failed to load landing page "not-a-landing-page": TypeError: fetch failed
```

— and no corresponding line for `/blog/…`, because nothing was raised. The
failure is in `anonClient().from(...)` and is therefore **slug-independent**: with
the database unreachable, a real published slug gets the same 404 this
nonexistent one got. I could not demonstrate that on a *real* slug because the
stub means there are no rows to name; the code path is the same one either way.

The same swallow-without-rethrow appears in `getCategoryCounts` (:236),
`getPostsByCategory` (:250), `getFeaturedPost` (:281), `getRelatedPosts` (:299)
and `getAdjacentPosts` (:329). `getAllPosts` (:184) and `getAllPostRefs` (:215)
are the two that were fixed — they call `unstable_rethrow(error)` first and log
before degrading. **Two of eight got the lesson.**

**Impact.** The blog is the largest indexed surface on the site (`F-C02` counts
1,063 sitemap URLs). A Supabase incident long enough for a crawl turns every
article into a 404, which is the strongest de-indexing signal there is, and
recovery from a mass de-index is measured in weeks. `getRelatedPosts` and
`getAdjacentPosts` additionally strip internal links during the same window,
and `getCategoryCounts` silently renders every category as empty.

**Recommended fix.** Give `getPost` the `/lp/[slug]` treatment: read `error`,
`unstable_rethrow` first, and throw on a read failure so the route renders a
retryable 5xx; reserve `undefined` for `data === null`. Apply the same to the
other five. A regression guard should assert that a *failing* client produces a
throw rather than `undefined` — that is the direction this codebase's guards keep
failing to cover.

**Status:** OPEN

---

## C-4-17

```
[CLAUDE-4][MEDIUM][PERF] The site logo is fetched at 1200px wide — 43 KB — on
every public page, because <Image> is given width/height but no `sizes`
File:     components/brand/logo.tsx:52-59
```

**Problem.**

```tsx
<Image src="/brand/bubaly-logo.png" alt={t('logo.bubaly')}
       width={1143} height={618} priority
       className="h-14 w-auto object-contain" />
```

`width={1143}` is the intrinsic size of the source file, not the rendered size.
With no `sizes`, `next/image` generates a `srcset` and the browser picks from the
declared width, so it requests the 1200 px candidate for an image CSS lays out at
`h-14` — 56 px tall, about 104 px wide. (`LogoMark`, twenty lines above in the
same file, gets this right: `fill sizes="96px"`.)

**Evidence.** The same request, same byte count, on every route measured:

```
43226 Image 200 /_next/image?url=%2Fbrand%2Fbubaly-logo.png&w=1200&q=75
```

— `/`, `/pricing`, `/features`, `/security`, `/faq`, `/privacy`, `/mobile`,
`/login`, `/cookies`, `/terms`, `/contact`, all 42.2 KB in the image column of
the weight table above. It is `priority`, so it also competes for bandwidth
during the initial paint.

**Impact.** ~40 KB of avoidable transfer on every page view of the entire public
site, at the highest fetch priority, for a logo. On `/cookies` it is larger than
the document.

**Recommended fix.** Add `sizes="(max-width: 640px) 96px, 112px"` (or set
`width`/`height` to the rendered size). Expected ~3–5 KB. Re-encoding
`public/brand/bubaly-logo.png` (270 KB for a logotype) is a second, separate win.

**Status:** OPEN

---

## C-4-18

```
[CLAUDE-4][MEDIUM][DELIVERY] 541 of 546 routes are server-rendered on demand —
including every legal page — so no public page is cacheable by any CDN
File:     app/layout.tsx:66  (RootLayout -> getLocaleContext)
          lib/i18n/server.ts:57  (requestSignals -> cookies() + headers())
```

**Problem.** `RootLayout` awaits `getLocaleContext()`, which awaits `cookies()`
and `headers()`. Reading a request API in the **root** layout opts every route
beneath it out of static rendering — which is every route in the application.

**Evidence.** The build's own route table (`next build`, from the build log this
session's server was started from):

```
○  (Static)   prerendered as static content     ->   5 routes
ƒ  (Dynamic)  server-rendered on demand         -> 541 routes
●  (SSG)      prerendered as static HTML        ->   0 routes
```

and the prerender manifest agrees — the only four prerendered app routes are the
ones that do not use the root layout:

```
$ node -e "console.log(Object.keys(require('./.next/prerender-manifest.json').routes))"
[ '/manifest.webmanifest', '/robots.txt', '/twitter-image', '/opengraph-image' ]
```

`app/(marketing)/cookies/page.tsx` declares no `dynamic`, no `revalidate`, and
reads nothing per-request of its own — and is still `ƒ`. The consequence reaches
the wire as a response header on a static legal document:

```
$ curl -sI http://localhost:3210/cookies | grep -i cache-control
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
```

`private, no-store` on a cookie policy: no CDN edge cache, no browser cache, a
full origin render for every visitor and every crawler.

Seventeen files under `app/(marketing)` additionally declare `force-dynamic`
themselves, several of which are genuinely dynamic; that is a separate and
smaller question. The root layout is what makes the *legal and evergreen* pages
dynamic.

**Impact.** Vercel serves the whole marketing site from the origin. Every
`/cookies`, `/terms`, `/privacy`, `/faq` view is a Node render with the DB reads
C-4-24 describes, where a cached 27 KB document would do. It also removes the
headroom that would absorb a traffic spike, and it is why C-4-24's failure mode
is felt by every visitor rather than by the first one after a cache expiry.

**Recommended fix.** Move the locale resolution out of the root layout: resolve
it in middleware (which already runs on every request and already reads cookies
and headers) and pass it down via a request header, or scope `getLocaleContext()`
to the route groups that need per-request locale and let the legal and evergreen
pages prerender. Whatever the shape, the test is `next build` reporting `○`/`●`
for `/cookies`, `/terms` and `/privacy`.

**Status:** OPEN — not a re-derivation of `F-C01`–`F-C03`, which were about what
a page *contains*; this is about whether it is rendered at all.

---

## C-4-19

```
[CLAUDE-4][MEDIUM][SEO] The 404 page emits two contradictory robots meta tags,
and carries the site's default title and a self-referential canonical
File:     app/layout.tsx:49  (metadata.robots = { index: true, follow: true })
          app/not-found.tsx  (no metadata export)
URL:      http://localhost:3210/nope
```

**Problem.** The Verification Checklist asks for *"`/nope` returns 404 with
`noindex`"*. It returns 404, and it returns `noindex` — **and also `index,
follow`, in the same `<head>`**:

```
$ curl -s http://localhost:3210/nope | grep -o '<meta name="robots"[^>]*>'
<meta name="robots" content="noindex"/>
<meta name="robots" content="index, follow"/>

$ curl -sI http://localhost:3210/nope | head -1
HTTP/1.1 404 Not Found
```

The first is injected by Next for the not-found boundary. The second is the root
layout's `robots: { index: true, follow: true }`, which is redundant in the first
place — absence of the tag already means index/follow — and here it directly
contradicts the one that matters.

Two smaller things on the same response: the `<title>` is the site default
(`Bubaly — Less Managing Life. More Living It.`) rather than anything saying the
page is missing, and the page carries `<link rel="canonical" href="…/nope"/>`.

**Evidence.** Above, verbatim. Google's documented resolution for conflicting
robots rules is that the more restrictive wins, so `noindex` should prevail
*there*; other crawlers are not all documented to do the same, and a tag that
says `index` on a 404 is an ambiguity with no upside.

**Impact.** Low on Google, unquantified elsewhere, and it makes the checklist
item unverifiable as written — the box cannot honestly be ticked from this
output. Every route in the app also carries the redundant `index, follow`.

**Recommended fix.** Drop `robots` from `app/layout.tsx`'s metadata (the default
is already index/follow) and set `robots: { index: false }` only where it is
meant, as `app/(auth)/login/page.tsx:6` already does correctly. Add
`export const metadata = { title: 'Page not found' }` to `app/not-found.tsx`.

**Status:** OPEN — the checklist item *"`/nope` returns 404 with `noindex`"* is
**partially verified**: the 404 and the `noindex` are both present, the page is
not unambiguously `noindex`. The other half of that item, *"`/dashboard` still
307s to `/login`"*, is **VERIFIED** (`307` in 3 ms, `Location: /login`).

---

## C-4-20

```
[CLAUDE-4][MEDIUM][RESILIENCE/UX] The durable rate limiter fails closed, so a
Supabase outage makes 25 endpoints answer "Too many requests" — observed on the
first-ever contact-form submit from a fresh browser
File:     lib/server/rate-limit-db.ts:19-22, :36
          lib/server/request-rate-limit.ts:17-19
          app/api/contact/route.ts:19-24  (+ 24 other routes)
```

**Problem.** `rateLimitDb` returns `{ ok: failOpen }` whenever the
`rate_limit_hit` RPC errors, and `failOpen` defaults to `false`. Failing closed
is a deliberate, documented abuse-control choice and is not itself the finding.
The finding is the **answer it produces**: callers map `!ok` to `429 Too Many
Requests` with `Retry-After`, so "the limiter is unavailable" is reported to the
client, and to the logs, as "you are calling too often". The two need different
handling and are indistinguishable.

**Evidence.** A brand-new browser context, one contact form filled in and
submitted once — never having called anything:

```
REQ  POST http://localhost:3210/api/contact
RESP 429  http://localhost:3210/api/contact
CONSOLE[error] Failed to load resource: the server responded with a status of 429
```

and the same on the analytics beacon, which then logs a console error on every
public page view:

```
BAD 429 http://localhost:3210/api/mkt/track     (on /, /pricing, /features, /security,
                                                 /faq, /privacy, /mobile, /cookies,
                                                 /terms, /contact — 10 of 11 routes)
$ curl -sD- -X POST -d '{}' http://localhost:3210/api/mkt/track
HTTP/1.1 429 Too Many Requests
retry-after: 5
{"error":"Too many requests"}
```

The trigger here is the stub (`rate_limit_hit` cannot be reached), and in
production these would pass. That is exactly the point: **this is what the
production code does during a database incident**, and the incident is invisible
because it looks like traffic. 25 routes use `enforceRequestRateLimit`, among
them `/api/contact`, `/api/blog/subscribe`, `/api/push/subscribe`,
`/api/marketing/unsubscribe` and all four `/api/billing/*` endpoints — so during
an outage a customer trying to check out, and a recipient trying to unsubscribe,
are both told they are making too many requests.

**Impact.** Wrong status code (429 rather than 503) on a fail-closed path means
a client that honours `Retry-After: 5` hammers a database that is already down,
an incident is buried in what looks like rate-limit noise, and a first-time
visitor is told they are abusive. `/api/marketing/unsubscribe` answering 429 has
a compliance edge to it as well.

**Recommended fix.** Return a distinguishable outcome from `rateLimitDb` —
`{ ok: false, reason: 'limited' | 'unavailable' }` — and let callers answer
`503` with a longer `Retry-After` for `unavailable` while keeping `429` for real
throttling. Log the `unavailable` branch, which today is silent. Separately,
teach the client tracker to swallow a non-2xx so an analytics beacon does not put
an error in every visitor's console.

**Status:** OPEN

---

## C-4-21

```
[CLAUDE-4][MEDIUM][UX] The public marketing surface has no error boundary, no
not-found boundary and no loading boundary — the authenticated app has eighteen
Files:    app/(marketing)/**  (none of error.tsx / not-found.tsx / loading.tsx)
```

**Problem.**

```
$ find "app/(marketing)" -name error.tsx -o -name not-found.tsx -o -name loading.tsx
(nothing)

$ find app -name error.tsx -o -name not-found.tsx | wc -l
20          # app/error.tsx, app/not-found.tsx, and 18 under app/(app)
$ find app -name loading.tsx
app/(app)/loading.tsx
app/(app)/guardian/loading.tsx
```

Every marketing failure therefore falls all the way to the root boundaries, which
render **outside the marketing chrome** — no site header, no footer, no
navigation — and whose primary call to action is a button labelled *"Go to
Dashboard"* (`app/not-found.tsx:13`, `app/error.tsx:27`). For the signed-out
visitor who is the entire audience of a marketing 404, that button is a 307 to a
login form.

The missing `loading.tsx` matters more here than it normally would, because of
C-4-18: every marketing route is dynamic, so a client-side navigation cannot be
served from a prefetch and has nothing to show while the server renders. Measured
with the RSC navigation request the router actually issues:

```
$ curl -s -H "RSC: 1" -H "Next-Router-Prefetch: 1" ".../cookies?_rsc=probe1"
200  0.0069s  191 bytes      # prefetch is correctly short-circuited — cheap
$ curl -s -H "RSC: 1"        ".../cookies?_rsc=probe2"
200  14.08s   45876 bytes    # the real navigation; nothing renders until it lands
```

**Impact.** With a healthy database the navigation is fast and this is cosmetic.
With a slow one there is no feedback of any kind — the previous page simply sits
there — and any render error drops the visitor out of the site's own shell onto a
page offering them a dashboard they do not have. The asymmetry is the tell: the
authenticated app, which has a session and a way back, is boundaried everywhere;
the public funnel, which does not, is boundaried nowhere.

**Recommended fix.** Add `app/(marketing)/error.tsx` and
`app/(marketing)/not-found.tsx` that render inside `MarketingLayout` with
marketing-appropriate actions (home, blog, search, contact — not "Go to
Dashboard"), and an `app/(marketing)/loading.tsx` skeleton. Change the root
`not-found.tsx` / `error.tsx` CTA to `/` for an anonymous visitor.

**Status:** OPEN

---

## C-4-22

```
[CLAUDE-4][LOW][UX/SEO] Every public page's footer links to /dashboard/migrate,
which 307s every signed-out visitor and every crawler to /login
File:     components/marketing/site-footer.tsx:59
          app/(marketing)/security/page.tsx:247   (/dashboard/trust)
```

**Evidence.** `{ href: '/dashboard/migrate', labelKey: 'siteFooter.switchToBubaly' }`
appears in the footer of all fifteen public pages fetched this session
(`acceptable-use, ai, blog, contact, cookies, family-display, faq, features,
how-it-works, index, mobile, pricing, privacy, security, terms`), and:

```
307 /dashboard/migrate
307 /dashboard/trust
307 /display
```

`/login` is `robots: { index: false, follow: false }`, so a crawler following the
site's most-repeated internal link lands on a redirect to a noindex page from
every page on the site. "Switch to Bubaly" is a conversion CTA aimed at people
who do not yet have an account, pointing at a page only account holders can open.

**Impact.** Small but site-wide: a dead-end CTA for the audience it targets, and
the most frequently repeated internal link on the site is a redirect chain.

**Recommended fix.** Point the footer entry at a public marketing page about
migrating (or gate the link on a session, as the `/contact` page already does
correctly at `app/(marketing)/contact/page.tsx:56-85` — it renders `/feedback`
for signed-in visitors and `/login?redirect=%2Ffeedback` for everyone else, with
a line of copy explaining the hop). `/security`'s trust-centre CTA needs the same
treatment.

**Status:** OPEN

---

## C-4-23

```
[CLAUDE-4][LOW][UX] An error toast disappears after 4.2 seconds, which is the
only notification a failed sign-in, sign-up or contact submission produces
File:     components/ui/toast.tsx:60
```

**Evidence.** `setTimeout(() => setToasts(...), action ? 7000 : 4200)` — an error
with no action button is removed after 4.2 s. Observed on a failed sign-in: the
toast appears at **+353 ms** and is gone well before a user who looked away can
read it; twenty-five seconds after the same click there is no trace of the
failure anywhere on the page, and the form is back to its resting state as if
nothing had been submitted.

**Impact.** A visitor who blinks sees a sign-in button that did nothing. The
information needed to act ("network problem, try again") existed and expired.

**Recommended fix.** Do not auto-dismiss `tone === 'error'` toasts, or give them
a much longer timeout plus an explicit dismiss control. Errors on the auth forms
would be better rendered inline near the submit button, the way the existing
`authError` banner at `components/auth/login-form.tsx:69-73` already is.

**Status:** OPEN

---

## C-4-24

```
[CLAUDE-4][MEDIUM][PERF/RESILIENCE] Every public marketing render blocks on at
least two serial Supabase reads with no timeout, so public-page TTFB is coupled
1:1 to database latency and unbounded on a hang
File:     lib/marketing/seo.ts:87-88   (resolveMarketingMetadata -> getSeoPage)
          components/marketing/site-footer.tsx  (getCachedSocialLinks)
          lib/server/social-links.ts:72-79
```

**Problem.** A page as static as `/cookies` performs a `marketing_pages` lookup
for its metadata and an `app_settings` lookup for the footer's social links, in
series, on every request — because of C-4-18 there is no cached render to serve
instead. Neither read carries an `AbortSignal` or a timeout, so the render waits
as long as the connection does.

`getCachedSocialLinks` is otherwise carefully built — `unstable_cache` with a tag
so an admin save invalidates immediately, and the `catch` deliberately placed
**outside** the cache so a failure is not cached for an hour. That last decision
is correct and it has a cost the comment does not mention: nothing is stored on
failure, so during an outage **every single request retries**, at full failure
latency, rather than one request paying it.

**Evidence.** With Supabase unreachable, `curl` against the running build:

```
/               14.15s      /cookies       14.09s      /terms     14.11s
/pricing        21.13s      /privacy       14.43s      /contact   14.16s
/blog           14.09s      /sitemap.xml   22.14s
/login           0.034s     /nope           0.036s     /dashboard  0.003s
```

The pattern is a ~7 s unit: `/cookies` pays two, `/pricing` and `/sitemap.xml`
pay three. `/login` and `/nope` — which touch no marketing table — return in
milliseconds through the same middleware, which is what isolates the cost to the
page's own reads rather than to the session refresh. The server log carries a
`[social-links] cached read failed` and a `[marketing-aeo] … read failed` line
per marketing render.

**The wall-clock numbers are an artifact of the stub and are not production
latency.** What they establish is the *count* and *seriality* of the blocking
reads, and that no timeout bounds any of them.

**Impact.** The public marketing site — the acquisition funnel and the crawl
surface — has no independent availability from the database. A Supabase
slow-period does not degrade the homepage, it stops it, and with C-4-18 there is
no cached copy anywhere to serve in the meantime. The `/sitemap.xml` figure is
the crawler-facing version of the same.

**Recommended fix.** Fix C-4-18 first — a cacheable page removes most of this by
construction. Independently: put an `AbortSignal.timeout(...)` on both reads and
render the fallback (`{}` social links, catalogue-derived metadata) when it
fires; and give the *failure* path of `getCachedSocialLinks` a short negative
cache (30–60 s) so an outage costs one round trip a minute rather than one per
visitor — which keeps the property the current comment is protecting (a
recovering database is picked up quickly) without the property it accidentally
created.

**Status:** OPEN

---

## Checked in a browser and found healthy — recorded so it is not re-derived

Each of these was actively exercised this session, not inferred.

1. **No hydration mismatches, anywhere on the public surface.** Eleven routes,
   fresh context each, `load` plus a 4 s settle so effects and hydration
   complete. `pageerror` count: **0 on every route.** Console `error` count:
   **1 on each of ten routes, and it is C-4-20's 429 beacon in every case** —
   no React hydration warning, no `Text content did not match`, no
   `useLayoutEffect` warning, no CSP violation. This was the single most likely
   class of defect a static pass could not see, and it is not there.
2. **No broken internal links found on the reachable public surface.** 37 unique
   internal hrefs harvested from fifteen fetched pages; every one resolves 200
   except the three protected routes in C-4-22 (307) — no 404. *Partially
   BLOCKED:* the crawl could not reach any DB-driven link (blog posts, `/lp/*`,
   `/glossary/*`, `/guides/*`), because with the stub those lists render empty.
   The eight `[slug]`-only families (`/resources`, `/guides`, `/customers`,
   `/compare`, `/glossary`, `/alternatives`, `/audiences`, `/questions`) have no
   index page and answer 404 at the bare prefix — nothing currently links to
   them, but a future footer or breadcrumb entry would break silently.
3. **The 404 / redirect contract holds.** `/nope` 404; `/blog/this-post-does-not-exist`
   404; `/blog/%20bad%20slug` 404 (whitespace slug handled, not 500);
   `/blog/../../etc/passwd` 404 with no traversal; `/dashboard` 307 → `/login`;
   `/display`, `/dashboard/migrate`, `/dashboard/trust` 307 → `/login`.
4. **Login, signup and contact are correctly built.** All three validate on the
   client before any network call (`"Enter a valid email address"`,
   `"Enter your password"`, `"Please enter your name"`, `"Please add a little
   more detail"`), all three surface a real error rather than hanging, and login
   and signup disable the submit button for the duration of the request
   (`components/ui/button.tsx:35`, `disabled={disabled || loading}`) — a second
   click during flight does nothing. Measured on a failed sign-in: toast at
   **+353 ms**, `role="alert"`, text *"Network problem — check your connection and
   try again."* No unhandled rejection, no silent hang, no double POST. The only
   complaint is how quickly that toast leaves (C-4-23).
5. **RSC prefetch is not the storm it looks like.** Each marketing page fires
   10–13 `?_rsc=` requests that show as `ERR_ABORTED` in the network log, which
   reads like a prefetch stampede against 541 dynamic routes. It is not: a
   prefetch request (`Next-Router-Prefetch: 1`) returns **191 bytes in 6.9 ms**
   because Next short-circuits prefetch for a dynamic route with no loading
   boundary. Recorded because the hypothesis was wrong and someone else will
   form it too.
6. **Server-side error instrumentation works.** Every 500 this session produced a
   `[server-error] digest=… route=… (GET …, render) …` line naming the route, the
   digest and the underlying cause. The digest in the log matches the one
   `app/error.tsx:32` shows the user, so a support report can be traced to a log
   line. That is better than most codebases manage and is worth keeping.

## Re-verified Pass F findings (rule 4 — verified, not re-derived)

Checked against the working tree as it stands this session. All four are
**unchanged and still OPEN**; none is newly reported.

| | Claim | Verified |
|---|---|---|
| `F-F01` | caller-supplied `max` returns `error: null` | **Still present.** `lib/supabase/read-all.ts:93`: `if (options.max !== undefined) return { rows: rows.slice(0, options.max), error: null };`. Callers unchanged, and the blast radius is wider than Pass F's five: `grep -rn "{ max:" app/ lib/` returns **59** call sites, including `readAllAsQuery(..., { max: 20000 })` at `admin/wallet/reconciliation/page.tsx:23,28`, `{ max: 5000 }` at `economy/page.tsx:28`, and `api/ai/wallet`, `api/ai/wallet/child/[childId]`, `api/ai/habits`, five `api/cron/*` routes, `api/sync/feeds/[token]`, `admin/social/usage` and `admin/feedback`. Not every one of the 59 is a money read, but every one of them takes the `error: null` exit. |
| `F-F03` | `/missions` — up to 240 sequential storage round trips | **Still present.** `app/(app)/missions/page.tsx:70-77` still nests `for (const s of subs) { for (const path of …slice(0,4)) { await …createSignedUrl(path, 600) } }`. Not exercised in a browser — the page needs a session (BLOCKED). |
| `F-F05` | no `testTimeout` configured anywhere | **Still true.** `grep testTimeout vitest.config.ts` → no match. |
| `F-F12` | the vitest config's JSX block is dead under vitest 4 | **Still true, and now provably so.** `vitest.config.ts:5-14` sets `esbuild: { jsx: 'automatic' }` under a comment reading *"vitest 2.x / vite 5 transforms with esbuild… the `oxc` key only applies to vitest 3+/rolldown and is a no-op here"* — and the installed vitest is **4.1.10**, so the two keys have swapped roles and the comment now describes the opposite of the truth. |

## What this session could not see — BLOCKED, and not to be read as clean

- **Everything behind a session.** No Supabase, no sign-in, so `app/(app)` was
  never rendered in a browser. `F-F01`, `F-F02`, `F-F03`, `F-F08` and every
  Pass D finding about the authenticated app remain statically derived. C-4-16's
  proof on a *real* blog slug is blocked for the same reason.
- **Production.** All measurements are against the local production build on
  `:3210`. `F-C03`'s "20 KB in production" figure is not contradicted by
  C-4-14's 26,593 B here; they are different artifacts and nobody has measured
  the production one since.
- **Production latency.** Every wall-clock number above is inflated by the
  stub's DNS failures and is used only to count and order blocking reads.
- **Anything a real database populates.** Blog posts, landing pages, glossary and
  comparison pages, AEO question blocks and the marketing-page registry all
  render empty or throw. No empty list anywhere above is reported as a defect.
- **Accessibility.** Deliberately out of scope this session — Claude-2 owns
  contrast, tab order and focus on these same routes, and no finding above
  touches them.

---

> **Union of two parallel audit sessions.** Everything above is this
> session's record; everything below arrived on `main` from the session
> that ran alongside it. Neither side is edited or dropped — rule 2 applies
> across sessions as much as within one.

---

### [CLAUDE-4][HIGH][INTEGRATION] With `RESEND_API_KEY` unset every email reports success, and notification rows are marked delivered forever

- **File/path:** `lib/email.ts:48-51`; `lib/server/notification-emails.ts:100-115`;
  `lib/health/status.ts:21-25,68-75`; the seven other `sendReactEmail` call sites
- **Problem:** `sendReactEmail` short-circuits when the key is absent and returns
  **`{ ok: true, skipped: true }`**:

      if (!emailEnabled()) {
        console.info(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
        return { ok: true, skipped: true };
      }

  The `skipped` flag exists precisely so a caller can tell "sent" from "not sent". **No caller reads
  it.** Every one of the nine call sites destructures `{ ok }` only, and two ignore the result
  entirely. So a deployment missing one env var has every email path report success.

  `RESEND_API_KEY` is in neither health tier — not `REQUIRED_ENV` (correct, it must not 503) and not
  the `FEATURE_ENV` tier Claude-1 added for exactly this failure shape. It is the seventh secret of
  that kind and the one that got missed.

- **Evidence:**

      $ grep -rn "sendReactEmail(" app/ lib/ --include=*.ts --include=*.tsx | grep -v '\.test\.'
      app/api/cron/weekly-digest/route.ts:93:    const { ok } = await sendReactEmail({
      app/api/cron/chore-reminders/route.ts:119:  const { ok } = await sendReactEmail({
      app/api/email/welcome/route.ts:27:          const { ok } = await sendReactEmail({
      app/api/email/invite/route.ts:35:           const { ok } = await sendReactEmail({
      app/(app)/admin/actions.ts:349:            const { ok } = await sendReactEmail({
      app/(app)/referrals/actions.ts:81:          const { ok } = await sendReactEmail({
      app/onboarding/actions.ts:575:                  await sendReactEmail({     <- result discarded
      app/onboarding/actions.ts:750:                  await sendReactEmail({     <- result discarded
      lib/server/notification-emails.ts:100:      const { ok } = await sendReactEmail({

      $ grep -rn "skipped" app/ lib/ --include=*.ts | grep -v '\.test\.' | grep sendReactEmail
      (no output — nothing destructures it)

      $ sed -n '21,25p;68,75p' lib/health/status.ts
      export const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY']
      export const FEATURE_ENV  = ['CRON_SECRET','CHILD_LOGIN_SECRET','INTERNAL_SECRET',
                                   'CONTACT_CENTER_INBOUND_SECRET','MARKETING_UNSUB_SECRET','GUARDIAN_INTERNAL_SECRET']
      # RESEND_API_KEY is in neither list.

  The consequence in `lib/server/notification-emails.ts` is not a missed send but a destroyed one:

      :105  if (ok) { sent++; resolvedIds.push(...ids); } else { failed++; }
      :114  await supabase.from('notifications').update({ sent_at: nowIso }).in('id', resolvedIds);

  `ok` is true, so every pending notification is stamped `sent_at = now()`. `sent_at` is the
  already-handled marker, so those rows are **never selected again**.

- **Impact:** One unset variable and:
  - every family notification email is permanently marked delivered and never sent, with no retry;
  - `/api/cron/notifications` answers 200 with `emailed: N, emailFailures: 0` — a fabricated number
    that looks healthier than a real run;
  - the weekly digest reports `sent: <every family>, failed: 0`;
  - `/api/email/invite` answers `{ sent: true }` 200, so the invite UI says the invite went out;
  - `/api/health` says `ok`.

  Every signal a deployment has agrees that email is working. This is the same failure Claude-1 closed
  for `CRON_SECRET` — with the difference that a 401'd cron leaves the data intact and retries next
  night, while this one writes `sent_at` and is unrecoverable per row.
- **Recommended fix:** three parts, smallest first.
  1. Add `RESEND_API_KEY` to `FEATURE_ENV` in `lib/health/status.ts`, so a deployment without it
     reports `degraded`/200 instead of `ok`. One line; the tier already exists.
  2. Make `notification-emails.ts` treat `skipped` as not-sent: `if (ok && !skipped)` before pushing
     into `resolvedIds`, leaving `sent_at` null so the next run retries once the key is configured.
     Count it in a third bucket so `emailSkipped` in `/api/cron/notifications` is truthful.
  3. Consider inverting the default in `lib/email.ts`: `ok: false, skipped: true`. The current
     signature was chosen so "local/dev flows never break", which is right, but it makes the safe
     local default the dangerous production default. If it stays, every caller must read `skipped`.
  Prove load-bearing by clearing the env var and asserting `notifications.sent_at` stays null.
- **Status:** OPEN

### [CLAUDE-4][HIGH][FLOW] A family can be left with zero managers, and nothing can restore one

- **File/path:** `components/modules/family-module.tsx:255-266` (the per-member Edit/Remove menu),
  `:499-548` (`MemberModal`), `:94` (`ROLE_OPTIONS`);
  `supabase/migrations/0003_functions_triggers.sql:22-29` (`can_manage_family`);
  `supabase/migrations/0211_family_members_update_rls.sql`
- **Problem:** The Family screen shows an Edit/Remove menu on **every** member card whenever
  `canManage`, with no exclusion for the signed-in user and no check on how many managers remain.
  `MemberModal`'s role `<Select>` offers all six roles including `child`, and both actions are direct
  browser PostgREST writes. So the only manager of a family can, in two clicks, either deactivate
  themselves or set their own role to `child`.

  Once that lands, `can_manage_family(family_id)` is false for everyone in the family, and it is the
  `USING` **and** `WITH CHECK` clause of `fm_update`, `fm_insert` and `fm_delete`. Nobody can promote
  anyone, add anyone, or reactivate anyone. There is no unwind.

- **Evidence:**

      components/modules/family-module.tsx:263
        <button onClick={() => { setMenuId(null); setEditMember(m); setAddOpen(true); }}>Edit</button>
      components/modules/family-module.tsx:264
        <button onClick={() => { setMenuId(null); setRemoveMember(m); }}>Remove</button>
      -- rendered inside `visibleMembers.map(...)` under `{canManage && ...}`; `m` is every member,
      -- self included. Contrast `components/modules/settings-module.tsx:355`, which does exclude
      -- self: `{admin && m.user_id !== userId && (<button onClick={() => removeMember(m.id)} ...`
      -- Two screens remove members; only one of them thought about this.

      components/modules/family-module.tsx:94
        const ROLE_OPTIONS: MemberRole[] = ['parent','adult','teen','child','caregiver','guest'];
      components/modules/family-module.tsx:520
        await sb.from('family_members').update(payload).eq('id', member.id)   // payload.role

      supabase/migrations/0003_functions_triggers.sql:22
        create or replace function public.can_manage_family(p_family_id uuid) ... select exists (
          select 1 from public.family_members
          where family_id = p_family_id and user_id = auth.uid()
            and role in ('parent','adult') and is_active );

  Nothing guards the count. Verified by searching every layer that could:

      $ grep -rni "last manager|last parent|only manager|at least one manager|sole manager" \
          app/ lib/ components/ supabase/migrations/
      (3 hits, all unrelated comments about manager-only writes; no guard)

      $ grep -rn "on public.family_members" supabase/migrations/*.sql | grep -i trigger
      (no output — family_members carries no trigger at all)

  Both self-demotion and self-removal pass RLS: `can_manage_family` is a `stable` `security definer`
  function, so within the statement it reads the pre-update snapshot in which the caller is still a
  manager. The two-manager case needs no such reasoning — A demotes B (plainly allowed), then A
  demotes A.

- **Impact:** The family is permanently frozen in a half-working state. `is_family_member` also
  requires `is_active`, so a manager who removes themselves loses the family outright — every read
  returns zero rows. What stays broken for everyone else: no reward redemption can be approved
  (0295's trigger requires `can_manage_family`), no wallet funding or allowance change (0217/0218),
  no member added or edited, no invite sent, no family settings changed. Children keep signing in to
  a household nobody can administer. Recovery requires a Super Admin or direct database access — and
  since F-001 blocks schema access in production, the operator path is the only one.
- **Recommended fix:** a database-level guard, because both write paths are unguarded browser writes
  and a client check would be bypassed by the same PostgREST call the UI makes. Add a
  `before update on public.family_members` trigger that raises `42501` when the statement would leave
  the family with zero rows matching `role in ('parent','adult') and is_active` — the shape 0295's
  redemption guard already uses, so it has a precedent and a probe pattern to copy. Then hide the
  affordance too: exclude self from the Remove menu as `settings-module.tsx:355` already does, and
  disable the `parent`/`adult` -> other-role transition in `MemberModal` when this is the last
  manager. Add `docs/audit/last-manager-check.sql` asserting both directions (the last manager is
  blocked; a manager with a co-manager is not) so `run-probes.sh` picks it up by glob.
- **Status:** OPEN — established from source and the RLS/function definitions. No live database in
  this sandbox to execute the transition against.

### [CLAUDE-4][MEDIUM][BROKEN FEATURE] The Family screen tells users to share a family code, and nothing in the product redeems one

- **File/path:** `components/modules/family-module.tsx:182-183,388-391,447,588-602`;
  `lib/i18n/messages/en-US.json:4802`; `supabase/migrations/01100_family_profile.sql:19-42`
- **Problem:** `families.family_code` is generated and uniquely indexed by `01100`, rendered on the
  Family screen, copyable to the clipboard, and is the entire content of the **Invite Family** modal.
  The English string is explicit: *"Share your family code so a new member can join, or manage invites
  in Members."* No route, server action, RPC, or migration function anywhere reads `family_code` as an
  input. The only working join path is `/join?token=…` -> `rpc('accept_invite', p_token)`, which
  matches `invites.token` — a DB-generated per-invite token with no relationship to the family code.
- **Evidence:**

      $ grep -rn "family_code" app/ lib/ components/ supabase/ scripts/ mobile/ \
          --include=*.ts --include=*.tsx --include=*.sql --include=*.mjs | grep -v database.types
      # every hit is a WRITE, a DISPLAY, or the migration that creates it:
      components/modules/family-module.tsx:183  navigator.clipboard.writeText(family.family_code)
      components/modules/family-module.tsx:389  <p ...>{family?.family_code ?? '—'}</p>
      components/modules/family-module.tsx:447  <InviteModal code={family?.family_code ?? null} .../>
      supabase/migrations/01100_family_profile.sql:19-42   add column + backfill + unique index
      # zero reads of it as an input. No `.eq('family_code', …)`, no RPC parameter.

      $ grep -n -A12 "function public.accept_invite" supabase/migrations/0005_rpcs.sql
      create or replace function public.accept_invite(p_token text) ...
        select * into v_invite from public.invites
        where token = p_token and status = 'pending' and expires_at > now() for update;

  The contrast inside the same repository settles it: `marketplace_circles.join_code` — the same idea,
  for circles — **does** have a redemption path, at
  `supabase/migrations/0176_marketplace_circles.sql:177`: `where join_code = upper(trim(p_code))`.
  Someone built the code-redemption RPC for circles and never for families.
- **Impact:** The most prominent invite affordance on the Family screen hands the user a string that
  nothing can consume. Whoever receives it has nowhere to type it — `/join` reads only `?token=`, and
  entering a code produces "This invite link is missing its token." The working path exists but is the
  secondary link in the same modal ("Manage Members & Invites"), so the failure is a confident
  wrong answer rather than a missing feature. Not higher than MEDIUM only because a working path is
  one click away.
- **Recommended fix:** decide one way and make the screen agree. Either add the redemption —
  a `join_family_by_code(p_code text)` RPC mirroring `0176`'s, plus a code field on `/join` — or drop
  the code from the invite modal and make Invite Family open the email invite form directly. The
  current middle state is the only option that misleads. Whichever is chosen, the guard should be a
  test asserting that every code the UI displays has a consumer, so this cannot recur for the next
  code-shaped column.
- **Status:** OPEN

### [CLAUDE-4][MEDIUM][FLOW] The invite email result is discarded, the success toast is unconditional, and there is no resend or copy-link

- **File/path:** `components/family/invite-form.tsx:113-121`;
  `components/modules/settings-module.tsx:417`; `app/api/email/invite/route.ts:44`
- **Problem:** `/api/email/invite` is careful — it answers **502** when the provider rejects the send.
  The client throws that away:

      void fetch('/api/email/invite', { method: 'POST', ... });   // response never read
      setLoading(false);
      onSent();                                                    // -> success('Invite sent')

  There is no pending-invite list on any family-facing screen, no resend button, and no way to see or
  copy the token. `invites` rows are listed only under `/admin/users`, which is Super Admin only.
- **Evidence:**

      $ grep -rn "invite" "app/(app)/family/members/" -i
      app/(app)/family/members/page.tsx:36:   <Settings .../> {t('familyMembers.manageInvite')}    # a link, not a list

      $ grep -rn "from('invites')" app/ lib/ components/ --include=*.ts --include=*.tsx | grep -v '\.test\.'
      components/family/invite-form.tsx:104   insert                       <- the only family-facing write
      app/(app)/admin/*                       list / resend                <- Super Admin only
      # no family-facing read of `invites` anywhere.

  Combined with the previous finding, this compounds: with `RESEND_API_KEY` unset the route answers
  `{ sent: true }` 200 and there is nothing to discard, so even a client that *did* read the response
  would be told the invite went out.
- **Impact:** An invite that fails to send is indistinguishable from one that succeeded, from the
  inviter's side and from the product's. The invitee waits for an email that will never arrive; the
  inviter has no list showing a pending invite, no resend, and no link to hand over another way. The
  family-growth flow — the one journey that turns a single account into a household — has no
  user-recoverable failure path.
- **Recommended fix:** await the fetch and branch on the status: on 502 keep the modal open and offer
  Retry plus a copyable `/join?token=…` link built from the row that was already inserted. Add a
  pending-invites list to the members screen (email, role, sent-at, expiry, resend, revoke), reading
  `invites` scoped to the family. The admin console already has all of this; the family does not.
- **Status:** OPEN

---

## Session 3 closing note (Sonnet relaunch, 2026-09-14)

No new CRITICAL/HIGH defect surfaced this session that isn't already recorded
above or in `finalaudit.md` Pass F-K. That is reported plainly rather than
padded out, per the brief's own instruction that a clean pass is a valid
result when the examined ground is recorded.

What this session adds on top of sessions 1-2: a third independent vacuous-test
sweep (different heuristics — commented-out `expect(`, a flat one-assertion-
per-`it` scan, a `when others` re-grep against all 22 `docs/audit/*.sql` files
rather than the 16 session 2 counted) converges on the same small set of real
instances session 2 already found and Claude-1 already fixed (G1/Pass F-F06),
plus two new files worth naming for how they resist the class on purpose:
`tests/paid-features-enforced-server-side.test.ts` strips comments before
matching source *and cites F11 by name* as the reason, and
`docs/audit/family-credentials-boundary-check.sql` /
`sensitive-role-boundary-check.sql` carry G1's `insufficient_privilege`
narrowing already, with the broad `when others` surviving only inside an
explanatory comment. Read together with sessions 1-2, this is now reasonably
strong evidence that "the guard that cannot fail" is a contained, catalogued
class in this repository rather than a systemic one — real, found, mostly
fixed, and the test-authors have visibly started writing the next guard
defensively against it.

The five items already on record above as OPEN (F-F01 caller-`max` truncation,
F-F02 Greenwich-day survivors incl. `kids/page.tsx`, RESEND_API_KEY absent from
FEATURE_ENV, the family-code dead invite affordance, the zero-managers
lockout) were each re-checked against the current tree in this session and are
still open — see the STATUS block at the top of this file for the exact
grep/read that confirmed each.

---

# Session 4 (2026-09-15) — inside the authenticated app

## SESSION 4 STATUS

*(Appended. The STATUS block at the top of this file is Session 3's and is left
byte-for-byte intact, per the charter's rule 1 — "append; never delete or
rewrite". Claude-1: this block is the current one.)*

CURRENT: Session 4. Scope as briefed — a **static flow and state audit of
`app/(app)`**, going after the classes a browser would not have shown anyway.
No sign-in was attempted: there is no local Supabase in this sandbox (no docker
daemon, no CLI), so no session can exist. That is stated, not worked around.

HEADLINE: **the `readAll` contract was fixed and 13 of its 59 call sites were
not migrated to it.** `lib/supabase/read-all.ts` now reads one row past the
caller's `max` and returns an ERROR when rows remain (commit `f462cc7e`,
2026-09-14) — so `F-F01`'s mechanism is closed at the helper. But
`readAllAsQuery` answers a truncated read with `data: null`, and thirteen call
sites destructure only `{ data }`. Those sites used to render a **prefix**; they
now render **zero**. For a money total, a count, or an AI coaching prompt, zero
is a more confident lie than a prefix was. Proven by execution, not inferred —
see C4-S4-01.

METHOD (what was executed vs. what is static):
  - EXECUTED: `npx vitest run tests/supabase-read-all.test.ts` → 19 passed,
    877ms. The helper's new contract holds.
  - EXECUTED: a purpose-built reproduction in the scratchpad, run against the
    REAL `lib/supabase/read-all.ts` through an isolated vitest config (the
    repo's own config restricts `include` to `tests/**`, and this session writes
    nothing into the repo). 2 passed. It shows a call site that destructures
    only `{ data }` computing a total of **0** from a 3,001-row table read with
    `{ max: 3000 }`, and the correct 299900 when the table fits. That is the
    exact shape of `app/api/ai/wallet/route.ts:56-61`.
  - STATIC: everything else. Every route-tree count, every call-site reading,
    every N+1 and every sequential-await count below is read from source. Where
    a claim is an inference about runtime behaviour it says so in the finding.

FILES-EXAMINED (session 4): `lib/supabase/read-all.ts`, `lib/supabase/settle.ts`,
  all 42 files containing a `readAll`/`readAllAsQuery` call (59 call sites),
  `app/(app)/home/page.tsx`, `app/(app)/missions/page.tsx`,
  `app/(app)/dashboard/journeys/page.tsx`,
  `app/(app)/admin/wallet/{page,reconciliation/page}.tsx`,
  `app/(app)/marketplace/{insights,questions,page,creators,collections}.tsx`,
  `app/(app)/wallet/{activity,treasury,send}/page.tsx`,
  `app/(app)/dashboard/{family-digital-twin,playbook,migrate}/*actions.ts`,
  `app/api/ai/wallet/route.ts`, `app/api/ai/wallet/child/[childId]/route.ts`,
  `app/api/sync/feeds/[token]/route.ts`, `app/api/cron/family-routines/route.ts`,
  `app/(app)/money/actions.ts`, `app/(app)/family/child-login-actions.ts`,
  `components/wallet/money-cards-view.tsx`, `components/modules/home-module.tsx`,
  `components/modules/habits-module.tsx`, `components/ui/partial-read-banner.tsx`,
  `lib/{marketplace/matches-server,feedback/github-sync,operating-index/server,
  intelligence/hard-signals-server,finance/timeline-load,metric/strategy-server,
  network/benchmarks-server,twin/project-server,reasoning/context,
  marketing/customers,autopilot/scan,autopilot/policy-scan,i18n/server,
  auth/child-throttle,storage/documents,metric/time-saved-server,
  metric/value-server}.ts`, `tests/no-limit-above-the-row-cap.test.ts`,
  `tests/supabase-read-all.test.ts`, `tests/read-all-pages.test.ts`,
  the full `app/(app)` route tree (354 `page.tsx`, 20 `layout.tsx`).

BLOCKERS: no authenticated session is possible here — permanent in this
  environment. Every claim about what a page *renders* is therefore a reading of
  the JSX given a state I proved reachable, not a screenshot.

LAST-UPDATE: 2026-09-15

---

## C4-S4-01

```
[CLAUDE-4][HIGH][QA/MONEY] The readAll contract was fixed; 13 of its 59 call sites
were not migrated, so a read past its own ceiling now renders ZERO rather than a
prefix — and those sites render totals, counts and AI prompts from it
File:     lib/supabase/read-all.ts:106-117  (the fixed helper)
          13 call sites listed below
Status:   OPEN — new this session; supersedes the call-site half of F-F01
```

**What changed under the call sites.** `F-F01` said `readAll` returned
`{ rows: slice(0, max), error: null }` on a caller ceiling. That is no longer
true at `HEAD`. The helper now reads one row *past* the ceiling and distinguishes
the two cases:

```ts
// lib/supabase/read-all.ts:80
const probe = ceiling + 1;
...
if (options.max !== undefined) {
  return { rows: rows.slice(0, ceiling), error: { message:
    `readAll reached the caller's max of ${ceiling} rows and more remain. ` +
    'These rows are a PREFIX, not the whole set — treat this as a failed read, ' +
    'or raise the max.' } };
}
```

and `readAllAsQuery` converts that into the shape a batch consumes:

```ts
// lib/supabase/read-all.ts:150
if (error) return { data: null, count: null, error };
```

`data: null`. Not a short array — **null**. So the failure mode flipped: a site
that reads `(data ?? [])` used to get `max` rows and now gets `[]`.

**Evidence (executed).** Against the real module, through an isolated vitest
config so nothing is written into the repo:

```
$ npx vitest run --config <scratchpad>/vitest.audit.config.mjs
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

```ts
// 3,001 rows against the { max: 3000 } that app/api/ai/wallet/route.ts uses
const { data: txns } = await readAllAsQuery(table(3001), { max: 3000 });
expect(txns).toBeNull();                                     // passes
expect((txns ?? []).reduce((s, t) => s + t.amount_cents, 0)).toBe(0);  // passes
// and with 2,999 rows the same expression yields the true 299900
```

The repo's own guard already states this contract:
`tests/supabase-read-all.test.ts:207` — *"honours a ceiling, and reports null
data when the read was truncated"*. 19/19 green, run this session. The helper is
correct and well tested. The call sites are the gap.

**The full 59-site census.** I classified every call site by whether the `error`
the helper returns is consumed. 46 consume it; 13 do not:

| # | Call site | What it feeds | Consumes `error`? |
|---|---|---|---|
| 1 | `app/api/ai/wallet/route.ts:61` | child wallet balances → AI coaching prompt | **NO** |
| 2 | `app/api/ai/wallet/child/[childId]/route.ts:72` | one child's balance → AI coaching prompt | **NO** |
| 3 | `app/(app)/dashboard/family-digital-twin/actions.ts:80` | `spentCents` → "can we afford this?" verdict | **NO** |
| 4 | `app/(app)/dashboard/family-digital-twin/actions.ts:137` | same, activity path | **NO** |
| 5 | `app/(app)/dashboard/journeys/page.tsx:28` | 3 funnel stat tiles | **NO** (see C4-S4-05) |
| 6 | `app/api/sync/feeds/[token]/route.ts:60` | the published ICS calendar body | **NO** (see C4-S4-06) |
| 7 | `app/(app)/marketplace/insights/page.tsx:50` | active-listing / category / demand-gap counts | **NO** |
| 8 | `app/(app)/marketplace/insights/page.tsx:52` | saves-per-listing counts | **NO** |
| 9 | `app/(app)/marketplace/insights/page.tsx:53` | open-offer counts | **NO** |
| 10 | `app/(app)/marketplace/questions/page.tsx:29` | the listing-title lookup every question renders | **NO** |
| 11 | `app/(app)/dashboard/playbook/playbook-actions.ts:58` | meal-frequency signals | **NO** |
| 12 | `app/(app)/dashboard/playbook/playbook-actions.ts:73` | grocery-frequency signals | **NO** |
| 13 | `app/(app)/dashboard/playbook/playbook-actions.ts:94` | annual-tradition detection | **NO** |
| 14 | `lib/marketplace/matches-server.ts:48` | the match strip (and its persisted snapshot) | **NO** |
| 15 | `lib/feedback/github-sync.ts:64` | the reconcile map (see C4-S4-13) | **NO** |

*(15 rows, 13 distinct sites plus the two extra `insights` reads; 8 distinct files.)*

The other 46 consume it properly, via one of four in-repo patterns — and this is
why the fix is cheap: **the remedy already exists here, four times over**:

- a fatal `readError` + `<ErrorState>` — `admin/wallet/reconciliation/page.tsx:31`,
  `admin/feedback/page.tsx:40`, `admin/marketing/affiliates/page.tsx:34`,
  `admin/social/usage/page.tsx:37`, `economy/page.tsx:39`;
- `PartialReadBanner` with a per-table failure list —
  `admin/wallet/page.tsx:39-78`, `admin/system/page.tsx:64-102`
  (`components/ui/partial-read-banner.tsx` returns `null` on an empty list, so
  it costs nothing when everything read);
- a `dataWarnings: string[]` note under the content — `wallet/treasury/page.tsx:49-54`
  rendered at `:124`, and the same in `wallet/activity` and `wallet/send`;
- a `ServiceResult` failure — `lib/intelligence/hard-signals-server.ts:57`,
  `lib/operating-index/server.ts:86`, `lib/finance/timeline-load.ts:184`,
  `lib/twin/project-server.ts:106`, `lib/autopilot/{scan,policy-scan}.ts`.

**Impact.** Ranked by what the site claims:

- Sites 1-4 are **money**. A family past the ceiling is told its children have
  **$0.00**, and that number is then fed to an LLM that writes coaching prose
  about it, or to a simulator that answers "does this purchase fit the budget?".
  See C4-S4-02 and C4-S4-03.
- Sites 5, 7-9 render **counts**. `marketplace/insights`' own comment says
  *"Every figure on this page is a count over these rows, so a capped read is a
  wrong number rather than a short list"* — and then the destructure at `:46` is
  `[{ data: listings }, { data: saves }, { data: offers }]`, with no `error`
  anywhere in the file. The page renders "0 active listings · 0 categories · 0
  demand gaps" and the reassuring copy "Supply is keeping up with requests".
- Site 6 publishes a **calendar** (C4-S4-06).
- Sites 11-13 silently drop the evidence a playbook suggestion is built from, so
  the playbook offers fewer suggestions and says nothing about why.
- Site 14 returns `[]` from `computeMatches([])` and exits before its upsert, so
  the strip shows "no matches" — no write damage, but a false empty.

**Why this is worth ranking above every missing loading state.** The ceilings are
2,000-20,000 rows. A household does not hit 3,000 wallet transactions quickly,
but `wallet_transactions` is append-only and every allowance run, chore reward,
transfer and reversal adds rows — so this is a defect that arrives with tenure,
on exactly the families with the most money in the product, and it arrives
silently. There is no error page, no log line at sites 1-4 and 7-14, and no
degraded-view banner. The only symptom is a wrong number rendered confidently.

**Fix.**
1. Thirteen call sites: adopt whichever of the four in-repo patterns fits.
   For sites 1-4 (money + AI) the correct answer is to **fail**, not degrade:
   coaching computed over a read the system knows is incomplete should not be
   generated at all. Sites 7-10 should use `PartialReadBanner`.
2. Add the companion guard the repo is missing.
   `tests/no-limit-above-the-row-cap.test.ts` is an excellent source-scanning
   guard — it forbids `.limit(n > 1000)` across `app/` and `lib/`, and it carries
   a real non-vacuity case (`it('recognises an over-cap limit when it sees one')`,
   five positive and negative assertions). It enforces the *shape* of the read.
   Nothing enforces that the read's *error* is consumed. A sibling scan —
   "every `readAll`/`readAllAsQuery` call site must bind `error` (directly, or
   positionally into a batch whose `.error` is inspected)" — would have caught
   all thirteen and will hold the line afterwards. It is the same technique, in
   the same file style, on the same call-site set.

**Note for Claude-1 (rule 4).** `finalaudit.md:264` still lists `F-F01` as OPEN
with the old mechanism ("a caller-supplied `max` truncates a money read and
reports success; reconciliation renders 'Everything reconciles' from a prefix").
That half is **FIXED**: `admin/wallet/reconciliation/page.tsx:31-44` now returns
`<ErrorState>` before `reconcileLedger` is ever called, so the "Everything
reconciles" copy is unreachable on a truncated read. The finding should be
re-scoped to the call-site half above rather than closed or left as written.

---

## C4-S4-02

```
[CLAUDE-4][HIGH][MONEY] The AI Money Coach computes every child's balance as $0.00
when the ledger read exceeds its ceiling, and writes coaching prose about it
File:     app/api/ai/wallet/route.ts:56-92
          app/api/ai/wallet/child/[childId]/route.ts:67-...
Status:   OPEN
```

**Problem.** The route reads the family's whole ledger through `readAllAsQuery`
with a comment that states the stake exactly:

```ts
// app/api/ai/wallet/route.ts:58-61
// Money, so a quietly truncated read is a wrong balance, not a short
// list. `.limit(3000)` never was 3,000 — PostgREST caps at db-max-rows.
const [{ data: childWallets }, { data: buckets }, { data: txns }, { data: members }, { data: goals }] = await settleAll([
  ...
  readAllAsQuery((from, to) => supabase.from('wallet_transactions')...range(from, to), { max: 3000 }),
```

The destructure takes `data` and nothing else. No `error` is bound anywhere in
the file for this batch. Past 3,000 rows, `txns` is `null`, and:

```ts
for (const t of txns ?? []) { ... }                       // iterates nothing
const children = (childWallets ?? []).map((cw) => {
  const entries = entriesByChild.get(cw.id) ?? [];         // []
  return { ..., totalCents: balanceFromLedger(entries),    // 0
            saveCents: bucketBalances(entries).save };     // 0
});
```

Every child's `totalCents` and `saveCents` is 0, and `weeksToGoal(saved, target,
0)` is computed from a weekly contribution rate of 0. Those numbers go straight
into `buildWalletCoachPrompt({ children, goals, familyName })` and out to the
model, which is asked to coach a family whose children it has been told have
nothing saved and are contributing nothing.

**Evidence.** Executed — see C4-S4-01's reproduction: `readAllAsQuery(3001 rows,
{ max: 3000 })` returns `data: null`, and the reduce over `data ?? []` is `0`.
The rest is a reading of this file; there is no `error` identifier bound to this
batch anywhere in it (`grep -n "\.error" app/api/ai/wallet/route.ts` returns
only `console.error` and the JSON `error:` response keys).

**Impact.** The product's money surface is where the audit has repeatedly found
its worst class, and this is that class with a language model bolted on: not a
wrong number on a page a parent can sanity-check against another page, but a
*paragraph of advice* generated from the wrong number, in the product's own
voice, charged against the family's AI quota, and recorded through
`withAiRequest` as a successful run. A parent reading "none of your children are
saving anything — here is how to start" has no way to tell it came from a failed
read.

**Fix.** Bind the error and return a 502 with the existing
`tr('wallet.couldNotGenerateCoachingRight')` copy, which the route already uses
at `:112` for the analogous "the model gave us nothing" case. Coaching over a
ledger the system knows it could not finish reading should not be generated.
Same change in the per-child route.

---

## C4-S4-03

```
[CLAUDE-4][HIGH][MONEY] The Decision Simulator reports a budget as untouched when
the spend read fails, so "can we afford this?" answers yes on no evidence
File:     app/(app)/dashboard/family-digital-twin/actions.ts:80-85, 137-141
Status:   OPEN
```

**Problem.** Both simulator paths compute the category's spend-to-date and hand
it to `simulateDecision` as the budget's consumed amount:

```ts
// actions.ts:80-85
const { rows: tx } = await readAll((from, to) => supabase
  .from('transactions').select('amount').eq('family_id', familyId)
  .eq('type', 'expense').ilike('category', escapeLike(b.category)).gte('date', start)
  .order('id').range(from, to), { max: 2000 });
const spentCents = Math.round((tx ?? []).reduce((s, t) => s + Number(t.amount ?? 0), 0) * 100);
budgets = [{ category: b.category, limitCents: ..., spentCents }];
```

`readAll` returns `{ rows, error }`. Only `rows` is bound. `readAll`'s `rows` is
a real array, so on a *transport* failure it is the partial prefix collected
before the failure, and on a *ceiling* breach it is exactly `max` — either way
`spentCents` understates, and in the transport case it can be near zero while
the simulator is told the budget is nearly untouched. Identical code at `:137`.

**Impact.** This is the "what-if" surface — a parent asks whether a purchase
fits, and the answer is the difference between `limitCents` and a `spentCents`
the code has no basis for. It is a *recommendation*, which is worse than a
display bug: the family acts on it. The module header says "All reads are
family-scoped via the RLS client; nothing is written — this is a safe 'what-if'
that never touches live data" — safe with respect to writes, but the reasoning
about reads never happened.

**Evidence.** Static reading of the two blocks; `grep -n "error" ` over the file
shows the only `error` bindings are for the two `settle`d calendar/vacation reads
at `:117`/`:123` and the two write paths at `:172`/`:182`. The two `readAll`
results are the only reads in the file whose error is never bound.

**Fix.** Bind `error`; return the existing
`{ ok: false, error: ... }` shape the file already uses at `:108` and `:172`
rather than simulating over an unknown budget. The simulator's honest answer
when it cannot read the spend is "I could not check", which it has no way to say
today.

---

## C4-S4-04

```
[CLAUDE-4][HIGH][FLOW] "Issue cards for everyone" discards every result and reports
a count it never verified — in payment-card issuance
File:     components/wallet/money-cards-view.tsx:92-100
Status:   OPEN
```

**Problem.** Four of the five `issueCardAction` call sites in this codebase check
the result. The bulk one does not:

```tsx
// components/wallet/money-cards-view.tsx:92-100
async function issueAllVirtual() {
  setBusy('issue-all');
  for (const child of childrenWithoutCards) {
    await issueCardAction({ childWalletId: child.id, type: 'virtual',
                            spendLimitCents: null, spendWindow: 'per_authorization' });
  }
  setBusy(null);
  success(`Issued ${childrenWithoutCards.length} virtual card${childrenWithoutCards.length !== 1 ? 's' : ''}!`);
  router.refresh();
}
```

Compare the single-child version **eight lines above it**, in the same component:

```tsx
// :83-90
const res = await issueCardAction({ childWalletId, ... });
setBusy(null);
if (!res.ok) return toastError(res.error);
success(t('moneyCardsView.virtualCardCreated'));
```

and `toggleFreeze` at `:102`, `startSetup` at `:75`, and the physical-card modal
at `:400` — all three check `res.ok`. Only the bulk path does not.

**What is being discarded.** `issueCardAction`
(`app/(app)/money/actions.ts:109-160`) is a careful function. It returns a
typed failure for: a non-manager caller, Issuing not enabled on the platform,
`card_issuing_enabled` false on the connected account ("Finish account setup
first"), the child wallet not found, a **Trust Engine denial**
(`Blocked by household policy: ${decision.reason}`), a failed cardholder read,
and any Stripe exception via `actionFailure('issue the card', ...)`. Every one of
those is thrown away here, and the toast says "Issued 3 virtual cards!".

**Impact.** The parent is told three children hold spending cards. They do not.
The most likely real-world trigger is the most damaging one: `card_issuing_enabled`
false, or a Trust policy the household itself configured denying `finances/create`
— i.e. the two cases where the product is *deliberately* refusing, and the UI
reports the refusal as a success. `router.refresh()` immediately re-renders the
list from the server, so the cards visibly do not appear, leaving the user with a
success toast and an unchanged screen and no stated reason. This is the repo's
"optimistic UI that lies" class at its highest stake — a payment instrument.

Secondary: the loop is serial, so N children cost N sequential Stripe round
trips with no progress indication beyond a single `busy` flag.

**Evidence.** The five call sites, read in full. `grep -n "issueCardAction"
components/wallet/money-cards-view.tsx` → `27, 85, 95, 401`; `:85` and `:401`
bind and check `res`, `:95` does not. The action's failure returns are at
`app/(app)/money/actions.ts:114, 117, 118, 124, 125, 126, 127, 135, 138, 158`.

**Fix.** Collect the results, `Promise.allSettled` or keep the serial loop, and
report honestly — `Issued ${ok} of ${n}` with `toastError` naming the first
failure. The component already imports `toastError` and uses it four times.
A partial success is a real outcome here and the UI has no vocabulary for it.

---

## C4-S4-05

```
[CLAUDE-4][MEDIUM][QA] A comment states the invariant the next line breaks: journey
analytics renders "0 started · 0 completed · 0%" from a failed read, and puts the
error message below the fold
File:     app/(app)/dashboard/journeys/page.tsx:28-54
Status:   OPEN
```

**Problem.** The page reads its telemetry, then says out loud what must not
happen, then does it:

```tsx
// :28
const { rows: data, error } = await readAll(..., { max: 5000 });

// :36-38  — the comment
// A failed telemetry read must not masquerade as "no events" — that would tell
// the operator onboarding traffic is zero when the query actually errored.
const events = (data ?? []) as JourneyEventLike[];

// :39-42
const rows = summarizeJourneys(events);
const totalStarts = rows.reduce((a, r) => a + r.starts, 0);
const totalCompletions = rows.reduce((a, r) => a + r.completions, 0);
const overallRate = totalStarts > 0 ? totalCompletions / totalStarts : 0;

// :51-55  — rendered UNCONDITIONALLY, above the error branch
<div className="grid grid-cols-3 gap-3">
  <StatTile label={t('dashboardJourneys.journeysStarted')} value={totalStarts} .../>
  <StatTile label={t('dashboardJourneys.completed')}      value={totalCompletions} .../>
  <StatTile label={t('dashboardJourneys.completion')}     value={formatRate(overallRate)} .../>
</div>

// :57-59  — the error is handled HERE, inside the card below
<SectionCard title={t('dashboardJourneys.perJourneyMedians')} description="Measured from journey_events (0124) — no estimates.">
  {error ? <MiniError text={t('journeys.couldnTLoadJourneyTelemetry')} /> : ...}
```

`error` *is* bound. It is simply consumed in the wrong place. The three headline
tiles — the largest numbers on the page — are computed before it is checked and
rendered above it.

**Impact.** Lower than C4-S4-02/03 because the page is gated by
`isSuperAdmin()` (`:22`), so the audience is operators, not families. But the
claim is a funnel measurement, the card underneath advertises itself as
"Measured from journey_events (0124) — **no estimates**", and an operator
scanning three big zeros above a small error note will read "onboarding
converted nobody" rather than "the query failed". The comment at `:36` proves the
author knew precisely this; the guard just landed one JSX level too low.

**Fix.** Two lines: hoist the `error` check above the tile grid, or render the
tiles as `—` when `error` is set. `MiniError` is already imported.

---

## C4-S4-06

```
[CLAUDE-4][MEDIUM][FLOW] The public ICS feed answers 200 with a truncated or partial
calendar, so a subscriber's calendar silently loses events
File:     app/api/sync/feeds/[token]/route.ts:60-90
Status:   OPEN
```

**Problem.** The feed route discards the read error entirely:

```ts
// :60-69  — note the destructure
const { rows } = await readAll((from, to) => supabase
  .from('sync_calendar_events').select(...)
  .eq('calendar_id', calendar.id).is('deleted_at', null).lte('starts_at', horizon)
  .order('starts_at', { ascending: true }).order('id')
  .range(from, to), { max: 2000 });

const events: IcsEvent[] = (rows ?? []).map((e) => ({ ... }));
const body = generateICS(events, { ... });
return new NextResponse(body, { status: 200, headers: { 'Content-Type': 'text/calendar; ...' } });
```

`readAll` returns `rows` collected-so-far alongside its error, so there are two
bad outcomes and no branch for either:

- **ceiling reached** (>2,000 events in the 400-day horizon): the first 2,000 are
  published and the rest are omitted;
- **a page fails mid-read** (the transport class `lib/supabase/settle.ts` was
  written for — "what took out /dashboard while the production database was
  reporting CONNECT_TIMEOUT"): a *partial* calendar is published.

The route is 15 lines below its own `if (error || !calendar) return 404` for the
calendar lookup, so the file is not error-blind in general — this one read is.

**Impact.** This is the only finding in this session whose blast radius is
*outside* the product. An ICS subscription is authoritative for the client:
Google Calendar, Apple Calendar and Outlook re-poll and reconcile against the
body they are served. Events absent from a fetch are removed from the
subscriber's calendar. So a transient database hiccup during one poll deletes
appointments from every device subscribed to that feed, and they reappear on the
next successful poll. The user sees their calendar flicker and has no reason to
suspect Bubaly; there is not even a log line here.

This is an inference about calendar-client behaviour, not something I could
execute — but the shape of the bug (200 + a valid, shorter document) is read
directly from the source above.

**Fix.** Bind `error` and return `503` with `Retry-After` rather than a short
200. A feed that cannot be built completely must not be served as if it were —
every calendar client already handles a failed poll by keeping what it has, which
is exactly the desired behaviour. Raising `max` addresses only the first case.

---

## C4-S4-07

```
[CLAUDE-4][MEDIUM][PERFORMANCE] /home — the authenticated app's landing page — is
about eleven sequential database round-trip waves, four of them collapsible with
no change in behaviour
File:     app/(app)/home/page.tsx:148-420
Status:   OPEN
```

**Problem.** Pass N proved the marketing surface serialises its calls by
measuring TTFB quantised at exact multiples of one timeout (1 call = 7s, 2 = 14s,
3 = 21s). The same shape is in `app/(app)`, and `/home` — the page every
authenticated session lands on — is the worst instance I found. Mapping every
top-level `await` in `HomePage()`:

| wave | line | what | independent of the previous wave? |
|---|---|---|---|
| 1 | 148 | `await getTranslations()` | — |
| 2 | 149 | `await getTranslations()` again, same function | **yes — identical call** |
| 3 | 150 | `await requireUserContext()` | yes |
| 4 | 152 | `await createServer()` | no (needs ctx) |
| 5 | 183 | `await settleAll([ …14 reads ])` | no |
| 6 | 258 | `await supabase.from('meals')…in(mealIds)` | no (needs wave 5) |
| 7 | 268 | `await supabase.from('chores')…in(choreIds)` | **yes — also only needs wave 5** |
| 8 | 287 | `await listPending(scope)` | **yes** |
| 9 | 295 | `await loadCompletedByBubaly(...)` | **yes** |
| 10 | 302 | `await settleAll([ …7 reads ])` | **yes** |
| 11 | ~360 | `await supabase.from('ai_plan_steps')…in(activePlanIds)` | no (needs wave 10) |
| 12 | 363 | `await supabase.from('chores')…in(missingChoreIds)` | **yes — also only needs wave 10** |
| 13 | 367 | `await schedulePromise` | already overlapped — correct, see below |
| 14 | 379 | `await loadTimeSaved(...)` | **yes** |
| 15 | 380 | `await loadFamilyValue(...)` | **yes** (and itself 2 more serial awaits) |
| 16 | 396 | `await supabase.from('activation_events')` | **yes** |
| 17 | 414 | `await getOnboardingProgress(...)` | **yes** (manager only) |
| 18 | ~417 | `await resolveCompleteness(...)` | no |

Eleven distinct waits on the network, and the page already knows the right
technique — `schedulePromise` at `:242` is started early and awaited at `:367`
with a comment explaining exactly why ("Started here, awaited before
`buildToday`, so it overlaps the reads below"). That one read is handled
correctly and the other six independent ones are not.

The comment at `:291-294` explains why `loadCompletedByBubaly` is *outside*
`settleAll` — it returns a `ServiceResult` with `ok`, not a `{ data, error }`,
so `settleAll`'s rejection substitution would not fit. That reasoning is right,
and it justifies not putting it *inside* the batch. It does not justify awaiting
it *before* the batch: `await Promise.all([listPending(…), loadCompletedByBubaly(…),
settleAll([…])])` keeps every shape intact and collapses waves 8, 9 and 10 into
one.

**Impact.** Collapsing the four safe groups — {6,7}, {8,9,10}, {11,12},
{14,15,16} — takes eleven waves to about six. At a normal 30-60 ms Supabase RTT
that is roughly 150-300 ms off the landing page's TTFB. Under the degraded
conditions the codebase documents (`lib/supabase/settle.ts`'s CONNECT_TIMEOUT
story), each wave is a *timeout*, and the page's latency is a multiple of it —
the precise quantisation Pass N measured on marketing. This is the finding most
likely to be visible to every user on every session.

**Evidence.** Static: the await map above, derived from a scripted scan of
top-level `await` statements outside `settleAll`/`Promise.all` array literals
across all 354 `page.tsx` and 20 `layout.tsx` under `app/(app)`, then read by
hand. `/home` is the deepest; `dashboard/concierge/runs/{page,[id]/page}.tsx`,
`dashboard/graph/page.tsx` and `display/page.tsx` are the next tier at 3-4
collapsible waves each. I could not measure TTFB — no authenticated session — so
the millisecond figures are arithmetic on a stated RTT, not a measurement.

**Fix.** Four `Promise.all` groupings, no behaviour change. Start with
{8,9,10} — it is the largest single saving and the pattern the file already
demonstrates 120 lines earlier.

---

## C4-S4-08

```
[CLAUDE-4][MEDIUM][EDGE CASE] The routines cron reads the family's timezone once per
rule inside the loop and discards the error, so a failed read silently schedules a
household on America/New_York
File:     app/api/cron/family-routines/route.ts:89-90, 240-241
Status:   OPEN
```

**Problem.** Two loops, the same two lines:

```ts
// :84-90  (the firing loop, over up to MAX_ROUTINES_PER_TICK = 25 rules)
for (const rule of due ?? []) {
  ...
  const { data: family } = await db.from('families').select('timezone').eq('id', rule.family_id).maybeSingle();
  const tz = family?.timezone ?? 'America/New_York';
```

```ts
// :237-242  (the arming loop, same bound)
for (const rule of pending ?? []) {
  ...
  const { data: family } = await db.from('families').select('timezone').eq('id', rule.family_id).maybeSingle();
  const tz = family?.timezone ?? 'America/New_York';
  const next = await nextFireAfter(db, rule.family_id, schedule, now, tz);
```

Two defects in one statement.

**(a) N+1.** One `families` round trip per rule, not per family. A household with
eight routines due in the same tick pays eight identical reads; the tick is
bounded at 25 rules, so up to 25 avoidable round trips per loop, 50 per
invocation, against a `TICK_BUDGET_MS` deadline the loop checks at `:85` — so the
wasted round trips directly reduce how many routines a tick can actually fire.
The repo already has the memoised-lookup pattern for exactly this:
`lib/server/push.ts` caches `membersOf(familyId)` in a `Map` before its per-
notification loop (I verified that one in session 3 and recorded it as sound).

**(b) The discarded error is a silent timezone substitution.** `{ data: family }`
binds no `error`. A refused or failed read is indistinguishable from "no such
family", and both fall through `??` to **`America/New_York`**. That constant is
then the entire basis for when the routine fires: `releaseWedgedOccurrence(db,
rule, dueAt, now, tz)` and `nextFireAfter(db, familyId, schedule, now, tz)` both
take it. For a household in Asia/Tokyo that is a 13-14 hour shift — a "7am school
morning" routine files at 8 or 9pm the previous evening, on the wrong calendar
day. This is the same family as `F-F02`'s Greenwich-day bug (a timezone decided
by something other than the family's own), reached through a discarded error
rather than a `Date` API.

**Impact.** (a) is bounded and modest. (b) is a wrong-day automation for any
non-US-Eastern household, arriving only when a read fails, with no log line and
no way for the family to attribute it. The `armed` counter at `:250` is
scrupulous about only counting writes that landed — the comment at `:247-249`
argues the case ("a quiet tick reads differently from a broken one") — so the
attention was there; it just did not reach the read two statements above.

**Fix.** Hoist the timezone lookup: one `.in('id', familyIds)` read before the
loop into a `Map<string, string>`, error bound and the tick failed or the rule
skipped on failure. That fixes both halves at once, and the "skip the rule rather
than guess its timezone" behaviour is the one consistent with `armed`'s own
reasoning.

---

## C4-S4-09

```
[CLAUDE-4][MEDIUM][FLOW] Removing a document deletes the row whether or not the file
was deleted, orphaning a private storage object, and says "File removed"
File:     components/modules/home-module.tsx:440-448  (and the rollback at :425)
Status:   OPEN
```

**Problem.**

```tsx
// :440-448
async function removeFile(doc: WarrantyDoc) {
  setRemovingId(doc.id);
  const supabase = createClient();
  await removeFamilyDocument(supabase, doc.storage_path);      // result DISCARDED
  const { error } = await supabase.from('documents').delete().eq('id', doc.id);
  setRemovingId(null);
  if (error) return toastError(describeDbError(error));
  success(tr('homeModule.fileRemoved'));
  onChanged();
}
```

`removeFamilyDocument` is explicitly designed to be checked —
`lib/storage/documents.ts:48-54` returns `Promise<{ error: string | null }>` and
the two other call sites in this same component check it (`:410-415` binds
`uploadError` and toasts on it). Here it is awaited bare.

**Impact.** Two consequences, in order of seriousness:

1. **The user's intent is not honoured and they are told it was.** A parent
   removing a warranty or a manual — plausibly because it contains a serial
   number, a policy number or a photo of a document — is told "File removed".
   The object stays in the private bucket. Because the `documents` row is gone,
   nothing in the product references it any more, so the parent has no way to
   see it, delete it, or know it is there. The only correct description of that
   outcome is a privacy defect, and the user has been told the opposite.
2. Orphaned objects accumulate in the bucket, billed and unreclaimable through
   the product.

The same discard is at `:425`, but that one is a genuine rollback path (the
insert failed, so we are cleaning up an object nothing references) and a failed
cleanup there is already the error case — lower stakes, worth the same one-line
treatment.

**Fix.** Bind the error; do not delete the row if the object survived, and toast
the storage failure. Ordering matters: deleting the row first is what makes the
leaked object invisible. `describeDbError` and `toastError` are both already in
scope.

---

## C4-S4-10

```
[CLAUDE-4][MEDIUM][QA] The real loading/error/not-found picture inside app/(app):
two loading skeletons for 354 pages, 222 of which are force-dynamic
File:     app/(app)/**  (route tree)
Status:   OPEN — extends F-D08 with the per-segment matrix it lacked
```

**The measurement.** Pass N established that the *marketing* surface has zero
`loading.tsx`/`error.tsx`/`not-found.tsx` against the app's 18. Here is what
those 18 actually are, per top-level segment:

| segment | pages | `error.tsx` | `loading.tsx` | `not-found.tsx` | `layout.tsx` |
|---|---|---|---|---|---|
| (root of `(app)`) | — | yes | yes | — | yes |
| dashboard | **215** | yes | — | yes | yes |
| admin | 80 | yes | — | — | yes |
| marketplace | 20 | yes | — | — | yes |
| wallet | 12 | yes | — | yes | yes |
| family | 6 | yes | — | — | yes |
| guardian | 5 | yes | **yes** | — | yes |
| capture / display / kids / missions / services | 2 each | yes | — | — | yes¹ |
| economy / feedback / home / referrals | 1 each | yes | — | — | yes |
| auth / parent | 1 each | — | — | — | — |
| account / money / settings | 0 | — | — | — | — |

¹ `display` has no `layout.tsx`. Totals: 354 `page.tsx`, **16** segment
`error.tsx` + 1 root, **2** `loading.tsx`, **2** `not-found.tsx`, 20 `layout.tsx`.

**What this corrects.** The error-boundary story inside `app/(app)` is *good*,
and it is worth saying so plainly so a later pass does not spend a session on it:
every segment that owns pages has an `error.tsx` except `auth` and `parent`
(one page each), and `app/(app)/error.tsx` catches those. A page that throws
degrades to an inline card inside the shell, with a `reset()` button and the
`digest` reference — `app/(app)/error.tsx:32-50`. A route that fetches and
crashes does **not** show a blank.

**What is actually missing.**

1. **Loading.** Two `loading.tsx` for 354 pages, and 222 of those pages declare
   `export const dynamic = 'force-dynamic'` — i.e. they *will* suspend on every
   navigation, so the skeleton is on the critical path for two thirds of the app.
   All of them get `app/(app)/loading.tsx`: a 48-wide title bar, a 72-wide
   subtitle and `SkeletonList count={4}`. That shape is a reasonable guess for a
   list page. It is wrong for `/home` (a dense command centre), for
   `admin/wallet` (a stat-tile grid), for `dashboard/graph`, and for every table
   page under `admin/`. Each of those gets four card-shaped grey blocks and then
   a layout that looks nothing like them — the layout shift the root file's own
   comment says it exists to avoid ("It mirrors the common page rhythm (title +
   content cards) to avoid layout shift"). `guardian/loading.tsx` is the one
   segment that took the trouble; it is the model for the rest.
   The highest-value additions, by traffic × mismatch: `home/`, `dashboard/`
   (215 pages under one skeleton), `admin/`, `wallet/`.
2. **Not-found.** Only `dashboard` and `wallet` have one. Every other segment's
   `notFound()` — including `dashboard/journeys/page.tsx:22`, which calls it for
   a non-super-admin — falls through to the app-wide 404. For
   `journeys` specifically, a non-admin gets a generic "not found" rather than
   anything explaining the surface is admin-only; that is arguably correct
   (do not confirm the route exists) and is recorded as intentional-looking, not
   as a defect.
3. **One granularity gap worth naming on its own:** 215 pages share
   `app/(app)/dashboard/error.tsx`. Any page under `/dashboard` that throws shows
   the same "This page hit a snag" card, and the `reset()` re-renders the same
   failing page. That is acceptable as a floor; it is not a substitute for the
   per-page degraded views the better pages already build by hand.

**Why this is MEDIUM and not higher.** Nothing here produces a wrong number.
Every finding above it does. It is recorded at this length because the brief
asked for the real per-route picture and because a future pass should not have to
re-derive the matrix.

**Fix.** Copy `app/(app)/guardian/loading.tsx`'s approach into `home/`,
`dashboard/`, `admin/` and `wallet/`, shaped to each segment's actual layout.
Four files.

---

## C4-S4-11

```
[CLAUDE-4][LOW][EDGE CASE] Resetting a child's PIN returns ok:true whether or not the
brute-force lockout was lifted, so the child can stay locked out for 15+ minutes
with the parent told the reset worked
File:     app/(app)/family/child-login-actions.ts:117-119  (and :86-88)
Status:   OPEN
```

**Problem.** `resetChildPinAction` updates the auth password, checks that error
properly (`:114`), then:

```ts
// :115-119
// A parent reset should also lift any brute-force lockout on that username, so
// the child can sign in immediately with the new PIN.
await admin.from('child_login_throttle')
  .update({ fails: 0, locked_until: null, window_start: new Date().toISOString() })
  .eq('username', normalizeUsername(row.username));
```

Result discarded, then `logAudit`, then `return { ok: true }`. The comment states
the contract — *"so the child can sign in immediately with the new PIN"* — and
the statement that delivers it is the one statement in the function whose error
is not bound. The same discard is at `:86-88` in `createChildLoginAction`, where
it exists to clear a stale lockout inherited from a previous holder of the
username.

**Impact.** Bounded but genuinely dead-ended. `lib/auth/child-throttle.ts:24-28`:
`maxFails: 5`, `lockMs: 15 * 60_000`, and `:77` escalates —
`locked_until = now + lockMs * factor`. So a child who tripped the throttle stays
locked for 15 minutes or a multiple of it. The parent has just been told the PIN
is reset. The child tries the new PIN, is refused before the password is even
checked (`child-throttle.ts:48-49`), and tries again — which on a repeat lockout
escalates the factor. `child_login_throttle` has no UI anywhere in the product,
so there is no way for the parent to see the lock or clear it; the only remedy is
waiting out a duration nobody is shown.

**Evidence.** Static. The two discarded statements, `DEFAULT_POLICY`, and the
escalation at `child-throttle.ts:72-79`. I could not exercise the throttle — no
auth backend here.

**Fix.** Bind the error and return a distinct failure ("PIN updated, but the
lockout could not be cleared — try again in a few minutes"), or retry. The reset
itself has already succeeded at that point, so the action must not report a plain
`ok: true` and must not report a plain failure either; it is a third state, the
same shape the blog-unsubscribe fix in `f462cc7e` introduced for exactly this
reason.

---

## C4-S4-12

```
[CLAUDE-4][LOW][PERFORMANCE] 93 authenticated pages await getTranslations() two to
five times in the same render, sequentially
File:     app/(app)/**/page.tsx (93 files); lib/i18n/server.ts:28-38
Status:   OPEN
```

**Problem.** `lib/i18n/server.ts` is explicit that it is **not** memoised, and
explains why:

> *"NOT memoised per request, deliberately. React's `cache()` would be the tool,
> and this project is on React 18.3, which does not export it. What is left to
> repeat per call is cheap… The expensive half — assembling the catalogue — is
> memoised per LOCALE in `getMessages`."*

The reasoning is sound. What it did not anticipate is the call pattern. 93 of the
354 pages call `await getTranslations()` more than once in a single render:

```
5×  app/(app)/admin/integrations/page.tsx
4×  app/(app)/admin/subscriptions/page.tsx
3×  home, family/reports, dashboard/sync, dashboard/family-stress,
    dashboard/family-operations, dashboard/contacts/[id],
    dashboard/concierge/runs/[id], admin/system, admin/support,
    admin/support-tickets, admin/onboarding, admin/marketing/{,video,referrals,
    pipeline,personalization}, marketplace/selling, … (+ ~78 more at 2×)
```

`app/(app)/home/page.tsx:148-149` is the clearest case — two identical awaits on
consecutive lines, bound to `i18nT` and `tr`, both used later in the same
component.

Each repeat is `await Promise.all([cookies(), headers()])` plus `resolveLocale`
plus a `Map` hit. Individually negligible; but they are `await`s, so they are
**sequential microtask boundaries on the render path**, and on `/home` two of
them are waves 1 and 2 of C4-S4-07's eleven.

**Fix.** Call it once per component and pass the translator down — mechanical,
93 files, zero risk. I checked whether the module's own escape hatch had opened:
`package.json:98-99` pins `react` and `react-dom` at `^18.3.1` (against
`next: ^15.5.25`), so React's `cache()` is genuinely still unavailable and the
module's stated reason for not memoising **stands**. This is a call-site fix, not
a helper fix. If the app is ever moved to React 19, memoising `getLocaleContext`
with `cache()` closes all 93 at once and the comment at `lib/i18n/server.ts:28`
should be revisited at that point.

---

## C4-S4-13

```
[CLAUDE-4][LOW][INTEGRATION] The GitHub feedback sync silently reconciles nothing and
reports "Nothing new — 0 issues in sync" to the super admin
File:     lib/feedback/github-sync.ts:64-76
Status:   OPEN
```

**Problem.** The reconcile half builds its idea lookup from a `readAll` whose
error is discarded:

```ts
// :64-75
const { rows: linked } = await readAll((from, to) => admin
  .from('feedback_ideas').select('id, title, status, github_issue_number')
  .not('github_issue_number', 'is', null).order('id').range(from, to), { max: 3000 });
const byNumber = new Map(...); const byId = new Map(...);
for (const row of linked ?? []) { ... }
```

On a failed read both maps are empty, so every issue hits `if (!idea) continue;`
(`:83`), `reconciled` stays 0, no `feedback_ideas` row is updated, and
`summarizeSync` (`:104-110`) reports `"Nothing new — 0 issues in sync."` —
because `errors` was never incremented either.

**Impact.** Low: read-only in effect, nothing is corrupted, and the next run
recovers. But it is the repo's signature defect in miniature — a failure reported
as a quiet success to the one person who could act on it — and the surrounding
function is otherwise careful (`:56-58` returns `errors + 1` when the GitHub
call throws). The header comment even anticipates the *other* direction of this
bug ("past 1,000 linked ideas the sync stopped seeing the rest and would have
started re-opening issues it believed unlinked"), which is what the `readAll`
was added to fix; the error it now returns was not picked up.

**Fix.** `const { rows: linked, error } = …; if (error) return { configured: true,
created, reconciled: 0, changes, errors: errors + 1 };` — the same early return
the function already uses eight lines above.

---

## Verified this session, not re-derived (rule 4)

- **`F-F01` — half FIXED, half re-scoped.** The helper defect is closed at
  `HEAD` (`lib/supabase/read-all.ts:80, 106-117`, landed in `f462cc7e`,
  2026-09-14). `app/(app)/admin/wallet/reconciliation/page.tsx:31-44` now returns
  `<ErrorState>` before `reconcileLedger` runs, so the "Everything reconciles"
  copy is unreachable over a truncated read. `finalaudit.md:264` still describes
  the old mechanism and marks it OPEN — see the note at the end of C4-S4-01. The
  59-call-site blast radius the finding named is real and is now enumerated in
  full; 46 of the 59 are clean.
- **`F-F03` — still OPEN, verbatim.** `app/(app)/missions/page.tsx:70-78`:
  `for (const s of subs)` over a read limited to 60 (`:30`), containing
  `for (const path of (s.media_paths ?? []).slice(0, 4))` containing
  `await supabase.storage.from('chore-proof').createSignedUrl(path, 600)`.
  60 × 4 = **up to 240 sequential storage round trips** on the parent approval
  queue. Worth adding to the finding: the batch API is **already used in this
  repo** — `app/(app)/admin/marketing/assets/page.tsx:53` calls
  `supabase.storage.from(BUCKET).createSignedUrls(imagePaths, 3600)` (plural) and
  binds its error. One call replaces 240.
- **`F-D08`** — confirmed and quantified; see C4-S4-10 for the per-segment matrix.
- **`tests/no-limit-above-the-row-cap.test.ts` is NOT vacuous.** I went looking
  for this repo's characteristic defect in the guard that most invited it, and it
  is clean: it scans `app/` and `lib/` for `.limit(n > 1000)`, skips comment
  lines, asserts `toEqual([])`, and carries an explicit non-vacuity test
  (`it('recognises an over-cap limit when it sees one')`) with five positive and
  negative cases. It enforces the read's *shape*; C4-S4-01's recommended sibling
  guard would enforce the read's *error*. Recording it as sound so a later pass
  does not re-check it.
- **`tests/supabase-read-all.test.ts` is load-bearing.** 19 tests, executed this
  session (877 ms, all green), including `:207` "honours a ceiling, and reports
  null data when the read was truncated" — which is the exact contract the 13
  call sites in C4-S4-01 fail to honour.

## Checked this session and found healthy (recorded so it is not re-derived)

- **46 of the 59 `readAll` call sites** consume their error correctly, through
  four distinct in-repo patterns. Specifically sound: `admin/wallet/page.tsx`,
  `admin/wallet/reconciliation`, `admin/system`, `admin/feedback`,
  `admin/social/usage`, `admin/marketing/{affiliates,intelligence,experiments}`,
  `economy`, `wallet/{activity,treasury,send}`, `marketplace/{creators,collections,page}`,
  `dashboard/migrate/actions.ts` (all four), `lib/operating-index/server.ts`,
  `lib/intelligence/hard-signals-server.ts`, `lib/finance/timeline-load.ts`
  (with a deliberate `isMissingTableError` exemption), `lib/twin/project-server.ts`,
  `lib/reasoning/context.ts`, `lib/marketing/customers.ts`,
  `lib/network/benchmarks-server.ts`, `lib/autopilot/{scan,policy-scan}.ts`,
  and all seven cron routes.
- **`lib/metric/strategy-server.ts`** defines its *own* local `readAll` (`:20-38`)
  that shadows the shared helper. It throws on error and pages by cursor rather
  than by ceiling, so it is not exposed to the C4-S4-01 class at all. Noted
  because a future grep for `readAll` will hit it and it is a different function.
- **Optimistic-UI sweep.** ~530 `success(…)` call sites across client components,
  scanned for a mutation whose result is discarded before a success signal. One
  real offender (C4-S4-04). Three candidates read in full and cleared as false
  positives of the scan window: `components/modules/recipes-module.tsx:183`
  (`if (!result.ok)` at `:196`), `components/modules/trust-module.tsx:361`
  (`if (!res.ok)` at `:378`), `components/auth/join-invite.tsx:55`
  (`.catch(() => '/home')` — a deliberate fallback for a landing path, not a
  swallowed mutation). `components/modules/habits-module.tsx:109-130` also checks
  every branch. The class is, on this evidence, much rarer in client components
  than the audit's "second-most-common defect" framing suggests — it lives in
  *server* reads, not client mutations.
- **N+1 sweep** over every `await` of a `.from(…)`/`.storage`/`.rpc(…)` inside a
  `for`/`while`/`map(async)` across `app/`, `lib/` and `components/`. Of the page
  renders, `missions/page.tsx` is the **only** one (`F-F03`). The rest are cron
  and sync engines where a per-row write loop is the correct shape
  (`lib/sync/engine/{generic,google}.ts` — per-event upsert against an external
  calendar, unavoidable; `app/api/cron/{return-reminders,provider-sync,close-auctions}`
  — per-row state transitions). The one true N+1 outside `/missions` is
  C4-S4-08's per-rule timezone read. `lib/server/push.ts` and
  `components/modules/messages-module.tsx` re-confirmed sound (session 3).
- **`components/ui/partial-read-banner.tsx`** — correct: returns `null` on an
  empty failure list, `role="status"`, names each failed read individually, and
  carries a `hint` for the credential-failure case where every reason is the same
  opaque string. It is the right target for C4-S4-01's page-level fixes and costs
  nothing when reads succeed. Used on 6 pages today.
- **`app/(app)/error.tsx`** — sound. Renders inside the app shell, logs with the
  digest, offers `reset()` and a Home link.

## What this session could not reach — BLOCKED, not clean

- **No authenticated session exists in this sandbox** (no docker daemon, no
  Supabase CLI). Every statement about what a page *renders* is a reading of its
  JSX under a state I proved reachable, not an observation. In particular:
  the zero-valued tiles in C4-S4-02, C4-S4-03 and C4-S4-05 were proven at the
  *helper* boundary by execution and traced by hand from there to the JSX; I did
  not see them on a screen.
- **No TTFB measurement for `app/(app)`.** C4-S4-07's wave count is exact
  (it is source), but the millisecond figures are arithmetic on an assumed RTT.
  The quantisation Pass N measured on marketing is the evidence that the pattern
  costs what it looks like it costs; reproducing that inside the app needs a
  session.
- **The ICS-client consequence in C4-S4-06 is an inference.** That a calendar
  client removes events absent from a re-poll is well-established behaviour, but
  I could not subscribe a client to a feed and watch it happen.
- **The remaining vacuity sweep.** Session 3's NEXT still stands: the
  mock-return-value and constant-substitution patterns were sampled, never swept
  at AST level across ~1,250 test files. This session spent its budget on the
  read-path thread instead, which the brief ranked higher. One guard was examined
  in depth (`no-limit-above-the-row-cap`) and is sound.
- **`app/(app)` pages 2-354.** I read roughly 45 of the 354 page files in full
  and scanned all of them programmatically for the specific patterns above. A
  page whose defect is none of {unconsumed `readAll` error, sequential await
  wave, in-loop await, discarded mutation error} would not have been caught.


---

# Session 5 (2026-09-15) — how many of the 13,746 passes mean anything

Session 3's NEXT and session 4's "could not reach" both named the same gap: the
AST-level vacuity sweep across the test suite was never run. This session ran it,
and — because a grep count is not a finding — proved every reported instance by
**neutering the code the test protects and showing the test still passes**. Every
mutation was reverted in a `finally`; `git status --porcelain` was empty before
and after (checked at four points during the session). Nothing in the repo was
changed except this file.

## Method

`tests/**/*.test.ts` was parsed with the TypeScript compiler API (5.9.3, the
repo's own) rather than grepped — **1,205 files, 9,275 literal `it()`/`test()`
blocks** (the 13,746 figure is post-`it.each` expansion). Seven patterns were
extracted structurally, then each candidate was put through a mutation harness
that edits the real source file, runs `npx vitest run <file>`, and restores.

Two mutation directions were used, because vacuity has two shapes:
- **Neuter** — delete the protected code. A guard that stays green is vacuous.
- **Plant** — insert the exact violation a repo-scanning guard claims to detect.
  A scanner that stays green is vacuous. (This is the only way to test a
  `toEqual([])` over a scan: the neuter direction cannot reach it.)

Scanner scripts are in the session scratchpad, not the repo.

## Scoreboard

| Class | Candidates | Mutation-tested | PROVEN vacuous |
|---|---|---|---|
| A. `indexOf` sentinel ordering | 73 → 59 literal-LHS | 31 | **8** |
| B. `toContain('<bareIdentifier>')` on a source file | 185 → 54 split | 51 | **46** |
| C. repo-scan `toEqual([])` / `toHaveLength(0)` | 30 without a corpus check | 11 | **0** |
| D. `it()` with no `expect` | 5 | 5 | **0** |
| E. unawaited `.rejects` / `.resolves` | 0 | — | **0** |
| F. `.skip` / `.todo` / `xit` | 0 | — | **0** |
| G. every assertion inside a loop | 380 / 9,275 | spot-checked | **0 proven** |

**54 assertions proven vacuous, across 45 test files.** Two classes account for
all of them, and one of the two is systemic.

---

## C4-S5-01 [HIGH][QA/TESTS] The "spelling-only" boundary guard — 46 PROVEN, and it is the repo's largest vacuity class

**Files:** 30 test files (full list below), each guarding a different action or
route file.

**Problem.** The dominant idiom for proving a boundary is honoured is
`expect(source).toContain('helperName')` against a `readFileSync` of the source.
That asserts **the identifier is spelled somewhere in the file** — and an ES
module that *imports* a helper spells it on the import line. So the guard is
satisfied by the import alone; every call site can be deleted and it stays green.

**Evidence (mutation).** For each candidate the harness rewrote every call site
`helperName(` → `__neutered(` in the real source file, **leaving the import line
untouched**, then ran the whole test file. 46 of 51 stayed fully green.

The starkest single case is an **authorization** gate:

    tests/marketing-core-referral-boundaries.test.ts:26
      expect(leadScores).toContain('requireMarketingAdmin');

Every call to `requireMarketingAdmin` was removed from
`app/(app)/admin/marketing/lead-scores/actions.ts`. The server action no longer
checks that the caller is a marketing admin. The test file passed. The same file
also proved spelling-only for `marketingActionFailure` (:27) and
`logMarketingAudit` (:28) — so on that one page the admin check, the error
sanitiser and the audit write can all be removed together and the suite is green.

The second-starkest is a **money** guard, which is this audit's recurring theme:

    tests/wallet-money-action-boundaries.test.ts:24
      expect(moneyActions).toContain('logWalletAudit');

All 4 `logWalletAudit(` call sites removed from `app/(app)/money/actions.ts`;
green. Note that `tests/audit-write-failures-are-visible.test.ts` catches the
*opposite* regression (writing `wallet_audit_logs` directly instead of through
the helper — PROVEN load-bearing below), so the pair looks complete and is not:
you cannot bypass the helper, but you can stop calling it at all.

**The repo already knows the fix, and applies it 20% of the time.**
`tests/cron-auth.test.ts` contains both idioms, eleven lines apart, with a
comment explaining exactly why the paren matters:

    :44  for (const file of cronRoutes) {
    :47    // Must both CALL the gate and ACT on it (reject) — importing without
    :48    // a 401 would leave the privileged job publicly triggerable.
    :49    expect(source, file).toContain('hasCronAuthorization(');   <- sound
    ...
    :53  const welcome = readFileSync('app/api/email/welcome/route.ts', 'utf8');
    :54  expect(welcome).toContain('hasInternalSecret');              <- PROVEN vacuous

The loop got the trailing `(`. The one-off next to it did not. Repo-wide the
split is **204 `toContain('ident(')` vs 837 `toContain('ident')`**.

**Impact.** 46 boundary guards — covering admin authz, service-role usage,
request-size bounds, SSRF containment, cron auth, audit logging and error
sanitisation — cannot fail when the behaviour they name is removed. They are
worse than no guard, because a reviewer reading the test file believes the
boundary is pinned.

**Fix (mechanical, low risk).** Append `(` to the asserted literal wherever the
identifier is a function: `toContain('describeActionError(')`. For helpers used
in non-call position, assert the shape that proves use, e.g.
`toMatch(/catch[\s\S]{0,200}describeActionError\(/)`. A one-off codemod plus a
meta-guard in the shape of `tests/boundary-probes-actually-assert.test.ts`
("no `toContain` of a bare identifier that the target file only imports") would
close the class and keep it closed.

**PROVEN spelling-only (46).** Format `test:line  identifier  <- neutered file`:

    admin-digest.test.ts:94                         summarizeDigestDelivery      app/api/cron/admin-digest/route.ts
    admin-management-action-boundaries.test.ts:10   describeActionError          app/(app)/admin/admins/actions.ts
    admin-management-action-boundaries.test.ts:21   toastError                   components/admin/admin-row-actions.tsx
    admin-management-action-boundaries.test.ts:22   success                      components/admin/admin-row-actions.tsx
    admin-marketing-content-campaigns-read-boundary.test.ts:24  getMarketingCustomersWithError  app/(app)/admin/marketing/campaigns/[id]/page.tsx
    admin-marketing-crm-read-boundary.test.ts:13    getMarketingCustomersWithError  app/(app)/admin/marketing/customers/page.tsx
    admin-tier-report-action-boundaries.test.ts:10  describeActionError          app/(app)/admin/tier-features/actions.ts
    ai-action-boundaries.test.ts:11                 describeActionError          lib/ai/provider.ts
    ai-action-boundaries.test.ts:13                 describeActionError          app/(app)/admin/ai/actions.ts
    alexa-request-verification.test.ts:433          readBoundedRequestBytes      app/api/assistant/alexa/route.ts
    assistant-bridge.test.ts:250                    readBoundedRequestJson       app/api/assistant/route.ts
    assistant-bridge.test.ts:251                    readBoundedRequestBytes      app/api/assistant/alexa/route.ts
    assistant-bridge.test.ts:290                    createServiceClient          app/api/assistant/route.ts
    contact-center.test.ts:125                      readBoundedRequestFormData   app/api/contact-center/email/route.ts
    cron-auth.test.ts:54                            hasInternalSecret            app/api/email/welcome/route.ts
    display-ask-handled-tiles.test.ts:105           submitAIRequest              components/concierge/ask-bubaly.tsx
    guardian-action-error-boundaries.test.ts:9      describeActionError          app/(app)/guardian/actions.ts
    manifest-share-target.test.ts:49                sharedCaptureText            app/(app)/capture/page.tsx
    marketing-assets-content-boundaries.test.ts:9   marketingActionFailure       app/(app)/admin/marketing/assets/actions.ts
    marketing-assets-content-boundaries.test.ts:17  marketingActionFailure       app/(app)/admin/marketing/content/actions.ts   (14 call sites removed)
    marketing-core-referral-boundaries.test.ts:19   marketingActionFailure       app/(app)/admin/marketing/referrals/actions.ts
    marketing-core-referral-boundaries.test.ts:26   requireMarketingAdmin        app/(app)/admin/marketing/lead-scores/actions.ts
    marketing-core-referral-boundaries.test.ts:27   marketingActionFailure       app/(app)/admin/marketing/lead-scores/actions.ts
    marketing-core-referral-boundaries.test.ts:28   logMarketingAudit            app/(app)/admin/marketing/lead-scores/actions.ts
    marketing-delivery-action-boundaries.test.ts:9  marketingActionFailure       app/(app)/admin/marketing/personalization/actions.ts
    marketing-delivery-action-boundaries.test.ts:16 marketingActionFailure       app/(app)/admin/marketing/push/actions.ts
    marketing-delivery-action-boundaries.test.ts:18 markFailedAndThrow           app/(app)/admin/marketing/push/actions.ts
    marketing-experiment-exit-survey-boundaries.test.ts:10  marketingActionFailure  app/(app)/admin/marketing/experiments/actions.ts
    marketing-experiment-exit-survey-boundaries.test.ts:11  hasConfiguredVariant    app/(app)/admin/marketing/experiments/actions.ts
    marketing-experiment-exit-survey-boundaries.test.ts:18  marketingActionFailure  app/(app)/admin/marketing/exit-intent/actions.ts
    marketing-experiment-exit-survey-boundaries.test.ts:24  marketingActionFailure  app/(app)/admin/marketing/surveys/actions.ts
    marketing-reputation-video-review-boundaries.test.ts:10 marketingActionFailure  app/(app)/admin/marketing/reputation/actions.ts
    marketing-reputation-video-review-boundaries.test.ts:17 marketingActionFailure  app/(app)/admin/marketing/video/actions.ts
    marketing-reputation-video-review-boundaries.test.ts:24 marketingActionFailure  app/(app)/admin/marketing/reviews/actions.ts
    marketing-social-proof.test.ts:15               createServiceClient          lib/marketing/reputation-server.ts
    persistent-login.test.ts:280                    durableCookieOptions         lib/supabase/client.ts
    recurring-ads-runner.test.ts:138                hasCronAuthorization         app/api/cron/marketing-social/route.ts
    server-action-error-boundaries.test.ts:21       describeActionError          lib/intelligence/hard-signals-server.ts
    social-feed-fetch-security.test.ts:33           fetchPublicText              app/(app)/dashboard/social-feed/actions.ts
    support-ticket-action-boundaries.test.ts:10     describeActionError          app/(app)/admin/support-tickets/actions.ts
    support-ticket-action-boundaries.test.ts:22     toastError                   components/admin/ticket-row-actions.tsx
    support-ticket-action-boundaries.test.ts:23     success                      components/admin/ticket-row-actions.tsx
    sync-job-persistence-boundaries.test.ts:28      getProviderAccessToken       lib/sync/engine/generic.ts
    tenant-isolation-rls.test.ts:21                 createServiceClient          lib/server/profiles.ts
    tenant-isolation-rls.test.ts:22                 createServiceClient          app/(app)/family/child-login-actions.ts
    wallet-money-action-boundaries.test.ts:24       logWalletAudit               app/(app)/money/actions.ts

**Sound (5, recorded so they are not re-tested):** the same mutation turned these
RED, because the test also asserts the *branch* around the call —
`admin-notification-boundary.test.ts:14`, `display-setup-page.test.ts:114/115/116`,
`marketing-loyalty-action-boundaries.test.ts:8`.

**Status:** OPEN. Audit-only session; no source or test modified.

---

## C4-S5-02 [HIGH][QA/TESTS] Eight ordering guards that a deleted statement satisfies — the `indexOf` → `-1` sentinel

**Problem.** `expect(src.indexOf(A)).toBeLessThan(src.indexOf(B))` reads as "A
happens before B". `String.prototype.indexOf` returns **-1** when A is absent,
and `-1` is less than any index — so the assertion passes *most convincingly*
when A has been deleted entirely. This is the exact shape Claude-1 found in a
test it had just written this round; it is not a one-off.

**Method.** 73 AST hits → 59 with a string-literal left-hand needle → 31 whose
needle could be located in a source file the test reads. For each, the needle was
deleted from the real source file and the whole test file re-run with
`--reporter=verbose`, so the specific `it` could be named as passing.

**PROVEN vacuous (8 assertions, 7 files).** Each line states what was removed
from the product and what the suite said about it:

1. **`tests/referral-reward.test.ts:195`** — removed
   `await markReferralConverted(supabase, familyId)` (1 occurrence) from
   `app/api/webhooks/stripe/route.ts`. The Stripe webhook no longer marks a
   referral converted at all. **11/11 passed**, including the test whose own name
   is *"the Stripe webhook fulfils the reward right after marking the
   conversion"*. **This is the worst instance found this session**: the suite
   affirms an ordering between two money events when the first one is gone.

2. **`tests/display-setup-page.test.ts:190`** — removed all 4 `return;`
   statements from `components/display/display-grid.tsx`, including the
   early-return that stops `setSetupDismissed(true)` after a failed write.
   **34/34 passed**, including *"does not claim the dismissal when the write
   failed"*. Optimistic-UI, the class this audit calls its second-most-common
   defect, guarded by an assertion that cannot see it.

3. **`tests/inventory-module-write-boundary.test.ts:40`** — removed all 4
   `from('inventory_items').update(` from `components/modules/inventory-module.tsx`.
   **9/9 passed**, including *"a move updates the item first and reports a failed
   history insert"*. The item update the test names does not have to exist.

4. **`tests/closet-module-write-boundary.test.ts:27`** — removed
   `from('outfit_logs').insert(` from `components/modules/closet-module.tsx`.
   **10/10 passed**, including *"logs a wear before bumping wear counts"*. The
   wear log need not be written.

5. **`tests/dashboard-modules-keep-prior-read.test.ts:26`** and **`:33`** — removed
   both `if (error) return;` guards from `components/modules/assistant-module.tsx`.
   **3/3 passed**, including *"assistant conversation list keeps prior history on
   error"* and *"assistant message load does not switch into a misleading greeting
   on error"*. These two tests exist specifically to hold the A-05 / PLA-0792 fix
   in place; `silent-empty-read-ratchet.test.ts` has already been edited to
   *remove* assistant-module from its BASELINE on the strength of that fix. The
   ratchet's own comment cites the fix these guards do not actually hold.

6. **`tests/dashboard-analytics-read-boundary.test.ts:29`** — removed `error ?`
   from `app/(app)/dashboard/journeys/page.tsx`, i.e. the entire error branch that
   renders `MiniError`. **3/3 passed**, including *"journeys page surfaces a
   failed telemetry read instead of a false-empty"*. The surviving
   `toContain('MiniError')` is class C4-S5-01: the import still spells it.
   Same provenance note as (5) — the ratchet baseline was pruned for this fix.

7. **`tests/notification-actions.test.ts:244`** — removed both `if (!result.ok)`
   branches from `components/modules/notifications-module.tsx`. **35/35 passed**,
   including *"marks a row read only after the action succeeded"*. A chore whose
   sign-off failed can be marked read and disappear, and the guard agrees.

**Why the other 23 mutations went RED (worth knowing before anyone "fixes" them
in bulk).** The safe form is a *pair* of assertions that bracket the needle, or a
sibling `toContain` of the same literal. `tests/blog-updated-at-is-a-content-date.test.ts:23-24`
is the model: `disable < update` and `update < enable`. Delete the update and the
first assertion fails, so the pair is load-bearing even though the second half is
individually sentinel-satisfiable. Sound by that construction:
`0261-home-briefs-kind-uniqueness`, `0262-home-briefs-quarantine`,
`admin-document-delete-boundary`, `chore-approval-authz`,
`dashboard-analytics-read-boundary:38/39`, `dashboard-modules-keep-prior-read:20`
(weather — a `toContain('if (error) return [];')` covers it),
`family-hub-read-boundary`, `kids-submit-read-boundary` (both),
`marketing-public-read-boundary` (both), `marketplace-reviews-read-boundary`,
`mobile-sw-notification-focus`, `persistent-login:313`,
`photos-mutation-boundary` (both), `referral-reward:202`,
`server-page-read-boundary:44/66`, `sync-write-failures-are-visible:184`,
`vacations-views-read-boundary`, `wishlists-actions-boundary:298`.

**Fix.** Assert the needle exists before asserting the order. Two lines, no
judgement call:

    const at = (needle: string) => { const i = src.indexOf(needle);
      expect(i, `missing: ${needle}`).toBeGreaterThan(-1); return i; };
    expect(at(A)).toBeLessThan(at(B));

Dropping that helper into `tests/helpers/` and using it at the 59 literal-LHS
sites removes the whole class, including the 23 currently sound-by-accident.

**Status:** OPEN. Audit-only session; every mutation reverted.

---

## C4-S5-03 [INFO][QA/TESTS] What the sweep found HEALTHY — and proved healthy

This is the part of the answer the brief asked for plainly. Outside the two
classes above, the suite held up under active attack.

**Repo-scanning guards are load-bearing: 11 of 11 caught a planted violation.**
The `toEqual([])`-over-a-filesystem-walk shape is the one the brief warned about
("a glob that matched no files"). It was tested the only way that can settle it —
by planting the exact offender each scanner claims to detect into a real source
file — and every one went red:

    no-limit-above-the-row-cap          planted `.limit(5000)`                     CAUGHT
    csp-client-hosts                    planted a client fetch to an off-list host  CAUGHT
    mobile-numeric-inputmode            planted type=number step=0.01, no inputMode CAUGHT
    seo-registry-junk-cleanup           planted a 'Seed data' literal               CAUGHT
    public-bucket-objects-are-unguessable  planted a Date.now()-only storage path   CAUGHT
    silent-empty-read-ratchet           planted `const { data } = await supabase…`  CAUGHT
    audit-write-failures-are-visible    planted a direct wallet_audit_logs insert   CAUGHT
    family-day-not-greenwich-day        planted setHours(0,0,0,0) beside a date eq  CAUGHT
    definer-search-path-pinned          planted a definer fn with no search_path    CAUGHT
    catalogue-key-not-rendered-raw      planted a key-shaped label beside real copy CAUGHT
    claimed-writes-that-did-not-land    planted a statement-position push_devices delete  CAUGHT

Two of these needed a second, more careful plant: my first attempt at
`catalogue-key-not-rendered-raw` and `claimed-writes-that-did-not-land` was not
actually an offender by their own (narrower, deliberately justified) definitions.
That is the scanners being precise, not lax — both caught the real thing. This is
worth recording because it is the direct counter-evidence to the assumption that
the ~1,030 `toEqual([])` assertions in the suite are decoration.

Several carry their own explicit anti-vacuity siblings, which is why:
`claimed-writes-that-did-not-land` asserts `files.length > 100` with the comment
*"the walk found nothing, so it proves nothing"*; `no-limit-above-the-row-cap`
has *"recognises an over-cap limit when it sees one"*; `mobile-numeric-inputmode`
has a *"sanity"* total count; `silent-empty-read-ratchet` has a third test that
fails if a BASELINE entry goes stale.

**`tests/boundary-probes-actually-assert.test.ts` is the repo's own answer to
this session's question, and it is correct.** It reads `docs/audit/*.sql` and
asserts (a) `checks.length > 10` — an `it` literally titled *"finds probes at all
(guards the guard)"*; (b) every `*-check.sql` contains at least one
`raise exception`; (c) no `raise exception` is parked in a file the runner's glob
does not match; (d) `run-probes.sh` exits 1 on an empty glob. That is the F-020 /
`i18n:gate` lesson generalised and enforced. It should be the template for the
meta-guards recommended in C4-S5-01 and C4-S5-02.

**Clean on four whole classes:**
- **`it()` with no assertion: 0 real.** 5 AST hits, all false positives of the
  scanner — `family-cfo-read-boundary:170`, `trust-sharing-presets:159`,
  `wishlists-actions-boundary:267` and `:307` assert through `expectSays` /
  `expectTranslates`; `travel-import-provider-schema:33` asserts through
  `strictProperties`, which contains the `toEqual`. Custom assertion helpers, not
  empty tests.
- **Unawaited async assertions: 0.** No `expect(...).rejects`/`.resolves` anywhere
  in the suite is missing an `await` or `return`.
- **Skipped/todo tests: 0.** No `it.skip`, `it.todo`, `describe.skip` or `xit`
  in 1,205 files. Nothing is parked.
- **Orphaned test files: 0.** `vitest.config.ts` includes only
  `tests/**/*.test.ts`. There is no `.test.tsx`, `.spec.ts` or stray test file
  anywhere in the repo outside `mobile/node_modules` — so no test exists that
  looks like it runs and does not. (This was worth checking: a `.tsx` test would
  have been silently excluded, and that is exactly the `i18n:gate` shape.)

**One residual, not proven either way: 380 of 9,275 `it()` blocks place every
assertion inside a loop** (`for…of`, `forEach`, `map`). If the collection is
empty the test asserts nothing and passes. Nearly all iterate module constants
(`ONBOARDING_FLOW`, `INSIGHT_META`, registries) that are non-empty by
construction and separately length-asserted; the ones iterating a filesystem scan
were checked and carry corpus guards. I did not mutate all 380, so I am not
claiming the class is clean — I am claiming the sampled glob-driven members of
it are, and that the constant-driven majority is low-risk. A cheap permanent
answer exists: vitest's `expect.hasAssertions()` in a shared setup file, or
`--expand-snapshot-diff`-style reporting of zero-assertion tests.

---

## Session 5 verdict

**Examined:** 9,275 `it()` blocks across 1,205 files at AST level; 673 assertions
matched one of seven vacuity shapes; **97 were put through an executed mutation**
(neuter or plant) rather than eyeballed.

**Proven vacuous: 54 assertions in 45 files.** Class B (spelling-only
`toContain`) is 46 of them and is systemic — the repo uses the sound form
(`toContain('name(')`) 204 times and the unsound form 837 times, and the split is
visible *within a single test file eleven lines apart*. Class A (the `-1`
sentinel) is 8 and is a drafting slip that a two-line helper eliminates.

**Worst single instance:** `tests/referral-reward.test.ts:195`. Delete the call
that marks a referral converted from the Stripe webhook and the test named for
that exact ordering passes, 11/11. Runner-up, and arguably worse in kind:
`tests/marketing-core-referral-boundaries.test.ts:26`, where an admin
authorization check, an error sanitiser and an audit write can be removed from
one server action together, and the file that names all three stays green.

**Honest rate.** Of assertions, not tests: I proved ~54 vacuous out of 673
examined, but I examined only the shapes most likely to be vacuous, so that ratio
is not a suite rate. Extrapolating class B by its structural signature — a bare
identifier `toContain` against a file that merely imports it — the untested
remainder of the 837 sites plausibly contains **another 100–250 of the same
defect**; that is an estimate from the 25% hit rate on the 185 I could resolve to
a source file, not a measurement. Class A is bounded: 59 literal-LHS sites exist
and all 31 reachable ones were tested.

**But the headline is not the 54.** The classes that would have made this suite
theatre — empty globs, skipped tests, assertion-free tests, unawaited promises,
tests outside the runner's glob, scanners that detect nothing — came back
**zero, under active attack, with a planted offender in every scanner I could
plant one in**. This is a suite that is mostly real, with one bad idiom repeated
several hundred times. Fixing the idiom is a codemod plus one meta-guard, and
the repo has already written the template for that meta-guard itself.

## NEXT (for whoever picks up Claude-4)

1. The 837-site class B extrapolation is an estimate. Resolving `toContain`
   subjects that are built by `.slice()`/function-call rather than a plain
   `const x = readFileSync('literal')` would make it a count. The harness
   generalises; it was the subject-resolution that stopped at 185.
2. The 380 loop-only tests want `expect.hasAssertions()` in a setup file rather
   than 380 mutations.
3. Nothing from sessions 1–4 was re-derived. F-F01, F-F02, C4-S4-01..08 and the
   RESEND_API_KEY / `family_code` / `family_members`-trigger items were not
   re-checked this session and should be assumed still open unless Claude-1's
   merge says otherwise.
