# Role-sweep, auth-route and server-action evidence (session_01DXw2nu25BjyRfA6Fg3YiMS)

Evidence only. This directory changes no code and does not edit `finalaudit.md`. Everything
here ran against a **local** stack; nothing claims production acceptance. It preserves the raw
results behind ledger entries this session already wrote, maps them to existing audit IDs,
says which results later changes made stale, and records the affected checks re-run on
2026-09-30. Status changes in `finalaudit.md` are left to its writer.

## Source qualification at reconciliation

The measurements below are historical local observations at their named source commits,
not new executions on current main. The September 30 rerun app used `bf8063e73`; its guard
tests used `bc147c761`. Source comparison from `bc147c761` to reconciliation base
`ab49820afd238451effb618822860a8306d468da` finds one changed application module:
`app/(app)/economy/actions.ts`, via #667. Its added `readAllAsQuery` import and
`requestRedemptionAction` behavior require fresh evidence for affected workflows; the
other six named exports in that module were not behaviorally edited by that diff. This
comparison is source-only, not a new runtime or transitive-import acceptance check.
The other changes in that range are ledger and test files. The later main `231e8140` additionally merges the Stripe webhook route and paired tests; that source repair does not replay any historical route/action observation here. Historical crawl data and its
page-file flags are preserved as measured; an unchanged page file does not establish
freshness of its imports, layout, middleware, data or provider behavior.

## Files

| File | What it is |
|---|---|
| `b7-second-pass-2026-09-27.jsonl` | Historical page audit B7, second pass: 1,470 page loads as a teen and a `/kid-login` child |
| `b14-axe-2026-09-27.jsonl` | Historical page audit B14: 1,256 axe loads as a parent, a `/kid-login` child and a super administrator, first pass and re-crawl |
| `route-rows.jsonl` | One row per crawled route: its `UI-ROUTE-` id, page file, B7 and B14 results, and whether the page file changed at the original comparison (not import freshness) |
| `sec-023-actions.tsv` | SEC-023's server actions, each mapped to its `ACTION-` row |
| `rerun-2026-09-30/` | The checks re-run that day, their raw output, and the 51 guard files run on `bc147c761` |
| `probes/` | The three local probe scripts used (`api-as.mjs`, `plan-gate.mjs`, `kid-pattern.mjs`), verbatim |
| `historical/route-auth-markers-2026-09-13.tsv` | A static scan of every `route.ts` for auth helpers, kept for the record; stale |

## Environment (every run)

- A local Supabase stack (Supabase CLI, every migration applied) on `127.0.0.1`.
- A production build of the app (`npm run build`, then `next start`), Node 24.21.0, and Playwright's Chromium.
- One seeded household (`scripts/seed-personas.mjs`) with:
  - two parents;
  - a teen who signs in with email;
  - a managed child whose login was created through the parent's **Family access → Create login** and who signs in at `/kid-login` with a username and PIN.
- Pages with an id in the path were given seeded rows.
- The super administrator is a local seeded account.
- **Not against production.** No production data, no provider keys.

## Results

### 1. Role sweep: page audit B7, second pass (2026-09-27)

**Source.**
- The 1280 px crawls ran on `cfa20b7b4` (on main).
- The plan-gated and 390 px crawls ran on local commit `11410c9fa`: `cfa20b7b4` plus the four B7 fixes (P-19 to P-22).
- Those fixes reached main as `1d992562f`, `5402f873c` and `277238195`.

**Command.** `node scripts/page-audit.mjs --base http://127.0.0.1:<port> --paths <354 signed-in routes> --storage <teen|child state> --concurrency 4 --out <file> [--mobile]`

| Pass | Loads | Result |
|---|---|---|
| Teen, household on no plan, 1280 px | 354 | 349 PASS, 5 CHECK: P-21 (the sync accounts page never settled), four sidebar `Failed to fetch` on a redirect (P-07) |
| Child (`/kid-login`), no plan, 1280 px | 354 | 351 PASS, 3 CHECK: P-21 and two sidebar aborts (P-07) |
| Teen and child, the 27 plan-gated routes, household on Family+ | 27 × 2 | 54 PASS; all render in place |
| Teen and child, 390 px, Family+, fixed build | 354 × 2 | 708 PASS |

