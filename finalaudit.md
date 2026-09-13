# Bubaly — Final Audit

A running, evidence-based audit of bubaly.com. Every entry records what was
checked, **how**, and what the check actually returned. Nothing is marked closed
on reasoning alone — a finding closes only when a command, probe, or rendered
page demonstrates it, and wherever a fix is claimed the check was also run
against the broken state to prove it was not passing vacuously.

- **Audit head:** `f9c4d7a1` (main) + fixes on this branch
- **Scope:** 395 pages · 140 API routes · 305 migrations · 1,150 unit-test files
- **Environment:** full local Supabase stack (all 305 migrations replayed), seeded
  anchor household, real browser sign-in.

Two entries in this file record the audit correcting *itself*: F-011 (the helper
written to fix silent truncation had the same defect) and F-015 (a probe granted
itself privileges and left them, so the suite's answer depended on what ran
before it). Both were found by re-checking a closure rather than trusting it, and
F-002 records reasoning that was wrong and what replaced it.

---

## 1. Status summary

| Area | Check | Result |
|---|---|---|
| Types | `tsc --noEmit` | ✅ clean |
| Lint | `next lint` | ✅ 0 errors (1 pre-existing warning) |
| Unit tests | `vitest run` | ✅ 13,108 tests |
| Build | `next build` | ✅ exits 0 |
| Schema ↔ code | `db:audit:queries` | ✅ 491 tables, 77 functions, 140 routes resolve |
| Migration names | `db:audit:migrations` | ✅ 305 files, no collisions |
| Migration replay | fresh DB, 0 → 305 | ✅ all applied, 0 failed |
| i18n | `i18n:gate` | ✅ all declared surfaces clean |
| RLS boundaries | 13 probes, fresh replay, run 3× | ✅ 13/13 each time (F-015 made it repeatable) |
| Authenticated routes | 353-route crawl | ✅ 351 ok, 1 gate redirect, 0 failures |
| Public content routes | unknown-slug probe | ✅ 404s (was one 500 — see F-005) |
| API authorization | guard-vs-public-list sweep | ✅ 140/140 accounted for |
| E2E | 108 specs + 2 gated journeys | ✅ all pass (a journey caught F-006) |
| Nightly jobs | all 11 cron routes exercised end to end | ✅ clean (F-008, F-009, F-010, F-014) |
| Whole-table reads | live PostgREST, 3 real tables | ✅ complete and distinct (F-008, F-011) |
| Row-ceiling honesty | scan of `app/` + `lib/` | ✅ 0 limits above the cap (was 59 — F-013) |
| Notification dedupe | 5 cron runs, duplicate-group count | ✅ no new duplicates (F-014) |
| Public sitemap | 1,049 published posts vs the served file | ✅ 1,049 listed (was 1,048 — F-012) |
| Production DB | migration ledger | ⚠️ **blocked — F-001** |

---

## 2. Open findings

### F-001 · Production migration ledger records only `0001–0003` — owner action

**Severity:** high · **Status:** OPEN, cannot be closed from a sandbox

Production carries 439 tables and 957 policies but a three-row ledger. Every
push to `main` therefore halts at the baseline guard in
`scripts/audit-production-migration-state.mjs` before `supabase db push` runs:

```
{"migrationVersions":["0001","0002","0003"],"tableCount":439,"policyCount":957,
 "requiresBaselineReview":true,"moneyWrites":{"exploitable":false}}
Existing production policies have no recorded baseline migration 0004.
Historical replay is blocked... Repairing it is a credentialed operator action.
```

The guard is correct — it is what keeps the held `0240–0254` bundle
(`docs/PENDING_PROD_MIGRATIONS.md`, unresolved requester-privacy findings) from
auto-applying. **Consequence:** every migration from `0276` on, including
**`0286` below**, replays cleanly in the repo but is *not applied to
production*. Needs an operator following `docs/runbooks/LB-016-…md` §4.

F-001 is the only finding still open. Everything else in this file closed with a
command, probe, or rendered page behind it.

