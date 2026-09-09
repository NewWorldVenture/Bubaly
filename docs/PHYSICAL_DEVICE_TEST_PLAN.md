# Physical-Device Test Plan — Mobile Launch

Manual test scripts for the checks that **emulation and CI cannot prove** — real
iOS/iPadOS Safari + Android Chrome behavior, the software keyboard, safe areas,
camera/photo pickers, PWA install, push, and biometrics. Pairs with
`MOBILE_PROGRESS.md` (what shipped) and `MOBILE_AUDIT.md` (route inventory).

**Why this exists:** the automated mobile matrix (`tests/e2e/mobile.spec.ts`, 8
Chromium-emulated device projects incl. landscape + dark-mode variants, M-036)
covers layout invariants (no horizontal overflow, no sub-16px inputs) but runs
Chromium, not WebKit, and cannot exercise a real keyboard/notch/camera. CI is additionally blocked (LB-015: runners not
provisioning), so until that clears, these scripts are the primary device evidence.

**How to use:** run each script on each listed device, in the app served from
production (or a preview build). Record Pass/Fail + capture the noted evidence
(screenshot/screen-recording). Do **not** mark a device-only item done elsewhere
without evidence here.

## Device set (minimum)
| # | Device | Why |
|---|--------|-----|
| D1 | Recent iPhone (Dynamic Island, iOS Safari) | notch/DI safe areas, home indicator, real WebKit |
| D2 | Older supported iPhone (e.g. SE — Touch ID, small 320–375pt) | smallest layout, no notch, home button |
| D3 | iPad (Safari, portrait + landscape, Split View) | tablet layout, external keyboard, ≥sm hover-reveal |
| D4 | Android phone (Chrome) | Android keyboard, back gesture, install banner |
| D5 | Android tablet (Chrome) | large Android layout |
| D6 | Low-memory / slow device | perf, long lists, scroll smoothness |

Legend: **P**/**F**/**N/A**. Evidence = what to capture.

---

## S1 — Viewport height & full-screen panels (verifies M-001, dvh)
**Devices:** D1, D2, D4. **Precondition:** signed in.
1. Open **Messages** (`/dashboard/messages`) and select a thread.
   - Expect: the message **composer input is fully visible** above the browser
     chrome; nothing is cut off at the bottom. Evidence: screenshot with composer.
2. Tap the composer — the software keyboard opens.
   - Expect: the composer rises with the keyboard; the input is not hidden behind
     it; you can see what you type. Evidence: screen-recording of focus.
3. Repeat on **Concierge** (`/dashboard/concierge`).
4. Scroll the message list up/down; the composer stays put.
- **Known-risk (M-011, UNVERIFIED):** confirm the composer is **not hidden behind
  the bottom tab bar** on a phone. If it is, that's the M-011 defect — record it.

## S2 — iOS zoom-on-focus (verifies M-002)
**Devices:** D1, D2, D3. **Precondition:** none.
1. Go to `/login`. Tap the **Email** field.
   - Expect: the page does **not** zoom in / shift right when the field focuses.
2. Repeat for **Password**, then a dashboard search box, then a money field
   (e.g. `/dashboard/expenses` amount) and an AEO/SEO admin input.
   - Expect: no zoom on any input focus. Evidence: screen-recording of taps.