- **Where the roles were sent.** All 80 `/admin` routes and `/auth/step-up` go to `/dashboard`, and `/dashboard/family-access` goes to `/home`.
- **The plan gate.** With no plan, 25 (teen) and 26 (child) routes went to the plan gate, which is P-19.

**Findings.** P-19, P-20, P-21 and P-22 were found and fixed in the ledger's B7 entry; P-07 was found earlier. The `/kid-login` child's reach into Tax Vault was recorded under PROD-002, the owner's call.

**Stale since.**
- Of the crawled routes, 50 page files changed after `cfa20b7b4` (351 commits), and 169 component files changed too. `route-rows.jsonl` marks each route whose page file changed.
- The role-redirect subset's own import closure also changed. One file matters there: `isSuperAdmin` gained an optional `client` argument, and its cookie-session default is unchanged.
- **Re-run on 2026-09-30:** that subset (80 admin routes, `/auth/step-up`, `/dashboard/family-access`) as the teen and the child. **82/82 and 82/82 land where they did.** These 164 checks establish the redirect destination dimension only, not the requested pages' rendered contents or complete workflows.
- The per-page render results for changed pages were **not** re-crawled, as instructed.

### 2. Role sweep: page audit B14, axe (2026-09-27/28)

**Source.**
- The first pass ran on `877d9a5eb`.
- The re-crawl ran on the fixed tree, committed as `934219b5d`.

Both commits are on main.

**Command.** `node scripts/axe-audit.mjs --base http://127.0.0.1:3107 --paths <list> --storage <state> --out <file>`. The script itself is in the repository.

| Crawl | Parent (274) | Child (274) | Super admin (80) |
|---|---|---|---|
| First pass | 15 pages with violations | 4 | 1 |
| Re-crawl, fixed build | 0 | 0 | 0 |

On the historical re-crawl, each reached landing page has exactly one `<h1>`. Axe inspects the reached page after navigation: when a requested route redirects, its result belongs to the landing page, not inaccessible content at the requested route.

**Findings.** P-27 to P-31, all fixed. MAIN-F-D02, F-D03 and F-D05 were closed on this evidence.

**Stale since.** 15 crawled page files and 114 component files changed after `934219b5d` (167 commits). The axe result for those pages is stale and was **not** re-crawled. These file-change counts are historical comparisons; unchanged page files may also have changed imports, so the remaining results are not automatically current. The guard tests that hold B14's fixes were re-run and pass (section 8).

### 3. Plan gate, driven end to end (MAIN-F15, F16, F17, F18)

**Source.** `877d9a5eb` (2026-09-27). The command is `node probes/plan-gate.mjs <parent state>`. As the parent, it switches the household between Free, Basic and Family+ in the local database, then sets the plan to hardcoded `plus` in `finally` and reuses the captured trial date. It does not capture or restore an arbitrary prior plan, and it does not set subscription status.

**Result.** 21/21 checks passed.
- Four pages redirect to the plan below their level, with the catalogue's `need`.
- Three endpoints answer 403 below their level and pass above it.

**Stale since.** Five files in the import closure changed: `review-card.tsx`, `app-context.tsx`, `roles.ts`, `database.types.ts` and `public-calendar-fetch.ts`. None of the changes touches the gate.

**Re-run on 2026-09-30: 21/21** (`rerun-2026-09-30/plan-gate.jsonl`). The author reported a post-run state of `plus`, `active`, with the same trial date. This confirms that fixture's reported final state, not generic restoration of its prior plan/status. The mutating probe was not rerun for this reconciliation.

The Autopilot cron half ("one entitled family on Family+, none on Free") was not re-run.

### 4. Kid login matches the username exactly (MAIN-F22)

**Source.** `877d9a5eb`. The command is `node probes/kid-pattern.mjs <child username> <PIN>`. It uses the child's real PIN and strips the form's own checks.

**Re-run on 2026-09-30** (the closure changed: `kid-login-form.tsx`, `otp.ts`):
- `maya%` and `mayarive_a` get no session.
  - The only cookie set is the 43-character PKCE-initiation cookie.
  - `/home` then lands on `/login`.
  - The probe's `signedIn` field is only "a cookie name contains `auth-token`", so read `homeLanded`.
