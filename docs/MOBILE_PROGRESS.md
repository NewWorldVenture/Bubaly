# Mobile Production-Readiness — Progress

Honest, evidence-based tracker for the mobile audit + remediation mission
(iPhone / iPad / Android phone + tablet · Safari / Chrome · PWA · portrait +
landscape · notches / safe areas). Progress is computed from **verified, shipped**
work — not estimated effort. **This is early; do not read any high percentage
into it.**

_Owner: agent-05 (CLAUDE-FRONTEND-01). Started 2026-07-18 20:12 UTC._

## Overall completion: ~27% (early)

Weighting (per the mission brief):

| Area | Weight | Verified done | Notes |
|------|--------|---------------|-------|
| Discovery & route inventory | 5% | ~1% | Architecture identified; full route inventory pending |
| Responsive layouts | 15% | ~1% | dvh viewport-height fixes landed; full sweep pending |
| Navigation & touch | 10% | 0% | pending |
| Forms & keyboard | 10% | 0% | pending (inputmode/type audit) |
| Supabase & backend workflows | 15% | ~2% | marketing read-path + fail-closed already hardened this session; app-wide pending |
| Auth & security | 10% | 0% | pending |
| Performance | 10% | ~1% | SEO/AEO bounded reads landed; app-wide pending |
| Accessibility | 10% | ~1% | A-05 icon-button a11y done earlier; app-wide pending |
| Automated testing | 10% | ~1% | guard tests added incrementally |
| Production release validation | 5% | 0% | pending |

## Architecture (Phase 1 — discovery, partial)

- **Framework:** Next.js 15.5 (App Router, RSC), React 19. Package manager: npm.
- **Backend:** Supabase (Postgres 16, RLS, Realtime, Storage). Server actions +
  route handlers + `createServiceClient`/`createServerClient`.
- **Styling:** Tailwind CSS 3.4 (supports `dvh`/`svh`/`lvh` utilities). Custom CSS
  properties for theming; `dark:` variants; `--safe-top` etc. safe-area vars.
- **Mobile foundation already present:** `app/layout.tsx` sets `viewport` with
  `viewportFit: 'cover'` + light/dark `themeColor`; PWA `app/manifest.ts` +
  `public/sw.js` service worker; `@capacitor/*` native bootstrap
  (`components/native/native-bootstrap.tsx`) — so a native wrapper path exists.
- **Baseline gates (green, verified this session):** `tsc --noEmit` clean;
  `eslint` clean (2 pre-existing hook warnings); `next build` succeeds;
  full vitest suite **3743 tests** green.

## Shipped remediation

### M-001 — Full-height mobile surfaces used `100vh` (controls hidden behind browser chrome)
- **Severity:** High (mobile). **Phase:** 8 (safe areas & viewport).
- **Problem:** `100vh`/`min-h-screen` on mobile Safari/Chrome is taller than the
  visible viewport (excludes the address bar), so full-height panels pushed their
  controls off-screen — notably the **messages** chat panel (input hidden behind
  the address bar / keyboard) and the **concierge** panel, plus the kids app shell
  and the gift/pay full-page layouts.
- **Fix:** switched to dynamic viewport units — messages
  `h-[calc(100dvh-…)]`, concierge `calc(100dvh - 140px)`, and app shells
  (`kids/layout`, `gift/[token]`, `pay/[handle]`, marketing showcase) to
  `min-h-dvh`. Desktop-only `lg:max-h-[calc(100vh-120px)]` panels left as-is
  (`100vh` is correct on desktop).
- **Files:** `components/modules/{messages,concierge}-module.tsx`,
  `app/(app)/kids/layout.tsx`, `app/gift/[token]/page.tsx`,
  `app/pay/[handle]/page.tsx`, `components/marketing/reference-showcases.tsx`.
- **Test:** `tests/mobile-viewport-height.test.ts` (3) — locks the surfaces on
  `dvh`, forbids a regression to bare mobile `100vh`/`min-h-screen`.
- **Evidence:** guard green; `tsc` clean; `eslint` 0 errors. Full app grep confirms
  no non-desktop `100vh`/`min-h-screen` remains.

### M-002 — iOS/iPadOS zoom-on-focus: mobile inputs rendered < 16px
- **Severity:** High (mobile, app-wide). **Phase:** 7 (forms & keyboard).
- **Problem:** iOS/iPadOS Safari zooms the whole page (and shifts it right) when a
  focused input's font is < 16px. `components/ui/input.tsx` used
  `text-sm sm:text-base` (**14px on mobile**, 16px desktop — backwards), and ~184
  files style inputs with `text-sm`/`text-xs`. A global `@media (max-width:640px)`
  rule *tried* to force 16px but had **no `!important`**, so Tailwind's `text-sm`
  utility (class selector) out-specified the bare `input` element selector and the
  zoom stayed live. It also missed iPads (> 640px).
