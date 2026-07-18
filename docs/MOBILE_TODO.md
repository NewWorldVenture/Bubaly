# Mobile Production-Readiness — TODO / Issue Tracker

Actionable backlog for the mobile audit mission. Pairs with `MOBILE_PROGRESS.md`
(status + weighting) and `MOBILE_AUDIT.md` (route inventory). **A resuming bot
should read all three, then pick the top OPEN item.** Every fix ships as one commit
with a guard test and a `MOBILE_PROGRESS.md` bump — see the working agreement at the
bottom of `MOBILE_PROGRESS.md`.

Branch: **`main`** (fleet-shared — rebase before every push). Commit tag scheme:
`M-###`. IDs are stable; do not renumber.

Legend: severity — P1 (blocks mobile use) / P2 (degrades) / P3 (polish).

---

## ✅ DONE (verified, on main)

| ID | Phase | Summary | Commit |
|----|-------|---------|--------|
| M-001 | 8 | Full-height surfaces `100vh`→`dvh` (controls no longer behind browser chrome) | `92af7096` |
| M-002 | 7 | iOS/iPadOS zoom-on-focus: force ≥16px inputs on touch (`!important` + coarse pointer) | `60741b61` |
| M-003 | 4 | Horizontal-overflow sweep — found compliant; ratcheted (tables stay scroll-wrapped) | `1e5d5cd5` |
| M-004 | 6 | Labeled 4 icon-only buttons; inbox archive made touch-visible + bigger target | `ded0e179` |
| M-005 | 6 | Hover-reveal row actions made touch-visible across 10 modules (was invisible on phones) | `d678557f` |
| M-006 | 7 | 29 money/decimal `type=number` inputs got `inputMode="decimal"` (iOS decimal keypad) across 19 modules | `67acb018` |
| M-007 | 11/8 | Overlay/shell audit — shared Modal (bottom-sheet/dvh/safe-area/focus-trap) + app-shell (pb-24, safe-bottom nav) verified excellent; ratcheted | `0c00ff0b` |
| M-009 | 2/23 | Playwright mobile device matrix stood up (iphone-se/iphone/pixel/ipad × mobile+overflow+public specs; 225 tests); WebKit→Chromium fix for sandbox/CI | `2bcc974e` |
| M-010 | 16 | PWA update prompt — RegisterSW detects a new SW + shows a mobile-safe "new version → Reload" banner; SW/manifest verified | (this commit) |
| M-012 | 11 | Hand-rolled full-screen overlays now lock background scroll on mobile (shared `useLockBodyScroll` hook applied to camera, command bar, exit-intent, paywall, app-lock, account-closed) | `57142f32` |
| M-013 | 6 | Dialog a11y semantics (`role="dialog"`+`aria-modal`+labelled heading, ESC on dismissible) added to 4 hand-rolled overlays (exit-intent, app-lock, guardian rules-editor + contact-editor) so mobile VoiceOver/TalkBack announce them | `cd945c1d` |
| M-014 | 8 | Landscape safe-area: the edge-to-edge full-screen **camera** now pads left/right insets too (`--safe-left`/`--safe-right`), so the top-bar + shutter controls clear the side notch when a phone is held in landscape | (this commit) |

Guard tests include `tests/mobile-overlay-scroll-lock.test.ts` (7),
`tests/mobile-overlay-dialog-a11y.test.ts` (5), and
`tests/mobile-landscape-safe-area.test.ts` (2) alongside the prior mobile guards.

> **Parallel-bot note:** M-012 was done concurrently with agent-05's M-006/M-007.
> It is **file-disjoint** and **complementary** to M-007: agent-05's M-007 audited
> overlay **safe-area / focus-trap** and found the shared `Modal` excellent, but the
> six hand-rolled full-screen overlays that bypass `Modal` still lacked the
> **background scroll-lock** that `Modal` bakes in — M-012 closes exactly that gap.
> (Renumbered from a transient M-011 to avoid colliding with agent-05's M-011
> chat-panel item.)

