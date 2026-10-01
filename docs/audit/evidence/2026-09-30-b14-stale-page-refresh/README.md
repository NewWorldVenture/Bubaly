# B14 refresh: the 15 page-file-stale routes (2026-09-30)

This directory is evidence only. It changes no code, dependency or migration, and it does not
edit `finalaudit.md`. It refreshes the 15 B14 axe results that #671
(`docs/audit/evidence/2026-09-30-role-auth-server-action/`, `route-rows.jsonl`,
`pageChangedSinceB14: true`) marked stale because their page files changed after
`934219b5d`. #671 is left as it is. Status changes stay with the ledger writer.

## Source and environment

| | |
|---|---|
| Source | `main` at `231e8140ea8394c2106c37f617b33b5fb5e8e569`, unmodified |
| Build | `npm run build`, then `next start` on `127.0.0.1:3107` (production) |
| Runtime | Node 24.21.0; React 18.3.1; Next 16.3.6 (from the repository lockfile) |
| Browser | Playwright 1.61.0 with its pinned Chromium **149.0.7827.55** (build 1228), headless |
| axe | `scripts/axe-audit.mjs` (unchanged); `@axe-core/playwright` 4.12.1; tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` |
| Data | A local Supabase stack with all 447 migrations through `0464`. The data is synthetic and local only; there was no production access and no provider keys |

**Personas.** Each signed in through the real `/login` or `/kid-login` form of the build (`probes/b14-signin.mjs`):
- **Parent:** a plain parent of the local crawl household. Its local `super_admins` row was removed so that the parent scans are not a super administrator's.
- **`/kid-login` child:** the household's child login. Its PIN was set the way the app's reset does, with `deriveChildPassword(CHILD_LOGIN_SECRET, username, pin)`.
- **Super administrator:** a local super admin from a separate local household.

**Records.** The four id routes use genuine rows in that household, checked on the page (`route-manifest.tsv`):
- **Seeded for this run:** one chore and a chore assignment for the child, and one marketplace listing owned by the child.
- **Already existing:** the child's active store and the child's active wallet.

**Commands.** `commands.txt`. The probes in `probes/` ran from the repository root as temporary copies, which were removed afterwards. They are **archived recipes**, recorded as run; none was rerun for the correction below. Only `b14-fixtures.mjs` enforces a local target (it refuses a Supabase URL that is not `http://127.0.0.1:…`). `b14-signin.mjs`, `b14-verify.mjs`, `b14-overlay-repro.mjs` and `b14-overlay-node.mjs` accept any base URL together with credentials or a storage state; they were pointed at `http://127.0.0.1:3107` by hand, and nothing in them enforces that. Reusing them needs a tested loopback guard that runs before credentials or storage are supplied.

**Freshness (static only).** Application, component, dependency and migration source is unchanged from the measured `231e8140` through `main` at `e43f835a`: the 31 later commits change only `.github/`, `docs/`, `finalaudit.md` and `tests/` (`git diff --name-only 231e8140 e43f835a`). This is a source comparison, not a browser rerun.

## Results

### axe: 52 unique loads, 0 violations (`axe-results.jsonl`)

| Role | Routes | 1280 px | 390 px |
|---|---|---|---|
| Super administrator | 4 admin routes | 4 × 200, 0 violations | 4 × 200, 0 violations |
| Parent | 11 family routes | 11 × 200, 0 violations | 11 × 200, 0 violations |
| `/kid-login` child | 11 family routes | 11 × 200, 0 violations | 11 × 200, 0 violations |

Every load has exactly one `<h1>`.

### These are feature scans, not redirects (`landing-and-records.jsonl`)

All 52 loads meet all five of these conditions:
- they land on the requested path (`redirected: false`);
- they are not the "We couldn't find that" page;
- they show no error boundary;
- the body is not blank;
- on the five record-bound pages, the seeded record is shown.

**The five record-bound pages**, with what each shows: 20 positive record checks, `seededRecordShown: true` for both roles at both widths (the other 32 loads have no record to check):
- `/kids/submit/<assignmentId>` shows the chore;
- `/marketplace/item/<listingId>` shows the listing;
- `/marketplace/creators/<storeId>` shows the listing;
- `/wallet/children/<childWalletId>` shows the child;
- `/family/members` shows the child.

