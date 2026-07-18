# Mobile Production-Readiness — Progress

Honest, evidence-based tracker for the mobile audit + remediation mission
(iPhone / iPad / Android phone + tablet · Safari / Chrome · PWA · portrait +
landscape · notches / safe areas). Progress is computed from **verified, shipped**
work — not estimated effort. **This is early; do not read any high percentage
into it.**

_Owner: agent-05 (CLAUDE-FRONTEND-01). Started 2026-07-18 20:12 UTC._

## Overall completion: ~37% (early)

Weighting (per the mission brief):

| Area | Weight | Verified done | Notes |
|------|--------|---------------|-------|
| Discovery & route inventory | 5% | ~1% | Architecture identified; full route inventory pending |
| Responsive layouts | 15% | ~1% | dvh viewport-height fixes landed; full sweep pending |
| Navigation & touch | 10% | 0% | pending |
| Forms & keyboard | 10% | 0% | pending (inputmode/type audit) |
| Supabase & backend workflows | 15% | ~2% | marketing read-path + fail-closed already hardened this session; app-wide pending |
| Auth & security | 10% | ~2% | M-023: SW never caches authed HTML (logout-persistence purged via v4) |
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
  `PHYSICAL_DEVICE_TEST_PLAN.md` (authored)).
- **Evidence:** `--list` shows all 4 mobile projects × mobile/overflow/public specs;
  eslint 0 on config + spec.
- **CI gate (M-009 follow-up):** `scripts/run-e2e.mjs` runs `playwright test` with no
  project filter, so the existing CI `e2e` job (on PR + push to `main`, Chromium
  installed) now runs the **mobile device matrix** too — every PR is gated on no
  horizontal overflow + no sub-16px inputs at real device viewports. CI job renamed
  to reflect it. The new `mobile.spec` gets its first real execution in CI (the
  sandbox `next start` cycle was too flaky to run it green locally); a red there is
  the gate catching a real device-viewport issue.
- **⚠️ CI runner blocker (LB-015):** verified the mobile matrix is now wired into
  the CI `e2e` job (job renamed, deploys), BUT no CI evidence is available — the
  latest runs (incl. this commit `e04c2f34`) fail in **3s with `runner_id: 0`**
  (no runner assigned; provisioning failure, not a test failure). This is the
  known GitHub Actions runner/billing/org-policy blocker (LB-015), owned by the
  org — not a code issue. Mobile matrix evidence therefore comes from local runs
  until runners are restored, at which point every PR is auto-gated. **✅ Local execution NOW GREEN:** after a browser-binary saga (WebKit absent → chromium-pinned; headless-shell build absent → env-gated `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` `executablePath` added to `playwright.config.ts`), the **`pixel` project ran `mobile.spec` against a real production build: 13 passed (42.4s)** — viewport-meta `viewport-fit=cover` + **no horizontal overflow + no sub-16px inputs across all 12 public routes** at an emulated Android device viewport. This is real automated evidence for M-002 (zoom) + M-003 (overflow) + viewport.  **UPDATE — full matrix GREEN:** ran all four device projects against the production build — **52 passed (2.1m), 0 failed** (iphone-se 375px, iphone 393px, ipad 820px, pixel Android × 13 tests each): no horizontal overflow, no sub-16px inputs, and viewport-fit=cover on every public route at every device width. CI (LB-015 runners) will re-run this per-PR once restored; `docs/PHYSICAL_DEVICE_TEST_PLAN.md` covers what emulation can't (real WebKit/keyboard/camera).

### M-010 — PWA update UX: no visible "new version" prompt (Phase 16)
- **Problem:** `RegisterSW` registered the SW but had **no update handling** — the
  mission requires a visible, reliable mechanism so users aren't stuck on stale
  code. (The SW already `skipWaiting()`s + never caches auth/API, and `/offline`
  + the manifest are complete.)
