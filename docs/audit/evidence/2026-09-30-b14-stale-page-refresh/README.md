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

**Commands.** `commands.txt`. The probes in `probes/` ran from the repository root as temporary copies, which were removed afterwards.

## Results

### axe: 52 loads, 0 violations (`axe-results.jsonl`)

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

**The five record-bound pages**, with what each shows (`seededRecordShown: true` for both roles at both widths):
- `/kids/submit/<assignmentId>` shows the chore;
- `/marketplace/item/<listingId>` shows the listing;
- `/marketplace/creators/<storeId>` shows the listing;
- `/wallet/children/<childWalletId>` shows the child;
- `/family/members` shows the child.

**The child scans are feature scans too.** The `/kid-login` child reaches all 11 family routes in place; none redirects that role.

### Overlays: keyboard operation and focus return (`overlay-keyboard.jsonl`, 172 rows)

**What was checked.** Every overlay that could be opened without changing data, on every route, role and width.
- **How:** it was focused and opened with **Enter** only.
- **Recorded:** whether focus moved inside; whether Tab stayed inside a modal; whether **Escape** closed it; and whether focus returned to the trigger.

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
- **The trigger is not the reason** (`repro/focus-restore-node-check.jsonl`). It is the **same DOM node** before and after, it is still connected, and it is neither `inert` nor inside `aria-hidden`. So the hook's cleanup `previouslyFocused.focus()` either saved something other than the trigger, or its focus is taken away afterwards.
- **Related existing ID:** MAIN-F-D04 records that the modal dialogs return focus on close. This is a failure of that behaviour on current `main`. WCAG 2.4.3 (Focus Order).
- **Reach:**
  - "Quick capture" is in the app shell, so it affects every signed-in family page, both roles, and both widths.
  - The two wallet dialogs affect the parent and the child.

**2. C2-B06 still reproduces:** the language picker declares `role="listbox"`/`option` without the listbox keyboard pattern (`components/i18n/language-picker.tsx`).
- **Reproduction:**
  1. Focus "Change language".
  2. Press Enter: the listbox opens.
  3. Focus **stays on the trigger**.
  4. **ArrowDown does nothing.**
  5. The options (rendered before the trigger in the DOM) are reachable only with Shift+Tab.
- **What works:** Escape closes the listbox and returns focus to the trigger.
- **Existing ID:** this is the existing finding C2-B06, confirmed on `231e8140`.

axe reports neither defect. axe does not test keyboard operation.

## Audit IDs this evidence supports

It is evidence for the dimension named, not a status change.

| ID | Dimension |
|---|---|
| UI-ROUTE-0008, -0024, -0060, -0077 | axe (0 violations) and in-place landing, as a super administrator, 1280 and 390 px |
| UI-ROUTE-0198, -0219, -0247, -0300, -0302, -0311, -0313, -0327, -0319, -0324, -0344 | axe (0 violations), in-place landing and seeded records, as a parent and a `/kid-login` child, 1280 and 390 px; overlay keyboard results per page |
| MAIN-F-D02, MAIN-F-D03, MAIN-F-D05 | No unnamed controls; one `<h1>` per page, for these 15 routes (refreshes #671's stale part) |
| P-27 to P-31 | Their fixes hold on these 15 routes (0 violations; one `<h1>`) |
| MAIN-F-D04 | **Contradicted** for the shared `Modal`: Escape closes it, but focus is not returned (defect 1) |
| C2-B06 | **Still reproduces** on current `main` (defect 2) |

## Coverage gaps (not claimed)

- **Overlays behind data-changing controls were not opened.** The probe skips any control whose name suggests a change (create, add, new, delete, save, send, approve and similar), so dialogs opened only from such buttons were not exercised. This covers all four admin pages, where the probe found no overlay it could open safely.
- **`/kids/submit/<assignmentId>`'s proof form was not submitted**, and its upload control was not exercised.
- **Shared components:**
  - #671 counted 114 component files changed since `934219b5d`. Only what these 15 routes render, for these three roles and at these two widths, was exercised.
  - Components were not mapped file by file to routes.
  - Shell overlays were exercised on every page, as recorded.
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
