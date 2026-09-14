# Claude-4 — QA / Features / Flows / Performance / Edge Cases

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

## Findings

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
