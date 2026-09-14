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