---

## 🔜 OPEN — do these next (priority order)

### ✅ M-005 (P1) — DONE (agent-05) — Hover-reveal controls are invisible/unreachable on touch
**Resolved.** All 10 modules with truly-hidden `opacity-0 group-hover:opacity-100`
row actions (billing, briefing, care, files-hub, grocery, notes, photos, shopping,
timetable, trips) transformed to `opacity-100 sm:opacity-0 sm:group-hover:opacity-100
focus-visible:opacity-100` — visible on touch, hover-reveal on mouse, keyboard-
reachable. No `hidden group-hover:` remained (inbox was fixed in M-004). Guard
`tests/mobile-hover-reveal.test.ts` forbids regression. The `opacity-70/80
group-hover:opacity-100` hits (no `opacity-0` base) were left — they are already
visible on touch and just brighten on hover (not a defect).

<details><summary>Original description (for reference)</summary>

The `opacity-0 group-hover:opacity-100` and `hidden group-hover:flex` pattern hides
row actions until mouse-hover — but **touch devices have no hover**, so these
controls never appear on a phone/tablet (edit, delete, archive, favorite, drag,
etc. become unusable). M-004 fixed the inbox archive as the template:
`flex sm:hidden sm:group-hover:flex` (shown on touch, hover-reveal only at `sm+`),
or add `focus-visible:opacity-100` for opacity-based ones, or just show them on
touch via `sm:opacity-0 sm:group-hover:opacity-100`.

**Concrete targets** (grep: `opacity-0 group-hover:opacity-100` / `hidden group-hover:`):
- `components/modules/billing-module.tsx:1468`
- `components/modules/briefing-module.tsx:168`
- `components/modules/care-module.tsx:245`
- `components/modules/files-hub-module.tsx:210` (+ `:214`)
- `components/modules/grocery-module.tsx:244`
- `components/modules/notes-module.tsx:280` (+ `:338`)
- `components/modules/photos-module.tsx:332`
- `components/modules/shopping-module.tsx:191` (+ `:289`)
- `components/modules/timetable-module.tsx:173`
- …plus ~20 `group-hover:opacity-100` usages (agents, assistant, calm, family,
  habits, journal, life-events, locator, meals, messages, pets, reminders,
  routines-panel, command-center, admin/marketing). Verify each is an
  **interactive control** (button/link) before changing — some are purely
  decorative (a chevron that also has a visible affordance) and can stay.
- Re-scan to confirm none remain unreached on touch; add a guard that forbids a
  bare `opacity-0 group-hover:opacity-100` on a `<button>`/`<a>` without a
  `focus-visible`/touch-visible escape hatch.

### ✅ M-006 (P2) — DONE (agent-05) — Field-level mobile keyboard audit (Phase 7)
- ✅ **Money/decimal keypad (agent-05):** all 29 `type="number"` inputs with a
  decimal step (`0.01`/`0.1`/`any`) or `0.00` placeholder across 19 modules now
  carry `inputMode="decimal"` so iOS surfaces the decimal point (cents). Guard
  `tests/mobile-numeric-inputmode.test.ts`. `type="number"` already yields a numeric
  keypad, so integer count/year inputs were intentionally left (no defect).
- ✅ **Search keyboard:** `inputMode="search"` + `enterKeyHint="search"` added to
  the 10 search boxes (files-hub, knowledge-base, weather, photos, social-feed,
  front-desk, inbox, shopping, marketplace, recipes). Guard
  `tests/mobile-search-inputmode.test.ts`.

