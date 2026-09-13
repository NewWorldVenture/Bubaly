# Claude-4 — QA / Features / Flows / Performance / Edge Cases

Findings only. Format:

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
