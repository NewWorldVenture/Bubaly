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

Guard tests: `tests/mobile-viewport-height.test.ts`, `tests/mobile-forms.test.ts`,
`tests/mobile-no-horizontal-overflow.test.ts`, `tests/mobile-touch-a11y.test.ts`
(14 assertions total).

---

## 🔜 OPEN — do these next (priority order)

### M-005 (P1) — Hover-reveal controls are invisible/unreachable on touch
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

### M-006 (P2) — Field-level mobile keyboard audit (Phase 7)
The global 16px zoom-guard (M-002) and auth/OTP/phone inputs are done. Remaining:
sweep numeric/currency/search/url inputs for `inputMode` + `type` + `autocomplete`.
- Currency/amount inputs → `inputMode="decimal"`; quantity/count → `inputMode="numeric"`.
- Search inputs → `type="search"` `inputMode="search"`.
- Verify `enterKeyHint` on multi-field forms where useful.
- Start: `grep -rn "type=\"number\"\|placeholder=\".*\\$\|amount\|quantity" components/modules`.

### M-007 (P2) — Overlay/drawer safe-area + keyboard behavior (Phase 11)
`components/ui/modal.tsx` already uses safe-area insets. Verify each modal/drawer:
fits `dvh`, scrolls internally, close reachable, background scroll locked, focus
trapped + restored. Convert oversized desktop popovers to bottom sheets where they
overflow a phone.

### M-008 (P2) — Tablet layouts don't waste space (Phase 9)
iPad portrait/landscape: check dashboard grids + `lg:grid-cols-[1fr_340px]` sidebars
render well; avoid narrow centered phone columns on tablets. Mostly a review pass.

### M-009 (P1 infra) — Playwright mobile-viewport E2E matrix (Phase 2/23)
Stand up device profiles (iPhone SE 320, iPhone 390, Pixel 412, iPad 768/1024) ×
portrait/landscape × light/dark, driving the critical journeys (auth, onboarding,
create/edit record, upload, nav). This unlocks evidence for Phases 3/13/17/19.
Check `playwright.config.*` for existing setup before adding.

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