- **Fix:** the global rule now uses `font-size: 16px !important` and is scoped to
  `@media (max-width: 640px), (pointer: coarse)` — covering phones **and** touch
  tablets, while mouse-desktop keeps its density. One CSS change fixes every input
  app-wide (no need to touch 184 files). Verified the auth email/password fields
  (`type` + `autocomplete`), OTP (`inputMode=numeric` + `one-time-code`), and phone
  (`type=tel`) inputs already carry correct mobile-keyboard semantics.
- **Files:** `app/globals.css`.
- **Test:** `tests/mobile-forms.test.ts` (6) — asserts the `!important` + coarse
  scope and the auth/OTP/phone keyboard attributes.
- **Evidence:** guard green (8 mobile tests total); `tsc`/`eslint` clean.

### M-003 — Horizontal-overflow sweep (Phase 4): swept, found already-compliant, ratcheted
- **Severity:** n/a (no defect found). **Phase:** 4 (responsive layout / no h-scroll).
- **Finding:** the dashboard is already well-built for horizontal overflow. Swept
  every module + dashboard route for the classic causes and found **zero real
  offenders**: all `<table>`s are inside `overflow-x-auto` wrappers (0 unwrapped);
  wide admin tables use `w-full min-w-[720px]` *inside* a scroll container (correct);
  card carousels (memories) use `w-[200px] shrink-0` inside `overflow-x-auto`
  (a correct swipeable pattern, not page overflow); other fixed widths are
  `max-w-[…]` (responsive) or `lg:`-prefixed (desktop-only).
- **Action:** deliberately did **not** add a global `overflow-x: hidden` — that
  masks real overflow and can break `position: sticky`. Instead added a regression
  ratchet locking the good state so a future change can't drop a raw page-widening
  table in.
- **Test:** `tests/mobile-no-horizontal-overflow.test.ts` (2) — asserts every
  module `<table>` sits in an `overflow-x-auto` container.
- **Evidence:** live grep → 0 unwrapped tables; guard green (10 mobile tests total).

### M-004 — Touch targets & accessible names (Phase 6): icon-only buttons swept
- **Severity:** Medium (a11y + touch). **Phase:** 6 (touch targets & interactions).
- **Finding:** app-wide scan of `<button>` elements for icon-only controls with no
  accessible name (beyond the A-05 photos/contacts set already fixed in PLA-0822).
  Most flags were false positives (visible text on an adjacent line). **Four real
  offenders** fixed:
  - `shopping-module` list **edit** (`<Pencil>`) — added `aria-label="Edit list"` +
    `focus-visible:opacity-100` (the hover-reveal control is now keyboard-reachable).
  - `inbox-module` **archive** (`<Archive>`) — added `aria-label="Archive"`, made it
    **visible on touch** (`flex sm:hidden sm:group-hover:flex` — hover-reveal was
    invisible on phones), and bumped the target from `h-7` (28px) to `h-9` (36px) on
    mobile.
  - `concierge-module` **back** (`<ArrowLeft>`) — added `aria-label="Back"`.
  - `feedback-board` **submit** (icon-only `<Send>`) — added `aria-label="Post
    feedback"` + `min-w-9 justify-center`.
- **Test:** `tests/mobile-touch-a11y.test.ts` (4). **14 mobile guard tests** total.
- **Evidence:** re-scan → the 4 targets no longer flag; `tsc` + `eslint` clean.
- **Noted for a follow-up increment:** the **hover-reveal pattern**
  (`opacity-0 group-hover:opacity-100` / `hidden group-hover:*`) appears on other
  list-row controls too — invisible on touch. A dedicated pass should make these
  touch-visible app-wide (inbox archive done here as the first).

### M-005 — Hover-reveal row actions invisible on touch (Phase 6)
- **Severity:** P1 (mobile). Row actions gated behind `opacity-0
  group-hover:opacity-100` never appear on a touch device (no hover), so
  edit/delete/archive/favorite/drag controls were unreachable on phones/tablets.
- **Fix:** transformed all 10 modules with the truly-hidden pattern (billing,
  briefing, care, files-hub, grocery, notes, photos, shopping, timetable, trips) to
  `opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100` —
  shown on touch, hover-reveal on mouse (`sm+`), keyboard-reachable. Left the
  `opacity-70/80 group-hover` hits (already visible on touch; they only brighten).
- **Test:** `tests/mobile-hover-reveal.test.ts` (3) — forbids a bare touch-invisible
  hover-reveal anywhere in `components/` + `app/`. **17 mobile guard tests** total.
- **Evidence:** app-wide grep → 0 bare hover-reveal remain; guard green; eslint 0.

### M-006 — Money inputs missing the mobile decimal keypad (Phase 7)
- **Severity:** P2 (mobile forms). `type="number"` on iOS Safari does not reliably
  show a decimal point, so entering cents in money fields was awkward.