- `%` is refused by the form itself.
- The real username signs in and lands on `/home`.

### 5. Admin marketing routes refuse a family member (MAIN-F-E09)

**Source.** `8f6155a37`, with `node probes/api-as.mjs <state> <METHOD> <path>`. A parent and a teen get `403 {"error":"Forbidden"}` from:
- `POST /api/admin/marketing/ai`;
- `GET /api/admin/marketing/email/send`;
- `POST /api/admin/marketing/email/send`.

**Re-run on 2026-09-30, identical** (`rerun-2026-09-30/role-api.txt`).
- The closure changed only in `roles.ts` (new label keys) and `database.types.ts`.
- That file's signed-out lines (200 and the login page) are the client-type limitation in section 6, not a failure.

### 6. A signed-out API call is told to sign in (AUTH-005)

**Source.**
- Reproduced on `8f6155a37`: a script client's signed-out call was followed to the login page and read as a 200.
- Fixed in `a9ded47c6` (`middleware.ts`).
- `tests/a-signed-out-api-call-is-told-to-sign-in.test.ts` fails 3 of 6 on the previous middleware.

**Stale since.** Nothing in `middleware.ts`'s import closure has changed since `a9ded47c6`.

**Re-run on 2026-09-30 anyway**, as it rides on section 5's run (`rerun-2026-09-30/signed-out-api.txt`). Across the marketing, Autopilot, home-diagnosis and weekend endpoints:
- a browser fetch (`Sec-Fetch-Mode: cors`) gets `401 {"code":"unauthenticated"}`;
- a JSON request (`Accept: application/json`) gets the same;
- a navigation gets `307 → /login?redirect=…`;
- `/dashboard`, `/admin` and `/wallet` still redirect to `/login`.

**Limitation, by design.** A client that sends neither `Sec-Fetch-Mode` nor `Accept: application/json` still follows the redirect to a 200 login page. Plain `curl` and Playwright's request API are such clients. The middleware cannot tell such a client from a browser navigation.

### 7. Server actions returned the database's own error text (SEC-023)

**Source.**
- Found and fixed as `be9df6045` on `claude/logged-in-pages-supabase-7q6vtf`, and ported to main as `418be2008` (2026-09-27).
- 61 returns across 22 files handed back `error.message`. As a parent session, the real `savePlace` action answered a radius of `150.5` with `invalid input syntax for type integer`.
- Every one now goes through `describeActionError`.
- A scan holds `app/` at zero, with one named admin-diagnostics exception. On main it found six more (recorded under PORT-001).

**Guards.** `tests/a-database-error-is-not-a-user-message.test.ts` and `tests/a-job-error-is-described-at-the-action.test.ts`.

**Re-run on 2026-09-30: both pass at `bc147c761`.** The live `savePlace` example was not re-run: the ratchet is the check that covers every site.

**Mapping.**
- `sec-023-actions.tsv` has 57 distinct path/function pairs: 55 mapped action pairs plus two helpers (`setInsightStatus`, `setMomentStatus`) with no row; these use 56 distinct function names.
- `toggleFavoriteAction` is a different export in each of two files: dining maps only to `ACTION-E7BFD9F7072B`, and social-feed only to `ACTION-C276C13E409F`. The two swapped cross-product pairings from the original evidence are removed. There are 55 distinct mapped audit IDs, not additional coverage from the duplicate name.
- `status_on_main` is the original source snapshot, not the current ledger status. This error-surface evidence overlaps the actions in #670; it does not create another set of action closures.
- SEC-023 has no finding row of its own in `finalaudit.md` on main.

### 8. Guard tests re-run at `bc147c761` (2026-09-30)

- The 51 guard files behind sections 1–7 pass: 51 files, 837 tests, on main at `bc147c761`, Node 24.21.0.
- They include the B7 and B14 guards, the plan-gate, kid-login, middleware and marketing tests, and SEC-023's two.
- The list and summary are in `rerun-2026-09-30/guards.txt`.
- The re-runs' app build was made from `bf8063e73`, which differs from `bc147c761` only in `mobile/package-lock.json`.

### Historical, stale: static route-auth scan (2026-09-13)

