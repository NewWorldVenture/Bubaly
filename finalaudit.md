# Bubaly — Final Audit

# Part 0 — Consolidated index (authoritative)

*Rebuilt 2026-09-14 by Claude-1. This is the one current view. The two
`Executive Summary — session record` sections below are the earlier summaries,
kept verbatim; where they disagree with this part, this part is newer.*

**Thirteen passes, A–M. 96 numbered findings.**

| Pass | Surface | Findings |
|---|---|---:|
| A | Public surface: marketing, SEO, crawler contract, entitlements | 22 (`F1`–`F22`) |
| B | Data layer: RLS, grants, nightly jobs, query plans, money concurrency | 20 (`F-001`–`F-020`) |
| C | Delivery and integration: page weight, routing, env contract, workflows | 10 (`F-C01`–`F-C10`) |
| D | Frontend and accessibility: the authenticated app | 14 (`F-D01`–`F-D14`) |
| E | Backend, auth and security: catalogue-verified RLS, 141 routes, storage | 9 (`F-E01`–`F-E09`) |
| F | QA, flows, performance, edge cases | 13 (`F-F01`–`F-F13`) |
| G | The audit's own instruments | 2 (`G1`, `G2`) |
| H | The auth-user ceiling; "manager" pinned to the database | fixes, unnumbered |
| I | `F-F04` — the spring-forward DST bug | fix |
| J | A reconciliation check that reconciled nothing | fix |
| K | A Stripe event acknowledged that nobody finished | fix |
| L | The marketing platform spine — the tables that had never replayed | 4 (`L1`–`L4`) |
| M | Reporting a failure is not surviving one; a feature nobody can enable | 2 (`M1`, `M2`) |

Session record 1 says "87 findings across six passes". That was true when
written; passes G–K have landed since, and Pass A is `F1`–`F22`, which is 22 and
not the 21 its table carried. Corrected here rather than in place.

## The one pattern worth carrying forward

**The failures in this repository are mostly guards that could not see what they
were named for.** A sweep that read one line at a time (Pass C). A probe that
granted itself the privileges it was testing for (`F-015`). A concurrency check
that never ran two things at once (`F-019`). An index test blind to `UNIQUE`.
A migration replay that only ever ran against an empty database (`F-020`).
Three boundary probes that passed while asserting nothing (`G1`). A bucket-drift
check that could not fire for any input (Pass J).

Verifying that a guard **fails when it should** is the highest-yield check in
this repository. Break what it protects and confirm it goes red; a guard nobody
has ever seen red is not evidence.

## What is still open

**Release blocker, needs a human operator — agents must not do this:**

| | Finding | State |
|---|---|---|
| `F5` / `F-001` | Production migration ledger records only `0001`–`0003`; every schema release halts at the baseline guard | **BLOCKED — operator credentials** |
| `F-C08` | Forward-release pinned to `0240`–`0254`; the repo is far past it | Code half fixed; the release itself is operator work |

That pair is the most important thing in this document, because it is also what
holds the CRITICAL finding away from production:

| | Finding | State |
|---|---|---|
| `F-E01` | Every child could read, edit and delete the family password vault; `secret` stored plaintext | Fixed by `0296` + a CI probe — **cannot reach production until the pair above clears** |
| `F-E04` | OAuth tokens in `social_account_tokens` were family-member readable | Fixed by `0297` (`can_manage_family`) — same constraint: in the repo, not in production |

**Open, no operator needed:** `F-E02` (step-up MFA is presentational — no policy
references `aal`), `F-E03` (`family-media` bucket public), `L1` (`anon` holds
TRUNCATE on all nine marketing-spine tables; RLS cannot constrain TRUNCATE — a
missing layer, not a live exploit, since PostgREST has no TRUNCATE verb), `L3`
(the spine has no probe), `L4` (the regeneration-loop guard tests a column value
rather than the statement), `F-F01` (a caller
`max` truncates a money read and still renders "Everything reconciles"),
`F-F02` (the `F-017` timezone bug live on eleven server-rendered surfaces),
`F-F03` (`/missions` — up to 240 sequential storage round trips), `F-D01`
(photo lightbox: no `role="dialog"`, no Escape, no focus trap), `F-D02`/`F-D03`
(55 detached labels, 65 unnamed `<select>`), `F-C07` (19 undocumented env vars),
`F-C09`, `F-C10`, `F19`, `F6`, `M2` (the calendar feed nobody can enable).

`F-D10` is the root cause under the accessibility findings and is worth more
than any single one of them: `.eslintrc.json` is `next/core-web-vitals` alone,
which enables **none** of the `jsx-a11y` rules that describe `F-D02`, `F-D03`
and `F-D06` — so `next lint` runs clean over ~1,000 files and the gap reads as a
green light.

## Coverage — and what "not audited" means here

*A heading with no findings says so. An area nobody has audited is recorded as
**not yet audited**, never as "clean": "we checked" and "we could not see" must
not read the same on this page.*

| Area | Audited by | Depth |
|---|---|---|
| Public surface, SEO, entitlement, child sign-in | Pass A | deep |
| Data layer, RLS, grants, cron, query plans, money concurrency | Pass B | deep |
| Delivery, routing, env contract, workflows | Pass C | deep |
| Frontend / UI / responsive / accessibility | Pass D | deep, but **static only — see below** |
| Backend / API / auth / security | Pass E | deep, **local replay only** |
| QA / flows / performance / edge cases | Pass F | deep |
| Architecture / integration seams | Claude-1, passes C/G/H | deep |
| Marketing platform spine tables (`0237`, `0239`, `0292`) | Claude-3, Pass L | deep — **gap closed 2026-09-14**, local replay only |
| Rendered accessibility: contrast, tab order, screen-reader output | **in progress 2026-09-14** | was **not audited** |
| Production schema as actually deployed | **nobody** | **not audited** — needs credentials |

### The three gaps this audit named as blocking its own completion

1. **No browser had ever been run.** Every Pass D finding is derived from
   reading source; colour contrast, real tab order and screen-reader output were
   unverified. *2026-09-14: this environment has Chromium, Playwright and
   `@axe-core/playwright`, so it is finally actionable and in progress. Scoped to
   the **public** surface — there is no local Supabase here (no usable docker
   daemon, no CLI), so the authenticated app cannot be signed into and Pass D's
   `app/(app)` findings stay statically derived.*
2. ~~**`0237`, `0239` and `0292` never replayed**~~ — **CLOSED 2026-09-14.**
   pgvector installed; 310 migrations applied, 0 failed; the nine spine tables
   audited. See **Pass L**. It found a real gap (`L1`) and, more importantly,
   **refuted one of Pass E's verified-healthy claims** (`L2`) — `anon` does hold
   write privilege on 483 of 491 tables, and the "zero" was an artefact of a
   hand-built test prelude. A wrong clean bill is worse than an unaudited area,
   because it stops the next person looking.
3. **Production was never verified.** Every Pass E finding describes the
   committed migrations replayed **locally**. If `F-001` holds, production may
   not carry even the policies verified correct. *Permanently blocked for agent
   workers: it needs operator credentials.*

---


> **Two audit sessions ran against this repository at the same time**, and both
> consolidated into this file. Git merged them cleanly, which is why there are
> two `# Executive Summary` sections: the first is this session's six-pass
> consolidation (87 findings, `F1`–`F21`, `F-001`–`F-020`, `F-C`, `F-D`, `F-E`,
> `F-F`), the second is the parallel session's, which reached main first and
> carries its own findings and fixes.
>
> **Neither is deleted.** The rule that no worker's findings are discarded
> applies across sessions as much as within one, and a merged record with two
> summaries is worth more than a tidy one missing half its evidence. The
> `audit/claude-*.md` working files are unioned the same way, each carrying both
> sessions' notes under a delimiter.
>
> Reconciling the two into a single summary is a deliberate follow-up, not
> something to do by picking a winner.


# Executive Summary — session record 1 (six-pass consolidation, superseded as the index)

> Kept verbatim. Part 0 at the top of this file is the current index; this is the
> summary as that session wrote it, with its own caveats intact. Its Pass A row
> reads 21; the pass is F1-F22, which is 22. Corrected in Part 0, not here.

**87 findings across six passes.** This document is the consolidated record.
The sections below are an **index**: each entry names a finding and links it to
the pass that holds its evidence. The passes themselves follow, in full, and are
never rewritten — a finding's detail, method and caveats live there.

| Pass | Surface | Findings |
|---|---|---:|
| A | Public surface: marketing, SEO, crawler contract, entitlements | 21 |
| B | Data layer: RLS, grants, nightly jobs, query plans, money concurrency | 20 |
| C | Delivery and integration: page weight, routing, env contract, workflows | 10 |
| D | Frontend and accessibility: the authenticated app | 14 |
| E | Backend, auth and security: catalogue-verified RLS, 141 routes, storage | 9 |
| F | QA, flows, performance, edge cases | 13 |

**Where the project actually stands.**

Most of what was found has been fixed. Passes A and B closed the large majority
of their findings, and Pass C shipped and verified five changes in production on
the day it ran. The public surface is in good shape: headers, structured data,
image alt text, redirects, canonical URLs and the sitemap are all now correct
and covered by tests that fail when they regress.

Three things are not fine, and they compound:

1. **There is no working path to apply a migration to production.** The
   migrations workflow cannot authenticate (**F5**), and the forward-release
   mechanism is pinned 38 migrations in the past (**F-C08**). Every migration
   from `0255` to `0296` is written, reviewed, merged — and unapplied. This is
   the single most important item in this document, because it is also what
   blocks the fix for the next one.
2. **A child can read the family password vault** (**F-E01**). Fixed by
   migration `0296` with a probe CI runs, and inert until item 1 is resolved.
3. **Authorization has a pattern of being drawn on the screen rather than in the
   database.** F16, F18, F20, F21, F-003, F-006, F-E01 and F-E02 are the same
   mistake in eight places: a control the UI enforces and the data layer does
   not. Most are now fixed; **F-E02** (step-up MFA that no policy knows about)
   is not.

**What has not been examined**, stated plainly so the gaps are not mistaken for
clean bills: no browser was run, so colour contrast, real tab order and
screen-reader output are unverified (Pass D); migrations `0237`, `0239` and
`0292` did not replay without the `vector` extension, so the marketing platform
spine tables were not checked (Pass E); and every Pass E finding describes the
committed migrations as replayed locally — if **F-001** holds, production may
not carry even the policies verified correct.

---

# Critical Issues

| | Finding | Status |
|---|---|---|
| **F-E01** | Every child can read, edit and delete the family password vault; `secret` is plaintext | **Fixed by `0296` + a CI probe — cannot reach production until F5/F-C08** |

---

# High Priority

| | Finding | Status |
|---|---|---|
| F5 / F-001 | Production migrations cannot be applied — the ledger records only `0001–0003` | **BLOCKED — operator** |
| F-C08 | The forward-release mechanism is pinned to `0240–0254`; the repo is 38 migrations past it | **Code half fixed — re-pinning is now a manifest change; the release itself is still owner/operator** |
| F-E02 | Step-up MFA is presentational; no policy references `aal`, and guarded pages fetch straight from PostgREST | OPEN |
| F-E03 | The `family-media` bucket is public; photos and attachments are served with no session | OPEN (known, tracked as LB-009) |
| F-F01 | A caller-supplied `max` truncates a money read and reports success; reconciliation renders "Everything reconciles" from a prefix | OPEN |
| F-F02 | F-017's timezone bug still live on eleven server-rendered surfaces, including the kids page | OPEN |
| F-F03 | `/missions` issues up to 240 sequential storage round trips on the parent approval queue | OPEN |
| F-D01 | The photo lightbox strands keyboard users: no `role="dialog"`, no Escape, no focus trap | OPEN |
| F-D02 / F-D03 | 55 labels detached from their control; 65 `<select>` with no accessible name | OPEN |
| F21 | A child could grant themselves a reward | Half fixed and live, half awaiting the operator |
| F1, F9, F10, F15, F16, F18, F20 | sitemap dead URLs; whole i18n catalogue per page; seeded records shown as real customer stories; Autopilot running for every family; paid features enforced by a padlock; ungated endpoints; a child clearing the chore board | **all fixed** |
| F-C01, F-C02, F-C03 | sitemap dated by generation time; 445 non-indexable URLs; the catalogue on every public page | **all fixed and verified in production** |

---

# Medium Priority

F2, F4, F6, F7, F11, F17, F19 (Pass A) · F-002, F-004, F-005, F-007, F-008,
F-009, F-010, F-011, F-012, F-013, F-014, F-015, F-016, F-018, F-019, F-020
(Pass B) · F-C04, F-C07, F-C10 (Pass C) · F-D04–F-D10 (Pass D) · F-E04–F-E07
(Pass E) · F-F04–F-F09 (Pass F).

Still open among them: **F-C07** (19 undocumented env vars, including one whose
absence silently rejects every inbound email), **F-C10** (the Expo app has no
tests), **F19** (unmetered AI endpoints — a pricing decision), **F6** (family
email built but not routed), and the Pass D/E/F entries listed in their own
sections below.

---

# Low Priority

F3, F8, F12, F13, F14 (Pass A) · F-C06, F-C09 (Pass C) · F-D11–F-D14 (Pass D) ·
F-E08, F-E09 (Pass E) · F-F10–F-F13 (Pass F).

---

# Architecture

- **F-C09** — Supabase credentials fail at first use, not at boot; a
  misconfigured deploy degrades into scattered 500s. OPEN.
- **Verified clean**: the server/client boundary holds (no client module
  imports `createServiceClient` or the service-role key); the CSP matches every
  host the browser actually calls; `npm audit --production` reports zero
  advisories at every severity.

---

# Frontend

Pass D in full. The root cause is **F-D10**: `.eslintrc.json` is
`next/core-web-vitals` alone, which enables none of the `jsx-a11y` rules that
describe F-D02, F-D03 and F-D06 — so `next lint` runs clean over ~1,000 files
and the gap reads as a green light. Fixing the config is worth more than fixing
any single finding beneath it.

Also here: **F-D05** (19 authenticated pages render no `<h1>`; 11 render no
heading at all), **F-D08** (all 354 authenticated pages share one loading
skeleton), **F-D09** (ten components set state from an un-cancelled async
effect), **F-D12** (two admin links point at routes that exist only at runtime).

---

# Backend

**F-F01** (a capped read reporting success) is the most consequential, because
it produces a *confidently wrong* answer about money rather than an error.
**F-E09** (an authorization failure answering 500 rather than 403) and
**F-F08** (`addFundsAction` writing the balance directly) sit alongside it.

Pass B's twenty findings are the bulk of this area and are almost entirely
closed.

---

# Database

- **F-001 / F5** — the production ledger. The blocker everything else waits on.
- **F-E01** — the vault policies. Fixed by `0296`.
- **F-003** (`anon` held write grants on all five money tables), **F-006**
  (cross-household AI job claiming), **F-018** (nine sequential scans),
  **F-013** (fifty-nine over-sized reads) — all fixed.
- **Verified**: no table is actually missing RLS once the catalogue is read
  rather than grepped. A text scan claims 216 are; the catalogue says none.
  Recorded because the grep result is a trap a later pass would fall into.

---

# Security/Auth

| | Finding | Status |
|---|---|---|
| F-E01 | The family password vault, open to children, secrets in plaintext | Fixed by `0296`, unapplied |
| F-E02 | Step-up MFA is a redirect; no policy knows `aal` | OPEN |
| F-E03 | `family-media` is a public bucket | OPEN |
| F-E04 | OAuth tokens family-member readable, while `sync_tokens` is service-only | OPEN |
| F-E05 | `feedback-attachments` is a public bucket | OPEN |
| F-E06 | The Contact Center secret is accepted in the query string, where it lands in logs | OPEN |
| F-E07 | Twilio signature verification is off outside production | OPEN |
| F-E08 | Shared-secret comparisons are not constant time | OPEN |
| F16, F18, F20, F21, F-003, F-006 | authorization drawn on screen rather than in the database | fixed |

---

# UX/Accessibility

Pass D. **F-D01** (the lightbox) is the one a keyboard user hits first.
**F-D07** — 92 destructive actions guarded only by `window.confirm()` — is the
one with the widest blast radius. **F-F11** (a discarded signing error showing a
parent a blank frame rather than a reason) belongs here too.

**Unverified, not clean**: contrast, tab order and screen-reader output.

---

# Performance

- **F-C03** — the i18n catalogue on every public page. Fixed: `/cookies`
  266 KB → 20 KB gzipped, `/` 291 → 45 KB.
- **F-C04** — `/blog` shipped all 1,048 posts to the browser. Fixed:
  89 → 40 KB gzipped, verified in production.
- **F-F03** — up to 240 sequential storage round trips on `/missions`. OPEN.
- **F-F09** — unbounded concurrent fan-out to an external drive-time API. OPEN.
- **F-018** — nine family-scoped reads doing sequential scans. Fixed.

---

# Mobile/Responsive

**F-C10** — the Expo app is 42 TypeScript files with **zero** tests, behind a CI
job that installs, typechecks and validates config. No lint, no unit tests, no
build. Nothing audits its dependency tree either: `npm audit` there reports 14
moderate advisories while the web tree reports none.

Responsive behaviour of the web app was checked by reading source only; the
device matrix in CI covers the public routes.

---

# Integrations

- **F-C07** — 19 undocumented environment variables. `CONTACT_CENTER_INBOUND_SECRET`
  is the sharpest: the endpoint is correctly fail-closed, so unset it silently
  rejects every inbound email. Apple calendar sync is configured by two
  undocumented variables and is simply off until someone reads the source.
- **F6** — family email is built but not routed. Operator config.
- **F-E07** — Twilio signature verification depends on `NEXT_PUBLIC_APP_URL`
  being exactly right.
- **Workflow health**: `cron-dispatch`, `supabase-schema-audit`,
  `finance-transaction-operation-runtime` and `travel-confirmation-runtime` are
  all healthy. `supabase-forward-release` and `supabase-production-migrations`
  are not — see F-C08 and F5.

---

# Testing/QA

- **F-F05** — 96 tests across 12 files share the shape of the known
  `api-ai-runs` 5-second timeout, and no `testTimeout` is configured anywhere.
- **F-F04** — a genuine DST bug, found by running the suite under
  `TZ=America/Los_Angeles`. The suite pins no `TZ` at all.
- **F-F06** — one test named "fails closed" that only forbids two shapes, so
  deleting the error check makes it greener.
- **F-F07** — 37 of 51 money, kids, economy and missions server actions have no
  test.
- **F4, F-004, F-015, F-019** — tests and probes that could not observe what
  they were named for. All fixed.
- **Worth recording as a positive**: the sweep for tests-that-cannot-fail came
  back *mostly clean*. This suite's grep-style guards mostly carry explicit
  non-vacuity blocks, which is unusual. The four above were the exception, not
  the pattern.

---

# Broken/Incomplete Features

- **F-F10** — two buttons in the message header exist only to say the feature is
  unavailable.
- **F6** — family email: built, not routed.
- **F-D12** — two admin links point at routes that exist only at runtime.
- **F-E03 / F-E05** — two storage buckets public by a decision that was recorded
  as a follow-up and never followed up.

---

# Technical Debt

- **F-D10** — the lint config that permits the whole accessibility class.
- **F-F12** — the vitest config's JSX block is dead under vitest 4.
- **F-F13** — sixty-nine test blocks assert only the absence of a pattern.
- **F-D13** — 172 index-derived React keys.
- **F-C09** — no central environment validation.
- **The release process itself** — two mechanisms, both non-functional, one
  pinned to a release 38 migrations old. This is debt that has become a blocker.

---

# Recommended Fix Order

Ordered by what unblocks the most, not by severity alone.

1. **Restore a path to production for migrations** (F5 / F-001 / F-C08). Until
   this is done, `0296` and every other schema fix is inert. Needs a Supabase
   access token with project privileges, and a decision on whether to re-pin the
   forward-release manifest or retire it.
2. **Apply `0296`** the moment step 1 lands, and confirm the boundary probe
   passes against production. This closes the only CRITICAL.
3. **F-F01** — the capped read that reports success. It makes reconciliation
   confidently wrong about money, which is worse than an error.
4. **F-E02** — step-up MFA. Either enforce `aal` in policy or stop presenting it
   as a control.
5. **F-E03 / F-E05** — decide on the public buckets. They are known and
   deliberate; what is missing is the decision, not the discovery.
6. **F-F02** — the eleven server-rendered surfaces still on server midnight, and
   widen F-017's guard so it can see `setHours` against `timestamptz`.
7. **F-D10** — turn on the `jsx-a11y` rules, then fix what they surface
   (F-D02, F-D03, F-D06). Config first: it stops the class from growing.
8. **F-D01** — the lightbox. Small, self-contained, and the file already imports
   the right component.
9. **F-C07** — document the environment contract. Cheap, and it un-breaks two
   integrations nobody knows are off.
10. **F-F03, F-F09** — the N+1 and the unbounded fan-out.
11. **F-C10** — give the mobile app a gate worth the name.
12. Everything remaining in Low.

---

# Verification Checklist

Each item is a thing to *run or observe*, not a box to tick from reading.

**Blockers**
- [ ] `supabase link` succeeds against the production project ref.
- [ ] The migration ledger lists every version through `0296`, not `0001–0003`.
- [ ] `supabase-forward-release` completes, or is retired and the workflow removed.

**The critical finding**
- [ ] `docs/audit/family-credentials-boundary-check.sql` passes against
      production, not only against a local replay.
- [ ] A real child account, signed in, sees zero rows on the vault page.
- [ ] A parent *and* a non-parent adult can both still read and edit it.

**Regression guards already in place** (these should fail if the fix is reverted)
- [ ] `tests/sitemap-lastmod-is-content-dated.test.ts`
- [ ] `tests/sitemap-urls.test.ts`
- [ ] `tests/i18n-client-scope.test.ts`
- [ ] `tests/route-access-is-total.test.ts`
- [ ] `tests/catalogue-holds-language-only.test.ts`
- [ ] `tests/blog-search-index-is-fetched-not-shipped.test.ts`
- [ ] Every `docs/audit/*-check.sql` probe, via the Database CI job.

**Production observations**
- [ ] `/sitemap.xml` — no URL dated with the build time; no 404s; ~1,063 URLs.
- [ ] `/cookies` under 25 KB gzipped.
- [ ] `/nope` returns 404 with `noindex`; `/dashboard` still 307s to `/login`.
- [ ] Blog `lastmod` values spread across real dates rather than all
      `2026-07-18` — this is the observable proof that `0286` applied.