## S3 — Touch targets & hover-reveal (verifies M-004, M-005, M-005b)
**Devices:** D2 (phone), D3 (iPad).
1. On **Shopping**/**Grocery**/**Notes**/**Photos** list rows, confirm the row
   actions (edit / delete / archive / favorite) are **visible and tappable
   without hovering** — on both the phone **and the iPad** (D3 is the M-005b case).
2. Tap each icon-only control; confirm it activates and the target feels ≥44px.
   Evidence: screenshot showing visible row actions on D3.

## S4 — Mobile keyboards (verifies M-002, M-006)
**Devices:** D1, D4.
1. Money field (`step=0.01`, e.g. add an expense): keyboard shows a **decimal
   point**. 2. OTP field (phone login): numeric keypad + OS offers the SMS code.
3. Phone field: telephone keypad. 4. A search box: keyboard shows a **Search**
   action key. 5. Email/password: correct keyboards + password-manager autofill.
   Evidence: screenshots of each keyboard.

## S5 — Safe areas & notch/home indicator (verifies M-001, shell, M-012)
**Devices:** D1 (Dynamic Island), D2 (home button).
1. On the dashboard, confirm the **top bar** clears the notch/Dynamic Island and
   the **bottom tab bar** clears the home indicator (no content under either).
2. Open a **modal** (any "Add" button) — it's a bottom sheet; its action row sits
   **above the home indicator**; background does not scroll behind it (M-012).
3. Rotate to **landscape** — end tabs/controls clear the notch. Evidence:
   screenshots portrait + landscape.

## S6 — Camera, photo library & uploads (Phase 12)
**Devices:** D1, D4.
1. **Photos** → upload: the OS sheet offers **Take Photo / Photo Library**.
2. Take a photo (front + back camera via the in-app `camera-capture` toggle) →
   uploads with progress; the record appears (real DB row, not a fake success).
3. **Scan** → camera opens directly (capture). 4. Upload a **HEIC** photo from an
   iPhone → it is accepted and displays. 5. Kill network mid-upload → a clear error
   + retry; **no orphaned/duplicate** record. Evidence: recording of upload + the
   interrupted case.

## S7 — Auth & session on device (Phase 13)
**Devices:** D1, D4, PWA (see S9).
1. Email/password sign-in; magic-link + OTP paths return to the app (no redirect
   loop). 2. Force-quit + reopen → session persists. 3. Sign out → protected routes
   redirect; no confidential content flashes. 4. Switch household/account → no prior
   user's data leaks. Evidence: recording of each.

## S8 — PWA install & update (verifies M-010, Phase 16)
**Devices:** D1 (Add to Home Screen), D4 (install banner).
1. Install to home screen; launch standalone → correct icon, name, splash;
   **standalone safe areas** correct (no content under notch/home indicator).
2. Deploy a new version (or simulate) → the **"A new version of Bubaly is
   available → Reload"** banner appears above the tab bar and clears the home
   indicator; **Reload** loads the new version; **Later** dismisses. Evidence:
   screenshot of the banner in standalone mode.

## S9 — Offline & poor network (Phase 17)
**Devices:** D1, D4.
1. Go offline mid-session → navigate → the **/offline** fallback appears (no
   infinite spinner). 2. Submit a form on a flaky connection → clear status; retry
   is safe; **no duplicate** record on double-tap. 3. Restore network → recovery is
   clean. Evidence: recording.
4. **Cache privacy (M-023):** sign in → browse the dashboard → **sign out** → go
   offline → reopen the app: **no private family content may render** (only the
   public shell / offline page). Also, updating from a pre-M-023 build must purge
   the old cache (DevTools → Cache Storage shows only `bubaly-v4`, containing only
   `/` and `/offline`). Evidence: screenshots of Cache Storage + offline relaunch.

## S10 — Push & biometrics (Phases 21/22)
**Devices:** D1, D4 (real push credentials required).
1. Notification permission is requested **with context** (not on first load).
2. Deny → app handles gracefully. 3. Grant → a test push arrives; its deep link
   respects auth. 4. **Focus-not-stack (M-026):** with the app already open, tap a
   push → the **existing** window/instance is focused and navigated (no second
   window/tab piles up). 5. App-lock (PIN/biometric) gate: unlock via Face ID /
   fingerprint. Evidence: recording.

## S11 — Tablet layout (verifies pending M-008)
**Devices:** D3, D5.
1. Dashboard + list/detail screens use the width well — no narrow centered phone
   column with huge empty margins; sidebars (`lg:grid-cols-[1fr_340px]`) render.
   **iPad portrait (M-035):** the family hubs (Health / Emergency / School /
   Sports / COO / CFO) show their card pairs **two-up**, not stacked.
2. External keyboard: Tab/Shift-Tab focus order is sane; Esc closes dialogs.
   Evidence: screenshots portrait + landscape.

## S12 — Signed-URL document opens (verifies M-030)
**Devices:** D1 (iOS Safari — the popup-blocker case), D4.
1. **Documents** → tap **View/Download** on a stored file.
   - Expect: a tab opens and shows the file (a blank tab may flash first — that is
     the gesture-blessed pre-open). **Nothing happening = fail (the pre-M-030 bug).**
2. Repeat on **Files Hub**, **Tax Vault**, a **Home warranty doc**, and (as super
   admin) the admin document viewer.