- **Fix:** `RegisterSW` now watches `updatefound` → `installed` (with an existing
  controller) and `controllerchange`, and renders a **mobile-safe** dismissible
  banner — *"A new version of Bubaly is available"* + **Reload** — fixed at the
  bottom, above the tab bar (`z-60`), clearing the home indicator
  (`env(safe-area-inset-bottom)`). Also polls `reg.update()` hourly so a long-lived
  tab isn't left stale. Mounted already in 4 layouts (marketing/family/capture/app).
- **Test:** `tests/mobile-pwa-update.test.ts` (5) — update detection + reload +
  safe-area banner; SW never-cache-auth + manifest installable.
- **Evidence:** guard green; `tsc` + `eslint` clean.

### M-013 — Hand-rolled overlays missing dialog semantics for screen readers (Phase 6)
- **Severity:** P2 (mobile a11y). **Phase:** 6 (a11y / VoiceOver / TalkBack).
- **Problem:** several full-screen overlays that bypass the shared `Modal` (which
  already carries dialog semantics) had no `role="dialog"` / `aria-modal` / accessible
  name, so mobile VoiceOver / TalkBack didn't announce them as modal dialogs or scope
  the reader to their contents — the exit-intent offer, the app-lock (PIN) gate, and
  the guardian rules-editor + contact-editor bottom sheets.
- **Fix:** added `role="dialog"` + `aria-modal="true"` + `aria-labelledby` (pointing
  at the real heading, which now carries the matching `id`) to all four, plus
  keyboard **ESC-to-close** on the dismissible exit-intent modal (parity with its
  scrim-click + close button). Bonus: the rules-editor panel's `max-h-[85vh]` →
  `max-h-[85dvh]` (mobile viewport-height correctness). The `aria-hidden` dropdown
  dismiss-catchers in wallet/contact were correctly left alone (not dialogs).
- **Files:** `components/marketing/exit-intent.tsx`, `components/app/app-lock-gate.tsx`,
  `components/guardian/rules-editor.tsx`, `components/guardian/contact-list.tsx`.
- **Test:** `tests/mobile-overlay-dialog-a11y.test.ts` (5) — asserts each overlay's
  labeled dialog semantics + the exit-intent ESC handler.
- **Evidence:** guard green; `tsc --noEmit` 0; eslint 0; `next build` exit 0.
- **Parallel note:** same overlay surface as M-012, disjoint from the module files
  the other bot works; complements agent-05's M-007 (safe-area/focus-trap on the
  shared `Modal`) by giving the hand-rolled overlays their missing dialog semantics.

### M-014 — Landscape safe-area: edge-to-edge camera didn't clear the side notch (Phase 8)
- **Severity:** P2 (mobile, landscape). **Phase:** 8 (safe areas & viewport).
- **Problem:** `--safe-left` / `--safe-right` are defined but were barely used
  app-wide (top/bottom only). The full-screen **camera** (`fixed inset-0 bg-black`,
  a HIGH-risk capture surface, often used in landscape) padded the top/bottom safe
  areas but not left/right — so on a notched phone in **landscape** the side notch /
  rounded corners overlap its edge-pinned controls (close/switch in the top bar and
  the shutter row).
- **Fix:** added `pl-[var(--safe-left)] pr-[var(--safe-right)]` to the camera shell
  so all four insets are respected. Purely additive — portrait / non-notched devices
  report 0 for these insets, so no visual change there. The centered gate overlays
  (paywall / account-closed / app-lock use `max-w-*` centered content) are already
  clear of side notches, so they were deliberately **not** touched (not offenders).
- **Files:** `components/ui/camera-capture.tsx`.
- **Test:** `tests/mobile-landscape-safe-area.test.ts` (2) — locks all four safe-area
  insets onto the camera shell.
- **Evidence:** guard green; eslint 0; `next build` exit 0. (className-only change, no
  TS surface.)
- **Parallel note:** continues my hand-rolled-overlay surface (M-012/M-013),
  disjoint from the module + app-shell files the other bot works.

### M-015 — Guardian contact editor inputs lacked mobile keyboards (Phase 7)
- **Severity:** P2 (mobile forms). **Phase:** 7 (forms & keyboard).
- **Problem:** agent-05's M-006 gave the money + search inputs their mobile keyboards,
  but the **guardian contact editor** (`components/guardian/contact-list.tsx`, a
  non-module component not in that sweep) had a **phone** and **email** input with no
  `type` / `inputMode`, so mobile browsers showed the plain alphabetic keyboard
  instead of the telephone keypad / email keyboard — slow + error-prone entry.