**Gaps to close before this audit can be called complete**
- [ ] Run a browser: contrast, tab order, screen-reader output (Pass D).
- [ ] Replay `0237`, `0239`, `0292` with the `vector` extension and audit the
      marketing platform spine tables (Pass E).
- [ ] Re-verify Pass E's findings against production once the ledger is current.

---


Two audits of bubaly.com, kept in one file because one file is the record.

They ran over **different surfaces** and neither supersedes the other:

| Pass | Surface | Findings | Numbering |
|---|---|---|---|
| **A — Public surface** | marketing pages, SEO and crawler contract, robots/sitemap, headers, titles, i18n payload, plan entitlement, role entitlement, child sign-in | 22 | `F1`–`F22` |
| **B — Data layer** | Supabase reads and writes, RLS and grant boundaries, nightly jobs, the build/data-cache boundary, calendar-day correctness, query plans, money concurrency, and the audit's own probes | 19 | `F-001`–`F-019` |
| **C — Delivery and integration** (2026-09-13) | what the sitemap says, what every public page weighs, what an unrouted path answers, the environment contract, workflow health, the mobile app's gate | 10 | `F-C01`–`F-C10` |
| **D — Frontend and accessibility** (2026-09-13) | the *authenticated* app, which A and B barely touched on the frontend: dialogs, labels, keyboard reachability, headings, loading and error states, React effect correctness | 14 | `F-D01`–`F-D14` |
| **E — Backend, auth and security** (2026-09-13) | RLS and grants audited against a real catalogue after replaying 308 migrations, all 141 API routes mapped to their guard, all 61 public-list carve-outs read, storage buckets, secrets | 9 | `F-E01`–`F-E09` |
| **F — QA, flows, performance, edge cases** (2026-09-13) | tests that cannot fail, coverage holes on money and children, timezone and DST correctness, N+1 round trips, incomplete features | 13 | `F-F01`–`F-F13` |

> **Pass E opens with the most serious finding in this document.** See
> **F-E01**: every child in a family can read, edit and delete the family
> password vault, and the secrets are stored in plaintext. **It is fixed** by
> migration `0296`, proved by a probe CI runs — but see F-C08: no migration can
> currently reach production.

**Pass C changes the disposition of two Pass A findings.** Both are recorded
below rather than edited in place, so the history stays readable:

- **F9** (the whole i18n catalogue on every page) was closed as *a decision*.
  It is now fixed and verified in production — `/cookies` went from 266 KB to
  20 KB gzipped. See **F-C03**.
- **F13** (unknown top-level paths redirecting to login) was recorded as *by
  design — no change*. The owner directed the change on 2026-09-13 and it is
  shipped and verified. Superseded by decision, not overturned on the merits.
  See **F-C05**.

**Where they touch, stated plainly.** Only two places:

- **The production migration ledger** is the same blocker in both — Pass A's
  **F5** and Pass B's **F-001**. A reaches it from the CI workflow (the access
  token cannot link the project), B from the database (the ledger records only
  `0001–0003`, so the baseline guard halts the push). Both are true, both are
  the same wall, and both need the same credentialed operator.

  Three findings in this file are still open, and only this one is a blocker:
  the ledger (A's **F5** / B's **F-001**) and A's **F6** both need a
  credentialed operator, and A's **F19** is a pricing decision for the owner
  rather than a defect.
- **The sitemap** appears in both, and they are *different defects*. Pass A's
  **F1**/**F3**/**F14** are about which URLs it listed — 435 that answered 404,
  the homepage twice, nine that canonicalise elsewhere — fixed on `main` by
  #526. Pass B's **F-012** is about the file being *stale*: correct URLs, but a
  six-day-old copy of the blog served from Next's build Data Cache, and frozen
  for a year. #526's URL work and F-012's freshness fix are both in the current
  file, and neither pass would have found the other's defect.

Everything else is disjoint.

---

# Part 0 — Consolidated view (session record 2, superseded by Part 0 at the top)

Maintained by **Claude-1** (coordinator). This part is a roll-up **over** the
detailed passes below, not a replacement for them: every entry points at the
finding that carries the evidence. Nothing below Part 0 is rewritten or removed
when this view is rebuilt.

Worker findings live in `audit/claude-1.md` … `audit/claude-4.md`; `audit/status.md`
is the board. Only Claude-1 edits this file.

**Honesty rule for this part:** a heading with no findings says so. An area no
worker has audited yet is recorded as *not yet audited*, never as "clean" —
*"we checked"* and *"we could not see"* must not read the same on the page.

## Coverage as of this rebuild

| Area | Audited by | Depth |
|---|---|---|
| Public surface, SEO, entitlement, child sign-in | Pass A (F1–F22) | deep |
| Data layer, RLS, grants, cron, query plans, money concurrency | Pass B (F-001–F-020) | deep |
| Architecture / integration seams | Claude-1 | in progress — config contract, cron auth, service-role boundary done |
| Frontend / UI / responsive / accessibility | Claude-2 | **running** |
| Backend / API / auth / security | Claude-3 | **running** |
| QA / flows / performance / edge cases | Claude-4 | **running** |

# Executive Summary — session record 2 (parallel session, superseded as the index)

> Kept verbatim. Written while passes A and B were complete and C-F were still
> running, so its counts are of that moment. Its "guards that could not see what
> they were named for" reading is the most useful paragraph in this file, and is
> carried up into Part 0.

Two deep passes are complete (41 findings, `F1`–`F22` and `F-001`–`F-020`), and
a coordinator pass on architecture and integration is in progress. **Three
findings remain open, and exactly one is a release blocker.**

The blocker is the production migration ledger (A's **F5** / B's **F-001**):
production carries the full schema but a three-row ledger, so every release
touching `supabase/` halts at the baseline guard. It needs a credentialed
operator; agents must not apply it.

The most consequential finding of this pass is **F-020**, because of what it
says about the others: the documented procedure for clearing that blocker
**did not work**, and had never been tested. It cited two guards as proof and
neither could observe the property it claimed. Replayed against production's
actual condition it stopped on the first file. That is now fixed, rehearsed,
and enforced by CI on every pull request.

The pattern worth carrying into the remaining passes: **the failures here are
mostly guards that could not see what they were named for** — a sweep that read
one line at a time (Pass C), a probe that granted itself privileges (F-015), a
concurrency check that never ran two things at once (F-019), an index test that
could not see `UNIQUE` declarations, a replay that ran only against an empty
database (F-020). Verifying that a guard fails when it should is the single
highest-yield check in this repository.

# Critical Issues

| # | Finding | Status |
|---|---|---|
| **F-020** | The documented production-recovery procedure did not work — `db push` stopped on `0004` and left the guard unclearable | **FIXED** + CI gate |

# High Priority

| # | Finding | Status |
|---|---|---|
| **F5 / F-001** | Production migration ledger records only `0001`–`0003`; every schema release is blocked | **BLOCKED — operator** |
| F15 | Family Autopilot ran for every family on the platform | fixed |
| F16 | Paid features enforced only by the sidebar padlock | fixed |
| F18 | Endpoints behind gated pages had no gate | fixed |
| F20 | A child could clear the chore board | fixed |
| F21 | A child could grant themselves a reward | fixed (app) · `0295` awaiting operator |
| F22 | A child's username was matched as a pattern | fixed |
| F1 | The sitemap advertised 435 dead URLs | fixed |
| F9 | The entire i18n catalogue ships on every page | closed as a decision |
| F10 | Seeded records presented as real customer stories | fixed |
| F-003 | `anon` held INSERT/UPDATE/DELETE on all five money tables | fixed · `0290` awaiting operator |
| F-005 | Every blog post not baked in at build time returned 500 | fixed |
| F-006 | Any signed-in user could claim another household's AI jobs | fixed · `0292` awaiting operator |
| F-008 | Six nightly jobs silently stopped at 1,000 rows | fixed |
| F-010 | Notification generation failed outright for affected households | fixed · `0293` awaiting operator |
| F-011 | The fix for F-008 had the same defect it was written to fix | fixed |
| F-012 | The sitemap was six days stale and would have stayed stale for a year | fixed |
| F-013 | 59 reads asked for more rows than the server would ever return | fixed |
| F-014 | Notification dedupe failed on every run | fixed |
| F-017 | A family's "today" was Greenwich's today | fixed |
| F-018 | Nine family-scoped reads were sequential scans | fixed |
| F-019 | The money-safety probe asserted concurrency it never tested | fixed |
| CLAUDE-1 | Nothing enforced migration idempotency, so it could regress silently | fixed (CI gate) |
| CLAUDE-1 | Two branches independently claimed migration version `0295` | fixed (renumbered `0296`) |
| CLAUDE-1 | A merge would have reopened the child-self-approval hole | fixed |
| CLAUDE-1 | `/api/health` reported `ok` while a missing `CRON_SECRET` silently 401'd all 24 scheduled jobs, and a missing `CHILD_LOGIN_SECRET` disabled child sign-in | fixed |
| CLAUDE-1 | Five nightly jobs answered HTTP 200 while counting their own failures; no cron route writes a durable run record | fixed |

# Medium Priority

| # | Finding | Status |
|---|---|---|
| **F6** | Family email is built but not routed | **OPEN — operator config** |
| **F19** | Most AI endpoints run unmetered | **OPEN — pricing decision for the owner** |
| F2 | `robots.txt` omitted 20 authenticated surfaces | fixed |
| F4 | The test named for F1's property could not observe it | fixed |
| F7 | The family email gate existed only on the screen | fixed |
| F11 | Five public pages had no `<h1>` | fixed |
| F17 | The documented tier map disagreed with the enforced one | fixed |
| F-004 | The money-boundary probe could not catch F-003 in CI | fixed |
| F-007 | The additive-migrations guard flagged a revoke as destructive | fixed |
| F-009 | A provider error in the mailer took down the whole cron run | fixed |
| F-015 | A probe granted itself privileges and left them, poisoning the suite | fixed |
| F-016 | The documented crawl workflow drops a live session cookie into the tree | fixed |
| CLAUDE-1 | `/api/contact-center` was public as a prefix, not as exact paths | fixed |
| CLAUDE-1 | A runtime gate fails on this Node and passes on CI's | **OPEN — worker collision** |

# Low Priority

| # | Finding | Status |
|---|---|---|
| F3 | The homepage was published twice | fixed |
| F8 | Page titles doubled the brand | fixed |
| F12 | The 404 page ships no server-rendered markup | closed — recorded |
| F14 | Nine sitemap URLs declare themselves non-canonical | fixed by #526 |
| **F13** | Unknown top-level paths redirect to login | **SUPERSEDED — see below** |
| CLAUDE-1 | The service-role boundary was real but inherited from an incidental `next/headers` import rather than declared | fixed (hardening) |
| CLAUDE-1 | Mobile imported from a folder Metro does not watch; safe only because the import is type-only, and no CI job bundles the app | fixed (guard added) |

# Architecture

Claude-1's scope. Detail in `audit/claude-1.md`.

- **F-020** and its CI gate are the substantive architectural findings of this
  pass: the repository's recovery story depended on a property (migration
  idempotency) that nothing enforced and one guard actively misrepresented.
- **Migration numbering is a cross-branch race.** `schema_migrations` has a
  PRIMARY KEY on `version`, but the guard that protects it
  (`tests/migration-version-safety.test.ts`) can only see one branch at a time.
  Two branches took `0295` simultaneously. The guard did its job *after* the
  merge, which is the only moment it can — worth knowing when several sessions
  author migrations in parallel, as they are now.
- **Merge direction carries security weight.** Resolving a conflict toward the
  branch rather than toward `main` silently reverted a fix in one case
  (rewards) and would have widened an auth boundary in another (contact-center).
  On this repository a merge conflict in an auth or money path deserves the same
  scrutiny as the original change.

# Frontend

**Not yet audited this pass.** Claude-2's scope; `audit/claude-2.md` is empty.
Pass A covered public marketing pages for SEO, headings and titles (F1–F14) but
did not audit component behaviour, state handling, loading/error states, or
responsive layout.

# Backend

Covered in depth by Pass B for the data layer (reads, writes, cron, caching) and
by Pass A for entitlement and authorization on gated endpoints (F16, F18, F19).
**Route-by-route API auditing is Claude-3's scope and has not started.**

# Database

Pass B's core surface, plus Claude-1's F-020 work.

- 308 migrations, replay 0 → 308 clean, and now **re-appliable** onto a populated
  schema (the F-020 gate).
