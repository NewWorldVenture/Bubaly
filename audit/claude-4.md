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