---

## 3. Closed this pass

### F-002 · Unbounded reads — the survey, and the reasoning in it that was wrong

**Severity:** medium · **Status:** CLOSED (see F-008 and F-013); the honest bound is now enforced, not assumed

243 reads use `.from(...).select(...)` with no `.limit()`, no `.single()` and no
`head:true` count. Classified by what they actually grow with:

- **122 are not family-scoped** — they grow with the whole platform.
- **121 are family-scoped** — they grow with one household.

The genuinely dangerous subset (F-008) is fixed, and a subset this entry had
**wrongly** put in the "accepted" pile is now fixed too — see F-013. The
reasoning that failed was this: a read carrying an explicit `.limit(n)` was
counted as bounded on purpose. For fifty-nine of them `n` was above the server's
row ceiling, which means it was never applied at all; they were unbounded reads
that merely looked deliberate. Re-measuring per family is what exposed it —
single households already hold 6,500 `habit_logs` and 3,709 `graph_entities`, so
"a problem that is not occurring" was not true when this entry was written.

What remains accepted is the reads whose bound is real (`n` at or below the
ceiling) or whose table is small admin/config data. That subset is now guarded
rather than asserted: `tests/no-limit-above-the-row-cap.test.ts` fails on any
`.limit()` above the cap, so the category cannot quietly refill.

---

### F-003 · `anon` held INSERT/UPDATE/DELETE on all five money tables

**Severity:** high (defence-in-depth) · **Status:** CLOSED — migration `0286`

`docs/audit/wallet-write-rls-check.sql` invariant 6 failed against a real
Supabase database:

```
A-08 FAIL: anon holds INSERT on wallet_transactions —
the restrictive guards are `to authenticated` and would not apply
```

The restrictive manager guards from `0254` are `TO authenticated`, and a
restrictive policy only ANDs with requests made **as a role it names** — for an
anonymous request they are simply absent. The grant layer is the only thing
closing that path, and it had never been closed: Supabase's default privileges
grant `arwdDxt` on every new `public` table to `anon`, and no migration revoked
it. All five money tables carried it.

**Not exploitable as found, and `0286` does not claim otherwise.** The only
permissive INSERT policy is also `TO authenticated`, so an anon insert is
refused for want of any permissive policy. Verified directly:

```
set role anon; insert into public.wallet_transactions (...) values (...);
ERROR:  new row violates row-level security policy for table "wallet_transactions"
```

What `0286` restores is the layer that makes that robust: one future permissive
policy written `TO public` — the exact stray shape `0275` had to sweep away —
would otherwise open an anonymous mint path no restrictive guard would catch.
Reads are deliberately left alone; the public gift flow writes through
`createServiceClient()`, so nothing legitimate loses a write.

### F-004 · The money-boundary probe could not catch F-003 in CI

**Severity:** high (false assurance) · **Status:** CLOSED — `pg-bootstrap.sh`

F-003 had been passing in CI for its entire life. `docs/audit/pg-bootstrap.sh`
built its roles by hand and granted `anon` only `SELECT`, so the shim was
**safer than production** — the wrong direction for a boundary harness. The
probe asserted something true of the shim and false of every real database.

The shim now reproduces Supabase's real default privileges, and does it *before*
migrations run, which is when they take effect on a real project — granting
after the migrations would have re-granted exactly what `0286` revokes and
silently undone it.

Proven non-vacuous end to end: re-granting `insert` to `anon` on the shim
reproduces `10/11 passed · FAILED: wallet-write-rls-check.sql`; revoking it
returns `11/11 passed`.

### F-005 · Every blog post not baked in at build time returned 500

**Severity:** high · **Status:** CLOSED

`/blog/none` answered **500** where all twelve sibling content routes answered
404. The server log gives the mechanism:

```
Error: Page changed from static to dynamic at runtime /blog/none, reason: cookies
```