`historical/route-auth-markers-2026-09-13.tsv` lists, for every `app/**/route.ts` at `de5763140` (144 files; the original September 30 comparison found 150), its HTTP methods and the auth helpers it names.

- It is a grep, not a probe.
- It is kept because it was this session's first auth-route sweep.
- It was superseded by the API sweep (#619, another session) and by the probes above. It was not re-run.

## Audit IDs this evidence supports

Evidence for the dimension named, not a status change. The rows' statuses are unchanged and stay the ledger writer's call.

| ID | Dimension supported | Sections |
|---|---|---|
| AUTH-005 | The fix, and its local re-run at the recorded source | 6 |
| MAIN-F-E09 | Parent and teen refused by the admin marketing routes, re-run | 5 |
| MAIN-F15, MAIN-F16, MAIN-F17, MAIN-F18 | Plan gate on pages and endpoints, re-run 21/21 | 3 |
| MAIN-F22 | Kid-login exact match, re-run | 4 |
| MAIN-F-D02, MAIN-F-D03, MAIN-F-D05 | Historical axe on reached landing pages; page/import freshness not established | 2 |
| P-19, P-20, P-21, P-22 (B7); P-27 to P-31 (B14) | Found and fixed by these crawls | 1, 2 |
| SEC-023 and its 55 `ACTION-` rows | Error-surface guard dimension at the recorded source; not full action acceptance | 7 |
| 351 `UI-ROUTE-` rows (`route-rows.jsonl`) | Historical role reach and landing-page axe; September 30 redirect subset only; page flags omit changed imports | 1, 2 |
| API-192980CC87C1, API-77A1BDDE52B2, API-68728C68AD8D | Authorization: parent and teen refused | 5 |
| API-5DF6AEE61A0B, API-BE4AC9438408, API-C282DCE0790A | Plan gate, and signed-out 401 | 3, 6 |
| UI-WF-001 | The child-PIN part: a login created by a parent, then `/kid-login` | 1, 4 |
| AUTH-002 | Signed out: API calls get 401, pages redirect to `/login` (not the persistence half) | 6 |
| SUPPORT-3C67EB27B539 (`middleware.ts`) | Its signed-out branch only | 6 |
| ROLE-0D5E0E2A8906, ROLE-8B7ECBCBD636 | `/kid-login` page and form, exercised by a real PIN session | 1, 4 |

## Observation, not assessed

`POST /api/autopilot/scan` checks the household's plan but not the member's role. In section 5's re-run, the teen's call answered 200 (`scanned: 0`). Whether any member may start a scan is a product question. It was not investigated, and no finding is raised here.

## What was left out

- The Playwright storage states, the child's PIN and the persona password.
- Local environment files, cookie values and raw page HTML or text.
- The screenshots.

Crawl rows are reduced to the route, status, landing path, `<h1>` count, overflow, verdict and error counts. Error text keeps its first line, and URLs lose their query strings. The household is a seeded local fixture; no customer data was involved.

## Limitations

- Local only. Nothing here is production acceptance. No probes or guard tests were rerun for this source-and-mapping reconciliation.
- **Roles covered.**
  - B7: the teen and the `/kid-login` child.
  - B14: the parent, the child and the super administrator.
  - Adult, caregiver and guest were not crawled here.
- **Widths.** 1280 and 390 px only.
- **Stale page results.** B7's and B14's per-page results for pages changed since their source commit are stale. The per-page staleness in `route-rows.jsonl` looks at the page file only, not its imports, so it is a lower bound.
- **Sanitization limits.** The companion #670 `scan.py` broadly exempts every 40-character hexadecimal string, not just verified commit IDs. A clean scanner result is not an absolute guarantee that evidence contains no identifiers or sensitive content; this archive's omissions and reduced fields describe the author's handling, not a complete redaction proof.
- **Archived probe reuse.** `api-as.mjs` accepts arbitrary `BASE_URL` without a loopback guard and prints a 160-character response prefix; its local default is not an enforced safety or redaction boundary. The scripts are preserved verbatim as historical evidence, not endorsed for reuse against another target. Storage state, target authorization and response sensitivity require review before any separately authorized execution.
- **Endpoint checks prove the gate, not the feature.** Weekend search answered 503 with no event-provider keys. The diagnosis probe's body was answered 400 ("Describe the problem first.").