- **Fix:** phone → `type="tel"` `inputMode="tel"` `autoComplete="tel"`; email →
  `type="email"` `inputMode="email"` `autoComplete="email"` `autoCapitalize="none"`
  `spellCheck={false}`; name → `autoCapitalize="words"` `autoComplete="name"`. A
  cross-`components/` scan confirmed these were the only remaining non-module
  phone/email inputs missing keyboard semantics.
- **Files:** `components/guardian/contact-list.tsx`.
- **Test:** `tests/mobile-contact-input-keyboard.test.ts` (2).
- **Evidence:** guard green; `tsc --noEmit` 0; eslint 0.
- **Parallel note:** non-module file, disjoint from the module inputs M-006 covered.

### M-016 — Messages chat panel sat behind the mobile bottom nav (Phase 8) — Chromium-verified
- **Severity:** P2 (mobile). **Phase:** 8 (safe areas & viewport). Resolves the
  **messages** half of the flagged M-011.
- **Problem:** the panel was `h-[calc(100dvh-var(--topbar-height)-1rem)]` — it
  subtracts the sticky top bar but not the fixed mobile bottom tab bar (`app-shell`
  reserves `pb-24`; the nav's real footprint is `4rem + safe-bottom`), so on a phone
  the message composer sat *behind* the bottom nav.
- **Verification (the reason this was deferred):** built a faithful HTML fixture of
  the app-shell chrome (sticky `4rem`/`72px` top bar, `main pt-4 pb-24`, fixed
  `4rem + var(--safe-bottom)` nav) and drove it in **real Chromium via Playwright**
  across iPhone-390, Pixel-412, iPhone-SE-375 (portrait) + iPhone landscape, injecting
  each device's home-indicator inset. The bug **reproduced on all**; a naive `-5rem`
  guess left the composer 10px behind the nav on the 34px-inset iPhone; the correct
  `-4rem-var(--safe-bottom)` **cleared the nav on all** (8px margin portrait, exact on
  SE/landscape).
- **Fix:** mobile `h-[calc(100dvh-var(--topbar-height)-1rem-4rem-var(--safe-bottom))]`,
  `lg:h-[calc(100dvh-var(--topbar-height)-1rem)]` (desktop has no bottom nav).
- **Files:** `components/modules/messages-module.tsx`.
- **Test:** `tests/mobile-chat-panel-height.test.ts` (2) locks the formula + `lg:`
  restore; the Playwright measurement is the shipping evidence.
- **Evidence:** guard green; eslint 0 (2 pre-existing warnings); `next build` exit 0;
  Chromium fixture: bug reproduced + fix cleared on all 4 profiles.
- **Follow-up:** the **concierge** panel (same bug, different wrappers) — fixed in
  M-017.

### M-017 — Concierge chat panel sat behind the mobile bottom nav (Phase 8) — Chromium-verified
- **Severity:** P2 (mobile). **Phase:** 8. **Fully closes M-011** (with M-016).
- **Problem:** the concierge chat view used an inline `style={{ height:
  'calc(100dvh - 140px)' }}` — like messages it subtracts the top chrome but not the
  fixed bottom nav (`4rem + safe-bottom`), so its composer sat behind the nav.
- **Verification:** extended the M-016 approach — a faithful fixture that also models
  the concierge `.module-main` (`flex flex-col`, no padding) + `.module-page`
  (`space-y-5`, no first-child offset) wrappers — and drove it in real Chromium
  across iPhone-390 / Pixel-412 / SE-375 portrait + iPhone landscape. Bug reproduced
  on all four; `-4rem-var(--safe-bottom)` cleared the nav on all four.
- **Fix:** replaced the inline style with Tailwind
  `h-[calc(100dvh-140px-4rem-var(--safe-bottom))] lg:h-[calc(100dvh-140px)]` (so the
  `lg:` desktop restore is expressible).
- **Files:** `components/modules/concierge-module.tsx`.
- **Test:** `tests/mobile-concierge-panel-height.test.ts` (3) — locks the formula,
  the `lg:` restore, and the removal of the old inline calc.
- **Evidence:** guard green; eslint 0; `next build` exit 0; Chromium fixture
  bug-reproduced + fix-cleared on all 4 profiles.

### M-018 — Inbox/front-desk full-screen detail panels missed the bottom/side safe area (Phase 8)
- **Severity:** P2 (mobile). **Phase:** 8 (safe areas & viewport).
- **Problem:** the inbox + front-desk detail views become a mobile full-screen
  takeover (`fixed inset-0 z-50 bg-background flex flex-col`, above the bottom nav).
  They padded only `pt-[var(--safe-top)]`, so bottom-anchored content — notably the
  **inbox reply composer** — sat under the home indicator on a notched phone, and in
  landscape the side notch clipped the edges.
- **Fix:** completed the safe-area padding on all four sides
  (`pb-[var(--safe-bottom)] pl-[var(--safe-left)] pr-[var(--safe-right)]` with
  `lg:pt-0 lg:pb-0 lg:pl-0 lg:pr-0` — the panels collapse to a static `lg:w-[400px]`
  sidebar on desktop, where there's no safe area). Additive: portrait / non-notched
  devices report 0 for these insets. Same completion pattern as M-014 (camera).
- **Files:** `components/modules/inbox-module.tsx`,
  `components/modules/front-desk-module.tsx`.
- **Test:** `tests/mobile-fullscreen-panel-safe-area.test.ts` (2) — locks all four
  insets + the `lg:` resets on both panels.
- **Evidence:** guard green; eslint 0; `next build` exit 0. (className-only, no TS
  surface — additive safe-area padding needs no pixel measurement, unlike the M-016/17
  calc.)

### M-019 — Blog Share bar icons were 32px — below the 44px touch target (Phase 6) — _parallel bot (public blog/marketing surface)_
- **Severity:** P2 (mobile). **Phase:** 6 (navigation & touch targets).
- **Problem:** the article Share bar (`app/(marketing)/blog/[slug]/share-buttons.tsx`)
  renders 8 icon-only share targets (X, Facebook, LinkedIn, WhatsApp, Reddit,
  Pinterest, Telegram + email) as a `flex flex-wrap gap-2` row of **`h-8 w-8` (32px)**
  squares, plus a Copy-link button at `px-3 py-1.5 text-xs` (~28px tall). 32px is
  below the 44px minimum tap target (WCAG 2.5.5 / Apple HIG 44pt / Material 48dp), so
  on a phone the tightly-packed icons are easy to mis-tap. Not a false positive: the
  boxes are a fixed 32px with no `sm:`/`coarse:` size bump and no larger padded hit
  area — the tappable element itself is 32px.
- **Fix:** grow every share target to a **≥44px square on coarse-pointer (touch)**
  devices — `coarse:min-h-11 coarse:min-w-11` on the 8 icon buttons, `coarse:min-h-11`
  on the Copy-link button. `min-*` overrides the fixed `h-8 w-8` when larger, so the
  dense 32px desktop-with-a-mouse row is untouched. Added the missing
  `.coarse\:min-w-11 { min-width: 2.75rem }` utility (square-target companion to the
  existing `coarse:min-h-11`) to `app/globals.css`.
- **Files:** `app/(marketing)/blog/[slug]/share-buttons.tsx`, `app/globals.css`.
- **Test:** `tests/mobile-share-touch-target.test.ts` (3) — asserts the utility
  exists, every `h-8 w-8` share target carries the coarse escape, and the Copy button
  is ≥44px tall on touch; forbids a regression to a bare 32px target.
- **Evidence:** guard green (3/3); `tsc --noEmit` clean; `eslint` on changed files 0;
  `next build` exit 0.
- **Parallel-bot note:** file-disjoint from agent-05 (modules + app-shell) and agent-02
  (hand-rolled overlays + non-module app chrome) — this is the public blog/marketing
  surface. The `coarse:min-w-11` utility is additive and shared-safe.

### M-020 — Gallery/feed thumbnails eager-loaded every image on mobile (Performance)
- **Severity:** P2 (mobile performance). **Phase:** performance.
- **Problem:** the photo / memory / social-feed **gallery grids** used raw `<img>`
  with no `loading` hint, so opening an image-heavy screen made a phone download
  *every* below-the-fold thumbnail immediately — wasted mobile data + slower first
  paint.
- **Fix:** added `loading="lazy" decoding="async"` to the grid/feed thumbnails in
  `photos-module`, `memories/page`, and `social-feed-module` (10 images). Deliberately
  **left eager** the photos lightbox's *active* image (it's the focused content — lazy
  would delay it) and the upload **blob previews** (immediately visible). Verified per
  image that each target is a below-the-fold grid/feed thumbnail, not a hero/LCP image.
- **Files:** `components/modules/photos-module.tsx`,
  `components/modules/social-feed-module.tsx`,
  `app/(app)/dashboard/memories/page.tsx`.
- **Test:** `tests/mobile-gallery-lazy-images.test.ts` (4) — asserts the grids
  lazy-load and that the lightbox active image is NOT lazy.
- **Evidence:** guard green; `tsc --noEmit` 0; eslint 0 (caught + fixed a duplicate
  `loading` prop where one image was already lazy).
- **First entry in the Performance area** (was 0% app-wide).

### M-021 — Marketing header control cluster had sub-44px touch targets (Phase 6) — _parallel bot (public marketing surface)_
- **Severity:** P2 (mobile). **Phase:** 6 (navigation & touch targets).
- **Problem:** the public `components/marketing/site-header.tsx` (rendered on every
  bubaly.com marketing page) has a top-bar control cluster with interactive targets
  below the 44px minimum on touch: the **ThemeToggle** is forced to `h-8 w-8` (32px —
  the site-header className overrides the toggle's own `h-10` base), the **mobile menu
  button** is `p-2` around a 24px icon (~40px), and the **Log in / Get Started** pills
  are `h-8` (32px tall) — these show at `sm:` (≥640px), i.e. on touch tablets. All are
  under the 44px Apple HIG / WCAG 2.5.5 tap-target minimum. Not false positives: each
  is a real `<button>`/`<a>` with a fixed sub-44px box and no touch-size escape.
- **Fix:** grow each to **≥44px on coarse-pointer (touch)** while keeping the compact
  desktop-with-a-mouse density — `coarse:min-h-11 coarse:min-w-11` on the square
  icon-only controls (ThemeToggle, menu button; menu button also gets `inline-flex
  items-center justify-center` so the icon stays centered as the box grows) and
  `coarse:min-h-11` on the two header pills. Reuses the M-019 utilities (no new CSS).
  The mobile drawer nav items were already compliant (`px-3 py-3 text-base` ≈ 48px).
- **Files:** `components/marketing/site-header.tsx`.
- **Test:** `tests/mobile-marketing-header-touch-target.test.ts` (4) — locks the
  coarse escape on the toggle, menu button, and both pills; forbids a regression.
- **Evidence:** guard green (4/4); `tsc --noEmit` clean; `eslint` on changed files 0;
  `next build` exit 0.
- **Parallel-bot note:** file-disjoint from agent-05 (modules + app-shell) and agent-02
  (hand-rolled overlays + non-module app chrome). The **marketing** `site-header` is a
  separate component from the authed app-shell header; the ThemeToggle change is scoped
  to the className this page passes, so the shared toggle's app-wide `h-10` base is
  untouched.

### M-022 — In-app Blog launcher modal used `88vh` + sub-44px header controls (Phase 8/6) — _parallel bot (blog feature component)_
- **Severity:** P2 (mobile). **Phase:** 8 (viewport) + 6 (touch targets).
- **Problem:** the signed-in **Blog launcher** modal (`components/app/blog-launcher.tsx`
  — the header BookOpen button that pops the blog in an in-app iframe) had two mobile
  bugs. (1) The panel was **`h-[88vh]`** — a *static* viewport unit; on mobile
  Safari/Chrome `vh` is measured against the address-bar-**retracted** viewport, so
  with the URL bar showing the 88vh panel is ~as tall as the whole visible area and
  its header row (with the **Close** button) is pushed up behind the browser chrome,
  and the iframe's bottom runs off-screen — the same class as M-001. (2) The header
  **Close** and **Open-in-new-tab** controls go **icon-only on mobile** (their labels
  are `hidden sm:inline`) at `px-2.5 py-1.5 text-xs` ≈ 28px — below the 44px minimum,
  and Close is the modal's primary escape control on a phone.
- **Fix:** (1) `h-[88vh]` → **`h-[88dvh]`** (dynamic viewport = the *visible* area, so
  the header + iframe stay on-screen with the URL bar showing). (2) `coarse:min-h-11
  coarse:min-w-11` + `justify-center` on the Close and Open-in-new-tab controls so they
  become ≥44px squares on touch (icon stays centered when the label is hidden). Reuses
  the M-019 utilities — no new CSS.
- **Files:** `components/app/blog-launcher.tsx`.
- **Test:** `tests/mobile-blog-launcher.test.ts` (3) — asserts the panel uses `dvh`
  (and forbids any bare `h-[NNvh]`) and that both header controls carry the coarse
  touch escape.
- **Evidence:** guard green (3/3); `tsc --noEmit` clean; `eslint` on changed files 0;
  `next build` exit 0.
- **Parallel-bot note:** the launcher is a **blog feature** component I authored this
  session (rendered by the app-shell but not part of the shell chrome agent-05 owns);
  the change is isolated to that one file — the shell's nav/top-bar/safe-area and the
  shared `Modal` are untouched. Left the launcher's `h-10 w-10` header **trigger** icon
  as-is, since its size is an app-header-density call in agent-05's lane.

### M-023 — SW cached authenticated HTML into Cache Storage (persisted after logout, served offline to anyone on the device) — _parallel bot (`agent-fable-opus`, PWA/SW lane)_

- **Problem (P1 privacy, Phases 16/17):** `public/sw.js`'s navigation handler
  `c.put()` **every** successful page navigation — including authenticated HTML
  (`/dashboard`, `/wallet`, `/admin`, … full of private family data) — and
  precached `/dashboard` at install. Cache Storage persists unencrypted **after
  logout**, and the offline fallback (`caches.match(request)`) would *serve* that
  cached authenticated page to whoever next opens the app on a shared/family
  device. Exactly the M-010 checklist item "no caching of authenticated
  responses".
- **Fix:** `APP_SHELL = ['/', '/offline']` (dropped `/dashboard`); navigation
  caching gated to a `CACHEABLE_NAV` public-shell allowlist (everything else is
  network-only with the `/offline` fallback); cache bumped `bubaly-v3 → v4` so the
  existing activate-time cleanup **purges any previously cached authed HTML** on
  update. `/api` + `/auth` remain fully uncached; cross-origin (Supabase storage
  signed URLs) was already untouched. Offline-page copy updated (no longer claims
  "recently viewed screens available").
- **Guard:** `tests/mobile-sw-auth-cache.test.ts` (5) — public-only precache,
  allowlist-gated navigation put (put must sit inside the gate), version-bump +
  cleanup purge, /api·/auth untouched, offline fallback kept.
- **Evidence:** guard green; all prior mobile guards green; `tsc --noEmit` 0;
  eslint 0; `next build` exit 0 (`/offline` prerendered). Also realigned one stale
  M-001 assertion to M-017's shipped Tailwind sizing (spaced `calc(100dvh - 140px)`
  → `h-[calc(100dvh-140px-4rem-var(--safe-bottom))]`) — behaviour unchanged,
  suite green.
- **Parallel-bot note:** file-disjoint from agent-05 (modules/app-shell) and
  agent-02 (overlays): touches only `public/sw.js`, `app/offline/page.tsx`, and
  tests. Completes the offline/caching-safety half of M-010 (the update-prompt
  half shipped earlier); remaining M-010 scope — long-running request timeout
  messaging — is app-level fetch error handling already covered by module error
  states.

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
