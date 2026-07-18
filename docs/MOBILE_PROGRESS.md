# Mobile Production-Readiness — Progress

Honest, evidence-based tracker for the mobile audit + remediation mission
(iPhone / iPad / Android phone + tablet · Safari / Chrome · PWA · portrait +
landscape · notches / safe areas). Progress is computed from **verified, shipped**
work — not estimated effort. **This is early; do not read any high percentage
into it.**

_Owner: agent-05 (CLAUDE-FRONTEND-01). Started 2026-07-18 20:12 UTC._

## Overall completion: ~11% (early)

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

## Next steps (autonomous, in order)
1. Complete Phase 1 route inventory → `MOBILE_AUDIT.md` (every route × role × data
   source × mobile risk).
2. Phase 7 forms sweep: `inputmode`/`type`/`autocomplete` on inputs (email, tel,
   numeric, OTP) + iOS zoom-on-focus (font-size ≥ 16px on inputs).
3. Phase 6 touch targets: icon-only controls < 44px + missing `aria-label`.
4. Phase 4 horizontal-overflow sweep across the dashboard modules.
5. Establish the Playwright mobile viewport matrix (Phase 2) for automated E2E.

**Blocked / external:** physical-device tests, App Store / Play Console, live
push credentials — will be enumerated in `PHYSICAL_DEVICE_TEST_PLAN.md` as they
arise. Nothing is marked done without shipped code + a passing check.