- **Fix:** added `inputMode="decimal"` to all **29** `type="number"` inputs with a
  decimal step (`0.01`/`0.1`/`any`) or `0.00` placeholder across **19 modules**
  (finances, expenses, billing, insurance, health, marketplace, subscriptions, …).
  Additive only — no type/validation change. Integer count/year inputs left as-is
  (`type=number` already gives a numeric keypad).
- **Test:** `tests/mobile-numeric-inputmode.test.ts` (2). **19 mobile guard tests** total.
- **Evidence:** grep → 29/29 decimal inputs now have `inputMode`, 0 missing; tsc + eslint clean.

### M-007 — Overlay + shell mobile system: audited excellent, ratcheted (Phase 11/8)
- **Finding:** the shared `modal.tsx` is a world-class mobile **bottom sheet**
  (`items-end sm:items-center`, `rounded-t-3xl`, `max-h-[85dvh]`,
  `env(safe-area-inset-bottom)` action row, focus trap + restore, ESC, body
  scroll-lock, `aria-modal`). The app-shell reserves `<main pb-24 lg:pb-8>` for the
  fixed mobile bottom tab bar, which uses `safe-bottom`; FABs are safe-area-aware.
- **Action:** ratcheted these properties (guard) rather than change working code.
- **Flagged M-011 (needs browser verify):** the full-height chat panels
  (`messages`/`concierge`, `h-[calc(100dvh-topbar-1rem)]`) don't subtract the mobile
  bottom-nav height, so the composer may sit behind the tab bar on a phone. The fix
  is layout-nesting-dependent — deferred to real-viewport verification (M-009), not
  changed blind.
- **Test:** `tests/mobile-overlay-safe-area.test.ts` (6). **25 mobile guard tests** total.

### M-005b — Tablet gap in the M-005 fix (coarse-pointer escape) — _agent-02_
- **Severity:** P1 (tablet). The M-005 form `opacity-100 sm:opacity-0
  sm:group-hover:opacity-100` is correct on **phones** (base `opacity-100` shows
  below `sm`) but **re-hides on tablets**: an iPad is `≥ sm` width yet has no hover,
  so `sm:opacity-0` hides the control and `sm:group-hover:*` never fires — the
  largest touch form-factor loses edit/delete/favorite/drag.
- **Fix:** appended a width-independent coarse-pointer escape `coarse:opacity-100`
  to all 11 hits across the same 10 modules. New utility in `app/globals.css`
  (`@media (pointer: coarse) { .coarse\:opacity-100 { opacity: 1 !important } }`)
  forces the control visible on **any** touch device regardless of width, while
  desktop (fine pointer) keeps the clean hover-reveal untouched.
- **Test:** `tests/mobile-hover-reveal-tablet.test.ts` (2) — asserts the utility
  exists in a coarse-pointer block and that every `sm:opacity-0 sm:group-hover`
  hover-reveal carries the `coarse:opacity-100` escape. tsc + eslint clean.
- **Evidence:** grep → 11/11 modules carry the escape; both guards green.

### M-012 — Hand-rolled full-screen overlays didn't lock background scroll (Phase 11)
- **Severity:** P2 (mobile). **Phase:** 11 (overlays & drawers).
- **Problem:** the shared `Modal` primitive locks background scroll while open
  (`document.body.style.overflow = 'hidden'`), but several full-screen overlays are
  hand-rolled and bypass `Modal`. On mobile Safari / Android Chrome an overlay that
  doesn't lock the body lets the page behind it keep scrolling ("scroll bleed") —
  touch-scrolling the overlay bubbles to the underlying page, which can be dragged
  out from under a camera viewfinder, command palette, paywall, or app-lock gate.
- **Fix:** added a shared `useLockBodyScroll(active)` hook
  (`lib/hooks/use-lock-body-scroll.ts`) that mirrors the `Modal` behavior (captures
  the previous `overflow`, restores it on cleanup, client-only so SSR is untouched),
  and wired it into the six genuinely-blocking full-screen overlays: camera capture,
  the ⌘K command bar, the exit-intent offer, the trial paywall gate, the app-lock
  (PIN) gate, and the account-closed gate. Deliberately **left the cookie-consent
  banner alone** — it's a dismissible bottom bar that should not lock page scroll.
- **Files:** `lib/hooks/use-lock-body-scroll.ts` (new),
  `components/ui/camera-capture.tsx`, `components/app/command-bar.tsx`,
  `components/marketing/exit-intent.tsx`, `components/app/trial-paywall-gate.tsx`,
  `components/app/app-lock-gate.tsx`, `components/app/account-closed-gate.tsx`.
- **Test:** `tests/mobile-overlay-scroll-lock.test.ts` (7) — locks the hook contract
  + each overlay onto it.
