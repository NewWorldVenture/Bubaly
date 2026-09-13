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
| Unit tests | `vitest run` | ✅ 1,146 files / 13,074 tests |
| Build | `next build` | ✅ exits 0 |
| Schema ↔ code | `db:audit:queries` | ✅ 491 tables, 77 functions, 140 routes resolve |
| Migration names | `db:audit:migrations` | ✅ 302 files, no collisions |
| Migration replay | fresh DB, 0 → 302 | ✅ all applied, 0 failed |
| i18n | `i18n:gate` | ✅ all declared surfaces clean |
| RLS boundaries | 11 probes, real Supabase | ✅ 11/11 (was 10/11 — see F-003) |
| Authenticated routes | 379-route crawl | ✅ 377 ok, 1 gate redirect, 0 failures |
| Public content routes | unknown-slug probe | ✅ 404s (was one 500 — see F-005) |
| API authorization | guard-vs-public-list sweep | ✅ 140/140 accounted for |
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

### F-002 · 243 unbounded `select()` reads

**Severity:** medium · **Status:** OPEN, triaged — no current failure

`.from(...).select(...)` with no `.limit()`, no `.single()`, no `head:true`
count, across `app/`. This is the class that produced the `/dashboard/conflicts`
outage (723 events → pairwise blow-up → >512 MB of HTML, never completed).

**Triaged against evidence, not fixed blind.** The 379-route crawl against a
household seeded with 2,006 calendar events returned 377 ok and zero slow or
oversized responses, so none of the 243 is failing today. The majority read
small admin/config tables where a limit would be noise. Left open deliberately:
the honest statement is "no current failure, and no bound protecting us if one
of these tables grows", not "fixed".

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
| `vitest run` | 1,146 files / 13,074 tests passed |
| `next build` | exits 0 |
| `db:audit:queries` | passed |
| `db:audit:migrations` | passed, next version 0287 |
| `i18n:gate` | clean |
| fresh-DB migration replay | 302/302 applied, 0 failed |
| `run-probes.sh` (real Supabase) | 11/11 after `0286` (10/11 before) |
| 379-route authenticated crawl | 377 ok · 1 gate redirect · 0 failures |
| unknown-slug probe, 16 public routes | all degrade correctly after F-005 |
| API guard sweep | 140/140 guarded or declared public |
