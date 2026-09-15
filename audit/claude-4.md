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