- 19 boundary probes under `docs/audit/`, globbed by `run-probes.sh`, all passing.
- Open: the production ledger (F-001). Five migrations (`0290`, `0292`, `0293`,
  `0295`, and #541's `0296`) are authored, tested, and **not in production**.

# Security/Auth

- Pass A found and closed four privilege-escalation classes (F15, F16, F18, F20,
  F21, F22) — all but F21's migration half are live.
- Pass B closed the money-table grant hole (F-003) and cross-household AI job
  claiming (F-006).
- Claude-1 this pass: prevented a merge from reopening F21's app half, and
  narrowed `/api/contact-center` from a public prefix to five exact paths.
- Claude-1 verified the **service-role boundary** by planting a `'use client'`
  page that imports `createServiceClient`: the build fails, and the key's value
  is absent from every emitted client chunk. It failed *before* the change too
  (via `next/headers`), so the boundary was sound and the fix is hardening — the
  protection is now declared rather than inherited. Recorded that way rather than
  as a closed vulnerability.
- All 24 cron routes enforce `hasCronAuthorization`, which is correctly
  fail-closed (`!!secret &&`, so an unset secret cannot become a matchable
  `Bearer undefined`). Now asserted per-route by a test rather than by grep.
- **A full authorization sweep over all 146 API routes is Claude-3's scope and
  has not started.**

# UX/Accessibility

**Not yet audited this pass.** Claude-2's scope. Pass A touched `<h1>` presence
on five public pages (F11); nothing else here is accessibility coverage.

# Performance

Partial. F9 (i18n payload, closed as a decision), F-018 (nine sequential scans
turned into index scans, measured at 700k rows), F-008/F-011/F-013 (row-ceiling
correctness, which is also a throughput property). **Systematic performance work
— bundle size, render cost, query N+1, cold start — is Claude-4's scope and has
not started.**

# Mobile/Responsive

**Not yet audited this pass.** Claude-2's scope. CI runs a mobile device matrix
(iphone-se / iphone / pixel / ipad) asserting no horizontal overflow and no
sub-16px inputs, so there is a standing gate; no one has audited beyond it.

# Integrations

Claude-1's scope, in progress.

- CI (`ci.yml`): five jobs; the Database job now carries the idempotency gate.
- Supabase: service-role vs anon client split; production ledger blocked (F-001).
- Vercel: deploys on merge to `main`; code fixes reach production, schema does not.
- Provider webhooks: Twilio (contact centre, Guardian), email inbound — each
  authenticates in its own handler; middleware must let them through, which is
  the exact-path narrowing above.
- **Cron observability:** 0 of 24 routes write a durable run record, so the HTTP
  status is the only signal a run failed. Five routes answered 200 while counting
  failures; all five now answer 502, matching the other 19.
- **Config contract:** 79 distinct env vars, no central schema. `/api/health` now
  reports a `FEATURE_ENV` tier as `degraded`/200 — the six secrets whose absence
  silently disables a whole subsystem. Previously invisible; see High Priority.
- **Not yet audited:** push/APNs, calendar feed subscribers, AI provider fallbacks.

# Testing/QA

- 13,641 unit tests across 1,187 files on #541's merged tree; 15,806 on #510's.
- 19 SQL boundary probes; E2E with a mobile device matrix.
- **The recurring defect class is vacuous guards** — see the Executive Summary.
  Claude-4 should treat "revert the fix and confirm the test fails" as the
  standard for any guard it reviews, not an optional extra.
- Open: `tests/stream-cancellation-runtime.test.ts` is Node-patch-sensitive.

# Broken/Incomplete Features

- **Family email** (F6) — built, not routed. Operator config.
- **AI metering** (F19) — most AI endpoints run unmetered. Owner decision.
- **`endEmergencyAction` writes no audit row at all** — recorded in Pass C as a
  missing feature rather than a discarded result.
- Five migrations authored but not applied to production (see Database).

# Technical Debt

- `docs/PENDING_PROD_MIGRATIONS.md` describes a baseline that is 70+ migrations
  behind; the range sentence has been corrected twice by the range simply growing.
- 17 historical duplicate migration versions were renamed; `ci-dedupe-migration-versions.mjs`
  remains as a no-op safety net.
- Four baseline `react-hooks/exhaustive-deps` lint warnings.
- `finalaudit.md` is now large enough that three concurrent sessions conflict in
  it on nearly every merge. Part 0 exists partly to give a stable place to read
  the state without diffing the whole file.

# Recommended Fix Order

1. **Operator: repair the production ledger** (F-001 / F5), following
   `docs/runbooks/LB-016-…md` §4 — now rehearsed end to end. This unblocks
   everything below it.
2. **Operator: apply the five held migrations** — `0290` (money grants),
   `0292` (privileged RPC), `0293` (`related_id` type), `0295` (reward
   redemption), `0296` (social-access delete). Until then F-003, F-006, F-010,
   F21 and I-01 are only half-live.
3. **Operator: route family email** (F6).
4. **Owner: decide AI metering** (F19).
5. Pin or guard the Node-sensitive runtime test.
6. Run the three unstarted worker passes (Claude-2, -3, -4).

# Verification Checklist

Commands, with what a good answer looks like. Everything here was run this pass
unless marked.

- [x] `npx tsc --noEmit` → clean
- [x] `npm run lint` → 0 errors (4 baseline warnings)
- [x] `npx vitest run` → all pass (13,641 on #541's tree)
- [x] `npm run build` → exits 0
- [x] `npm run db:audit:migrations` → no collisions
- [x] `npm run db:audit:queries` → every table, column, function, route resolves
- [x] `bash docs/audit/verify-pg.sh up` → all migrations applied, 0 failed
- [x] `bash docs/audit/rehearse-ledger-repair.sh` → **FAILED: 0**, `0004` recorded
- [x] `bash docs/audit/run-probes.sh` → 19/19
- [x] `node scripts/check-conflict-targets.mjs` → every target inferable
- [x] Gate proven load-bearing: plant an unguarded `create policy`, confirm the
      rehearsal fails **and** the from-scratch replay does not
- [x] Service-role boundary: plant a `'use client'` importer, confirm the build
      fails **and** confirm the control (guard removed) fails too — otherwise you
      are reporting a hole that was never open
- [x] `/api/health` degraded tier proved load-bearing by reverting the branch
- [ ] Frontend / accessibility pass (Claude-2)
- [ ] API authorization sweep over all 146 routes (Claude-3)
- [ ] End-to-end flow + edge-case pass (Claude-4)
- [ ] Production: ledger repaired and five migrations applied (operator)

---

# Pass A — Public surface (F1–F22)

Full audit of bubaly.com: what was checked, what was found, what was fixed, and
what remains — with an owner for every remaining item. Every finding here was
reproduced against the live site or the real code path before being written
down; nothing is inferred from a filename or a comment.

**Audit status: reopened, then complete again.** Twenty-two findings, and the
arithmetic stated exactly rather than approximately:

| | |
|---|---|
| **Fixed in code** | **15** — F2, F4, F7, F8, F10, F11, F15, F16, F17, F18, F20, F22 from this audit; F1, F3, F14 on `main` via #526, whose sitemap implementation superseded mine and which I withdrew in its favour |
| **Written, proven, not yet live** | **1** — F21's durable half. The trigger can only land as a migration, and the migration workflow is F5's blocker; CI replays and probes it on every pull request. Its client-side half — the app no longer deciding status, decider or price — *is* live |
| **Closed without a code change** | **4** — F9 (a decision, with the design and the numbers recorded), F12 (recorded; the fix is not worth its risk), F13 (correct as built — fail-closed routing), F19 (a pricing decision the owner has to make; the numbers are below) |
| **Blocked on credentials** | **2** — F5 (Supabase access token *and* the ledger baseline gate) and F6 (`CONTACT_CENTER_INBOUND_SECRET` + MX records) |

One further observation was **disproved and withdrawn** after re-checking: a
reading that two pages shipped no metadata, which was my own extraction bug.

Nothing is left unexamined or unassigned.

- **Audit opened:** 2026-09-13
- **Audit closed:** 2026-09-13
- **Reopened:** 2026-09-13 — F7 was not a one-off but a *shape*: an entitlement
  stated where a user can see it and absent where it is enforced. Every paid
  feature was re-checked for that shape. It recurred four more times: in a
  nightly cron (F15), across 24 pages and their shared write path (F16), in the
  documentation that describes the tiers (F17), and behind 20 endpoints — 14
  under `/api/ai` and six outside it (F18)
- **Production head at open:** `f9c4d7a1` (#522)
- **Scope:** public marketing surface, authenticated app surface, API boundary,
  SEO/crawler contract, security headers, build and test health, and the
  operator-owned items inherited from earlier work.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Sitemap advertised 435 URLs that answer 404 (29% of it) | High | **Fixed on main by #526**; my implementation withdrawn in its favour |
| F2 | `robots.txt` omitted 20 authenticated surfaces, `/admin` among them | Medium | **Fixed** — and #526 did *not* cover this |
| F3 | Homepage published twice in the sitemap (`…com` and `…com/`) | Low | **Fixed on main by #526** |
| F4 | The test named for F1's property only grepped source | Medium | **Fixed** |
| F5 | Supabase production migration workflow cannot authenticate | High | **Operator — credentials** |
| F6 | Family email routing not configured (`CONTACT_CENTER_INBOUND_SECRET`, MX) | Medium | **Operator — config** |
| F7 | Family email is gated on the screen only — inbound pipeline has no plan check | Medium | **Fixed** — owner chose Family+ |
| F8 | Page titles doubled the brand (`… — Bubaly · Bubaly`) | Low | **Fixed** |
| F9 | Whole 848 KB i18n catalogue serialized into every page | High (perf) | **Closed — decision recorded** |
| F10 | Seeded placeholder records shown as real customer stories on the homepage and /pricing | High | **Fixed** |
| F11 | Five public pages had no `<h1>` at all | Medium | **Fixed** |
| F12 | The 404 page ships no server-rendered markup | Low | **Closed — recorded, not worth the fix** |
| F13 | An unknown top-level path redirects to login instead of 404 | Low | **By design — no change** |
| F14 | Sitemap lists 9 `/blog?category=` URLs whose canonical points at `/blog` | Low | **Fixed on main by #526** |
| F15 | Family Autopilot (Plus) ran nightly for *every* family — both things that run it had no plan check | High | **Fixed** |
| F16 | 24 of 62 paid features were enforced only by the sidebar padlock — the URL was the bypass | High | **Fixed** |
| F17 | The documented route→tier map disagreed with what is enforced on 19 of 55 routes | Medium | **Fixed** |
| F18 | 20 endpoints behind feature-gated pages had no entitlement check — the fetch was the bypass, mostly on the surface that costs money per call | High | **Fixed** |
| F19 | `AI_MONTHLY_ALLOWANCE` is enforced on 4 of the 39 AI routes; 35 run unmetered | Medium | **Open — a pricing decision, recorded** |
| F20 | A child could delete any chore on the family's board, and mint chores for a sibling | High | **Fixed** |
| F21 | A child could self-approve a reward redemption — the third decision forgery, and the only one left unguarded | High | **Half fixed and live; the durable half awaits the F5 operator** |
| F22 | A child's username was matched as a LIKE **pattern**, so every wildcard spelling was a fresh brute-force budget against their PIN | High | **Fixed** |

---

## F1 — The sitemap advertised 435 dead URLs *(High, fixed)*

**What was wrong.** The live sitemap carried 1,508 URLs. 435 of them — 29% —
were of the form `/blog/Seed <uuid>`, and every single one answered **404**.

Sampled 8 seed URLs and 8 real ones; the split was total:

```
404  /blog/Seed b40afaf9-4b6e-43ff-b617-f2e682cca0f8
404  /blog/Seed 0665c96f-735b-4819-906c-38c0ca07a83b     (8/8 seed → 404)
200  /blog/a-simple-system-for-a-calm-approach-to-holiday-hosting
200  /blog/planning-a-road-trip-playlist-a-calm-practical-guide   (8/8 real → 200)
```

They also carried a literal **space** in the path, which is not a valid `<loc>`.

**Root cause.** Two halves of the same system disagreed about what exists.

- `app/sitemap.ts` builds blog entries from `getAllPosts()`, which filters
  through `publicRows` → `isSyntheticBlogSeedSlug`. That filter is correct: run
  against all 435 live slugs it caught **435 of 435**.
- But the sitemap *also* emits `platformEntries` from the `marketing_pages`
  table, which stores a `path` directly and had **no seed filter of any kind**.
  Any published row was emitted verbatim.
- The renderer refuses them: `getPost()` (`lib/blog/posts.ts:196`) begins
  `if (isSyntheticBlogSeedSlug(slug)) return undefined;`, and the page then calls
  `notFound()`.

So `marketing_pages` advertised what `blog_posts` refused to render. The file's
own comment already stated the rule it was breaking: *"a sitemap must never point
at a 404."*

**Fix.** `app/sitemap.ts` gained two exported, unit-tested helpers:

- `isAdvertisablePlatformPath()` — rejects a platform path under `/blog/` whose
  slug the renderer will refuse, applying the *same* predicate the renderer uses,
  so the two cannot diverge again. Also rejects non-rooted paths, which closes an
  absolute-URL row (`https://evil.example/x`) that the old
  `path.startsWith('/')` check already handled but nothing pinned.
- `canonicalSitemapUrl()` — collapses a stored root path of `/` onto the static
  spelling `''` (see F3).

**Verification.** Reverted the fix and re-ran: the two new behavioural cases fail,
and pass again once restored.

## F2 — `robots.txt` omitted 20 authenticated surfaces *(Medium, fixed)*

**What was wrong.** `app/robots.ts` carried the comment *"Authenticated app
surfaces should not be indexed"* above a list of four: `/dashboard`,
`/onboarding`, `/api`, `/auth`.

The authenticated route group holds **22 segments**, and probing production found
**20 gated surfaces absent from that list** — every one answering 307 to `/login`:

```
/account /admin /capture /display /economy /family /feedback /guardian
/home /kids /library /marketplace /missions /money /parent /pay
/referrals /services /settings /wallet
```

`/admin` alone is 80 pages, including the super-admin console.

**Severity, stated honestly.** This is **not** a data leak. Every one of these
redirects to login while signed out, so there is nothing for a crawler to index.
What was wrong is narrower: the stated policy did not match the implementation,
crawl budget was spent discovering them, and — the part that actually matters —
a future route that answers 200 anonymously would have inherited no protection.

**Fix.** `DISALLOWED_APP_PATHS` now names all 24 paths. A new test derives the
segment list from `app/(app)` on disk and fails when a segment is added without a
matching entry, so the list cannot fall behind. A separate case asserts the
public marketing routes are still allowed — `/family-display` is public while
`/family` and `/display` are not, so a naive prefix rule would have taken it down
with them.

**Verification.** Restoring the four-entry list fails 3 of the 6 cases.

## F3 — The homepage was published twice *(Low, fixed)*

The sitemap contained both `https://www.bubaly.com` and `https://www.bubaly.com/`.
`STATIC_ROUTES` spells the root as `''`; a `marketing_pages` row spelled it `/`.
The dedupe keys on the URL **string**, so the two never collapsed. Fixed by
`canonicalSitemapUrl()`; pinned by a test asserting exactly one homepage entry
and, separately, that the whole sitemap contains no duplicate URL at all.

## F4 — The test named for F1's property could not observe it *(Medium, fixed)*

`tests/marketing-sitemap-closed-loop.test.ts` — the file named for this exact
property — never ran the sitemap. All three cases read `app/sitemap.ts` as text
and asserted that certain substrings appeared in it. A grep cannot tell you what
a function emits, which is why a 29%-dead sitemap shipped under a green test.

Demonstrated rather than asserted: against the pre-fix code, **all three
source-grep cases still pass** while the new behavioural ones fail.

The three original cases are kept — they do pin real wiring — and five cases were
added that execute `sitemap()` against a stubbed database and assert on the URLs
it returns. The Supabase stub is a `Proxy`, not a fixed method list, so adding a
`.limit()` or `.range()` to either query cannot silently turn the suite into a
false pass.

## F5 — Production migrations cannot be applied *(High, operator — credentials)*

The **Supabase production migrations** workflow fails on every push:

```
Authorization failed for the access token and project ref pair:
"Your account does not have the necessary privileges to access this endpoint."
```

`Link production project` fails and every apply/verify step after it is
**skipped**, so no migration reaches production.

Two independent blockers, and fixing one alone changes nothing:

1. **The access token lost its privileges.** Not caused by any recent PR — the
   19:16 and 22:24 runs on 2026-09-12 failed identically. It *is* a regression
   though: the 2026-09-07 run got past `link` and read the real production
   catalogue (441 tables, 978 policies). So the token or project ref was revoked,
   rotated, or had its role changed since.
2. **The baseline gate stops it by design.** `hasUnrecordedBaseline` throws while
   `profiles_insert_self` exists without a recorded migration `0004` — exactly
   production's state. `scripts/audit-production-migration-state.mjs` says so
   outright: *"Repairing it is a credentialed operator action."*

Migrations have therefore never been auto-applying; production's schema is
hand-managed per the runbook. **Deliberately not touched** — the repo forbids
agents applying migrations or stamping the ledger.

**Consequence to be aware of:** `docs/PENDING_PROD_MIGRATIONS.md` records the
production ledger as holding only `0001-0003`, and warns that a missing ledger
entry does *not* prove the schema is absent (441 tables exist). So the state of
any given migration in production is genuinely unknown from here.

## F6 — Family email is built but not routed *(Medium, operator — config)*

The code path is complete and merged (#516, #517): addresses are provisioned at
onboarding, the reserved namespace is held back, the inbound webhook is reachable,
and replies go out *as* the family. Two config steps remain, both requiring
credentials this session does not have:

- `CONTACT_CENTER_INBOUND_SECRET` in Vercel
- MX routing for `bubaly.com` → `/api/contact-center/email?key=…`

Current live behaviour is correct for that state: `POST /api/contact-center/email`
answers **401** (verified three times), meaning the route runs and refuses. Before
#516 it answered 307 → `/login`, so the route never executed at all.

## F7 — The family email gate existed only on the screen *(Medium, fixed)*

**Corrected once on re-examination, then resolved.** I first recorded this as "a
Free family is given an address it cannot see", which understated it. Tracing the
whole path found no plan check anywhere except the screen:

| Stage | Gate, before |
|---|---|
| Contact Center screen | `requirePlanLevel(2)` — a bare literal |
| Address provisioning at onboarding | **none** — ran for every tier |
| Inbound webhook | **none** |
| `lib/contact-center/{server,address,provision}.ts` | **none** |

So a **Free** family had a working `@bubaly.com` address that received mail,
filed it, ran the AI concierge over it and auto-replied **as the family**. The
only thing they could not do was open the inbox.

**Resolved: the owner chose Family+.** All three surfaces now read one constant,
`FAMILY_EMAIL_MIN_PLAN_LEVEL` in `lib/constants/plans.ts`. The bare
`requirePlanLevel(2)` is gone — a literal in one file is what let the other two
drift in the first place, so moving the feature between tiers is now a change to
that line rather than a hunt through three files.

Two details that carry the risk:

**Ordering.** Provisioning is gated *before* the webhook, deliberately. Gating
the webhook first would strand mail addressed to an address a family still
holds. With provisioning closed, a family below the line has no address for
anything to arrive at, and the webhook check covers the single case left: an
address issued while the family was Family+ and still resolvable after a
downgrade.

**An unreadable plan is not an unentitled family.** `resolveFamilyPlanLevel`
throws when the subscription read fails, and the webhook catches that separately
and answers **503**, exactly as its other read failures do. Answering 200 would
tell the provider the message was handled — no retry, and no copy of it
anywhere — so a teacher's email would be gone because a database read blipped.
That case has its own test, and reverting the 503 to a 200 fails it.

The same throw sits inside onboarding's provisioning block, which is still
wrapped and still last, so a subscription blip cannot turn a completed signup
into a retry.

Verified non-vacuous three ways: reverting the page to its literal, the webhook's
503 to a 200, and the provisioning gate each fail exactly the case that covers
them.

**One follow-up worth doing when MX is live (F6).** A refused message currently
answers `{ ok: true, skipped: 'plan' }` — acknowledged and logged, matching this
route's existing idiom for a recipient it will not process. A real bounce would
be kinder to the sender, who otherwise learns nothing. Not built here because
nothing is routed to the webhook yet, so there is no live behaviour to preserve
or break.

## F8 — Page titles doubled the brand *(Low, fixed)*

Live on 2026-09-13:

```
<title>Security &amp; Privacy — Bubaly · Bubaly</title>
<title>Contact Bubaly · Bubaly</title>
```

The root layout formats titles with `template: '%s · Bubaly'`, so a title that
already ends in the brand gets it twice. The titles come from the admin SEO store
(`marketing_seo_pages`, read by `getSeoPage`), not from the i18n catalogue —
confirmed: **0** catalogue strings end in "— Bubaly".

That makes correcting the rows the wrong fix: the store is admin-editable free
text, so the next brand-suffixed title reintroduces it. The template owns the
brand, so `titleWithoutDoubledBrand()` now opts a self-branded title out of the
template using Next.js's own `absolute` mechanism.

Only a *trailing* brand counts. "Bubaly — The AI Family Operating System" leads
with the name and still wants the suffix. The regex requires a separator before
the brand, so "Meet the Bubalys" is untouched — pinned by its own case.

`openGraph.title` keeps the plain string: it carries no brand template of its
own and was never doubled.

## F9 — The entire i18n catalogue ships on every page *(High — perf; closed as a decision)*

**Measured, not estimated.** `app/layout.tsx` passes the whole merged catalogue
to `LocaleProvider`, which is a `'use client'` component — so React serializes
all of it into the RSC payload of every page.

| | |
|---|---|
| `/login` HTML | 906,263 bytes raw, **255 KB brotli** |
| of which one RSC script | 870,633 chars — **98%** |
| `en-US.json` on disk | 848.5 KB, 13,449 keys |

Proven rather than inferred from the size match: five strings from sections with
nothing to do with signing in — `wallet`, `kids`, `marketplace`, `guardian`,
`benchmarksPage` — appear **verbatim** in the `/login` HTML, 5 of 5.

### What the public site actually needs

Computed as a transitive import closure from each route group's pages, keeping
client components and everything they import, then collecting every string
literal that is a real catalogue key (not only those inside a `t(...)` call):

| scope | client files | keys | size | share of catalogue |
|---|---|---|---|---|
| marketing | 81 | 324 | 21 KB | **2.6%** |
| auth (`/login`, `/signup`, `/welcome`, `/kid-login`) | 62 | 89 | 5 KB | **0.6%** |
| signed-in app | 1,122 | 8,282 | 442 KB | 55.7% |

So the public marketing site ships **793 KB to deliver 21 KB of value** — the
pages every first-time visitor and every crawler sees.

### The key sets for marketing and auth are provably complete

The danger in pruning is a key a static scan cannot see, which renders as the
raw key (`calendar.addEvent`) in front of a person. For these two groups that
was checked exhaustively rather than sampled:

- **9 dynamic `t(variable)` call sites** across both groups, all of the form
  `t(item.labelKey)`.
- Every one reads from a **static module inside the closure** — `MARKETING_NAV`
  (`lib/constants/navigation`), `VALUE_ROWS`/`VALUE_TIERS`
  (`lib/marketing/value`), the consent categories, and the local `LINKS` map in
  `components/auth/legal-consent.tsx`. None comes from the database or from user
  input.
- Checked directly: **36 of 36** keys reachable through those dynamic sites are
  present in the computed set. **Zero missing.**

### Why it is still not shipped

Two candidate mechanisms, both blocked, and the third disproved outright:

1. **A global client-only subset** (no path detection, one code path, 40%
   saving) is **unsafe, and I disproved it rather than assuming**: **123
   catalogue keys are defined as literals in server components and handed to
   client components as props** — `admins.tab.users`, `supportTickets.tab.open`,
   `runHistory.filterActive`, `familyCfo.subscription`,
   `displaySetup.stepInstallTitle` and 118 more. Every one would render as a raw
   key. The scan could be widened to catch these, but that is whack-a-mole: the
   next unanticipated pattern breaks a page in production.
2. **Scoping by request path** needs the pathname in the root layout, which
   means a header set in `middleware.ts`. That file's own comment documents that
   mishandling its request/response pair causes Supabase to treat a reused
   refresh token as stolen and **revoke the entire session family**. Threading a
   header through its five return points is not verifiable here.
3. **A nested provider** — the cleanest option, and no restructure at all. The
   root layout keeps `LocaleProvider` but is given only the keys every route
   *outside* `app/(app)` can reach; `app/(app)/layout.tsx`, which already
   exists, renders a nested `LocaleProvider` carrying the full catalogue, and
   the inner context simply wins for signed-in pages.

   Measured: the root set is **702 keys — 44 KB of 793 KB (5.5%)**, covering
   marketing, auth, onboarding, library, join, pay, gift, reviews, `/s` and
   offline together. Public pages drop by ~94%; signed-in pages carry the extra
   44 KB, which is the whole cost and is paid behind a login.

   Completeness was checked the same way as before, and **only three keys are
   uncovered**, all in one file:

   ```
   marketingDisplay.mockScheduleTitle  app/(marketing)/family-display/page.tsx
   marketingDisplay.mockAskTitle       app/(marketing)/family-display/page.tsx
   marketingDisplay.mockHandledTitle   app/(marketing)/family-display/page.tsx
   ```

   They are defined in that server page and passed to a client component, so
   the generator must scan non-`(app)` server files for key literals too — the
   same pattern that makes a global subset unsafe, but here it is three keys in
   one file rather than 123 across the admin console.

The common blocker is verification: the entire risk surface of all three is
**client-side hydration**, and a browser cannot run in this environment. Chromium
dies in the proxy relay for every host (see *Method*), so the one thing that
would prove a scoped payload still renders every string cannot be run.

**Recommendation.** Take option 3. Leave the signed-in app on the full catalogue
via the nested provider — it holds 1,122 client files and the 123 server-defined
keys, past what inspection can cover, and it sits behind a login where payload
matters least. Handle the three `marketingDisplay.*` keys, generate the root set,
and add a test that regenerates it and fails on any drift; then the failure mode
reduces to "is a key missing", which is a static property a test can settle
exhaustively without a browser.

That is a deliberate, evidence-backed decision to defer, not an open question:
the measurements, the safety proof, the counterexamples, and the mechanism are
all settled. What remains is a person running it in a browser once.

## F10 — Seeded records presented as real customer stories *(High, fixed)*

Found by crawling the internal links on the live public pages.

The **homepage** and **/pricing** both rendered a section headed **"Family
stories"**, introducing its contents as quotes *"In the family's own words"* —
and the contents were three database seed rows:

```
Seed Case Studies #450   Seed Summary value 450   Seed Result Metric value 450
Seed Case Studies #180   Seed Summary value 180   Seed Result Metric value 180
Seed Case Studies #90    Seed Summary value 90    Seed Result Metric value 90
```

Each linked to a detail page that answered **200** with
`<h1>Seed Case Studies #450</h1>` at `/customers/seed-case_studies-450`.

This is the same class as F1 — seeded rows reaching a public surface — but worse
in kind: F1 published dead links, while this published *invented customers* under
a heading that explicitly claims they are real families.

**Why `is_published` could not have caught it.** The seeder sets `is_published`
true; that flag is exactly what made them public. The rows are identifiable only
by the seeder's slug convention, `seed-<table>-<n>`.

**Fix.** `isSyntheticSeedSlug()` joins `publishedOnly()` in the shared reputation
helpers, so the list readers on both pages exclude them, and
`loadPublishedCaseStudy()` refuses one **before touching the database** so a link
surviving in a cache or a search index cannot still render one. The list and the
detail page agreeing is the whole point — F1 existed precisely because two
readers of the same content did not.

Deliberately narrow: testimonials have no `slug` column at all, so they pass
through untouched, and the guard requires the marker at the *start* of the slug
so a genuine story like `seeds-of-change` or `seed-starting-with-kids` is not
swept up. Both are pinned.

**Still worth doing separately:** the rows remain in the database. The site no
longer renders them, which is the visible outcome, but deleting them is an admin
action (Super Admin → Marketing, or SQL) that this session has no credentials
for.

## F11 — Five public pages had no `<h1>` *(Medium, fixed)*

Verified against production: `/faq`, `/contact`, `/mobile` and `/family-display`
each returned **zero `<h1>` elements**, starting their document outline at `<h2>`.

All four used `SectionHeading` for their **page title**, and that component
hard-coded `h2`. Pages with a hand-rolled hero (`/`, `/pricing`, `/features`)
render exactly one `<h1>` and were unaffected — which is why this only hit the
pages that reused the shared component.

A missing `h1` costs screen-reader users their primary means of orienting on a
page, and removes the strongest on-page relevance signal for search.

**Fix.** `SectionHeading` takes an optional `as="h1"`, defaulting to `h2` so
every existing section heading is unchanged. The five page titles set it. The
class list is identical at either level and a test asserts that — this is a
document-outline fix and those pages must look exactly as they did.

**The fifth page.** The structural test caught `/resources/benchmarks`, which
live probing could never have found: it 404s while its publication flag is off.
Same defect, same fix.

**A vacuous test, caught and fixed.** The first version of the sweep passed even
with the fix reverted. The JSDoc I had just written on `SectionHeading` contains
the literal `as="h1"` as an instruction to callers, so every page importing that
module matched on the comment. Found by reverting one page and watching the test
stay green — precisely the failure F4 is about. The sweep now strips comments
before scanning, and reverting `/faq` correctly fails and names it.

## F12 — The 404 page ships no server-rendered markup *(Low, closed — recorded)*

A dead URL under a public prefix correctly answers **404**, but the response body
contains no rendered content — only an unresolved React Suspense placeholder:

```html
<body><div hidden=""><!--$?--><template id="B:0"></template><!--/$--></div>
```

69 characters of markup, against 6,133 on the homepage. The words "Page not
found" appear exactly once in the response, escaped inside the JSON flight
payload — never as HTML. Confirmed on two separate dead URLs.

So the 404 page is blank until JavaScript loads and hydrates it.

**Scope checked, and it is narrow.** All 17 public pages were measured and every
one ships real markup (6 KB–92 KB). This is specific to the not-found path, not
systemic.

**Severity, honestly.** Visitors with JavaScript — effectively all of them — see
the correct page after hydration, and the HTTP status is already correct, so the
SEO impact is minimal. The cost is a blank screen on a slow connection and
nothing at all without JS. Recorded with evidence rather than fixed, because the
fix touches how `not-found.tsx` resolves translations and the payoff is small;
worth doing deliberately rather than as a drive-by.

## F13 — Unknown top-level paths redirect to login *(Superseded — main #544 fixed it a third way)*

`/nope` answers **307 → `/login?redirect=%2Fnope`** rather than 404. Paths under
a known public prefix behave correctly: `/blog/nope`, `/features/nope` and
`/customers/nope` all return 404.

The cause is the middleware's allowlist: a path that is not public is treated as
a protected app route. **That is the correct posture** — failing closed is what
keeps an unlisted route from leaking, and the entire `/api/contact-center` and
assistant-bridge history on this codebase is about routes that were *missing*
from an allowlist. The cost is that a typo'd marketing URL lands on a login page
and search engines see a soft 404 instead of a hard one.

Deliberately **not changed** at the time: trading fail-closed routing for a nicer
typo experience is a bad exchange, and weakening auth routing is off-limits.
Recorded so the trade-off is known rather than rediscovered.

> **Superseded on 2026-09-13 by main #544** — and the reasoning above is why this
> note matters rather than a quiet edit. This entry told a future reader the
> change was off-limits. It is not, because #544 did not take either side of the
> trade-off as stated. It added an explicit **`PROTECTED`** list alongside
> `PUBLIC` in `lib/auth/route-access.ts`, so a path is now one of three things
> rather than two:
>
>     isPublic    -> serve it
>     isProtected -> require a session      (fail-closed, unchanged)
>     neither     -> fall through to the router, which 404s
>
> An unlisted app route is still protected, because app routes live under
> prefixes that are in `PROTECTED`. `/nope` is under neither list, so it is a
> path with no route and answers 404. Fail-closed routing is preserved exactly;
> the soft 404 is gone.
>
> The general lesson is worth more than the fix: a finding closed as "an
> unavoidable trade-off" is a finding that stopped looking for a third option.
> **Do not revert #544 on the strength of the paragraph above it.**

---

## F14 — Nine sitemap URLs declare themselves non-canonical *(Low, fixed on main by #526)*

**Not my find.** A parallel audit session raised it on
[#526](https://github.com/NewWorldVenture/Bubaly/pull/526); I verified it
independently before recording it:

```
GET /blog?category=Parenting          -> 200
     <link rel="canonical" href="https://www.bubaly.com/blog"/>
```

`app/sitemap.ts` emits one entry per blog category — 9 of them. Each answers 200
but names `/blog` as its canonical, so the sitemap asks Google to index URLs the
pages themselves declare are not the canonical version. A sitemap entry and a
canonical pointing elsewhere are a contradiction; the entries are dropped from
the index and the crawl budget is spent anyway.

Same family as F1 — the sitemap claiming something the site does not support —
and it is in this audit's scope. I missed it: I checked whether sitemap URLs
**resolved**, which they do, and never checked whether they were **indexable**.
Worth naming as a gap in my method, not just a gap in the sitemap.

**Deliberately not fixed here.** #526 rewrites the same file with a broader
`canonicalUrl()` — trailing-slash normalisation, per-segment percent-encoding,
and refusal of query strings, fragments, non-relative paths and anything
`robots.txt` disallows, reading that disallow list from `robots.ts` so the two
cannot drift. That is a better fix than a second patch of mine would be, and two
PRs rewriting `app/sitemap.ts` in different directions helps nobody.

### Overlap with #526, stated plainly

#526 independently found and fixed F1 (the 435 dead seed URLs) and F3 (the
duplicate homepage). Its approach is broader on URL hygiene; mine has one
property worth preserving in whichever lands second — `isAdvertisablePlatformPath()`
applies **the same predicate the renderer uses** (`isSyntheticBlogSeedSlug`), so
the sitemap and the blog page cannot drift apart again, which is the root cause
F1 actually had.

The rest of this branch — robots coverage, the seeded customer stories, the
missing `<h1>`s, the brand-doubled titles — does not overlap #526 at all.

---

## F15 — Family Autopilot ran for every family on the platform *(High, fixed)*

F7 closed a gate that existed on the Contact Center screen and nowhere in the
pipeline behind it. That is a shape, not an incident, so every paid feature was
re-checked for it. Autopilot had the same one, and worse consequences.

`/dashboard/autopilot` is `requireFeature`-gated, and `resolveAutopilotSuggestionAction`
re-checks the tier before it writes. Both are correct. But the two things that
actually *run* Autopilot checked nothing:

| Entry point | Guard it had |
|---|---|
| `GET /api/cron/autopilot-scan` | none — `from('families').select('id').limit(5000)`, then scan each |
| `POST /api/autopilot/scan` | `requireUserContext()` — a session, not an entitlement |

So the nightly cron ran the full Plus feature for every family on the platform.
`runAutopilotScan` is not a read: for a family that never bought it, it

- wrote behavioural traits to `family_digital_twin_profiles`,
- auto-created `reminders` rows and `grocery_items` (the "auto-executed" path),
- inserted `autopilot_suggestions`, and
- sent push/email through the notifications service.

The gating made that worse rather than safer. A Free family got reminders and
shopping-list entries they did not create, and notifications about them — then
could not open `/dashboard/autopilot` to see where any of it came from, because
the page redirects them to billing, and could not dismiss a suggestion, because
the action returns `accessDenied`. The only surface that explained the writes was
the one they were refused.

### The fix — one resolver, not a fourth copy

`requireFeature` could not be reused here: it resolves the caller's session and
then throws a `redirect`, which a cron has neither of. That is exactly why every
pipeline that *did* check had hand-rolled its own copy of "tier → level →
compare" — `lib/server/ai-access.ts`, `lib/services/trips/confirmation-import.ts`
and `lib/services/onboarding-calendar/access.ts` each hold a different one — and
why the two above simply skipped it.

So the resolution moved into `lib/server/feature-entitlement.ts`, and
`requireFeature` became a wrapper over it. The page guard and the pipelines now
compute entitlement with the same function; they cannot drift again without
someone deleting the call.

Both entry points now refuse, and the interesting part is what they do when the
plan cannot be *read*. `resolveFamilyPlanLevel` throws on a failed subscription
read, and an unreadable plan is not an unentitled family — the F7 lesson,
applied again:

- the cron counts it as a **failure** for that family (502 overall), never a
  skip, so a subscription blip cannot silently stop Autopilot for a paying
  family while the run reports success;
- the route answers **503**, not 403, so a paying family is never told they need
  to upgrade to something they already bought.

### Proof, not a green test

`tests/autopilot-plan-gate.test.ts` drives both real routes against an in-memory
database holding one Free and one Plus household, and asserts which family ids
`runAutopilotScan` was handed. Four mutations were applied to confirm the
assertions bite — the cron gate, the route gate, "unreadable plan → skip", and
"unreadable plan → 403" — and each failed the suite before being reverted. The
one source-reading case in the file is the one claim that *is* about source:
that `requireFeature` no longer holds its own copy of the comparison.

## F16 — Paid features enforced only by the sidebar padlock *(High, fixed)*

The sidebar already refuses every paid feature to a family below its tier.
`featureAccessByTier` returns `'locked'`, and `NavEntry` then renders a padlock
and an upgrade prompt **instead of a link** — never a dead link, deliberately.
So the product tells a Free family, in the UI, that they do not have these.

**24 of the 62 paid features did not check on the server.** Each page called
`requireUserContext()` and rendered. Typing the URL was the entire bypass.

| Tier | Pages |
|---|---|
| Plus | `/dashboard/family-automation`, `family-cfo`, `family-coo`, `family-digital-twin`, `family-emergency`, `family-health`, `family-operations`, `family-school`, `family-stress`, `/missions` |
| Basic | `/dashboard/activity`, `announcements`, `assistant`, `concierge`, `concierge/runs`, `insurance`, `kitchen`, `memories`, `migrate`, `pets`, `readiness`, `social`, `trip-intel`, `/referrals` |

Part of this was already known and written down — `docs/AI_FAMILY_OS_IMPLEMENTATION_MAP.md`
records "Tier/allowance enforcement for AI | **missing** | … no `requireFeature`
on either page" — but only for the two AI pages, and it had not been connected
to the other 22.

### It was not only reading

`lib/family/actions.ts` is the generic write path for eleven family tables. It
checked the signed-in user and, for sensitive tables, the member's role. It did
not check the plan. So a Free family could **write** Plus-feature data:
automation rules, emergency plans and contacts, stress signals, and behavioural
profiles in `family_digital_twin_profiles`.

Nine of those eleven tables now resolve to a feature and are gated through the
same `resolveFeatureEntitlement` the pages use. Two are not, and the omission is
deliberate and commented rather than silent: `family_ai_recommendations` and
`family_milestones` are each rendered by several pages that are not catalog
features at all, so there is no one feature a write to them belongs to, and
guessing would gate a surface nobody decided to gate.

Three further choices worth stating, because each could reasonably have gone the
other way:

- **Delete is not gated.** A family that drops a tier keeps the right to remove
  rows they made. Access is gated; ownership is not.
- **`setRecommendationStatus` and `resolveAutomationRun` are not gated.** Both
  resolve an item that already exists rather than create new use of the feature,
  and gating them would strand a downgraded family's pending items.
- **Super-admins bypass**, exactly as they do on the page, so preview still
  works.

### Two tiers that were themselves the mistake — now free

`/dashboard/migrate` ("Switch to Bubaly", the competitor-import wizard) and
`/referrals` (refer-a-friend) were both Basic in the catalog. The sidebar had
always shown them locked to a Free family, but nothing enforced it until the fix
above — so the day enforcement arrived, a Free family lost the wizard that brings
their data across from a competitor and the page that refers a friend.

Raised here as "the fix is the tier, not the gate", and the owner made that call
on 2026-09-13. **Both are `free` now.** An on-ramp you have to buy before you can
use it is not an on-ramp, and a referral programme switched off for everyone who
has not paid refers nobody.

The `requireFeature` calls stay on both pages. At the free tier they pass
everyone, and if either tier ever moves back, enforcement follows without anyone
having to remember those two pages exist. That is the whole point of the fix: the
tier is now the only thing that decides, and it is one line.

### Proof

`tests/paid-features-enforced-server-side.test.ts`. The sweep is derived from
the catalog rather than a list, so a new paid feature added without a guard
fails it. Comments are stripped before matching — a JSDoc mentioning the guard
is how the F11 sweep went vacuous once already — and one case proves the
detector itself by pointing it at a page that genuinely has no guard. The write
path is exercised for real against an in-memory database: a Free family is
refused and nothing is written, a Plus family's identical write lands, and an
unreadable plan produces a *different* message, because telling a paying family
to buy what they already own is the failure mode that matters.

Three mutations were applied and each failed the suite before being reverted.

## F17 — The documented tier map disagreed with the enforced one *(Medium, fixed)*

`ROUTE_PLAN_LEVEL` in `lib/constants/plans.ts` maps 58 routes to a minimum plan
level. Nothing reads it — `docs/AGENT_HANDOFF.md` says so outright
("`ROUTE_PLAN_LEVEL` is documentation only"). It was maintained by hand.

Of the 55 routes it shares with the enforced catalog, **19 disagreed** — a third
of the table. Not marginally, either: it documented `/dashboard/rewards`,
`/dashboard/sports`, `/dashboard/home` and `/dashboard/briefing` as *cheaper*
than they are enforced, and `/dashboard/chores`, `/dashboard/meals`,
`/dashboard/school` and six others as *dearer*.

That matters because three other documents cite it as fact —
`MARKET_DOMINATION_AUDIT.md` twice, `STRATEGY_WORK_QUEUE.md` once, and
`AI_FAMILY_OS_IMPLEMENTATION_MAP.md` builds an argument on
`ROUTE_PLAN_LEVEL['/dashboard/assistant']=0`. A stale table nothing executes is
still read by people, and by whoever writes the next audit.

The catalog routes are now **derived** from `FEATURE_CATALOG`, so they cannot
drift again. Only the five routes that are not catalog features at all
(`/dashboard`, `/dashboard/settings`, `/dashboard/billing`, `/dashboard/trust`,
`/dashboard/relationship`) are still stated by hand, because the catalog has
nothing to say about them. A test pins that the derivation stays derived: adding
a hand-written entry that contradicts the catalog fails it.

## F18 — Endpoints behind gated pages had no gate *(High, fixed)*

Thirty-nine routes live under `/api/ai`. Every one of them calls a model, which
is the only surface in this application that costs money per request. Of those:

| Guard | Count |
|---|---|
| `assertAIAccess` — feature, tier **and** the monthly allowance | 4 |
| `authenticateAI` — identity only; it resolves a caller and stops there | 5 |
| a hand-rolled `resolveFamilyPlanLevel` comparison | 4 |
| a session and a per-minute rate limit, and nothing else | **26** |

The second row is worth reading twice: `authenticateAI` sounds like the gate and
is not one. Two of the five routes that rely on it — `ai/voice/speak` and
`ai/voice/transcribe` — are model calls.

Fourteen of those 26 sit directly behind a page that `requireFeature` refuses.
`/api/ai/resolve-conflict` serves `/dashboard/conflicts` (Plus).
`/api/ai/briefing` serves `/dashboard/briefing` (Plus). The page refused; the
endpoint behind it did not, and a `fetch` is not harder to send than a URL is to
type.

Each mapping was established by finding the component that calls the endpoint
and the page that hosts it, not by matching names:

| Endpoint | Called from | Page it serves |
|---|---|---|
| `ai/resolve-conflict` | `family/conflict-resolver` | `/dashboard/conflicts` (Plus) |
| `ai/briefing` | `lib/briefing/cache-isolation` | `/dashboard/briefing` (Plus) |
| `ai/assist`, `ai/import` | `modules/inbox-module`, `modules/concierge-module` | `/dashboard/inbox`, `/dashboard/concierge` |
| `ai/chef` | `modules/kitchen-dashboard` | `/dashboard/kitchen` |
| `ai/flyer` | `modules/scan-module` | `/dashboard/scan` |
| `ai/health/coach` | `modules/health-module` | `/dashboard/health` |
| `ai/home/diagnose`, `find-pro`, `forecast` | the three `home/*` clients | `/dashboard/home` |
| `ai/home/utility-savings` | `modules/utilities-module` | `/dashboard/utilities` |
| `ai/savings` | `modules/savings-coach-card` → `subscriptions-module` | `/dashboard/subscriptions` |
| `ai/trip` | `modules/trip-intel-module` | `/dashboard/trip-intel` |
| `ai/auto/accident` | `auto/accident-client` | `/dashboard/auto` |

The same sweep run outside `/api/ai` found six more, most of which also call a
model:

| Endpoint | Called from | Page it serves |
|---|---|---|
| `behavior/insight` | `modules/behavior-module` | `/dashboard/behavior` |
| `weekend/discover` | `modules/weekend-module` | `/dashboard/weekend` |
| `vacations/ai`, `vacations/weather` | `vacations/trip-concierge`, `trip-weather` | `/dashboard/vacations` |
| `social/ai` | `social/studio-form` | `/dashboard/social` |
| `notifications/generate` | `modules/notifications-module` | `/dashboard/notifications` |

All twenty now refuse through `refuseUnlessEntitled`, which resolves through
the same function the page does. The refusal happens **before the rate limiter
and before the provider call**, which the tests pin explicitly: a gate placed
after the model would refuse the family and still have paid for the answer.
`ai/assist` is served by two modules, so it accepts either — requiring both
would refuse someone the page in front of them allows.

Two more were checked and deliberately left alone. `/api/paperwork/capture` and
`/api/paperwork/link` are reached from `/capture`, which is not a catalog
feature, so there is no one feature a call to them belongs to — the same
reasoning that left `family_milestones` open in F16. `/api/assistant` and
`/api/assistant/alexa` are unauthenticated **by design** and correctly so: the
token is the authorization (like the ICS feeds), they rate-limit by IP *before*
the token lookup so the endpoint cannot be used to guess tokens at speed, and
the Alexa one verifies Amazon's signature and answers a bare 403 when it cannot
be proven — with no speech, so a prober learns nothing.

One near-miss worth recording. `components/marketing/switching-band.tsx` appears
in a grep for `/api/ai/flyer`, which looked for a moment like a public marketing
component calling an authenticated AI endpoint. It is a comment citing the route
as evidence that a claim in the copy ships. Checked before it was written down.

`/api/ai/gift` is genuinely public and is *correct*: documented as such,
IP-rate-limited both in memory and durably, scoped to one already-secret gift
token, and read-only. It is the model the other routes should have followed.

## F19 — Most AI endpoints run unmetered *(Medium, open — a pricing decision)*

F18 fixed *entitlement*. It did not fix *metering*, and the two are different
questions.

`lib/server/ai-access.ts` defines `AI_MONTHLY_ALLOWANCE` per plan level and
enforces it — for the **4** routes that call `assertAIAccess`. The other 35 have
at most a per-minute rate limit, which bounds a burst, not a month. A family on any
tier can call `/api/ai/chef`, `/api/ai/meals/plan`, `/api/ai/journal`,
`/api/ai/notes` and twenty more as often as they like, all month, and each call
is a paid model request.

This is **not** written up as a defect to fix, because the fix is a pricing
decision and both directions cost something:

- **Meter them all against the existing allowance.** Simple, consistent, and it
  changes what paying customers can do today — a Basic family that uses the meal
  planner daily would start hitting a wall it has never hit.
- **Meter only the expensive ones.** Truer to cost, and needs per-route budgets
  nobody has set.
- **Leave them unmetered** and accept the exposure, which is what happens now,
  but deliberately rather than by omission.

What is *not* a live risk: every one of these routes requires a session, a
family, and now — where the page is gated — an entitlement. The exposure is a
signed-in family's own usage, not the open internet.

Twelve of the 26 unguarded routes were left ungated by F18 on purpose: they
serve features that are Free (`ai/journal`, `ai/habits`, `ai/meals/plan`,
`ai/notes`, `ai/schedule`, `ai/relationship`, `ai/pantry-chef`), or they fan out
across a dozen modules and would need a per-`kind` mapping (`ai/insights`), or
they are the assistant itself (`ai`, `ai/chat`). For those, metering — not
entitlement — is the right instrument, which is exactly the decision above.

The numbers an owner needs are here; the choice is theirs.

## F20 — A child could clear the chore board *(High, fixed)*

The plan sweeps asked who may use a feature. This one asks who may use it
*within* a family, and it is the same shape with a different subject.

The chores board has four manager-only writes. Two were defended and two were
manager-only on the screen alone:

| Board action | UI | Server |
|---|---|---|
| Approve a submission | `manager &&` | ✅ trigger `chore_assignment_decision_guard` (0223) |
| Pay a chore reward | `manager &&` | ✅ `isManager` in `payChoreRewardAction` + manager-only wallet RLS (0217) |
| **Add a chore** | `manager &&` | ❌ nothing |
| **Delete an assignment** | `manager &&` | ❌ nothing |

Nothing behind the screen agreed. The actions took any signed-in member,
`createChore` and `deleteChoreAssignment` scope by family and not by role, and
the RLS on `chore_assignments` is `is_family_member` for **all four**
operations (migration 0004 applies one membership-only policy set across 21
family tables). So a child could delete any chore on the board — including one
assigned to them — and mint chores assigned to a sibling, with points.

### Why this is the gap and not the design

The team had already reasoned about exactly this class. Migration 0223 closed
`update chore_assignments set status='approved'` by a child, and its own header
calls it "an accountability/integrity forgery, not a money-minting one", the
sibling of the `chore_submissions` forge closed in 0222.

Deleting the assignment reaches the same end from the other direction. A child
who cannot forge *completion* can simply remove the row: the chore is gone from
the board, and so is the record that it was ever owed. Closing one and not the
other is not a decision anyone made — 0223 enumerates the statuses a member may
drive and never mentions the delete.

### The fix, and where it sits

`isManager` in the two server actions, refusing before the service is reached.

The action layer rather than the service, for two reasons. It is where the
screen's claim lives; and it is where `payChoreRewardAction` — the board's third
manager-only write, and the one that moves money — already puts it, so the
board's writes now check in one consistent place. The service stays reachable by
the assistant's path, which the Trust Engine governs separately and which this
audit did not examine.

**Defence in depth is the right follow-up and is deliberately not in this
change.** The repo's own pattern (0222, 0223) is a database trigger alongside the
code check, and a `can_manage_family()` guard on delete would be its natural
sibling. But the migration ledger is the subject of F5: the baseline is
unrepaired and the workflow cannot authenticate, so adding a migration that
cannot be applied would enlarge a backlog that is already blocked. It belongs
with the operator who fixes F5, and is recorded here rather than half-done.

### The open half: who may advance a status

`ChoreRow` carried the comment *"Assignee can advance their own chore's status;
managers can act on any."* Neither half was true. The control renders for every
member regardless of assignee, and `setChoreProgress` scopes by family only — so
any member can advance any chore, including submitting a sibling's chore they
did not do.

That comment is now corrected to say what the code does, rather than the rule
being implemented quietly. Enforcing "assignee, or a manager" is a product
decision: it is a real restriction on a board families may drive
collaboratively, and unlike the delete there is no screen-level claim being
violated — the UI and the server already agree. It needs an owner's call, not a
patch.

### Three candidates checked and cleared

Run against every component that gates UI on `isManager`, the same sweep also
looked at:

- `setLocationSharing` — no role check, and **correct**: it writes only the
  caller's own `member_locations` row. A member turning their own sharing off is
  the point.
- `saveAISettingsAction` — no role check in the action, and **correct**:
  `updateAISettings` refuses a non-manager in the service, one layer down.
- `savePlace` / `deletePlace` / `setGeofenceEnabled` — already `isManager`-gated.

Recording what the sweep cleared matters as much as what it caught: three of the
four plausible instances were already right.

## F21 — A child could grant themselves a reward *(High; half fixed and live, half awaiting the operator)*

F20 found one gap the team's own `0222`/`0223` work had left. Looking for the
rest of that family found the other, and it is the more direct of the two.

`reward_redemptions` shipped in `0028` with a single policy —
`FOR ALL … USING is_family_member(family_id) WITH CHECK is_family_member(family_id)`
— and no trigger. Both of its write paths were **direct browser writes** that
chose `status`, `decided_by` *and* `cost_points` client-side:

| Path | Write |
|---|---|
| `chores-module.tsx` → `redeem()` | insert; `status` = `'approved'` when the client believed the member was a manager |
| `rewards-module.tsx` → `requestReward()` | insert; the same choice |
| `rewards-module.tsx` → `decide()` | update; `status` straight from the caller |

**The choice was the client's.** A child could insert a redemption already
marked `approved` with `decided_by` pointing at themselves, or approve one
sitting in the queue — and set `cost_points` to whatever they liked in the same
request.

This is the **third** of three decision surfaces in the chores and rewards
economy. `0222` closed the submission forge, `0223` the assignment-status forge,
and this was the only one left open. Like them it **mints no money**: the points
economy is separate from the wallet, which is manager-only under `0217`. It is
an accountability forgery, in the exact words `0223`'s own header uses.

### The half that ships without the migration

Both write paths go through `app/(app)/dashboard/rewards/actions.ts`. The role is
resolved from the session rather than asserted by the caller, `decided_by` is the
session's own member, and `reward_title` and `cost_points` are read from the
reward instead of accepted from the request.

That last one is the quieter half of the finding: `cost_points` is a deliberate
snapshot so history survives the reward being edited (`0028`), and a snapshot the
spender supplies is not a snapshot — a child could ask for an expensive reward at
a cost of zero points, and the balance the board renders would never know.

Reads stay in the client. Both screens subscribe to the table through
`useRealtimeQuery`, which is the point of a live board; it is the writes that had
to move, and the test forbids those specifically rather than any mention of the
table.

This does **not** close the finding. `reward_redemptions` is reachable from
PostgREST whatever these actions do, so the forgery is now a hand-crafted API
call rather than a browser console. A smaller door, not a shut one.

### The half that shuts it, and cannot be applied

Migration `0295` is the sibling of `0222` and `0223`:

- **Guarded**: `approved`, `rejected`, `fulfilled` — the three a parent decides.
- **Left to the member**: `requested` and `pending` (asking), and `cancelled`
  (withdrawing your own ask, which needs no parent). A guard that blocked those
  would break the queue it exists to protect.
- **Allowed through**: the service role, an unauthenticated migration or seed,
  and `can_manage_family()`.

No legitimate flow breaks: the only code that sets a guarded status is a
manager's own click in the two modules above, and the service role.

### Proven before it was written down

`docs/audit/reward-redemption-decision-check.sql` runs as a real `authenticated`
session under RLS and asserts **both** directions — child insert-as-approved,
approve-from-queue and mark-fulfilled all refused; child request and child cancel
allowed; parent approve and fulfil allowed.

It was run against a local PostgreSQL 16 with the trigger present (six assertions
pass) and with it dropped, where it fails on the first case: *"a child inserted
an APPROVED reward redemption"*. CI replays it against the fully bootstrapped
schema on every pull request — `run-probes.sh` globs rather than lists, so it
runs without anyone registering it.

### What is not done

**The migration is not applied, and cannot be.** That is F5: the workflow cannot
authenticate and the ledger baseline is unrepaired, in that order. Until an
operator clears both, the direct-to-PostgREST forgery is live in production and
the guard sits in the repository, replayed and probed by CI, waiting.
`docs/PENDING_PROD_MIGRATIONS.md` records it alongside the others, so it is
visible rather than inferred from the absence of a row.

This is the one finding in this audit whose fix I could write but not land.

## F22 — A child's username was matched as a pattern *(High, fixed)*

`lib/auth/child-throttle.ts` states the stakes in its own header: *"a 4-digit
PIN is only 10,000 combinations and kid usernames are guessable (suggested from
the display name), so unthrottled sign-in is a real account-takeover risk."* The
throttle it implements is the control that makes a 4-digit PIN survivable — five
failures per username per fifteen minutes, then an escalating lockout.

Sign-in resolved the account with `.ilike('username', username)`. In SQL LIKE,
**`_` matches any single character**. `USERNAME_RE` anchors both ends to
`[a-z0-9]`, so `%` and an edge underscore are refused — but it permits `_` in
between:

| Typed | Valid username? | `ILIKE` matches |
|---|---|---|
| `a%ice` | no | — |
| `alic_` | no | — |
| `a_ice` | **yes** | `alice` |
| `a___e` | **yes** | `alice` |

Verified against PostgreSQL 16 rather than reasoned about: `where username ilike
'a_ice'` returns `alice`; `where username = 'a_ice'` returns nothing.

### Why that broke the throttle rather than the password

On its own a wildcard match is not a bypass — the attacker still needs the PIN,
and sign-in proceeds as `row.username`, the real account. What it broke is the
budget.

The throttle is keyed on the username **as typed** (`child_login_throttle.username`),
while the lookup treated that same string as a **pattern**. So every wildcard
spelling was a different throttle key pointing at one real account:

```
alice → a_ice  al_ce  ali_e  a__ce  a_i_e  al__e  a___e      (7 spellings)
```

Eight keys × five failures = **40 attempts per fifteen minutes instead of 5**. An
eight-character username yields 63 spellings — **320 per window**. The per-IP
limiter (30/min) is then the only remaining bound, and it is per-IP, not
per-account, so it does not constrain an attacker with addresses to spend.

### The fix

`eq`, not an escape. Both sides are already lowercased by `normalizeUsername` —
the create path normalizes before inserting and sign-in normalizes before looking
up — so the case-insensitive match was buying nothing and costing the throttle
its purpose. `eq` removes the metacharacter class rather than escaping it.

The same change is applied to the "is this username free?" check in
`child-login-actions.ts`, which had the same `ilike` and was therefore answering
about a *different* login than the one being created. Over-strict rather than
under-strict, but wrong either way.

**This is consistent with the repository, not a new idea in it.** `escapeLike`
and inline `%_` escaping already appear in a dozen service queries — home, trips,
inventory, groceries, meals, finances. The two lookups that did not escape were
the two on the authentication path.

### What was left alone

Roughly a dozen `ilike('…', '%term%')` search queries do not escape. In a search
box an unescaped `_` makes the match slightly fuzzier and nothing more — there is
no throttle keyed on the term and no credential behind it. Widening this change
to cover them would have buried a security fix inside a refactor.

## Reconciliation with #526 — how the sitemap findings actually landed

#526 merged to `main` as `61ad4bb0` while this branch was open, and it rewrote
both files this audit touched. The overlap was predicted and written down before
it happened; this records the outcome.

**F1 and F3: #526's implementation won, and mine was withdrawn.** Its rule is
stronger than the one I shipped. I filtered the registry's `/blog` rows through
the same predicate the renderer uses; #526 observes that the `marketing_pages`
registry is a **path overlay** — a row decorates a path, it is not a claim that
the path resolves — and so lets a registry row mint a URL only for a prefix the
registry itself renders. `/blog` is served from `blog_posts`, so no registry row
can publish a `/blog` URL at all.

That **subsumes** the seed filter rather than duplicating it: if none can
publish a blog URL, none can publish a wrong one. My `isAdvertisablePlatformPath`
and `canonicalSitemapUrl` are deleted; `canonicalUrl()` and
`isRegistryRenderedPath()` do the work, and also cover percent-encoding, query
strings and fragments that mine did not.

One of my tests asserted the behaviour I had built — that a *real* blog path from
the registry is still advertised. Under #526 that is deliberately false. The case
is rewritten to assert the new rule and to say why it inverted, rather than being
deleted.

**F2 was not covered by #526, and still is not.** It kept the four-entry list
(`/dashboard`, `/onboarding`, `/api`, `/auth`). The 20 missing authenticated
surfaces are still this branch's finding, and the fix is now **better placed than
where I first put it**: #526 moved the disallow list into
`lib/marketing/sitemap-urls.ts` and made `canonicalUrl()` refuse any URL beneath
it, so robots and the sitemap cannot contradict each other. Expanding that shared
constant to all 24 surfaces therefore fixes robots **and** stops the sitemap from
ever listing them.

That coupling introduced one hazard worth pinning: the matcher is `=== p` or
`startsWith(p + '/')`. A looser `startsWith(p)` would now drop the **public**
`/family-display` from both robots and the sitemap, because `/family` and
`/display` are both on the list. Verified empirically and pinned by its own test.

---

## Verified healthy (no action)

| Area | Evidence |
|---|---|
| Security headers | CSP with `frame-ancestors 'none'` and `object-src 'none'`, HSTS `max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restricting camera/mic/geolocation to self |
| Public routes | 21 public routes probed; all 200 except the two noted below |
| `/onboarding` 307 | Correct — gated, redirects to login |
| `/resources/benchmarks` 404 | **By design.** Gated on an admin publication flag so an unpublished page is indistinguishable from one that never existed. The sitemap already refuses to list it unless published. Not a defect |
| Page metadata | All 17 public pages carry a real `<title>`, description and canonical. An earlier reading that `/how-it-works` and `/login` had none was **my own extraction bug**, re-checked and withdrawn — both are correct |
| API boundary | Every public-allowlisted API route refuses an unauthenticated request: contact-center email 401, sms/voice/transcription 401 each (with provider-shaped bodies), assistant 401, alexa 403, stripe webhook 400, forms 422. Nothing answered 200 with data |
| Production revision | `/api/build-info` reports `f9c4d7a1…`, matching `main` — production is current |
| Typecheck | `tsc --noEmit` clean |
| Lint | 0 errors (2 pre-existing `exhaustive-deps` warnings, untouched) |
| Test suite | 1,150 files / 13,102 tests passing |
| Security headers | see above — CSP, HSTS, frame/nosniff/referrer/permissions all present |
| Domain redirects | `http://bubaly.com`, `https://bubaly.com` and `http://www.bubaly.com` all 308 to `https://www.bubaly.com`; trailing slash 308s to the canonical path. An initial `000` reading on the apex was a transient blip — it resolved cleanly on all three retries, so it is not reported as a finding |
| Accessibility basics | one `<h1>` per page (after F11), all images carry `alt`, `lang` set, skip link present, single `<main>` landmark |
| Server-rendered content | all 17 public pages ship 6 KB–92 KB of real markup; only the 404 path does not (F12) |
| Programmatic SEO routes | `/compare`, `/guides`, `/alternatives`, `/audiences`, `/questions`, `/glossary` render from `marketing_pages` and simply have no published rows yet — feature built, content pending. Not a defect |
| Unresolved work markers | 38 `TODO`/`FIXME` in source; the substantive ones are migration-gated and explicitly marked "owner approval required", i.e. blocked behind F5. None independently closeable |
| Health endpoint | `status: ok` — env, database ~98ms, auth ~90ms, serviceRole ~508ms |
| Auth gating | All 20 authenticated segments answer 307 to `/login` when signed out |

### Checked during the entitlement sweeps, and sound

These were examined because they were the *next plausible instance* of a shape
this audit kept finding. None of them was one. Recording that matters: an audit
that lists only defects says nothing about what was actually looked at, and the
next person needs to know which stones were already turned.

| Area | What was checked | Why it is sound |
|---|---|---|
| **Payment webhooks** | `/api/webhooks/stripe`, `/money`, `/resend` | All three verify signatures before touching anything — Stripe via `constructEvent`, Resend via HMAC with `timingSafeEqual`. All fail **closed** when the secret is unset (503, not "allow"). Stripe additionally bounds the body and dedupes by event id under a claim token. This matters more than it looks: every plan gate in F15–F18 rests on `subscriptions`, and this is what writes it |
| **SSRF on user-supplied URLs** | `public-calendar-fetch`, `public-document-fetch`, `public-media-fetch` | Textbook-correct, including the case most implementations miss. Private/loopback/link-local CIDRs blocked; DNS resolved once and the address **pinned** into a per-request agent, so neither a rebinding race nor a pooled connection nor an environment proxy can reach an address that was never validated; `autoSelectFamily: false` so Happy Eyeballs cannot pick an unchecked one; https only |
| **Public write surface** | 15 unauthenticated API routes | Every one that accepts a body bounds it and rate-limits by IP, most through `enforceRequestRateLimit` (durable, cross-instance) rather than memory alone. The two without a limiter are a token-keyed idempotent GET and a small CDN-cached read — neither has anything to abuse |
| **AI memory read privacy** | "what Bubaly worked out about each person" | The panel tells a non-manager *"Only a parent or adult can see…"*, and for once the claim is kept where it should be: `listMemoryProfile` returns `traits: []` to anyone who is not a manager, so the empty state is the only state they can reach. Its comment reasons about the exact harm — *"A reliability score about a sibling is not a child's business"* |
| **Notification recipients** | `notify()` → `resolveRecipients` | Scoped to `family_id = scope.familyId` and `is_active`, so no member can address a notification outside their own family |
| **Role checks that looked missing** | `setLocationSharing`, `saveAISettingsAction`, the locator's place writes | All correct. The first writes only the caller's own row; the second is refused a layer down in `updateAISettings`; the third was already `isManager`-gated. Three of the four candidates in that sweep were already right — only the chore board (F20) was not |

## What remains, and who owns it

Nothing here is unexamined. Each item is closed with a decision or assigned to
someone who has access this session does not.

| Item | Owner | Next step |
|---|---|---|
| **F5** Supabase migration workflow | Operator | The access token or project ref lost its privileges some time after 2026-09-07. Restore it, **then** repair the ledger baseline — the gate throws by design until `0004` is recorded, and that is explicitly a credentialed operator action. `docs/PENDING_PROD_MIGRATIONS.md` claimed "connectivity works" until this audit corrected it; it now states the failure and that fixing the token alone is not sufficient |
| **F6** Family email routing | Operator | Step-by-step in [`docs/runbooks/family-contact-center-routing.md`](docs/runbooks/family-contact-center-routing.md) — written during this audit because none existed. Set `CONTACT_CENTER_INBOUND_SECRET` in Vercel, redeploy, point `bubaly.com` MX at an inbound-parse provider aimed at `/api/contact-center/email?key=…`. Until then the webhook correctly answers 401 |
| **F10** Seed rows in the database | Operator | The site no longer renders them. Deleting the three `case_studies` rows is a Super Admin action |
| **F9** i18n payload | Engineering | Design settled, safety proven, and the mechanism now needs no middleware or restructure — a nested provider in `app/(app)/layout.tsx` with a 702-key (44 KB) root set. Three named keys to cover first. Needs one person to confirm a marketing page renders in a browser, which this environment cannot do |


## Dependency security — closed, nothing to fix

`npm audit` reports 8 advisories (3 moderate, 5 high). **None of them affect
bubaly.com**, and that was checked rather than assumed: every package was
resolved against the production dependency tree.

| package | in production tree |
|---|---|
| `js-yaml`, `tar`, `brace-expansion`, `browserslist` | no |
| `@xmldom/xmldom`, `vitest`, `@vitest/mocker`, `baseline-browser-mapping` | no |

`npm audit --omit=dev --audit-level=moderate` — the exact command CI runs —
reports **0 vulnerabilities**. All 8 are build and test tooling that never
reaches the deployed artifact.

So there is no site finding here. Upgrading the dev toolchain is ordinary
maintenance, not audit remediation, and worth noting it cannot be done casually:
`npm audit fix` cannot even produce a plan on this tree (it exits with an
internal npm error), so it would mean a hand-managed lockfile rewrite against a
13,000-test suite for no change to what users run.

## Method, and what it could not reach

Findings were established by probing the live site and reading the real code
path, then reproduced before being recorded. Each fix was checked for
non-vacuity by reverting it and confirming the new tests fail.

That discipline paid twice, and both are recorded rather than quietly corrected:

- **A finding withdrawn.** An early reading that `/how-it-works` and `/login`
  shipped no title, description or canonical was my own extraction bug. Both are
  correct. Re-checked and struck.
- **A vacuous test caught.** The first version of the F11 sweep passed with the
  fix reverted, because the JSDoc it was testing contains the literal `as="h1"`.
  Found by reverting a page and watching the test stay green — the same failure
  as F4, in the fix for F11.

**One limitation worth stating plainly, so nothing above is over-read.** No
browser could run in this environment. Chromium launches but every navigation
dies inside the agent proxy relay (`ws_closed_mid_exchange`, 39 bytes received)
for *every* host, including `www.google.com` — so it is the relay, not the site.
`curl` through the same proxy works, and every finding above rests on that or on
the code.

So the following were **not** checked and are not claimed: client-side console
errors, hydration behaviour, visual layout and responsive rendering, and
interactive flows (forms, the consent manager, the language picker). A local
production server was started to close the gap and reproduced the routing
behaviour, but could not exercise data-backed pages — without real Supabase
credentials they answer 500 before reaching the code under test.

This is also the single reason F9 is a decision rather than a fix: its entire
risk surface is hydration, which is precisely what could not be exercised here.

---

# Pass B — Data layer (F-001–F-019)

A running, evidence-based audit of bubaly.com. Every entry records what was
checked, **how**, and what the check actually returned. Nothing is marked closed
on reasoning alone — a finding closes only when a command, probe, or rendered
page demonstrates it, and wherever a fix is claimed the check was also run
against the broken state to prove it was not passing vacuously.

- **Audit head:** `ed85df8a` (main, after Pass A's fixes) + this pass
- **Scope:** 395 pages · 140 API routes · 306 migrations · 1,170 unit-test files
- **Environment:** full local Supabase stack (all 306 migrations replayed), seeded
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
| Lint | `next lint` | ✅ 0 errors (4 pre-existing `react-hooks/exhaustive-deps` warnings) |
| Unit tests | `vitest run` | ✅ 13,537 tests |
| Build | `next build` | ✅ exits 0 |
| Schema ↔ code | `db:audit:queries` | ✅ 491 tables, 77 functions, 140 routes resolve |
| Migration names | `db:audit:migrations` | ✅ 307 files, no collisions |
| Migration replay | fresh DB, 0 → 307 | ✅ all applied, 0 failed |
| Migration **re**-apply | populated DB, replay from `0004` | ✅ 0 failed (was 18 — F-020) |
| i18n | `i18n:gate` | ✅ all declared surfaces clean |
| RLS boundaries | 15 probes, fresh 307-migration replay, run 2× | ✅ 15/15 each time (F-015 made it repeatable) |
| Authenticated routes | 353-route crawl | ✅ 351 ok, 1 gate redirect, 0 failures |
| Public content routes | unknown-slug probe | ✅ 404s (was one 500 — see F-005) |
| API authorization | guard-vs-public-list sweep | ✅ 140/140 accounted for |
| E2E | 108 specs + 2 gated journeys | ✅ all pass (a journey caught F-006) |
| Nightly jobs | all 11 cron routes exercised end to end | ✅ clean (F-008, F-009, F-010, F-014) |
| Whole-table reads | live PostgREST, 3 real tables | ✅ complete and distinct (F-008, F-011) |
| Row-ceiling honesty | scan of `app/` + `lib/` | ✅ 0 limits above the cap (was 59 — F-013) |
| Notification dedupe | 5 cron runs, duplicate-group count | ✅ no new duplicates (F-014) |
| Public sitemap | 1,049 published posts vs the served file | ✅ 1,049 listed (was 1,048 — F-012) |
| Calendar-day correctness | day keys vs DATE columns, 9 zones | ✅ family zone on every user-facing surface (F-017) |
| Query plans | family-scoped reads at 700k rows | ✅ index scan, was a full scan (F-018) |
| Money under concurrency | 2 simultaneous auths vs one balance | ✅ exactly 1 approves (F-019) |
| Production DB | migration ledger | ⚠️ **blocked — F-001** |

---

## 2. Open findings

### F-001 · Production migration ledger records only `0001–0003` — owner action

**Severity:** high · **Status:** OPEN, cannot be closed from a sandbox
· **Same wall as Pass A's F5**, reached from the database rather than from CI

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
**`0290` below**, replays cleanly in the repo but is *not applied to
production*. Needs an operator following `docs/runbooks/LB-016-…md` §4.

F-001 is the only finding still open. Everything else in this file closed with a
command, probe, or rendered page behind it.

**What this means for what actually shipped.** The code for every fix here is on
`main`. The four migrations are not, and cannot be until an operator runs them,
so two closures are only half-live in production:

| Fix | Code on `main` | Needs migration | State in production until an operator runs it |
|---|---|---|---|
| **F-010** `notifications.related_id` is a key, not a uuid | — | **`0293`** | The column is still `uuid`, so the generic notification pass still rejects every composite dedupe key |
| **F-014** dedupe read batched | ✅ | depends on `0293` | The batching is live, but the read it protects cannot succeed until `0293` lands |
| **F-003** `anon` write grant on the money tables | — | **`0290`** | Still open in production |
| **F-006** privileged-RPC lockdown re-asserted | — | **`0292`** | `0253`/`0204` may still be undone later in the chain |
| Everything else (F-002, F-005, F-007–F-009, F-011–F-013, F-015, F-016) | ✅ | none | Fully live |

The `Supabase production migrations` workflow fails on every push for the reason
Pass A's F5 records, so this is not a matter of waiting — it needs the operator
action in both F5 and F-001. Agents must not apply migrations to production
(`docs/PENDING_PROD_MIGRATIONS.md`), and this one did not.

**What changed for the operator this pass.** The repair procedure in
`LB-016 §4` would not have worked. Replayed against a database that already
carries the schema — production's actual condition — `supabase db push` stopped
on the *first* file it tried, and left `0004` unrecorded, so the guard would not
have cleared either. That is now fixed and rehearsed end to end: see **F-020**.
The finding stays open because the credentials are the operator's and applying
migrations is not an agent action, but it is no longer open on top of a
procedure that does not run.

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

**Severity:** high (defence-in-depth) · **Status:** CLOSED — migration `0290`

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

**Not exploitable as found, and `0290` does not claim otherwise.** The only
permissive INSERT policy is also `TO authenticated`, so an anon insert is
refused for want of any permissive policy. Verified directly:

```
set role anon; insert into public.wallet_transactions (...) values (...);
ERROR:  new row violates row-level security policy for table "wallet_transactions"
```

What `0290` restores is the layer that makes that robust: one future permissive
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
after the migrations would have re-granted exactly what `0290` revokes and
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

**Severity:** high (cross-tenant) · **Status:** CLOSED — migration `0292`

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

`0292` re-asserts all five at the end of the chain. Verified after the fix: a
member and anon both get `42501 permission denied` through PostgREST, and
`service_role` still executes. The gated E2E journey that asserts exactly this
(`authenticated.spec.ts:150`, "Only the server worker may claim AI jobs") now
passes, having failed before.

### F-007 · The additive-migrations guard flagged a revoke as destructive

**Severity:** low · **Status:** CLOSED

`tests/migrations-are-additive.test.ts` scans for a bare `\btruncate\b`, so
`revoke insert, update, delete, truncate … from anon` in `0290` read as
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

**Severity:** high · **Status:** CLOSED — migration `0293`

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
to pick the uuid back out of a colon-delimited string. `0293` widens it to
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
· Distinct from Pass A's F1/F3/F14, which were about *which URLs* it listed;
this is about the file being a stale copy. Both fixes are in the current file.

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

A PostgREST filter travels in the **query string**. Since `0293` (F-010) these
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
single statement undoes the deliberate revokes in `0204`/`0253`/`0292` and hands
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

### F-017 · A family's "today" was Greenwich's today, on every surface that shows a day

**Severity:** high · **Status:** CLOSED — `dayKeyInTz` adopted across the
user-facing surfaces; the background remainder is allowlisted with reasons

A DATE column in this schema holds the day on the family's kitchen wall.
`new Date().toISOString().slice(0, 10)` answers the day at Greenwich. Nineteen
files compared one against the other.

This is not an edge case. Measured across every minute of a day:

```
America/Los_Angeles   420 min/day wrong   (29.2%)
America/New_York      240 min/day wrong   (16.7%)
Asia/Tokyo            540 min/day wrong   (37.5%)
Australia/Sydney      600 min/day wrong   (41.7%)
```

For a Californian household that is **every evening from 5pm**.

Proven end to end against the database, at 18:30 on a Sunday in Los Angeles:

```
instant                : 2026-09-14T01:30:00Z
family wall clock      : Sunday, September 13, 2026 at 6:30 PM
the family's today     : 2026-09-13
page's today (UTC)     : 2026-09-14   ← what meal_plans was queried with

  the page rendered  →  "Monday pasta — tomorrow"
  the family was eating →  "Sunday roast — eaten TONIGHT"
```

The same instant rolled `weekStart` forward too, so **"this week" silently became
next week every Sunday evening**.

Three findings within the class were worse than a wrong list:

- **The family display.** A wall-mounted kitchen screen took the *server's*
  midnight (`setHours(0,0,0,0)`), which on a UTC host is 17:00 in California —
  the screen turned over to tomorrow's schedule in the middle of the afternoon,
  every day. It now uses the family's day bounds.
- **Medication reminders.** `generateFamilyNotifications` bounded "doses already
  logged today" at UTC midnight. In California that window opens at 17:00 local,
  so the morning dose looked untaken and the family was reminded again; in Tokyo
  it opens at 09:00 the *previous* local day, so yesterday's dose was mistaken
  for today's and **the reminder never fired**. A missed medication reminder is
  the worse of the two.
- **Allowance scheduling.** A parent setting up an allowance on Sunday evening
  in California had `next_run_on` dated from Monday.

The fix was already written and documented. `lib/services/scope.ts` has carried
`dayKeyInTz` / `zonedDayBoundsMs` all along, and its own header names this exact
bug — *"a household in America/Los_Angeles sees tomorrow's day key for the last
seven hours of every day"*. Four surfaces used it; nineteen never adopted it.
This finding is about adoption, not about inventing a mechanism.

Two helpers were missing and are added: `addDaysToDayKey` and `weekStartDayKey`,
both string-in/string-out so they never touch an instant and cannot be knocked
off by a DST transition. Measured: from local midnight on 26 Oct 2026, adding
seven *fixed* days lands at 23:00 on 1 Nov — a day short of the calendar answer.
The window where that bites is 26–31 Oct, which is precisely why spot-checking
one date misses it.

**Converted:** kitchen, readiness, agents, intelligence, planning, moments,
family-cfo, food, display, wallet actions, and the medication window in
`lib/server/notifications.ts`.

**Not converted, each with its reason**, recorded in the guard's allowlist rather
than left looking overlooked: `lib/network/aggregate-server.ts` (platform-wide
aggregation — UTC bucketing is what a cross-household benchmark should use),
`app/api/cron/wallet-allowance/route.ts` (platform-wide cron; bounded at one day
early for families west of UTC), and five background derivations that take a
`familyId` but no zone, so converting them means threading one through.

`tests/family-day-not-greenwich-day.test.ts` fails on any new surface that builds
a Greenwich day key beside a DATE filter without reaching for the zone helpers,
and a second case fails if an allowlist entry outlives its reason — an allowlist
that rots is how the next regression hides. Reverting the kitchen fix fails it;
restoring it passes. `tests/family-day-key-arithmetic.test.ts` pins the helpers,
including both DST directions.

One correction worth recording: my first two attempts at the DST assertion had
the direction backwards, and I only got it right by measuring across a year
rather than reasoning about it. Spring-forward arrives an hour *late* and stays
inside the right day; it is the autumn transition that lands on the previous
evening.

### F-018 · Nine family-scoped reads were sequential scans of whole tables

**Severity:** medium · **Status:** CLOSED — migration `0294`

A read filtered by `family_id` on a table with no index *leading* on that column
scans the whole table — every other household's rows included. The cost then
grows with the **platform**, not with the family, which is the shape that looks
fine in staging and becomes a page-load problem at scale. RLS sharpens it: the
policies gate on `family_id`, so the predicate is applied to every row on every
read whether or not the application also filters on it.

Measured on `sync_job_runs` loaded with **700,000 rows across 2,000 households**
— a year of quarter-hourly calendar syncs — running the query the sync history
page actually issues:

```
before   Parallel Seq Scan   38,258 buffers   ~46 ms   (46, 48, 46 ms)
after    Index Scan               54 buffers   ~0.30 ms (0.33, 0.30, 0.28 ms)
```

~150× faster, ~700× fewer buffers, and bounded by one family's rows.

Nine tables were in that state, each indexed in the order its page queries, so
one index serves both the filter and the sort:

| Table | Index |
|---|---|
| `sync_job_runs` | `(family_id, started_at desc)` |
| `guardian_routing_rules` | `(family_id, priority)` |
| `social_post_variants` | `(family_id, post_id)` |
| `activation_events` | `(family_id, milestone)` |
| `allowance_rules`, `meal_vote_options`, `meal_vote_ballots`, `move_boxes`, `crm_contacts` | `(family_id)` |

**What was deliberately left alone, and why it matters to the finding.** A first
pass flagged 27 more tables. Checked against `pg_index` rather than against the
migration text, **23 of those already had a leading index** from a `UNIQUE` or
`PRIMARY KEY` declaration on `family_id` — my SQL-text parser simply could not
see those forms. The remaining four — `ai_messages`, `member_badges`,
`marketplace_listing_shares`, `social_publish_jobs` — are each read by
`family_id` *alongside* a primary key or another indexed column, so the other
index already does the selective work and a `family_id` index would buy nothing
and cost write throughput.

So the rule is not "every family-scoped read needs a `family_id` index". It is
"a family-scoped read needs **some** selective index", and only nine had none.

That correction is the reason this closed as a SQL probe rather than a unit
test. `docs/audit/family-scoped-index-check.sql` asserts against `pg_index`,
where a UNIQUE or PK declaration is visible as the index it really creates;
reading the migration SQL for the same fact is what produced 23 false positives.
The probe also proves it can fail — it drops one index inside a transaction,
confirms the assertion notices, and rolls back — because a check that cannot
detect the state it forbids is decoration. Verified: 14/14 probes on a fresh
307-migration replay, twice, with the dropped index still present afterwards.

### F-019 · The money-safety probe asserted concurrency it never tested

**Severity:** medium (instrument) · **Status:** CLOSED — `docs/audit/wallet-concurrency-check.sql`

The product is correct. The *check* was not, and after F-015 that is a finding in
its own right.

`wallet-overspend-check.sql` says it proves `wallet_reserve_card_auth` "counts a
pending hold against the balance (so concurrent auths serialize under its FOR
UPDATE lock)". It runs a fixed **sequential** sequence. Nothing in it ever runs
two authorizations at once, so the single property most worth knowing about a
child's wallet — *you cannot spend the same dollar twice by tapping twice* — was
inferred from the presence of a lock rather than demonstrated.

Raced for real, two `$8` authorizations against a `$10` balance on separate
connections:

```
with FOR UPDATE (the shipped function)
  A-15 OK: 1 of 2 simultaneous $8 authorizations approved against $10; $8.00 held

with FOR UPDATE removed
  A-15 FAIL: 2 of 2 simultaneous $8 authorizations approved against $10 (a=t, b=t)
```

Two approvals is a child spending **$16 of a $10 balance**. So the lock is
load-bearing, the shipped behaviour is right, and that is now evidence instead
of an assumption.

Two things about the probe itself are worth recording, because both are mistakes
I made and then had to correct:

- **The seed cannot live in the `do $$` block.** That block is one transaction,
  its writes stay uncommitted, and a dblink session taking `FOR UPDATE` on those
  rows waits on it forever. The first draft hung exactly that way. The seed is
  now plain top-level statements, which psql commits one at a time.
- **Two plain `dblink()` calls are not a race.** They run one after the other,
  each in its own committed transaction — which proves a hold is counted *across*
  transactions, a weaker claim, and the same kind of overclaim this finding is
  about. It now uses `dblink_send_query` / `dblink_get_result` so both are
  genuinely in flight before either is collected.

Where `dblink` is unavailable the probe SKIPs with a notice rather than failing:
a check that cannot run is not a check that found a problem, and conflating the
two teaches people to ignore red.

Verified: 15/15 probes on a pristine 307-migration replay, and 15/15 twice in a
row on a used one.

### F-020 · The documented production-recovery procedure did not work

**Severity:** high · **Status:** closed — 18 migrations made re-appliable, and
the rehearsal is now a CI gate

`LB-016 §4.1` is the procedure an operator follows to unblock production. Its
whole basis is one sentence:

> Every migration in this repository is **additive and idempotent** … So the
> ledger does not need to be *told* what is applied; it repairs itself by letting
> `supabase db push` run from `0004`, where the already-applied migrations no-op
> and the genuinely missing ones land.

It cited two things as proof. **Neither one showed what it was cited for.**

- `tests/migrations-are-additive.test.ts` bans `DROP TABLE` / `DROP COLUMN` /
  `TRUNCATE` / `DROP TYPE`. That is *additive*. It says nothing about applying
  anything twice.
- The CI replay applies all 307 migrations to an **empty** database. On an empty
  database `create policy` has nothing to collide with, so the replay cannot
  observe idempotency even in principle.

Additive is not idempotent, and nothing in the repository had ever asserted the
property the recovery depends on. The one situation that exercises it is the one
situation it had never been run in: a database that *already carries the schema*
— which is precisely production.

**What the evidence said.** `docs/audit/rehearse-ledger-repair.sh` reproduces
production's condition exactly — full schema, ledger holding only `0001`–`0003`
— and replays from `0004` the way `db push` does: version order, each file in
its own transaction, a ledger row per success. Against the history as it stood:

```
re-applied cleanly (no-op as claimed): 286
FAILED:                               18
The operator's push would STOP at:
  0004_rls.sql :: ERROR: policy "profiles_insert_self" for table "profiles"
                         already exists
0004 recorded: 0  -> requiresBaselineReview would still be TRUE
```

It stopped on the **first file it tried**. And because `0004` never recorded,
`hasUnrecordedBaseline` would still have been true afterwards: the operator
would have spent the maintenance window and come out with the ledger no more
repaired than when they went in, the release still blocked, and no indication
of which of the remaining 17 files would have stopped them next.

**Why it broke.** Five ordinary Postgres statements are not idempotent and had
no guard: `create policy`, `create trigger`, `create table`, `create index`, and
`alter publication supabase_realtime add table`. Worth naming: **`create policy`
has no `IF NOT EXISTS` form in any Postgres version**, so there is no way to
write one that is safe to re-run — it must be preceded by a `drop policy if
exists`. `0004` already did that for three of its policies and not for the
others, which is the clearest possible sign this was an oversight rather than a
decision.

**The fix.** Each of the 18 follows the convention its own neighbours already
used — `drop policy if exists` first, `create or replace trigger`, `create index
if not exists`, `create table if not exists`, `add column if not exists`,
`create or replace function`, and a `pg_publication_tables` existence check
around the publication adds. Two needed more than a substitution:

- **`0018`** creates its policies inside `execute format(...)` over a table
  list. A static `drop policy if exists` cannot name a table that only exists as
  `%I` at run time, so the drop had to go *inside* the loop as its own
  `execute format`.
- **`0226`** failed for an entirely different reason, and it is the interesting
  one. It seeds 525 blog posts whose hero images are credited `LoremFlickr (CC)`.
  `0238` later installs a trigger that refuses any hero image whose licence it
  cannot identify, and `0231` nulls every LoremFlickr hero out. Replayed from
  scratch that ordering is fine — the rows go in before the trigger exists. But
  replayed against a populated schema the trigger is **already installed** when
  `0226` runs, and it rejects all 525 rows. So the seed was re-introducing
  exactly the data the product had decided to remove, and only the accident of
  ordering hid it. Seeding those three columns `NULL` reaches the identical end
  state (`0231`'s update now matches nothing; `0232`/`0235` still attach the
  real Unsplash covers) without ever putting an unverified licence in the table.

`0112` was left alone: it already had the publication guard, and the blanket
transform had nested a second, redundant one inside it. Reverted.

**After:**

```
re-applied cleanly (no-op as claimed): 304
FAILED:                               0
0004 recorded: 1
requiresBaselineReview would now be FALSE — the guard clears on its own
```

A from-scratch replay is unchanged at **307 applied / 0 failed**, checked after
every stage of the change rather than once at the end.

**It cannot silently break again.** The rehearsal is now the last step of the
`Database (migration replay · RLS boundary probes)` CI job. It runs last because
it rewrites the ledger and replays everything, so nothing may depend on the
database after it — and it is valuable *because* the job's earlier step already
applied every migration once, which means the rehearsal applies each of them a
**second** time. A migration added tomorrow is checked for idempotency on the
pull request that introduces it, not in a maintenance window years later.

I confirmed the gate actually fails rather than assuming it would, by adding a
deliberately unguarded `create policy` as `0999` and running the job's two steps
in order:

```
== migrations applied: 308, failed: 0 ==      <- the existing replay is happy
FAILED: 1
  0999_tmp_regression_probe.sql :: ERROR: policy "tmp_regression_probe" for
                                          table "profiles" already exists
REHEARSAL EXIT=1
```

The existing from-scratch replay passes it without complaint, which is the whole
point: the new step catches a class of defect the old one structurally could
not. The probe was then deleted and both runs re-verified clean.

The script refuses any `PGHOST` that is not a unix socket or the loopback
interface. That is a reachability test rather than a name allowlist — production
is a remote host, and neither a unix socket nor loopback can reach it from
anywhere — so it holds regardless of what a host is called.

**What this does not do.** It does not apply anything to production. F-001 is
still open and still an operator action. What changed is that the procedure the
operator will follow has now been executed end to end against a faithful
reproduction of production's condition, instead of being asserted.

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
| `vitest run` | 13,518 tests passed |
| `next build` | exits 0 |
| `db:audit:queries` | passed |
| `db:audit:migrations` | passed, next version 0291 |
| `i18n:gate` | clean |
| fresh-DB migration replay | 302/302 applied, 0 failed |
| `run-probes.sh` (fresh 306-migration replay, ×3) | 13/13 every run; the five privileged RPCs still service-role-only afterwards |
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
| day-key drift, every minute of a day, 9 zones | LA 29.2% · NYC 16.7% · Tokyo 37.5% · Sydney 41.7% |
| meal-plan read at 18:30 Sunday in LA | rendered tomorrow's dinner; now renders tonight's |
| DST week arithmetic, measured across 2026 | 26–31 Oct: +7 fixed days lands a day short |
| F-017 guard with the kitchen fix reverted | fails — not vacuous |
| `sync_job_runs` at 700k rows / 2,000 households | 38,258 buffers · 46 ms → 54 buffers · 0.30 ms |
| 27 further tables checked against `pg_index` | 23 already indexed via UNIQUE/PK; 4 covered by another index |
| A-14 probe, index dropped in a rolled-back txn | the check detects it — not decoration |
| 2 overlapping $8 auths vs a $10 wallet | 1 approved, $8 held — the lock serializes them |
| the same race with `FOR UPDATE` removed | 2 of 2 approved ($16 of $10) — the probe catches it |
| `run-probes.sh`, pristine replay and used DB | 15/15, and 15/15 twice in a row |


---

# Pass C — Delivery and integration (F-C01–F-C10)

Ran 2026-09-13 against the live site and the real code paths. Every finding
here was reproduced before it was written, and every fix was verified in
production after deploy rather than assumed from a green build.

Full working notes, with the commands and outputs, are in `audit/claude-1.md`.

## F-C01 — The sitemap dated 24 URLs with the time the file ran *(High, fixed)*

`app/sitemap.ts` opened with `const now = new Date()` and applied it to all 15
static routes and 9 category tabs. Every regeneration told crawlers those URLs
had just changed.

Evidence: the live sitemap carried `2026-09-13T11:51:45.957Z` on 24 entries,
identical to the millisecond — the build's own transaction time.

Fixed by #526. Each source now answers from its own real date; anything with no
real date omits `lastmod` rather than inventing one.
`tests/sitemap-lastmod-is-content-dated.test.ts` generates the sitemap twice
with the clock moved a year between and requires every date to be identical, so
a `new Date()` reintroduced anywhere in the pipeline fails immediately.

## F-C02 — 445 of 1,508 sitemap URLs were not indexable *(High, fixed)*

435 answered `404` with `noindex`, 9 canonicalised to `/blog`, and the homepage
was listed twice.

The 435 were `marketing_pages` registry rows for `/blog/Seed <uuid>` slugs.
That table is a path *overlay* — a row supplies a page's title and description,
not proof the path resolves — and `/blog/<slug>` is served from `blog_posts`,
which hides synthetic seed rows. They were also unparseable as URLs: the slug
was interpolated raw, putting a literal space inside `<loc>`.

Fixed by #526. `canonicalUrl()` in `lib/marketing/sitemap-urls.ts` is now the
only thing that may mint a `<loc>`. Production verified: 1,063 URLs, none
returning 404, none `noindex`, none canonicalising elsewhere.

*Overlaps Pass A's F1/F3/F14, which found the same URL set from the crawler
side. Same defect, independently reproduced.*

## F-C03 — The whole message catalogue shipped on every public page *(High, fixed — supersedes F9)*

`LocaleProvider` is a client component, so the catalogue handed to it in the
root layout was serialised into the RSC payload of every route beneath — which
is every route.

Measured on production: `/cookies`, a legal page of a few hundred words, was
949,769 bytes raw and 265,651 gzipped, of which **246,126 gzipped was the
catalogue** — 93% — carrying wallet errors, marketplace copy and the admin
studio's capability matrix onto a cookie policy.

Fixed by #540. Each surface declares the namespaces its own client components
use; marketing needs 26 of 13,449 keys. The authenticated app keeps the whole
catalogue deliberately: 3,791 keys across 368 namespaces with 96 non-literal
`t()` calls, where no static subset is provable and there is no crawler or
first-visit cost to pay for it.

Production, gzipped: `/cookies` 266→20 KB, `/faq` 276→31 KB, `/terms` 269→24 KB,
`/` 291→45 KB.

`tests/i18n-client-scope.test.ts` walks the import graph from every page and
fails, naming the key and file, if a scope does not cover what its client
components ask for.

## F-C04 — /blog shipped its entire search corpus to the browser *(Medium, fixed)*

All 1,048 published posts were passed to the client search component as a prop,
so React serialised the corpus into the HTML of a page that renders 25 cards:
446 KB of a 597 KB response, paid by every visitor so the minority who type in
the box could filter locally.

Fixed by #543. The index loads on first interaction from
`/api/blog/search-index`, edge-cached, so the corpus is fetched per publish
rather than per visitor. Production: 88,907 → 40,098 gzipped (−54.9%),
occurrences of the corpus in the HTML 1,048 → 0, 25 cards still rendered.

## F-C05 — Every unrouted path answered a login form *(Medium, fixed — supersedes F13)*

`/nope`, `/some-random-thing` and `/.env` all answered `307` to
`/login?redirect=…`. Middleware had one list, `PUBLIC`, and redirected
everything else — right for a real app route, wrong for a path with no route.

A person following a stale link met a sign-in form instead of "page not found",
and after signing in would have landed on a 404 anyway. A crawler saw a
redirect to an irrelevant page, which Google counts as a **soft 404**.

Fixed by #544. `PROTECTED` now names the paths that require a session; a path
on neither list falls through to `app/not-found.tsx`.

**This inverted a safety property** — forgetting to classify a route used to
leave it protected and now leaves it reachable — so
`tests/route-access-is-total.test.ts` walks `app/` and fails if any routable
top-level path is on neither list. It earned itself immediately, catching
`/display` (the signed-in kiosk), `/account`, `/money` and `/settings` missing
from the first `PROTECTED` list.

Verified in production: unrouted paths answer 404 with `noindex`; all twenty
protected segments still 307 to `/login`; public pages still 200;
`/dashboard/not-a-page` still redirects rather than revealing which pages exist.

## F-C06 — A CSS margin lived in the message catalogue *(Low, fixed)*

`tableOfContents.80px0px600px` held `-80px 0px -60% 0px`, the `rootMargin` of
the blog table of contents' `IntersectionObserver`, duplicated across all seven
full catalogues. A translator or tool altering it produces a value
`IntersectionObserver` rejects; it throws at construction and the table of
contents disappears for that locale on every article while the English build
stays green.

Fixed by #546. `tests/catalogue-holds-language-only.test.ts` sweeps for CSS
lengths, hex colours, URLs and CSS keywords. It deliberately does not catch
`profileQuestions.householdThree` (`'3'` — numerals differ by script) or
`network.bandNone` (`'none'` — a word a reader sees); both are pinned so the
rule cannot widen onto them.

## F-C07 — Nineteen environment variables are undocumented *(Medium, open)*

`.env.example` documents 75; app code reads 89. Nineteen are absent.

The sharpest is `CONTACT_CENTER_INBOUND_SECRET`. The inbound email endpoint is
correctly fail-closed in production, so with the secret unset it rejects
**every** inbound message, silently, and nothing says why. Apple calendar sync
is configured by two undocumented variables (`APPLE_SYNC_ENABLED`,
`APPLE_CALDAV_BASE_URL`) and is simply off until someone reads the source.

Fix: add the operator-facing variables with a line each saying what breaks when
unset; group the test-only ones (`PW_*`, `PLAYWRIGHT_*`, `AI_PROVIDER_STUB_DIR`)
under their own heading.

## F-C08 — The forward-release mechanism is pinned 38 migrations in the past *(High, open)*

`.github/workflows/supabase-forward-release.yml` failed on its most recent run
(34781290560, 2026-09-13T20:36Z) and the one before it. The cause is now
established, not guessed.

The failing step is #4, "Release preview, read-only proof, or atomic apply",
which runs `scripts/apply-production-forward-release.mjs` in preview mode. That
script opens with:

```js
export function assertNoNewerMigrations(migrationNames) {
  const latestReviewedVersion = Number(RELEASE_VERSIONS.at(-1));   // 0254
  const newer = migrationNames.filter(…);
  if (newer.length) {
    throw new Error('Production forward release is held: repository migrations '
      + 'outside the pinned 0240-0254 release: ' + newer.join(', '));
  }
}
```

The repository now carries **38 migrations past 0254** — `0255_ai_runtime_lockdown`
through `0295_reward_redemption_decision_guard`. The guard fires every time.

Two things follow, and the second is the one that matters:

1. **The workflow is not broken; it is correctly refusing.** It is a
   deliberately pinned, checksum-reviewed release of exactly `0240`–`0254`, and
   it holds the moment the repository moves past that. Step 6 ("Capture
   metadata after release attempt") succeeded in the same run and uploaded its
   artifact, which proves the credentials reach production — so this is a
   verdict, not a connectivity failure, and it is a *different* wall from F5.

2. **There is now no working path to apply a migration to production.** The
   migrations workflow cannot authenticate (F5), and the forward-release
   mechanism is pinned 38 migrations behind (this finding). Every migration
   from `0255` onward — including `0286`, the `blog_posts.updated_at` backfill
   merged today — is written, reviewed, merged, and unapplied.

Fix: re-pin the release to the current head with fresh checksums, or retire the
pinned-release mechanism in favour of the ledger-based one. Either is an owner
decision about release process, not a code defect.

**Update — the code half is now done; the release itself remains the owner's.**

There *was* a code defect underneath, and it is what made re-pinning expensive:
the pinned range was stated **twice**. Authoritatively in
`supabase/production-forward-release.json`, and again as three hardcoded
literals in `scripts/apply-production-forward-release.mjs` — `RELEASE_VERSIONS`,
the filename regex `^0(?:24\d|25[0-4])_…`, and two error strings. Re-pinning
therefore meant editing code *and* regenerating the manifest, and if the two
disagreed `readReleaseFiles` refused with "Only the pinned 0240-0254 production
release is supported."

The manifest is now the only statement of the range. Re-pinning is a reviewed
data change. Nothing was relaxed: every sha256 is still verified, the project
ref is still checked, the filename still cannot escape `supabase/migrations/`,
and the range must now additionally be **contiguous and duplicate-free** — a
property the hand-written list could only assert by being written out correctly.
The held-release error now names the range it is actually pinned to and points
at the manifest. Proved by a test that feeds the script a manifest re-pinned to
`0240-0255`, with the real checksum of `0255`, and asserts it is accepted with
no code change and still rejects a corrupted read.

**What remains is not code.** A re-pinned manifest also carries `boundary` —
a snapshot of production's live catalogue — and `newTables`, which
`assertPreflight` requires to be *absent* from production. Both need a
credentialed read of production, which this session does not have and must not
have. And the runbook is explicit that an apply needs "a new successful preview,
review evidence … and explicit parent authorization", and that the baseline
block "must not be bypassed or treated as a missing-credentials failure".

So F-C08's code half is closed and F-C08's release half, like F5, is the
operator's.

## F-C09 — Supabase credentials fail at first use, not at boot *(Low, open)*

`NEXT_PUBLIC_SUPABASE_URL` (7 sites) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (6) are
read with a non-null assertion, and there is no central env validation module.

Reproduced: starting the built app with those unset made `/pricing` answer 500
with `Error: supabaseUrl is required` while `/terms` and `/cookies` rendered
fine. A misconfigured deploy degrades into scattered 500s on whichever pages
happen to read the database, instead of refusing to start.

## F-C10 — The mobile app has no tests, and CI barely checks it *(Medium, open)*

`mobile/` is a real Expo app of 42 TypeScript files with **zero** test files.
Its CI job has three steps: install, `npm run typecheck`, and
`npx expo config --type public`. No lint, no unit tests, no build.

The web app is gated on 13,500 tests and a mobile device matrix; the mobile app
is gated on "it compiles and its config parses". Separately, nothing audits the
mobile dependency tree — `npm audit --package-lock-only` there reports 14
moderate advisories, while the root tree reports zero of any severity.

## Verified clean in Pass C

Recorded so no later pass re-derives them:

- **Security headers** — full CSP with `frame-ancestors 'none'`, HSTS
  `max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`, `nosniff`,
  `strict-origin-when-cross-origin`, a scoped permissions policy.
- **The CSP matches reality** — every `fetch()` inside a `"use client"` module
  targets a host in `connect-src`. Google, OpenAI, Resend and the grocery and
  recipe integrations are all server-side.
- **The server/client boundary holds** — no client module imports
  `lib/supabase/server`, `createServiceClient` or `SUPABASE_SERVICE_ROLE_KEY`.
- **Redirects** — `http→https` and apex→www are clean 308s.
- **Images** — 69 `<img>` on the public pages, every one with non-empty alt;
  35 lazy-loaded, the above-fold ones correctly not.
- **Structured data** — 33 JSON-LD blocks, all parse, one schema type per page,
  no duplicates.
- **Page metadata** — no duplicate titles or descriptions across the 15 static
  routes; each has exactly one `<h1>`, a description and an `og:image`.
- **Web dependencies** — `npm audit --production` reports zero advisories at
  every severity.


---

# Pass D — Frontend and accessibility (F-D01–F-D14)

Ran 2026-09-13 over `app/(app)/` (354 pages) and `components/` (456 files) —
the authenticated surface, which Passes A and B examined from the data side and
barely touched on the frontend. Working notes, with every file:line and the
quoted code, are in `audit/claude-2.md`.

**No browser was run.** Colour contrast, real tab order and screen-reader output
are therefore *unverified* and are marked as such rather than asserted. Every
finding below is from reading the source.

**A note on method that changes how to read the counts.** The first scan used a
regex of the shape `<input[^>]*>`, which terminates on the `>` of an inline
arrow function (`onChange={(e) => …}`) and silently mis-reports attributes. That
produced wrong numbers, was caught, and every count below comes from a
brace-aware parser tracking label open/close depth. The `<h1>` scan likewise
over-matched by following imports into a conditional heading in
`trial-paywall-gate.tsx`; all 19 pages were confirmed by hand and 11 false
positives dropped.

## The three that matter most

### F-D01 — The photo lightbox strands keyboard users *(High)*

`components/modules/photos-module.tsx:407`. A hand-rolled full-screen overlay
with no `role="dialog"`, no Escape handler (`grep -c Escape` → 0), no focus
trap and no scroll lock. Its only dismissal is an `onClick` on a `<div>`.

A keyboard user who opens a photo is stranded behind an opaque `bg-black/95`
layer, operating UI they cannot see.

The same file already imports the project's `<Modal>` component and uses it
correctly elsewhere, so the fix is to use it here too.

### F-D02 / F-D03 — Controls with no programmatic name *(High)*

- **55 visible labels are detached from their control** across 22 files: a
  sibling `<label>` with no `htmlFor`, a control with no `id`. Includes the
  *public* survey form at `app/s/[slug]/survey-form.tsx:79`.
- **65 of 145 `<select>` elements have no accessible name at all** — among them
  the select that chooses *which child* a reward is redeemed for
  (`rewards-module.tsx:324`, `economy-view.tsx:190`) and the one that sets a
  member's role during onboarding.

A screen-reader user hears "combo box" and must infer the rest from position.

### F-D10 — The lint config enables none of the rules that would have caught them *(Medium — and the root cause)*

`.eslintrc.json` is `next/core-web-vitals` alone, which enables none of
`label-has-associated-control`, `click-events-have-key-events`,
`no-static-element-interactions` or `control-has-associated-label` — precisely
the rules describing F-D02, F-D03 and F-D06.

`npx next lint` runs clean over ~1,000 files with 3 warnings, so the gap reads
as a green light. **This is why the other findings accumulated**, and fixing it
is worth more than fixing any single one of them.

## The rest

| | Finding | Severity |
|---|---|---|
| F-D04 | Four hand-rolled dialogs claim `aria-modal="true"` but never trap focus or handle Escape | Medium |
| F-D05 | 19 authenticated pages render no `<h1>`; 11 render no heading at all | Medium |
| F-D06 | Primary content rows across seven modules are clickable but not keyboard reachable | Medium |
| F-D07 | 92 destructive actions are guarded only by native `window.confirm()` | Medium |
| F-D08 | All 354 authenticated pages share one route-group loading skeleton | Medium |
| F-D09 | Ten client components set state from an un-cancelled async effect | Medium |
| F-D11 | Two icon-only buttons in the guardian contact list have no accessible name | Low |
| F-D12 | Two admin links point at routes that exist only at runtime | Low |
| F-D13 | 172 index-derived React keys; the reorderable cases are worth a second look | Low |
| F-D14 | Three `exhaustive-deps` warnings, one a genuine ref-in-cleanup bug | Low |

## Verified clean in Pass D

Eight areas were checked and found sound; they are listed in `audit/claude-2.md`
so a later pass does not re-derive them.


---

# Pass E — Backend, auth and security (F-E01–F-E09)

Ran 2026-09-13. Working notes in `audit/claude-3.md`.

**Method, and why it found things greps do not.** All 308 migrations were
replayed into a local Postgres 16 and then RLS, grants, policies and
`SECURITY DEFINER` functions were audited **against the live catalogue**, not
by text search. That distinction is load-bearing: this repo enables RLS through
`DO $$ … EXECUTE format('alter table public.%I enable row level security')`
loops, so a text scan reports 216 tables "missing RLS" while the catalogue
reports zero missing. All 141 `app/api` routes were mapped to their guard and
all 61 entries of the public carve-out list were read individually.

**Two caveats that bound every finding below.**

1. These describe the **committed migrations as replayed locally**. If F-001
   still holds and production's ledger is stuck at `0001–0003`, production may
   not carry even the policies verified here as correct. That cuts both ways,
   and F-C08 makes it likely: there is currently no working path to apply a
   migration to production.
2. Migrations `0237`, `0239` and `0292` did not replay locally — the `vector`
   extension was absent — so the **marketing platform spine tables were not
   checked**. That is a known gap, not a clean bill.

## F-E01 — Every child can read, edit and delete the family password vault *(CRITICAL — fixed by 0296, unapplied)*

`public.family_credentials` holds Wi-Fi passwords, account logins, PINs and card
details, with `secret` stored as **plaintext `text`**.

All four of its policies are written as `is_family_member(family_id)`, which
answers "is this user in the family" and **ignores role entirely** — unlike
`can_manage_family()`, and unlike the `documents` table, which correctly ANDs in
`can_manage_family` for its sensitive rows.

Children are real auth users with `family_members.user_id` set
(`app/(app)/family/child-login-actions.ts:49-60`). The page carries no role
check; `requireAal2` is a no-op for children (`lib/auth/mfa.ts:103`); and the
module reads through the browser client anyway, so **RLS is the only boundary
and it does not hold**.

A child signed into the family app can read every stored password, change them,
or delete them.

### Independently reproduced, then fixed

Every link was verified by hand before anything was changed: `secret` is
plaintext `text`; all four policies call `is_family_member`; that function
checks only `user_id = auth.uid() and is_active`; `child-login-actions.ts`
creates a real auth user and sets `family_members.user_id` to it, its own
comment reading *"Link the member to the new auth user so they ARE this member
on sign-in"*; and no migration after `0119` ever touched the table.

**Migration `0296_family_credentials_manager_only.sql`** swaps all four policies
to `can_manage_family`, which is `role in ('parent','adult') and is_active` —
so no adult loses access and only children do, which is the point. `0266` did
exactly this for the document vault; this is the same fix for the table that
holds the passwords.

**`docs/audit/family-credentials-boundary-check.sql`** proves it behaviourally,
and CI globs `docs/audit/*-check.sql`, so it runs on every PR. Against a real
Postgres 16:

- against the **original** policies it fails with
  `0296: a child can READ 1 credential row(s); the vault is open`
- against the **fixed** policies it passes, asserting the child is refused
  read, insert, update *and* delete, while both a parent and an adult keep the
  vault and can still write to it

The probe was itself defective on first write — it inserted a row per run, so a
second run tripped its own count assertion and looked like the fix had locked
out a parent. It now clears its family's rows first and asserts on the row it
created; verified re-runnable three times.

**This cannot reach production yet.** See F5 and F-C08: authentication blocks
one release path and a stale pin blocks the other. The fix is merged-ready and
inert until an operator unblocks them.

*If the owner wants the vault narrowed further — parents only, not adults —
that is a second and additive decision, deliberately not made here.*

## F-E02 — Step-up MFA is presentational *(High)*

`requireAal2` guards 19 pages by redirect, but the data on those pages is
fetched by client components straight from PostgREST
(`components/finance/bills-view.tsx:54,63`), and

```sql
select count(*) from pg_policies where qual/with_check ilike '%aal%'  -->  0
```

No policy knows what `aal` is. `aal2Verdict` — which exists precisely so route
handlers can answer `403 step_up_required` — is wired into 3 routes, none of
them money.

A stolen `aal1` session reads and writes bills, expenses, autopay and both
vaults without ever being asked for a code.

## F-E03 — The `family-media` bucket is public *(High)*

`supabase/migrations/0216_family_media_bucket.sql:22-24` creates the bucket with
`public = true`, so family photos, videos, message attachments and reminder
attachments are served from `/storage/v1/object/public/…` **with no session**.
The four family-scoped SELECT policies the same migration creates never run on
that path.

The migration documents this as a tracked follow-up (LB-009), so it is a known
decision rather than an oversight — but it is a live exposure, and one that
survives both row deletion and membership revocation, because the object URL
keeps working.

## The rest

| | Finding | Severity |
|---|---|---|
| F-E04 | OAuth tokens in `social_account_tokens` are family-member readable, while the equivalent `sync_tokens` is service-only | Medium |
| F-E05 | `feedback-attachments` is a public bucket holding user-uploaded screenshots | Medium |
| F-E06 | The Contact Center inbound-email secret is accepted in the query string, where it lands in logs and referrers | Medium |
| F-E07 | Twilio signature verification is off outside production and depends on `NEXT_PUBLIC_APP_URL` being exactly right | Medium |
| F-E08 | Shared-secret comparisons are not constant time | Low |
| F-E09 | An authorization failure in the marketing AI route answers 500, not 403 | Low |

F-E06 is the same variable as **F-C07**, reached from the other side: Pass C
found it undocumented, Pass E found it accepted in a query string.

## Verified healthy in Pass E

Twelve items, listed in `audit/claude-3.md`, including that no table is
actually missing RLS once the catalogue is read rather than grepped.


---

# Pass F — QA, flows, performance and edge cases (F-F01–F-F13)

Ran 2026-09-13. Working notes in `audit/claude-4.md`.

## The three that matter most

### F-F01 — A capped read reports success while dropping rows *(High, money)*

`lib/supabase/read-all.ts:93` returns `error: null` when a read stops at a
**caller-supplied** `max`; only the default ceiling raises.

So `app/(app)/admin/wallet/reconciliation/page.tsx` reads the platform-wide
ledger with `{ max: 20000 }` ordered `created_at DESC`, silently drops every
row past that, and renders **"Everything reconciles"** from a prefix — the
exact failure its own comment says the helper was fixed to prevent. Same shape
at `economy/page.tsx` with `{ max: 5000 }`, where the comment reads *"a capped
read is a wrong balance."*

*Related to F-008/F-011/F-013, which fixed the default ceiling. This is the
caller-supplied path the fix did not cover.*

### F-F02 — F-017's timezone bug is still live on eleven server-rendered surfaces *(High)*

`setHours(0,0,0,0)` — server midnight — remains on eleven surfaces including
`app/(app)/kids/page.tsx:22` and the "today"/"tomorrow" text of every
notification.

F-017's guard cannot see them: it flags `toISOString().slice(0,10)` next to a
**DATE** column, and these are `setHours` against **timestamptz**. On a UTC host
a Californian child's "today" runs 17:00 → 17:00.

*This is F-017 incompletely closed, found by a different detector.*

### F-F03 — /missions issues up to 240 sequential storage round trips *(High, perf)*

`app/(app)/missions/page.tsx:70-77` nests two loops around
`await createSignedUrl`. The batch call `createSignedUrls` is already used
correctly at `app/(app)/admin/marketing/assets/page.tsx:53`. This is the parent
approval queue — the page a parent opens most.

## The rest

| | Finding | Severity |
|---|---|---|
| F-F04 | A requested local time that does not exist (DST spring-forward) is mishandled — **a genuine production bug**, found by running the suite under `TZ=America/Los_Angeles`, reproduced in two lines of node, and the suite pins no `TZ` at all | Medium |
| F-F05 | 96 tests across 12 files share the exact shape of the known `api-ai-runs` 5-second timeout — a cold `await import('@/app/…')` inside a default-timeout test — and no `testTimeout` is configured anywhere | Medium |
| F-F06 | `tests/seed-failure-safety.test.ts`, named "fails closed", asserts only the *absence* of two bad shapes, so deleting the error check makes it greener | Medium |
| F-F07 | 37 of 51 money, kids, economy and missions server actions have no test | Medium |
| F-F08 | `addFundsAction` is the one money mutator that writes the balance directly | Medium |
| F-F09 | Unbounded concurrent fan-out to an external drive-time API | Medium |
| F-F10 | Two buttons in the message header exist only to say the feature is unavailable | Low |
| F-F11 | The proof-photo signing error is discarded, so a parent sees a blank frame rather than a reason | Low |
| F-F12 | The vitest config's JSX block is dead under vitest 4 | Low |
| F-F13 | Sixty-nine test blocks assert only the absence of a pattern | Low |

## On the hunt for tests that cannot fail

This was the highest-priority sweep and it came back **mostly clean** — one
genuine instance (F-F06). That is worth recording as a positive: this suite's
grep-style guards mostly carry explicit non-vacuity blocks, which is unusual
and means the earlier findings (F4, F-004, F-015, F-019) were the exception
rather than the pattern.

---

# Pass G — the audit's own instruments, and the list the database ignores

Two findings, one shape: a boundary that is stated somewhere and enforced
nowhere.

## G1 — Three boundary probes passed while testing nothing

`document-vault-boundary-check.sql`, `money-write-boundary-check.sql` and
`wallet-write-rls-check.sql` each guarded a security boundary with
`when others`, so ANY error counted as "the boundary held". Renaming one column
in each guarded statement left all three printing a pass; the wallet probe
printed `sqlstate 42703` (undefined_column) inside a message claiming RLS had
rejected a valid $9,999.99 credit.

**Status: fixed.** Narrowed to `insufficient_privilege`; the wallet probe now
asserts the sqlstate it was already capturing; a renamed money table now fails
loudly instead of reading as locked.

This is the same defect that made the `0296` vault probe vacuous in CI, which
is why the whole `docs/audit` suite was swept for it. `approval-dedupe`,
`family-scoped-index` and `rls-isolation` were checked and are correct.

## G2 — 58 of the 66 tables the code calls sensitive are readable by children

`lib/ai/context/policy.ts` carries `SENSITIVE_TABLES`: 66 tables, curated and
reasoned, under a header stating *"§4 says a child must not inspect household
finances or confidential documents"*. It governs what an AI context slice may
read. **It does not govern the database.**

Measured against the RLS catalogue of a replayed database: **58 of the 66** are
readable by any family member, children included, because their read policies
gate on `is_family_member`, which ignores role. `0297` fixes three
(`child_logins`, `social_account_tokens`, `driver_licenses`); **55 remain**.

These are NOT all defects. A child should see their own wallet, their own
medications, their own sleep log. That is exactly why they are recorded here
rather than swept: each needs a decision of the form *"none", "own row only"
(`is_self_member`), or "managers only"* (`can_manage_family`) — the three
shapes this repository already uses (`0272`, `0266`, `0296`).

The count is the finding. A 66-table list that the database honours on 8 of
them is a policy that exists in one layer only.

**Two checks were run before publishing this list, because a catalogue reading
is not a measurement.**

*Is the permissive union really the whole gate?* A RESTRICTIVE policy ANDs with
the permissive ones, so a manager-gated restrictive read policy would make the
entry wrong. **Zero** of the 55 carry one: the permissive union is the gate.

*Does a child actually get the rows?* Spot-checked behaviourally against a
replayed database, as a real child auth user with the impersonation asserted:

```
child sees 1 financial_accounts row(s)   [policy.ts: "account numbers"]
child sees 1 member_locations row(s) for a PARENT   [policy.ts: "live location"]
```

That is the household's bank account with its balance, and a parent's
location-sharing row, read by a child.

| Table | policy.ts reason |
|---|---|
| `ai_messages` | other conversations |
| `auto_insurance_policies` | policy numbers |
| `babysitter_payments` | payment detail |
| `behavior_logs` | behaviour notes about children |
| `billing_customers` | billing identity |
| `care_log` | care notes |
| `checkout_sessions` | payment sessions |
| `child_wallets` | child balances |
| `driving_trips` | driving telemetry |
| `family_emergency_contacts` | emergency contacts |
| `family_emergency_plans` | emergency plans |
| `family_inbox_messages` | inbound mail bodies |
| `family_insurance_policies` | policy numbers |
| `family_wallets` | wallet balances |
| `financial_accounts` | account numbers |
| `gift_payments` | payment detail |
| `health_goals` | health targets |
| `health_metrics` | measurements |
| `health_providers` | clinicians |
| `health_visits` | visit notes |
| `home_warranties` | warranty account numbers |
| `household_info` | rows flagged is_sensitive (alarm codes, wifi keys) |
| `immunizations` | vaccination records |
| `insurance_policies` | policy numbers |
| `invest_holdings` | investment positions |
| `invest_orders` | investment orders |
| `journal_entries` | private journals |
| `location_events` | location history |
| `medical_profiles` | conditions, physicians, emergency contacts |
| `medication_doses` | prescriptions |
| `medication_schedules` | prescriptions |
| `medications` | prescriptions |
| `member_locations` | live location |
| `nutrition_logs` | per-person intake |
| `paperwork_items` | scanned paperwork bodies |
| `pay_handles` | payment handles |
| `rides` | ride locations |
| `safety_check_ins` | check-in locations |
| `sleep_checkins` | sleep tracking |
| `sleep_logs` | sleep tracking |
| `stripe_authorizations` | card authorisations |
| `stripe_cardholders` | cardholder identity |
| `stripe_connected_accounts` | payout accounts |
| `stripe_financial_accounts` | account numbers |
| `stripe_issuing_cards` | card numbers |
| `symptom_logs` | symptoms |
| `tax_documents` | tax filings |
| `vacation_documents` | passport and ticket scans |
| `vacation_emergency_contacts` | emergency contacts |
| `vacation_medical_information` | travel medical detail |
| `vehicle_registrations` | registration numbers |
| `wallet_cards` | card details |
| `wallet_passes` | stored passes |
| `wallet_transactions` | per-child card activity |
| `weather_locations` | stored coordinates |

**Suggested triage**, for an owner to confirm rather than for an agent to
assume:

* **Managers only** — the money instruments and account numbers
  (`financial_accounts`, the `stripe_*` group, `pay_handles`, `invest_*`,
  `wallet_cards`, `home_warranties`, the `*insurance_policies` group,
  `tax_documents`, `paperwork_items`, `vacation_documents`).
* **Own row only** — the per-person health and telemetry tables, which have a
  member column and a real first-person use (`medications`,
  `medication_schedules`, `medication_doses`, `health_*`, `immunizations`,
  `symptom_logs`, `sleep_*`, `nutrition_logs`, `journal_entries`,
  `member_locations`, `location_events`, `safety_check_ins`, `driving_trips`,
  `rides`, `child_wallets`, `wallet_transactions`).
* **Needs a column-aware rule**, as `0266` did for documents —
  `household_info`, whose own reason names only the rows "flagged
  is_sensitive (alarm codes, wifi keys)".

**Status: 3 fixed by `0297` and proved by
`docs/audit/sensitive-role-boundary-check.sql`; 55 OPEN, owner decision.**
Like every migration since `0255`, `0297` is inert in production until F5 and
F-C08 are cleared.

---

# Pass H — the auth-user ceiling, closed

`[CLAUDE-4][HIGH][EDGE CASE]` recorded that three production paths read only the
first 50 auth users and that one of them marked the rest delivered. It was
recorded and never fixed. It is fixed now.

`supabase.auth.admin.listUsers()` with no arguments sends an empty `per_page`,
so GoTrue applies its own default of 50 and answers with the first page — no
error, no short-read signal. Three callers did exactly that:

| Caller | What truncation did |
|---|---|
| `lib/server/notification-emails.ts` | **Permanent loss.** A recipient past the 50th had no metadata, so `!meta?.email` matched the "no email on file" branch, their notification ids went into `resolvedIds`, and `sent_at` was stamped. Marked delivered, never sent, never retried. |
| `app/api/cron/weekly-digest/route.ts` | Families are read with `readAll`, so the family list is complete — and then the digest is dropped for every family whose members sit past the first page. |
| `app/api/cron/chore-reminders/route.ts` | The reminder is skipped for any member past the first page. The `userIds` filter can only narrow what was read. |

The notification one is the severe case: a truncated lookup was
indistinguishable from a user who genuinely has no address, and the code's
response to "no address" is to settle the notification rather than retry it.

**Fixed** by `lib/server/list-all-auth-users.ts`, which pages explicitly and
returns `{ users, error }` where any error means the list is NOT complete, so a
caller can never read a partial list as an absent user.

Two details that are the whole difficulty:

* It terminates on an **empty** page, not a short one — mirroring
  `lib/supabase/read-all.ts`. Stopping on a page shorter than the one requested
  rebuilds the bug: GoTrue may clamp `per_page` below what the client asks for,
  and then the first page is "short" and the read ends at the server's cap.
  **I wrote the short-page version first**; the test that models a clamping
  server caught it before it was committed.
* It does not use the client's `nextPage`. That value is parsed out of the Link
  header with `.substring(0, 1)` — one character — so page 10 reads as page 1.
  Measured against `@supabase/auth-js` 2.108.2.

`tests/auth-user-list-is-complete.test.ts` is behavioural, not source-reading: a
fake GoTrue that clamps `per_page` to 50 exactly as the real one does. Verified
non-vacuous — reintroducing the short-page termination fails 4 of its 10 tests.

**Status: FIXED**, and unlike `0296`/`0297` this one needs no migration, so it
reaches production with the deploy.

## Also fixed in Pass H — nothing pinned "manager" to the database

"Manager" was stated three times and nothing tied them together:

```
lib/constants/roles.ts   MANAGER_ROLES = ['parent', 'adult']
lib/constants/roles.ts   isManager = role === 'parent' || role === 'adult'
0003_functions_triggers  can_manage_family: role in ('parent','adult')
```

All three agree today, and `MANAGER_ROLES` appeared in **zero** tests. This is
the source of the class that dominates this audit — F16, F18, F20, F21, F-003,
F-006, F-E01, F-E02, *one mistake in eight places*: authorization drawn on the
screen rather than in the database. `roles.ts` says so itself: *"Used for UI
gating; the database RLS is the real enforcement boundary."*

`tests/manager-role-agrees-with-the-database.test.ts` reads the roles out of the
migration that defines each function and asserts the sets match, and that
`can_manage_family` stays strictly narrower than membership — never `child` or
`teen`, the equivalence `0296`/`0297` had to undo. Non-vacuous against all three
drift directions (array 3/6, predicate 2/6, SQL 2/6).

## Swept and found clean in Pass H

Recorded so a later pass does not re-derive them.

**The service-role surface** (it bypasses RLS entirely, so it is the one place
where every database boundary in this audit is irrelevant):

* 71 service-role API routes and 30 service-role server-action files — all gated.
* 24/24 cron routes call `hasCronAuthorization`, which fails closed on a missing
  secret.
* 9 Twilio webhooks validate `x-twilio-signature` through a validator that fails
  closed on a missing token and uses `timingSafeEqual`.
* The three ungated public actions (`gift`, `reviews/new`, `s/[slug]`) are IP
  rate-limited and scoped by an unguessable token or a public slug.
* 0/24 cron routes contain an unbounded `select()` — the PostgREST 1,000-row cap
  class is closed there.

**The child sign-in path**, which is the most attackable surface in the product
(guessable username, 4-digit PIN, real auth users):

* A wrong PIN records a failure and a success clears the counter — the throttle
  is not decorative.
* The `ilike` wildcard hole is fixed and documented in place.
* `child_login_throttle` is RLS-on-with-no-policies, so it is deny-all to every
  client role and cannot be reset by the account being throttled.
* `resetChildPinAction` checks `isManager` **and** that the member belongs to the
  caller's own family, so it is not a cross-family takeover.

**The rate limiter**: `rate_limit_hit` is a single atomic
`insert … on conflict do update … returning count`, so there is no read-then-write
race; execute is revoked from `public`/`anon`; and an authenticated caller may
only use a key containing their own `auth.uid()`, so one user cannot exhaust
another's bucket. `rateLimitDb` fails closed by default.

---

# Pass I — F-F04, the DST bug, fixed

`F-F04` was recorded as *"a genuine production bug"*, VERIFIED, with a diagnosis
and a proposed fix — and then left. It is fixed now.

**Reproduced first, not taken on trust:**

```
TZ=UTC                  tests/assistant-capture-fidelity  38 passed
TZ=America/Los_Angeles  × moves an appointment to the first minute that exists
                        AssertionError: expected '03:30' to be '03:00'
```

**The mechanism.** `lib/capture/parse.ts` does its arithmetic on Date *fields*,
which is right in a browser, where the runtime zone IS the family's zone. The
server bridged to it with `asWallClockIn`, a Date whose LOCAL fields spell the
family's wall clock — and a Date built from local fields is normalised by the
runtime's own DST rules:

```
TZ=America/Los_Angeles  new Date(2026, 2, 8, 2, 30)  ->  03:30
TZ=UTC                  new Date(2026, 2, 8, 2, 30)  ->  02:30
```

So on the spring-forward morning the parser's `setMinutes(150)` on local
midnight landed at 03:30, and the 02:30 the family asked for was destroyed
*before* `instantForLocalTime` could move it to 03:00, the first minute that
exists. The appointment shifted an hour instead of to the top of the hour.

**The fix.** UTC observes no DST, so arithmetic in UTC fields cannot be
normalised. `parse.ts` gained a `DateOps` pair — local and UTC — selected by an
optional `{ utc }`; `asWallClockUtc` is the UTC twin of the bridge; the voice
router uses both and reads UTC fields back. **The browser path is untouched**:
`utc` defaults false, and local is the correct answer there.

**The guard, which is the half that matters.** Production runs UTC, so the whole
suite passed on every run while the bridge was host-dependent. Nothing would
have caught the next one:

* `vitest.config.ts` pins `TZ` so a run is hermetic — but as
  `process.env.TZ ?? 'UTC'`, never a bare literal, so an explicit TZ still wins.
  A hard-coded value would have silently overridden the CI job below and made it
  prove nothing.
* CI now runs the suite a **second time under `TZ=America/Los_Angeles`**.

Verified from inside a test worker rather than from the reporter, which runs in
the main process and never sees `test.env`:

| Invocation | Worker resolves |
|---|---|
| pin only, no shell `TZ` | `ENV=UTC RESOLVED=UTC OFFSET=0` |
| `TZ=America/Los_Angeles` | `ENV=America/Los_Angeles RESOLVED=America/Los_Angeles OFFSET=420` |

**Result:** the full suite, 13,643 tests, passes under UTC *and* under
America/Los_Angeles. Before the fix it failed under the latter. Also spot-checked
green under Australia/Sydney (southern-hemisphere DST) and Asia/Kolkata (a
half-hour offset). Non-vacuous: restoring the old bridge fails LA again with the
same `'03:30' to be '03:00'`.

**Not fixed, and not claimed:** `classifyVoiceCommand` still calls `suggestKind`
with the raw `now` rather than the family's wall clock. It only chooses a KIND —
`withDates` re-parses with the correct clock — so the blast radius is a
misclassification near a family's midnight, not a wrong time. Left alone rather
than widened into.

**Status: FIXED.** No migration, so it reaches production with the deploy.

---

## Pass J — a reconciliation check that reconciled nothing

**F-J01 — `bucket_drift` could not fire for any input (wallet reconciliation).**

`lib/wallet/reconcile.ts` documents six integrity checks and is the module behind
`/admin/wallet/reconciliation`, the page whose stated job is to *prove* the
Family Wallet ledger is internally consistent. Check 6 — "Bucket sum drift —
Σ(bucket balances) ≠ wallet total (rounding leak)" — was structurally incapable
of detecting anything.

**The mechanism.** Both sides of the comparison were accumulated from the same
value, in the same loop, for every row:

```js
const v = signedValue({ ... });
walletTotals.set(id, (walletTotals.get(id) ?? 0) + v);   // the total
buckets[t.bucket_kind ?? 'spend'] += v;                  // exactly one bucket
```

Every entry adds `v` to exactly one bucket **and** to the total, so
`bucketSum !== total` is unreachable. The check reported a clean ledger *by
construction* rather than by reconciliation — the same vacuity class as the
0296 probe in Pass F, this time in production code rather than in a probe.

**Proved before changing anything**, not argued:

| Sweep | Result |
|---|---|
| Exhaustive single-txn (6 bucket kinds × 2 directions × 4 statuses × 7 amounts) | **0** drift / 240 cases |
| Randomised multi-txn, 1–6 rows, mixed wallets/kinds/statuses/signs | **0** drift / 4,000 ledgers |

Corroborating evidence it was never real: `tests/wallet-reconcile.test.ts` had
**no** case for `bucket_drift`. Nobody could write one.

**The real defect underneath it.** `wallet_transactions.bucket_id` is
`ON DELETE SET NULL`, and the allocation writer stores
`bucketByKind.get(k) ?? null` (`lib/wallet/server.ts:253`,
`app/(app)/wallet/actions.ts:157`), so completed money can legitimately end up
attached to no bucket. The reconciler silently folded it into `spend` — so the
one screen built to surface unreconciled money *hid* it, and corrupted the spend
figure at the same time (unattributed money could mask a genuinely negative
spend bucket, or manufacture one).

**The fix.** `bucket_drift` is replaced by `unattributed_bucket`, which counts
unbucketed completed money apart from the five real buckets and reports it per
wallet. The wallet total still includes it, so `Σ(buckets) + unattributed =
total`. Severity is **medium**, not high: the money is present and the total is
right — it is the attribution that is missing — so it does not flip the ledger
to unhealthy, which stays reserved for figures that are actually wrong.

`bucketBalances` in `lib/wallet/ledger.ts` still folds unbucketed entries into
`spend` and is deliberately **left alone**: that is the display path, the
behaviour is documented there, and a child's bucket view is a different contract
from an operator's reconciliation view.

**Verification.** 7 new tests, all of which **fail against the old module** and
pass against the new one — including the two the old check could never have
supported: that unbucketed money is not hidden inside `spend`, and that it does
not mask a negative spend bucket. Full suite **13,650 / 13,650** under pinned UTC
and again under `TZ=America/Los_Angeles`. `npx tsc --noEmit` and eslint clean.

**Status: FIXED.** No migration, so it reaches production with the deploy.

---

## Pass K — acknowledging an event nobody finished

**F-K01 — a lost Stripe money event, answered 200 and never retried.**

Stripe stops retrying an event the moment one delivery answers 2xx. `recordEvent`
in `lib/stripe/webhook.ts` returned `'duplicate'` — which both webhook routes
answer **200** — for two different situations: an event that reached status
`processed`, and an event another delivery merely *holds* at status `processing`.
Those are not the same thing, and conflating them loses money.

**The sequence.**

1. A handler throws — `handleTransactionCreated`, say, on a transient database failure.
2. `markEventError`, hitting the same failure, throws too. It is the only thing
   that moves the row to `error`, so the row stays `processing`.
3. Stripe retries a minute later — inside `STALE_EVENT_MS` (10 min), so the claim
   is not yet reclaimable.
4. `recordEvent` falls through to `return { outcome: 'duplicate' }`. The route
   answers **200**.
5. Stripe considers the event delivered and **stops**. The card debit is never
   applied, and the row sits in `processing` with nothing left to reprocess it.

**Proved behaviourally** against `tests/helpers/in-memory-supabase.ts` (the
Postgres-faithful fake), not from reading:

| After | A Stripe retry saw |
|---|---|
| `markEventError` **succeeded** | `fresh` — reprocessed ✅ |
| `markEventError` **failed** | `duplicate` → **200** → retries stop ❌ |

**A second, unconditional defect in the same path.** The money route called
`markEventError` *unguarded*, unlike the billing route which wraps it:

```js
await markEventError(supabase, event.id, message, claimToken);  // can throw
console.error('[money webhook] handler error', event.type, e);  // never reached
```

So whenever recording the error state failed, the throw escaped the catch block
and took the **original money error with it**. The operator saw only the
secondary failure — "error state was not recorded" — and never the debit failure
that actually happened. `markEventProcessed` was unguarded there too.

**The fix.** `recordEvent` now distinguishes `'duplicate'` (FINISHED — the only
outcome a route may acknowledge) from `'in_flight'` (held, unfinished). Both
routes answer `in_flight` with **409**, so the retry keeps coming: if the holder
succeeds the next delivery sees `processed` and is acknowledged; if the holder
died the claim goes stale and is reclaimed. The money route now logs the handler
error **before** the write that can throw, and guards both `markEventError` and
`markEventProcessed` the way the billing route already did.

Not changed: `issuing_authorization.request` still bypasses the claim entirely —
that is deliberate and correct (Stripe's real-time window, and
`wallet_reserve_card_auth` is idempotent on `p_auth_id` under a row lock, which
was verified rather than assumed).

**Verification.** 8 new behavioural tests; **5 fail against the original code**
and the other 3 are regression guards for behaviour that was already right
(finished ⇒ duplicate, stale reclaim, error reclaim). Full suite **13,658 /
13,658** under pinned UTC and again under `TZ=America/Los_Angeles`.
`npx tsc --noEmit` and eslint clean.

**Status: FIXED.** No migration, so it reaches production with the deploy.

---

# Pass L — the marketing platform spine, and a clean bill that was not one

*Claude-3, 2026-09-14. Merged by Claude-1. Evidence in `audit/claude-3.md`.*

This pass exists because of a gap the Verification Checklist named: `0237`,
`0239` and `0292` had never replayed — the `vector` extension was absent — so
the nine **marketing platform spine** tables had never been audited at all.
pgvector was installed and the replay run through the repo's own harness
(`docs/audit/verify-pg.sh`, the same `pg-bootstrap.sh` CI uses, rather than a
hand-rolled prelude — which turns out to matter, see L2).

**310 migrations applied, 0 failed**, against Pass E's 308 applied / 3 failed.
491 public tables against Pass E's 482.

## L1 — `anon` holds TRUNCATE on all nine spine tables, and RLS cannot see it

`MEDIUM`. RLS correctly refuses anon and non-admin `INSERT`/`UPDATE`/`DELETE`
on every spine table — each verified. **TRUNCATE is not subject to RLS.**

```
set role anon; truncate public.marketing_pages cascade;   -- succeeds
```

It empties the table and cascades to `marketing_page_versions` and
`marketing_page_relationships`. Same on all nine plus `marketing_audit_logs`.
`0237` reasons about the grant layer explicitly and revokes from
`authenticated` on one table, but never touches `anon` and never revokes
TRUNCATE; Supabase hands every new table `arwdDxt` to `anon` by default.

**Not reachable through PostgREST** — there is no TRUNCATE verb, and Claude-3
confirmed zero anon-callable functions that truncate and zero anon-callable
`SECURITY INVOKER` dynamic-SQL functions. So this is a **missing layer, not a
live exploit**, and takes the same disposition `0290` took for the money tables.
Fix is one migration in `0290`'s shape.

*Caveat, stated because it is load-bearing:* with no PostgREST available (no
docker, no Supabase CLI) the unreachability rests on catalogue queries and the
absence of a TRUNCATE verb — not on an HTTP request being refused.

## L2 — Pass E's verified-healthy #3 is false, and it was written to stop people re-checking

`MEDIUM`, and the most important entry in this pass.

Pass E recorded, in the list explicitly kept *so nobody re-derives it*:

> **3. `anon` holds no write privilege on any table at all** — zero rows across
> all 482.

Re-running **Pass E's own query** against the complete replay returns **1,931
grant rows across 483 of 491 tables**. Only 8 tables were ever revoked.

The zero was an artefact of Pass E's hand-built prelude not reproducing
Supabase's default privileges — *the identical defect this document already
records as `F-004` against the old CI shim.*

This is the pattern in Part 0 in its purest form: **a guard that could not see
what it was named for**, then written down as a clean bill and marked
do-not-re-check. A wrong "verified healthy" is worse than an unaudited area,
because it actively stops the next person looking. Claude-3 did not edit the
claim — correct, it is not their file to rewrite. It is **struck here**:

> **Pass E verified-healthy #3 is REFUTED. Do not rely on it.**

## L3 — the spine has no probe, and its own verification was a comment

`LOW`. 18 of 18 `docs/audit/*-check.sql` probes pass and **none touches the nine
spine tables**. `0237` left its verification as a SQL comment, which nothing
runs. Proposed probe contents are in `audit/claude-3.md`.

## L4 — the regeneration-loop guard tests the column value, not the statement

`LOW`. `new.updated_by is not null` is permanently true once an admin has edited
a page, so a writer that *omits* the column re-bumps the version and enqueues
another AI job. Measured: 2 omitting writes → +2 versions, +2 jobs. No shipped
caller does this; it holds solely because `platform.ts:268` writes
`updated_by: null` on purpose — which nothing states and nothing tests.

## Re-verified from Pass E

| Claim | Outcome |
|---|---|
| VH#1, VH#2, VH#11 | confirmed |
| **VH#3** (anon has no write privilege) | **REFUTED — see L2** |
| `F-E01` (password vault) | confirmed fixed by `0296`, now against the *complete* chain |
| `F-E02`, `F-E03` | still open |
| **`F-E04`** (OAuth tokens family-member readable) | **fixed** by `0297_sensitive_tables_respect_role.sql` — `social_account_tokens` select/insert/update now `can_manage_family(family_id)`. Verified independently by Claude-1 by reading the migration. Subject to `F-001` like every other migration: fixed in the repo, not yet in production. |

## Verified healthy in Pass L

13 items recorded in `audit/claude-3.md` so a later pass does not re-derive them,
including: RLS on all nine spine tables; the read/write boundary holding for
anon and for a non-super-admin authenticated user; 65 `SECURITY DEFINER`
functions with **0 unpinned** `search_path`; the trigger/queue machinery
exercised end to end (enqueue, `0239` backfill suppression, stale-lock recovery,
dead-letter); all six platform server actions calling `requireMarketingAdmin()`
— which matters precisely because `page.tsx` reads with the service client, so
RLS is bypassed on that path.

Two probes passed **for the first time ever**, because they needed the three
migrations that had never replayed: `privileged-rpc-grants-check.sql`, and
`check-conflict-targets.mjs` at 181/491 with the spine present.

*Given L2, the phrase "verified healthy" in this pass means: verified against a
faithful replay through the repo's own bootstrap. It does not mean verified
against production, which remains unaudited and needs operator credentials.*

---

# Pass M — reporting a failure is not surviving one

*Claude-1, 2026-09-14. Evidence in `audit/claude-1.md` (`C1-S3-01`).*

## M1 — a push that failed was recorded as delivered, and nothing could retry it

`HIGH`. `lib/server/push.ts` stamped `pushed_at` on every notification the
dispatcher touched, success or failure. `pushed_at` is the only column the
pending query filters on (`.is('pushed_at', null)`), nothing in the codebase
ever clears it, and no retry path exists — so a provider outage dropped every
notification in that run **permanently**.

Proved, not read: with `web-push` stubbed to reject `statusCode: 500`, the send
is counted `failed` and the row is stamped delivered in the same loop iteration.

```
✓ counts the send as failed                     failed === 1, sent === 0
✗ does NOT stamp pushed_at when every send failed
    expected [] to deeply equal
    [ { "pushed_at": "2026-09-14T21:13:14.747Z", "table": "notifications" } ]
```

**Why this is worth a pass of its own.** It is a *second-order* instance of the
pattern in Part 0, and the more dangerous kind. The cron route already answers
**502** when `result.failed > 0` — an earlier fix in this same audit, and it
works. It made the failure **visible** while leaving it **unrecoverable**: the
run goes red, the row says delivered, and the row is what the next run reads.

*Reporting a failure and surviving one are different properties.* The red cron
run made this look handled, which is precisely why it survived the pass that
created it. The question that found it was asked of this audit's own fix: **the
cron now reports the failure — but does anything act on it?**

Fixed: retry only when nothing got through at all (`failed > 0`, `sent === 0`,
`pruned === 0`), bounded at 24h so a dead endpoint cannot retry forever. A
partial success still stamps — those devices have the notification and
re-sending would buzz them twice. Distinguishing partial from total is the most
that can be done without per-device delivery state, which is a schema change and
therefore inert in production while `F-001` holds. Guard neutered → suite red;
restored → green.

**Carry this forward:** every fix in this document that makes a failure
*visible* — the cron 502s, the `/api/health` FEATURE_ENV tier, the dead-letter
tables — deserves the same second question. Visibility is where this codebase
tends to stop, and it is only half of the property.

## M2 — the public calendar feed cannot be turned on by anybody

`MEDIUM`. `app/api/sync/feeds/[token]/route.ts` is complete, hardened and
unreachable. It documents itself as how "Apple Calendar, Outlook, Google
('From URL'), and Alexa" subscribe to a bubaly calendar. Nothing in the
codebase ever mints a `feed_token` or sets `feed_enabled = true`:

```
grep -rn "generateFeedToken" app lib components tests
  lib/sync/feed-token.ts:13:export function generateFeedToken()   # the definition, and nothing else
grep -rn "feed_token|feedToken" app/(app) components
  (no matches)
```

So `.eq('feed_token', token).eq('feed_enabled', true)` can never match, and the
route answers 404 to every request that will ever reach it. `0018` declares the
column "nullable until published" and nothing publishes.

Everything *around* it is real: two rate limiters, token-shape validation,
`readAll` pagination carrying a comment about a previously-fixed truncation, a
constant-time HMAC verifier, two test files. Both test files exercise the route
against **a token they supply themselves** — nothing asserts a token can be
obtained, so they pass on a feature no user can reach. The Part 0 pattern in its
*tested the half that works* form.

The part that outlives the dead feature: `middleware.ts` carves
`/api/sync/feeds` out of the authentication guard, with a comment explaining
that the unguessable token IS the authorization. That is correct for a live
feature and unearned attack surface for one that cannot be enabled. Carve-outs
get reviewed as a set, and this one has been carrying a justification that is
not currently true.

**Left OPEN deliberately.** Finish it (an action that mints the token and
surfaces the URL, plus a test that a published calendar is reachable end to end)
or retire it (drop the route, the carve-out and `feed-token.ts`). Choosing
between shipping and retiring a user-facing capability is a product decision,
not an audit one.