`app/(marketing)/blog/[slug]/page.tsx` declared `revalidate = 3600` with
`dynamicParams = true`, but resolves locale per request through
`getTranslations()` → `cookies()`. Declaring ISR while reading cookies is not a
no-op: Next prerenders the route, sees the cookie read on a later request, and
throws. With `dynamicParams = true` that is a 500 for **every post published
since the last deploy** and for every unknown slug a crawler tries — where 404
is the right answer.

`app/(marketing)/blog/page.tsx` and `app/(marketing)/faq/page.tsx` carry the
same shape; there the served page is the stale prerender and the background
revalidation fails forever, so the page silently stops updating. All three are
now `dynamic = 'force-dynamic'`, which is what a per-request locale actually
means. A sweep confirms no other `revalidate` route reads cookies.

### F-006 · Any signed-in user could claim another household's AI jobs

**Severity:** high (cross-tenant) · **Status:** CLOSED — migration `0288`

`claim_ai_runs` is `SECURITY DEFINER` and scoped to the whole platform, not to a
family. `authenticated` held EXECUTE on it. Acting as an ordinary member of
family A:

```
set role authenticated; set request.jwt.claim.sub = '<member of family A>';
select * from public.claim_ai_runs(10, 60);
-> claimed ids: 00000000-0000-4000-8000-00000000ab01   (a run owned by family B)
```

So any signed-in user could lease AI runs belonging to any other household,
pull them out of the real worker's queue, drive the run state machine across
tenants, and read back the run ids. The same grant was open on
`claim_marketing_generation_jobs` (also to `anon`) and on the three
`loyalty_*` ledger functions.

**This had already been fixed twice.** `0253` revoked `claim_ai_runs` from
public/anon/authenticated and *raised an exception* if the revoke had not taken;
`0204` did the same for the loyalty trio. Both lockdowns were undone later in
the chain: Supabase's default privileges grant EXECUTE on functions straight to
anon and authenticated, so a later `create or replace` (`0263` re-creates
`claim_ai_runs`) hands the grant back. `0253`'s check passed because it verified
**its own moment**, not the final state — which is the only state a database
runs in.

`0288` re-asserts all five at the end of the chain. Verified after the fix: a
member and anon both get `42501 permission denied` through PostgREST, and
`service_role` still executes. The gated E2E journey that asserts exactly this
(`authenticated.spec.ts:150`, "Only the server worker may claim AI jobs") now
passes, having failed before.

### F-007 · The additive-migrations guard flagged a revoke as destructive

**Severity:** low · **Status:** CLOSED

`tests/migrations-are-additive.test.ts` scans for a bare `\btruncate\b`, so
`revoke insert, update, delete, truncate … from anon` in `0286` read as
destructive DDL — though it *removes* the ability to truncate. The guard already
masked one legitimate TRUNCATE (the trigger-event declaration); it now masks the
privilege list of a GRANT/REVOKE too. Both directions are pinned: a revoke is
allowed, and `REVOKE TRUNCATE … ; TRUNCATE TABLE public.history;` is still
rejected, so the mask cannot launder a real statement.

### F-008 · Six nightly jobs silently stopped at 1,000 rows

**Severity:** high · **Status:** CLOSED — `lib/supabase/read-all.ts`

PostgREST answers an unbounded `select()` with at most `db-max-rows` and reports
nothing — no error, no short-read signal. Measured against the live local
project, on real tables, through the real helper:

```
calendar_events  unbounded=1000  readAll=2012  distinct=2012  error=null
graph_entities   unbounded=1000  readAll=3709  distinct=3709  error=null
notifications    unbounded=1000  readAll=1420  distinct=1420  error=null
```

The unbounded read returns exactly 1,000 rows of a 2,012-row table and calls it
the table. `distinct == total` also shows the paged read neither repeats nor
skips a row across page boundaries.

This is not a scale-someday problem — **single households already exceed the
ceiling** in the seeded data:

```
habit_logs        max rows for one family: 6500
pet_care_records                           4000
graph_entities                             3709
calendar_events                            1906
notifications                              1402
```