**The child scans are feature scans too.** The `/kid-login` child reaches all 11 family routes in place; none redirects that role.

### Overlays: keyboard operation and focus return (`overlay-keyboard.jsonl`, 172 rows)

**What was checked.** The overlays the probe found and could open without changing data, on the route/role/width combinations recorded in `overlay-keyboard.jsonl`: parent and child, 1280 and 390 px, on 10 of the 11 family routes. `/kids/submit/<assignmentId>` has no overlay observation, `/dashboard/social/feed` has only the shell's "All Services", "Open menu" and blog overlays, and no admin overlay was opened (see the coverage gaps below).
- **How:** it was focused and opened with **Enter** only.
- **Recorded:** whether focus moved inside; whether Tab stayed inside a modal; whether **Escape** closed it; and whether focus returned to the trigger.
- **Totals:** 172 observations. 92 pass every recorded criterion. 44 fail focus return (36 Quick capture, 4 Request, 4 Ask for more allowance). 36 language-picker observations fail initial focus placement.
- **Route coverage:** Quick capture and Change language were checked on 9 of the 11 family routes. `/dashboard/social/feed` and `/kids/submit/<assignmentId>` have no Quick capture or language-picker observation.

| Overlay (where) | Opened by Enter | Focus inside | Tab trapped (modal) | Escape closes | Focus returns | Loads |
|---|---|---|---|---|---|---|
| "All Services" (shell) | yes | yes | yes | yes | **yes** | 14 |
| "Read the Bubaly blog" (shell) | yes | yes | yes | yes | **yes** | 40 |
| "Open menu" (shell, 390 px) | yes | yes | yes | yes | **yes** | 20 |
| "Ask the AI assistant" (shell) | yes | yes | yes | yes | **yes** | 18 |
| **"Quick capture"** (shell) | yes | yes | yes | yes | **no, focus is lost to `<body>`** | 36 |
| **"Request"** (`/wallet/children/<childWalletId>`) | yes | yes | yes | yes | **no, `<body>`** | 4 |
| **"Ask for more allowance"** (same page) | yes | yes | yes | yes | **no, `<body>`** | 4 |
| **"Change language"** (listbox) | yes | **no**; focus stays on the trigger | n/a | yes | yes | 36 |

## Defects, each with a minimal reproduction (`repro/`)

**1. Focus is not returned after the shared `Modal` closes on Escape.** "Quick capture", and the child-wallet "Request" and "Ask for more allowance" dialogs, all use `components/ui/modal.tsx` → `lib/a11y/use-dialog-behavior.ts`.
- **Reproduction** (`probes/b14-overlay-repro.mjs`, `repro/overlay-keyboard-repro.jsonl`), as the parent or the child at 1280 or 390 px:
  1. Open `/home`.
  2. Focus the "Quick capture" button.
  3. Press Enter: a modal dialog opens and focus moves to its first control.
  4. Press Escape: the dialog closes.
  5. `document.activeElement` is `<body>`, not the trigger.
- **The same on the wallet page** with "Request" and "Ask for more allowance".
- **Trigger node identity** (`repro/focus-restore-node-check.jsonl`): two checks only, both as the parent at 1280 px (Quick capture on `/home`, Request on the wallet page). In those two, the trigger is the **same DOM node** before and after, still connected, and neither `inert` nor inside `aria-hidden`. Trigger replacement is excluded for those two cases only, not for other roles, widths or triggers.
- **Cause: not determined here.** The hook's passive capture of focus, with callers whose field takes focus by `autoFocus`, is a plausible mechanism. It was not instrumented in this evidence.
- **Audit IDs:** the failure is in the shared Modal, COMPONENT-DA7D449CE911 (already IN PROGRESS). The hook LIBRARY-836BF6D8DBFF and the callers COMPONENT-97EAFCA06075 (`components/app/quick-capture.tsx`) and COMPONENT-96ACB1178C63 (`components/wallet/child-detail-view.tsx`) are investigation context. MAIN-F-D04's historical pass covers four named hand-rolled dialogs (Guardian rules editor, contact editor, trial paywall, closed-account gate). None of them was exercised here, so that scoped pass stands. WCAG 2.4.3 (Focus Order).
- **Observed reach:**
  - "Quick capture": the 9 family routes where it was checked, both roles, both widths.
  - The two wallet dialogs: the parent and the child.