### ✅ M-007 (P2) — DONE (agent-05) — Overlay/drawer safe-area + keyboard (Phase 11/8)
**Audited; system is excellent, ratcheted.** The shared `components/ui/modal.tsx`
is a proper mobile **bottom sheet**: `items-end sm:items-center`, `rounded-t-3xl`,
`max-h-[85dvh]`, `pb-[max(1rem,env(safe-area-inset-bottom))]`, focus trap + restore,
ESC, body scroll-lock, `aria-modal`. The app-shell reserves `<main pb-24 lg:pb-8>`
for the fixed mobile bottom tab bar, which itself uses `safe-bottom`; FABs use
`bottom-[calc(...+var(--safe-bottom))]`. Guard
`tests/mobile-overlay-safe-area.test.ts` (6) locks these in. Only 1 shared overlay
primitive (Modal) — the ad-hoc `fixed inset-0` panels (front-desk/inbox/messages)
already carry `pt-[var(--safe-top)]` + internal `overflow-y-auto`.

### 🔬 M-011 (P2, NEEDS BROWSER VERIFY) — full-height chat panels vs the mobile bottom nav
`components/modules/messages-module.tsx:544` (and concierge) size the panel
`h-[calc(100dvh-var(--topbar-height)-1rem)]` — this subtracts the **top** bar but
**not** the fixed mobile bottom tab bar (`app-shell` reserves `pb-24`≈6rem there).
On a phone the composer may therefore sit behind/under the bottom nav. The fix is
layout-nesting-dependent (subtract the bottom-nav height on mobile only, `lg:`
restores desktop) and must be **verified in a real mobile viewport** (Playwright
/ device) before shipping — do NOT change the calc blind. Depends on M-009 (device
matrix) for evidence.

### M-008 (P2) — Tablet layouts don't waste space (Phase 9)
iPad portrait/landscape: check dashboard grids + `lg:grid-cols-[1fr_340px]` sidebars
render well; avoid narrow centered phone columns on tablets. Mostly a review pass.

### 🟡 M-009 (P1 infra) — Playwright mobile matrix (Phase 2/23) — MATRIX UP; journeys remain
- ✅ **Device matrix stood up (agent-05):** `playwright.config.ts` now has 4 emulated
  mobile projects — `iphone-se` (iPhone SE), `iphone` (iPhone 14 Pro), `pixel`
  (Pixel 7), `ipad` (iPad gen 7) — running the viewport-relevant specs
  (`mobile|overflow|public`). New `tests/e2e/mobile.spec.ts` asserts per-device:
  viewport-meta `viewport-fit=cover`, no horizontal overflow, and **no focusable
  input < 16px** (runtime iOS-zoom guard). `--list` → 225 tests / 5 projects.
- 🔜 **Remaining:** (a) authed critical journeys (login → create/edit record →
  upload → nav) need CI Supabase creds — extend `PUBLIC_ROUTES` → authed once
  available (see `authenticated.spec.ts`); (b) landscape + dark-mode variants;
  (c) wire the mobile projects into CI — ✅ **DONE**: `run-e2e.mjs` runs all projects with no filter, so the CI `e2e` job (PR + push to main) now executes the mobile matrix as a gate. Running the full matrix needs a
  `next build` + server (~5 min) — kicked once for evidence.

### M-010 (P2) — PWA update UX + offline states (Phases 16/17)
`app/manifest.ts` + `public/sw.js` exist. Verify: a visible "new version available"
prompt (no permanently-stale code), offline fallback, no caching of authenticated
responses, and that long-running requests time out with a retry-safe message.

---

## Notes for the next bot
- **Do not** add a global `overflow-x: hidden` (masks real bugs, breaks sticky) —
  see M-003.
- **Do not** weaken RLS/auth/validation to make a mobile check pass.
- Verify with `tsc --noEmit` + `eslint <changed>` + a focused guard test; run
  `next build` for anything touching layout/CSS. tsc on this repo takes ~2–4 min —
  give it time, it is not hung.
- Keep each increment small and shippable; update `MOBILE_PROGRESS.md` % from
  **verified** work only, never estimate.