Six cron jobs read their driving table with no pagination, so past 1,000 rows
each silently did part of its work and reported success:

| Job | Driving read |
|---|---|
| `weekly-digest` | every family |
| `notifications` | every family |
| `push-scan` | every family |
| `chore-reminders` | every open assignment due this week |
| `calendar-feeds` | every subscribed feed |
| `checkout-abandoned` | every pending checkout session |

All six now read through `readAll`. It is deliberately **not** applied where a
bound is correct — an admin list wants a limit, not every row. Nine unit tests
pin the behaviour (see F-011 for the two that matter most).

Verified by running each route end to end against the live stack:

```
weekly-digest        {"sent":0,"failed":1}                        [502]
notifications        {"ok":false,"families":16,"created":100,…}
push-scan            {"ok":true,"families":16,…}                  [200]
chore-reminders      {"sent":0,"failed":1}                        [502]
calendar-feeds       {"ok":false,"feeds":3,"synced":0,"failed":3} [502]
checkout-abandoned   {"pending":0,"abandoned":0,"fired":0}        [200]
```

The 502s are local delivery failures — no real Resend key, fake feed URLs — and
are now *reported* rather than crashing the run (F-009).

### F-009 · A provider error in the mailer took down the whole cron run

**Severity:** high · **Status:** CLOSED — `lib/email.ts`

`sendReactEmail` is typed `Promise<{ ok: boolean }>` and every caller is built on
that: the weekly digest counts a failure per family and moves on. But it only
handled the SDK's `{ error }` return — a *thrown* provider error (network
failure, or a malformed key, which surfaces from inside the client as a bare
`TypeError: b is not a function`) escaped and took the caller with it.
Observed: `GET /api/cron/weekly-digest` → **500**, mid-run, abandoning every
family after the first.

Now wrapped, so the function keeps its contract. After the fix the same route
answers `{"sent":0,"failed":1}` — it completes and reports instead of crashing.
Five unit tests pin it, including the exact `TypeError` shape.

### F-010 · Notification generation failed outright for affected households

**Severity:** high · **Status:** CLOSED — migration `0289`

`notifications.related_id` was typed `uuid`, but three subsystems deliberately
store a **composite dedupe key** in it — that is what the column is for, since
the generic pass skips any candidate whose `(type, related_id, user_id)` already
exists:

```
lib/server/notifications.ts   'moment:<eventId>:<date>'  (so a recurring
                              occurrence pings at most once), 'conflict:<ids>'
lib/services/approvals        .in('related_id', candidates.map(c => c.dedupe_key))
lib/ai/tools/notifications    related_id: z.string().nullish()
```

Postgres rejected every one:

```
Notification generation failed for family 11111111-…:
invalid input syntax for type uuid: "moment:3fd2b8f5-…:2026-09-14"
```

The throw is caught per family, so the cron reported success overall — while
that household received **no notifications at all** from the run, not merely no
moment reminder. Five of sixteen seeded families hit it on one pass.

The column was the outlier: polymorphic, qualified by `related_type`, with no
foreign key and no index, and a read-side helper (`entityIdFrom`) whose job is
to pick the uuid back out of a colon-delimited string. `0289` widens it to
`text` — lossless. Measured before and after on the same cron run:

| | before | after |
|---|---|---|
| uuid errors | 5 | **0** |
| families failing generation | 5 | **0** |
| notifications created | 100 | **117** |
| `push-scan` | 502, `failed: 5` | **200, `failed: 0`** |

---

### F-011 · The fix for F-008 had the same defect it was written to fix

**Severity:** high · **Status:** CLOSED — `lib/supabase/read-all.ts`

Found by comparing `readAll` against `lib/supabase/read-all-pages.ts`, a paging
helper that already existed in the repo and did one thing differently.

`readAll` asked for rows `0–999`, and treated **any page shorter than 1,000 as
the end of the table**. That is only true if the server never returns fewer rows
than the range requests — and returning fewer rows than requested is precisely
what `db-max-rows` does. `db-max-rows` is a per-project setting; 1,000 is the
default, not a guarantee. Against a project set lower, the helper written to
prevent silent truncation reproduced it, and worse — advancing by the range
*requested* rather than the rows *received* also skips the rows in between:

```
table rows:            2011
server cap per page:   500
old loop returned:     500 rows, error=null
households lost:       1511
```

Two rules now hold, and both are pinned by tests that fail without them:

- **Advance by the rows received**, never by the range requested.
- **Stop only on an empty page.** A short page is not proof of the end; it is
  equally the signature of a cap. One extra round trip tells them apart.

A page that reports neither rows nor an error is now a failure rather than an
ending — "no data, no reason" is the exact shape of the truncation being
guarded against.

Three hand-rolled paging loops existed; there is now one. `readAllPages` keeps
its stricter contract (any failure yields *no* rows, so a partial read can never
be mistaken for a household's complete history) and delegates the loop. Its
pre-existing test — *"continues when a server returns fewer rows than the
requested range"* — passes unchanged against the shared implementation, which is
what proves the contract survived consolidation.

### F-012 · The sitemap search engines read was six days stale, and would have stayed stale for a year

**Severity:** high · **Status:** CLOSED — `lib/blog/posts.ts`, `app/sitemap.ts`

The live sitemap listed **1,048** blog URLs. The database held **1,049**
published posts. One article was simply absent from the file search engines use
to discover content.

It was not a paging bug, an RLS bug, or a missing row. `app/sitemap.ts` was
prerendered, and Next patches `fetch`: for a route it prerenders, the response
goes into the build Data Cache under the route's revalidate. The route declared
none, so the entry was written with Next's "forever" value and no tag able to
clear it. Decoded straight out of `.next/cache/fetch-cache`:

```
url:        …/rest/v1/blog_posts?select=slug,title,excerpt,…&published=eq.true
rows:       1000                     (a second entry held the remaining 48)
revalidate: 31536000                 ← one year
tags:       []                       ← nothing can revalidate it
written:    2026-09-07 23:50
```

1,000 + 48 = the 1,048 in the shipped sitemap. A build on **2026-09-13** served
its blog list from entries written **six days earlier**, and Vercel restores
`.next/cache` between deploys — so redeploying would not have fixed it. Every
article published from that day on would have been invisible in the sitemap for
a year. On a site whose organic surface *is* its blog, that is the whole point
of publishing.

Why it stayed invisible: `getAllPosts` ended in a bare `catch { return []; }`.
The failure had no voice.

Fixed in three parts, each verified:

1. **The reads leave the cache.** The blog's Supabase client passes its own
   `fetch` with `cache: 'no-store'`, so every query this module makes is
   covered — not just the one that was noticed. The blog pages themselves are
   `force-dynamic`, so nothing there was ever cached and nothing there changed.
2. **The route says what it is.** `export const dynamic = 'force-dynamic'` on
   `app/sitemap.ts`. `no-store` alone already forced this, but only by *throwing*
   during Next's trial static render — which is how the third part surfaced.
3. **The catch stops swallowing framework control flow.** `unstable_rethrow(error)`
   runs before the fallback in both readers. Next signals "this route cannot be
   static" by throwing out of the fetch; swallowing it hands Next an empty
   article list and lets it prerender and ship that. It had in fact already
   written such an artifact — a 4,055-byte sitemap with no posts in it.

Because the route now renders per request, it also stopped reading what it does
not use: `getAllPostRefs` selects `slug, published_at` instead of all thirteen
card columns — kilobytes per crawl instead of about a megabyte.

Before and after, against the running production build:

```
before   1048 blog <loc>   audit-fixture-post absent    227,217 bytes
after    1049 blog <loc>   audit-fixture-post present   227,389 bytes, 141–226 ms
```

Also fixed while here: `published_at` alone ordered the paged blog read, and
**717 of the 1,049 published rows share a date with another row**. Two pages are
two separately planned queries, so a tied boundary is free to move between them
— repeating one row and dropping another. The read now orders by
`published_at, slug`.

Four tests pin all of it, and **three of the four fail** when the fix is
reverted (`cache: 'force-cache'`, no `force-dynamic`, no `unstable_rethrow`) —
so the guard is not passing vacuously.

### F-013 · Fifty-nine reads asked for more rows than the server would ever return

**Severity:** high · **Status:** CLOSED — `readAll(…, { max })`

`.limit(n)` for n above the row ceiling is not a bound. It is a silent
truncation wearing the costume of a deliberate choice: PostgREST caps a response
at `db-max-rows` whatever the client asked for, so the number in the source reads
as a considered ceiling in review and returns 1,000 in production.

Measured against the live project, with the app's own numbers:

```
habit_logs       table=6500   asked .limit(5000) → got 1000
graph_entities   table=3709   asked .limit(4000) → got 1000
graph_edges      table=999    asked .limit(8000) → got  999   (under the cap: honest)
```

**Fifty-nine call sites** had written such a limit. What each one was actually
doing:

| Read | Wrote | Got | Consequence |
|---|---|---|---|
| `habit_logs` (AI habit coach) | 5,000 | 1,000 | streaks computed from a sixth of the history |
| `graph_entities` (`loadFamilyGraph`) | 4,000 | 1,000 | the AI reasons over a quarter of the household's graph — under a docstring promising never to present a partial view as current |
| `wallet_transactions` (×5 surfaces) | 2,000–20,000 | 1,000 | balances and the reconciliation page totalled from part of the ledger |
| `ab_events` per chunk | 100,000 | 1,000 | every experiment conversion rate a 1,000-row sample, read as exact |
| `calendar_events` (migration de-dupe) | 5,000 | 1,000 | an import re-adds events it cannot see |
| `transactions`, `mkt_touchpoints`, `marketplace_saves`, … | 2,000–10,000 | 1,000 | counts and sums reported as exact |

This is not a scale-someday problem — **single households already exceed the
ceiling** in the seeded data: `habit_logs` 6,500, `pet_care_records` 4,000,
`graph_entities` 3,709, `calendar_events` 1,906, `notifications` 1,402.

Every site now reads through `readAll`/`readAllAsQuery` with `max` set to the
number its author meant, which is honoured by paging to it. `readAllAsQuery`
answers in the `{ data, count, error }` shape a query answers, so a read inside a
`settleAll([...])` batch swaps one expression and nothing else moves.

`tests/no-limit-above-the-row-cap.test.ts` scans `app/` and `lib/` and fails on
any `.limit(n > 1000)`, with its own non-vacuity case pinning that the scan
catches the pattern and does not fire on a real bound or on prose describing the
rule. Verified after: typecheck clean, 13,108 tests, 353-route crawl with 0
failures, all 11 cron routes complete, and each of the 20 changed pages returns
200.

### F-014 · Notification dedupe failed on every run, so every run re-notified

**Severity:** high · **Status:** CLOSED — `lib/server/notifications.ts`, `lib/services/approvals`

Found by reading the server log after exercising the cron routes:

```
[notifications] dedup read failed { familyId: …, error: { message: 'URI too long\n' } }
[service:approvals] reminder dedupe read failed { familyId: …, error: { message: 'URI too long\n' } }
```

A PostgREST filter travels in the **query string**. Since `0289` (F-010) these
ids are no longer uuids — `related_id` carries a composite dedupe key such as
`moment:<eventId>:<date>` — and a few hundred of them build a request line past
the gateway's limit. Measured, by binary search against the live project:

```
  50 ids → URL  3168 bytes → 200
 100 ids → URL  6268 bytes → 200
 150 ids → URL  9418 bytes → 414
```

The code already named the consequence, in a comment written beside the read:
*"A failed dedup read leaves `seen` empty, so every candidate would pass the
filter and re-insert as a duplicate."* That is exactly what was happening, every
run, unnoticed — because the failure only logs, and the run still reports success.
The damage was measurable in the database: **117 duplicate
`(type, related_id, user_id)` groups holding 1,300 rows.** The approvals path
failed the other way, skipping the family every tick rather than duplicating.

Both reads now batch through `lib/supabase/chunked-in.ts` — the helper that
exists for this exact failure — at 50 ids per request, which the measurement
above puts at ~3 KB.

Proof, on the running production build:

```
before   [notifications] dedup read failed … URI too long   (every run)
after    URI-too-long errors: 0 · dedupe failures: 0
run 1    approvals reminded: 334 across 1 family   ← had been skipped every tick
run 2    approvals reminded: 0                     ← dedupe now suppresses
3 further runs → duplicate groups 117 → 117        ← no new duplicates
```

### F-015 · A probe granted itself privileges and left them, poisoning the suite

**Severity:** high · **Status:** CLOSED — `docs/audit/rls-isolation-check.sql`

The audit's own instrument was unsound, which makes it the most important finding
here: **a probe suite whose answer depends on what ran before it is not
evidence.**

`rls-isolation-check.sql` carried a bare

```sql
grant execute on all functions in schema public to authenticated;
```

so that one call below it could run as `authenticated`. It never revoked it. That
single statement undoes the deliberate revokes in `0204`/`0253`/`0288` and hands
`authenticated` EXECUTE on `claim_ai_runs` and the four loyalty RPCs — **the exact
cross-tenant hole F-006 closed.**

Probes glob alphabetically, so `privileged-rpc-grants-check` (**p**) ran *before*
`rls-isolation-check` (**r**) and passed; every run after that saw a poisoned
database. Observed directly: 13/13, then the same probe failing on a re-run
against the same database, naming all five RPCs. I had previously written that
flip off as my own out-of-order manual SQL. That was wrong — the leak was in the
suite, and saying so is the point of keeping this entry.

Two things were fixed:

1. **The grant is gone.** It was never needed: `CREATE FUNCTION` grants EXECUTE
   to PUBLIC, so `authenticated` can already call that RPC. Verified on a
   pristine 305-migration replay, before any probe ran —
   `has_function_privilege('authenticated', 'marketplace_create_circle', 'EXECUTE')`
   is already true, while all five privileged RPCs read service-role-only.
2. **An assertion that was only true because of the grant was corrected.**
   Invariant 5 matched `sqlerrm ilike '%not authorized%'`, the in-function check.
   With EXECUTE revoked from `authenticated` *and* PUBLIC, Postgres refuses the
   call outright — `42501: permission denied for function` — which is the
   *stronger* boundary, and the probe was reading it as a failure. It now accepts
   either, and still fails if the call SUCCEEDS, which is the thing that must
   never happen.

Now repeat-stable, which it was not before:

```
run 1  == probes: 13/13 passed ==
run 2  == probes: 13/13 passed ==
run 3  == probes: 13/13 passed ==
and after all three, the five privileged RPCs still read
  authenticated=false  anon=false  service_role=true
```

### F-016 · The documented crawl workflow drops a live session cookie into the working tree

**Severity:** low · **Status:** CLOSED — `.gitignore`

`npm run crawl:login` writes `cookies.json` — a real Supabase session cookie for
whatever account signed in — into the repository root, and `crawl:routes` reads
it back. Both are documented workflows and were run several times during this
audit, so the file lands in the working tree routinely. It was **not** gitignored:

```
$ git status --short
?? cookies.json
$ git check-ignore -v cookies.json
(no match)
```

Nothing had committed it, but the next `git add -A` by anyone following the
documented steps would have. Now ignored, with the reason written beside the
entry so it is not "tidied away" later by someone who reads it as a stray
artifact:

```
$ git check-ignore -v cookies.json
.gitignore:36:cookies.json	cookies.json
```

## 4. Closed previously (regression-checked this pass)

| ID | Finding | Still closed by |
|---|---|---|
| C-001 | `weekly-digest` read `status`/`assignee_id` off `chores`; filtered `meal_plans` on `planned_for` — every digest skipped | `db:audit:queries` |
| C-002 | Meals AI insight selected `meals.servings` (a `recipes` column) | `db:audit:queries` |
| C-003 | `getUserContext` threw on `AuthSessionMissingError` — expired cookie became a full-page error | `auth-context-error-contract.test.ts` |
| C-004 | A failed `user_preferences` read took down every authenticated page | same test |
| C-005 | 14 chrome-mounting sections had no `error.tsx` | re-verified: every section with a layout has one |
| C-006 | `app_settings` RLS-enabled with no policy since `0023` | `0276` |
| C-007 | OAuth callback bounced a just-signed-in user to `/login` | `auth-callback-boundary.test.ts` |
| C-008 | Sign-out unreachable from two gates (`<a href>` vs POST-only route) | `persistent-login.test.ts` |
| C-009 | `/dashboard/conflicts` emitted unbounded HTML | crawl: renders clean |
| C-010 | Knowledge Center showed English under translated headings | `0277` |
| C-011 | `rpc('public_handled_stats')` undefined — marketing figures silently zero | `0278` |
| C-012 | `privacy-export` failed nightly 00:00–04:00 UTC | suite green |

---

## 5. Reviewed, not a defect

- **Service-role client in `dashboard/settings` and `dashboard/billing`.** Both
  read global, non-secret config (referral config; Stripe fee display) under
  `(app)/dashboard/layout.tsx`, whose `AppFrame` calls `requireUserContext`. No
  user input reaches either query.
- **17 `TODO(migration …)` markers.** Each names a schema change deliberately
  deferred for owner approval — documentation of a boundary, not dead code.
- **1 lint warning** (`react-hooks/exhaustive-deps`), pre-existing.
- **`/gift/<bad token>`, `/pay/<unknown>`, `/s/<unknown>` answer 200.** These
  render an explicit "not found / expired" state rather than a bare 404, which
  is the better answer for a link someone was handed.

---

## 6. Verification log

| What ran | Result |
|---|---|
| `tsc --noEmit` | clean |
| `next lint` | 0 errors, 1 warning |
| `vitest run` | 13,108 tests passed |
| `next build` | exits 0 |
| `db:audit:queries` | passed |
| `db:audit:migrations` | passed, next version 0287 |
| `i18n:gate` | clean |
| fresh-DB migration replay | 302/302 applied, 0 failed |
| `run-probes.sh` (fresh replay, ×3) | 13/13 every run; the five privileged RPCs still service-role-only afterwards |
| 353-route authenticated crawl | 351 ok · 1 gate redirect · 0 failures |
| unknown-slug probe, 16 public routes | all degrade correctly after F-005 |
| API guard sweep | 140/140 guarded or declared public |
| `authenticated.spec.ts` + `concierge.spec.ts` | both pass (needed `E2E_PROVIDER_STUB=1`) |
| all 6 cron routes, live stack | each completes and reports; no run aborts |
| `readAll` vs live PostgREST, 3 tables | 2012 / 3709 / 1420 rows, all distinct; unbounded returns 1000 |
| old paging loop vs a 500-row server cap | returned 500 of 2011, `error=null` — the defect F-011 closes |
| `/sitemap.xml` on the running build | 1,049 blog URLs (was 1,048), 141–226 ms |
| F-012 guard with the fix reverted | 3 of 4 tests fail — not vacuous |
| `/blog`, `/blog/audit-fixture-post` | 200, 363 ms / 200 |
| all 11 cron routes, live stack | each completes and reports; no run aborts |
| 20 changed pages (wallet, marketplace, admin, dashboard) | 200 each |
| `.limit(n > 1000)` scan of `app/` + `lib/` | 0 remaining; guard fails on a planted one |
| PostgREST request-line limit, binary search | 200 at 6,268 bytes · 414 at 9,418 |
| notifications cron ×5 | URI-too-long: 0 · duplicate groups 117 → 117 |
| pristine replay, grants before any probe | five privileged RPCs service-role-only |
| `git check-ignore cookies.json` | ignored (was untracked and committable — F-016) |