3. Turn OFF "Block Pop-ups" → same flows still work. Turn it ON (Safari default)
   → flows still work (that's the fix). With an aggressive third-party blocker,
   the file may open **in the same tab** — acceptable fallback; Back returns.
4. Kill network, tap View → the blank tab **closes itself** + an error toast
   (no orphaned about:blank tab). Evidence: recording of 1/3/4.

## S13 — Media & chat polish (verifies M-028, M-031, M-033)
**Devices:** D1, D4.
1. **Photos** → open a **video** in the lightbox → it plays **inline inside the
   lightbox with sound** (does not hijack into the system fullscreen player;
   fullscreen remains available via the control). (M-028)
2. Focus the **Messages / Assistant / Concierge** composer → the keyboard's
   return key reads **"Send"** and sends; the Kitchen AI-Chef box's return key
   inserts a newline (send is the button). (M-031)
3. Trigger any success toast (e.g. save a note) on D1 (notched) and D3 →
   the toast is **fully visible above the bottom tab bar** / home indicator,
   and above the keyboard-less bar on iPad widths. (M-033)
   Evidence: recordings of 1–3.

## S14 — Wall display / Kitchen Mode (verifies M18, M37, W6)
**Devices:** D3 (iPad), D5 (Android tablet). **Precondition:** signed in on the
tablet, Family Basic or above, a charger and a stand.
1. **Install.** `/display` → Share → **Add to Home Screen**; launch from the home
   screen. Expect: no browser bars, the tiles fill the screen, landscape.
   Evidence: photo of the tablet in its stand.
2. **First-run card.** The **"Set up this tablet"** card is at the top on first
   load. Read its wake-lock line and record which of the four it says (keeping
   awake / declined / no screen lock / asking). Tap **Got it** → the card goes.
   **Reload the page and reopen the display on a SECOND device** — the card must
   stay gone on both (the dismissal is stored per family in
   `display_layouts.settings`, not per browser). If the write fails, the card
   must come back with an error toast — it must never look dismissed while
   nothing was saved.
3. **Self-check.** Header → the monitor button → `/display/setup` → **Run the
   checks**. Expect four rows, each flipping from "Not tested yet" to its own
   answer, and NOTHING claimed beyond those four. Record all four answers.
   Evidence: screenshot of the results.
4. **Fullscreen.** Back on `/display`, tap the full-screen control. Expect: the
   grid fills the panel edge to edge, no page scroll on the kiosk fit.
5. **Wake lock (the one only a device can prove).** Leave the display in the
   foreground, untouched, for **30 minutes** with the tablet's own auto-lock at
   its default. Expect: the screen is still on. If it slept, that is the honest
   result — set auto-lock to Never and record that this device needs it.
6. **Rotate.** Turn the tablet to portrait and back. Expect: no clipped tile, no
   horizontal page scroll, the timers keep counting.
7. **Ask tile.** Add an **Ask Bubaly** tile (pencil → Section → Ask Bubaly →
   Save). Type a request; then tap the mic and speak one. Expect: both land on
   the run page or answer inline, and **nothing is executed without an approval**
   — a request that would act shows a plan first. Evidence: recording.
8. **Handled today tile.** Add the **Handled today** tile. With the tablet
   offline (airplane mode) reload: the tile must read **"Bubaly could not read
   what it finished"** with a **Try again** — **a zero here is a FAIL.** Back
   online, the count must match the runs Home → Handled shows as **completed**
   today. It is not the same number as Home's own total whenever a run finished
   only partly: the wall counts `state = 'completed'`, Home counts
   `completed` **and** `partially_completed` (`HANDLED_RUN_STATES`,
   `lib/metric/time-saved.ts`). Check against the completed rows, not the total.
9. **24-hour soak.** Leave the display running overnight, plugged in, on the home
   screen. The next morning check: the screen is on (or the auto-lock note from
   step 5 applies), the date/greeting rolled over, today's events are today's,
   and no error screen. **Deploy a new version during the soak** if possible: the
   tab must pick it up on its own within ~12h, not sit on a dead bundle.
   Evidence: photo the next morning + the browser's page-load time.

---

## Results log
Copy this table per test session (date / build SHA / tester):

| Script | D1 iPhone | D2 old iPhone | D3 iPad | D4 Android | D5 Android tab | D6 low-mem | Notes |
|--------|-----------|---------------|---------|------------|----------------|------------|-------|
| S1 |  |  |  |  |  |  |  |
| S2 |  |  |  |  |  |  |  |
| S3 |  |  |  |  |  |  |  |
| S4 |  |  |  |  |  |  |  |
| S5 |  |  |  |  |  |  |  |
| S6 |  |  |  |  |  |  |  |
| S7 |  |  |  |  |  |  |  |
| S8 |  |  |  |  |  |  |  |
| S9 |  |  |  |  |  |  |  |
| S10 |  |  |  |  |  |  |  |
| S11 |  |  |  |  |  |  |  |
| S12 |  |  |  |  |  |  |  |
| S13 |  |  |  |  |  |  |  |
| S14 | N/A | N/A |  | N/A |  | N/A |  |

**External dependencies to unblock device testing:** LB-015 (CI runners) for the
automated matrix; real push credentials (S10); App Store Connect / Play Console for
native-wrapper store submission (out of scope for the web/PWA path).
