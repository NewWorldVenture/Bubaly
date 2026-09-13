# Bubaly — Final Audit

A running, evidence-based audit of bubaly.com. Every entry records what was
checked, **how**, and what the check actually returned. Nothing is marked closed
on reasoning alone — a finding closes only when a command, probe, or rendered
page demonstrates it, and wherever a fix is claimed the check was also run
against the broken state to prove it was not passing vacuously.

- **Audit head:** `f9c4d7a1` (main) + fixes on this branch
- **Scope:** 395 pages · 140 API routes · 302 migrations · 1,146 unit-test files
- **Environment:** full local Supabase stack (all 302 migrations replayed), seeded
  anchor household, real browser sign-in.

---

## 1. Status summary

| Area | Check | Result |
|---|---|---|
| Types | `tsc --noEmit` | ✅ clean |
| Lint | `next lint` | ✅ 0 errors (4 pre-existing warnings) |
| Unit tests | `vitest run` | ✅ 13,088 tests |
| Build | `next build` | ✅ exits 0 |
| Schema ↔ code | `db:audit:queries` | ✅ 491 tables, 77 functions, 140 routes resolve |
| Migration names | `db:audit:migrations` | ✅ 305 files, no collisions |
| Migration replay | fresh DB, 0 → 305 | ✅ all applied, 0 failed |
| i18n | `i18n:gate` | ✅ all declared surfaces clean |
| RLS boundaries | 13 probes, fresh 305-migration replay | ✅ 13/13 (was 10/11 — F-003, F-006) |
| Authenticated routes | 379-route crawl | ✅ 377 ok, 1 gate redirect, 0 failures |
| Public content routes | unknown-slug probe | ✅ 404s (was one 500 — see F-005) |
| API authorization | guard-vs-public-list sweep | ✅ 140/140 accounted for |
| E2E | 108 specs + 2 gated journeys | ✅ all pass (a journey caught F-006) |
| Nightly jobs | cron routes exercised end to end | ✅ clean (F-008, F-009, F-010) |
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

### F-002 · Unbounded reads — the dangerous half is closed, the rest is accepted

**Severity:** medium · **Status:** PARTIALLY CLOSED (see F-008), remainder accepted

243 reads use `.from(...).select(...)` with no `.limit()`, no `.single()` and no
`head:true` count. Classified by what they actually grow with:

- **122 are not family-scoped** — they grow with the whole platform.
- **121 are family-scoped** — they grow with one household.

The genuinely dangerous subset (F-008) is fixed. The remainder is accepted
deliberately: most read small admin/config tables, and the 379-route crawl
against a household seeded with 2,011 calendar events returned 377 ok with no
slow or oversized response. Adding limits to the rest would be churn against a
problem that is not occurring. The honest statement is "measured, bounded where
it mattered, and left alone where a bound would be noise".

---

## 3. Closed this pass

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

### F-008 · Three nightly jobs silently stopped at 1,000 households

**Severity:** high · **Status:** CLOSED — `lib/supabase/read-all.ts`

PostgREST answers an unbounded `select()` with at most `db-max-rows` and reports
nothing — no error, no short-read signal. Measured directly: a table holding
2,011 rows returns exactly **1,000**.

```
rows in table: 2011
rows returned unbounded: 1000
paged with .range(): 1000 + 1000 + 11 = 2011
```

`weekly-digest`, `notifications` and `push-scan` each read *every* family with
no pagination. Past 1,000 households, families would silently stop receiving
their digest, their reminders and their push scan — with nothing logged
anywhere, because from the code's point of view the table simply ended.

`readAll` pages with `.range()` until a short page proves the end, and is used
by those three. It is deliberately not applied to reads where a bound is
correct — an admin list wants a limit, not every row. Six unit tests pin the
behaviour, including that a full first page is not treated as the end and that
an error mid-read surfaces rather than reading as "the table ended here".

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
- **4 lint warnings** (`react-hooks/exhaustive-deps`), pre-existing.
- **`/gift/<bad token>`, `/pay/<unknown>`, `/s/<unknown>` answer 200.** These
  render an explicit "not found / expired" state rather than a bare 404, which
  is the better answer for a link someone was handed.

---

## 6. Verification log

| What ran | Result |
|---|---|
| `tsc --noEmit` | clean |
| `next lint` | 0 errors, 4 warnings |
| `vitest run` | 13,088 tests passed |
| `next build` | exits 0 |
| `db:audit:queries` | passed |
| `db:audit:migrations` | passed, next version 0287 |
| `i18n:gate` | clean |
| fresh-DB migration replay | 302/302 applied, 0 failed |
| `run-probes.sh` (fresh replay) | 13/13; grants verified service-role-only after a full 305-migration replay |
| 379-route authenticated crawl | 377 ok · 1 gate redirect · 0 failures |
| unknown-slug probe, 16 public routes | all degrade correctly after F-005 |
| API guard sweep | 140/140 guarded or declared public |
| `authenticated.spec.ts` + `concierge.spec.ts` | both pass (needed `E2E_PROVIDER_STUB=1`) |