**2. C2-B06 still reproduces:** the language picker declares `role="listbox"`/`option` without the listbox keyboard pattern (`components/i18n/language-picker.tsx`).
- **Reproduction:**
  1. Focus "Change language".
  2. Press Enter: the listbox opens.
  3. Focus **stays on the trigger**.
  4. **ArrowDown does nothing.**
  5. The options (rendered before the trigger in the DOM) are reachable only with Shift+Tab.
- **What works:** Escape closes the listbox and returns focus to the trigger.
- **Audit IDs:** the component is COMPONENT-F9B18D77DEBF. C2-B06 remains the existing narrative issue, confirmed on `231e8140`. Observed on the 9 family routes where the picker was checked.

axe reports neither defect. axe does not test keyboard operation.

## Audit IDs this evidence supports

It is evidence for the dimension named, not a status change: no bulk PASS, and no automatic reopening of MAIN-F-D04.

| ID | Dimension |
|---|---|
| UI-ROUTE-0008, -0024, -0060, -0077 | axe (0 violations) and in-place landing, as a super administrator, 1280 and 390 px |
| UI-ROUTE-0198, -0219, -0247, -0300, -0302, -0311, -0313, -0327, -0319, -0324, -0344 | axe (0 violations), in-place landing and seeded records, as a parent and a `/kid-login` child, 1280 and 390 px; overlay keyboard results per page |
| MAIN-F-D02, MAIN-F-D03, MAIN-F-D05 | No unnamed controls; one `<h1>` per page, for these 15 routes (refreshes #671's stale part) |
| P-27 to P-31 | Their fixes hold on these 15 routes (0 violations; one `<h1>`) |
| COMPONENT-DA7D449CE911 | Shared `Modal`: Escape closes it, but focus is not returned (defect 1) |
| LIBRARY-836BF6D8DBFF, COMPONENT-97EAFCA06075, COMPONENT-96ACB1178C63 | Investigation context for defect 1 (hook, Quick capture, child wallet); statuses unchanged |
| MAIN-F-D04 | Not exercised: its scoped pass covers four hand-rolled dialogs, none of them tested here |
| COMPONENT-F9B18D77DEBF, C2-B06 | Language picker: initial focus placement fails; C2-B06 still reproduces on `231e8140` (defect 2) |

## Coverage gaps (not claimed)

- **Overlays behind data-changing controls were not opened.** The probe skips any control whose name suggests a change (create, add, new, delete, save, send, approve and similar), so dialogs opened only from such buttons were not exercised. This covers all four admin pages, where the probe found no overlay it could open safely.
- **`/kids/submit/<assignmentId>`'s proof form was not submitted**, and its upload control was not exercised.
- **Shared components:**
  - #671 counted 114 component files changed since `934219b5d`. Only what these 15 routes render, for these three roles and at these two widths, was exercised.
  - Components were not mapped file by file to routes.
  - Shell overlays were exercised only on the recorded route/role/width combinations: not on `/kids/submit/<assignmentId>`, and on `/dashboard/social/feed` without Quick capture or the language picker.
- **Not covered:**
  - roles: teen, adult, caregiver or guest;
  - widths: 768 and 1024 px;
  - dark mode;
  - WCAG 2.2 criteria (not in the axe tags used);
  - screen readers (only programmatic state was read).
- **Local only.** No production acceptance is claimed.

## Guards and scanners

`guards-and-scanners.txt`: the existing B14 guard tests, and the repository's full unit suite (which contains the documentation and tracked-tree scanners), run with this directory present.

## Left out

- Credentials, Playwright storage states and the child's PIN.
- Raw page text, screenshots, videos and traces.
- Record ids (replaced with named placeholders) and member display names (`<name>`).

A pattern scan of the 14 files here found no credential patterns. It covers only the patterns scanned; it is not an exhaustive sanitization certification.