- **Evidence:** guard green; `tsc --noEmit` 0; eslint 0 on changed files;
  `next build` exit 0.
- **Parallel note:** complements agent-05's M-007 (which audited overlay
  **safe-area / focus-trap** and found `Modal` excellent): the six hand-rolled
  overlays that bypass `Modal` still lacked the **background scroll-lock** `Modal`
  bakes in, and M-012 closes that gap. File-disjoint from M-005/M-006/M-007 so it
  ran concurrently without collision. (Renumbered from a transient M-011 to avoid
  clashing with agent-05's M-011 chat-panel item.)

### M-009 — Playwright mobile device matrix (Phase 2/23): stood up + browser-fixed
- **Delivered:** `playwright.config.ts` gains 4 emulated mobile projects —
  `iphone-se` (iPhone SE), `iphone` (iPhone 14 Pro), `pixel` (Pixel 7), `ipad`
  (iPad gen 7) — each running the viewport-relevant specs. New
  `tests/e2e/mobile.spec.ts` asserts per-device: viewport-meta `viewport-fit=cover`,
  no horizontal overflow, and **no focusable input < 16px** (runtime iOS-zoom guard,
  reading computed `font-size`). `--list` → **225 tests / 5 projects**.
- **Real finding (sandbox):** the iPhone/iPad device descriptors default to
  **WebKit**, which isn't installed here (Chromium-only, and `playwright install` is
  disallowed) — the first run failed to launch WebKit. Fixed by pinning
  `browserName: 'chromium'` on those projects (real mobile viewport/DPR/UA/touch,
  Chromium engine) so the matrix runs in this sandbox **and** CI; a `PW_WEBKIT=1`
  env switch restores native-engine runs where WebKit is available.
- **Honest status:** config + spec **enumerate + type-check + lint clean**; a full
  green *execution* is a CI concern — the sandbox's build+`next start` cycle was
  flaky here (server-start aborts), so the run itself is deferred to CI (see M-009 remaining in TODO).
  This is emulated coverage, explicitly **not** physical-device (see
  `PHYSICAL_DEVICE_TEST_PLAN` — to be authored).
- **Evidence:** `--list` shows all 4 mobile projects × mobile/overflow/public specs;
  eslint 0 on config + spec.

## Next steps (autonomous, in order)
The prioritized backlog lives in **`docs/MOBILE_TODO.md`**. Top of queue now:
**M-006** (field-level mobile keyboard: `inputMode` on numeric/currency/search),
then M-007 (overlays/safe-area), M-009 (Playwright matrix), M-010 (PWA/offline).

---

## 🤝 Handoff — how another Claude bot resumes this

**Read first:** this file (status), `docs/MOBILE_TODO.md` (backlog + exact
targets), `docs/MOBILE_AUDIT.md` (route inventory). Then take the top OPEN item in
MOBILE_TODO.

**Branch:** `main` — fleet-shared, multiple bots push here. **Always**
`git pull --rebase origin main` before pushing; expect non-fast-forward and retry.

**Working agreement (one increment = one commit):**
1. Find a real, concrete mobile defect (grep/read — verify it's a true offender,
   not a false positive; many `group-hover`/`w-[…]`/`text-sm` hits are fine in
   context — check for `sm:`/`lg:` prefixes, `max-w`, scroll wrappers, adjacent
   visible text).
2. Fix it for real — never mask (no global `overflow-x:hidden`), never hide
   functionality on mobile, never weaken RLS/auth/validation.
3. Add a **guard test** (`tests/mobile-*.test.ts`, static `fs.readFileSync` +
   assertions — matches the existing four) that locks the fix and forbids
   regression.
4. Verify: `npx vitest run tests/mobile-*.test.ts` → green; `npx tsc --noEmit` → 0
   (takes ~2–4 min, not hung); `npx eslint <changed files>` → 0 errors; run
   `npm run build` for layout/CSS/route changes.
5. Update this file: add an `M-###` entry + bump the % from **verified** work only.
6. Commit `fix(mobile): … [M-###]` (or `test(mobile): …`), rebase, push to `main`.

**Verification notes:** mobile work needs no PG16/DB harness (that's for blog/seed
migrations). The full vitest suite (~3700+) should stay green. Last full
`next build` on the mobile work: exit 0.

**Conventions that matter:** touch target ≥ ~44px where practical; icon-only
controls need `aria-label`; use `dvh`/`svh` not `100vh` for full-height; inputs
≥16px on touch (already global via `app/globals.css`); hover-reveal must have a
touch/focus escape hatch.

**Blocked / external** (enumerate in `PHYSICAL_DEVICE_TEST_PLAN.md` when reached):
physical-device tests, App Store / Play Console, live push credentials. Nothing is
marked done without shipped code + a passing check.
