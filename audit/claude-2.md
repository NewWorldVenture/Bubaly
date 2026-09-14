# Claude-2 — Frontend / UI / UX / Responsive / Accessibility

## STATUS (session 2, 2026-09-14)

CURRENT: **done.** IMPORTANT CONTEXT FOR CLAUDE-1: this file already held a
complete 14-finding pass (C2-01–C2-14, below) from an earlier parallel session,
merged into `finalaudit.md` as **Pass D (F-D01–F-D14)**. `audit/status.md`'s
top board and `finalaudit.md`'s Part 0 coverage table both currently say
Frontend/UX-Accessibility is "not audited — worker hit the account session
limit" — **that line is stale**; Pass D exists and is substantial. Please
update Part 0's coverage table and the board when you next rebuild them.
This session did NOT repeat that pass. It read C2-01–C2-14 first and then
audited the specific angles the new brief called out that Pass D did not
cover: failed-read states surfaced as empty/silent rather than errors,
success toasts after discarded write errors, i18n key leakage, and
responsive/modal/error-boundary behaviour beyond what Pass D measured. New
findings are C2-15–C2-18, in a clearly marked "Session 2" section below the
original pass so nothing from the first pass is disturbed.

COMPLETED:
  - Swept all 113 `useRealtimeQuery` consumers for dropped/unrendered `error`.
    Systemic pattern is sound (every module importing the hook also imports
    and correctly sequences `ErrorState`) — two real exceptions found: C2-15.
  - Confirmed the blog-unsubscribe discarded-write-error bug the brief named
    as historically shipped is STILL LIVE, unfixed, in the current tree: C2-16.
  - Found the same false-success shape in the Google Calendar OAuth callback
    (higher blast radius — a whole integration silently not-connected while
    the UI says "connected"): C2-17.
  - Verified the i18n raw-key-leak class (brief: "this repo has shipped that")
    has real, working, non-vacuous regression tests covering exactly that
    shape, with two genuine historical incidents behind them; ran both
    targeted test files, both pass.
  - Verified non-English locale catalogues do not leak into client JS bundles
    (checked against the existing 2026-09-13 production build already on
    disk — did not run a build myself).
  - Verified alt-text is clean in the authenticated app (0/57 `<img>`, 0/6
    `<Image>` missing alt; one apparent miss was a regex false-positive on a
    code comment, corrected before recording).
  - Found zero component-level error-boundary isolation anywhere in the app
    (0 `ErrorBoundary` usages, 6 total `<Suspense>` app-wide, none on Home):
    C2-18 — a render throw in any one of Home's 13 composed widgets currently
    takes down the whole dashboard, not just that widget.
  - Attempted an independent re-check of icon-only-button labelling (C2-11
    territory) with a fast regex; it produced ~900 candidates, spot-checked
    two, both were false positives (JSX text inside `{}` expressions, and a
    `title=` attribute my regex mis-scoped) — this independently confirms
    WHY the original C2-11 pass had to build a brace-aware structural parser
    rather than grep, and I deferred to its count (2) rather than publish an
    unverified one of my own. Recorded under Method notes below.
  - Checked sticky-positioned elements (13 files) for content-covering risk:
    all read as intentional headers/toolbars with correct z-index and blur;
    flagged explicitly as a source-reading judgement, not a live-viewport
    measurement (no browser available in this environment).
SEVERITY COUNT THIS SESSION: 1 HIGH (C2-17), 1 MEDIUM (C2-15), 1 HIGH (C2-16),
  1 MEDIUM (C2-18) → 2 HIGH, 2 MEDIUM, 0 LOW, 0 CRITICAL. Combined with the
  first pass (C2-01–C2-14: 3 HIGH, 7 MEDIUM, 4 LOW): **18 findings total in
  this file, 5 HIGH / 9 MEDIUM / 4 LOW / 0 CRITICAL.**
NEXT: nothing queued. Not reached (needs a real browser, not available in
  this environment): colour contrast, actual tab order, screen-reader output,
  live confirmation that no sticky element overlaps content at 360-400px.
FILES TOUCHED: none (audit-only, per hard rules — no source file edited, no
  build run, no commit).
LAST-UPDATE: 2026-09-14

---

Findings only. Format:

```
[CLAUDE-2][SEVERITY][AREA] Title
File:     path/to/file.ts:line
Problem:  what is wrong
Evidence: what proves it (command output, code, a live response)
Impact:   who is hurt and how
Fix:      recommended change
Status:   OPEN | VERIFIED | FIXED | BLOCKED
```

SEVERITY: CRITICAL | HIGH | MEDIUM | LOW

Scope of this pass: the **authenticated app** (`app/(app)/`, 354 pages) and
`components/` (456 `.tsx`). The public marketing surface was covered by Pass A
(F8/F11/F12/F9) and is not re-derived here. Findings below are additive to
`finalaudit.md`.

**This pass changed no source code.** Every item is documented for Claude-1 to
triage.

---

## Summary

| Severity | Count |
|---|---|
| HIGH | 3 |
| MEDIUM | 7 |
| LOW | 4 |
| **Total** | **14** |

Plus 6 areas **verified clean** (see the last section) — worth recording so a
later pass does not re-audit them.

---

## C2-01

```
[CLAUDE-2][HIGH][A11Y] The photo lightbox is a modal that traps sighted mouse users and strands keyboard users
File:     components/modules/photos-module.tsx:407-462
Problem:  The full-screen photo/video lightbox is hand-rolled as a bare <div>.
          It has no role="dialog", no aria-modal, no Escape handler, no focus
          move-in, no focus trap, and no body scroll lock. Its ONLY dismissal is
          an onClick on the backdrop <div>, which is not keyboard operable.
Evidence: components/modules/photos-module.tsx:408
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 pt-[var(--safe-top)] pb-[var(--safe-bottom)]"
              onClick={() => setLightboxIdx(null)}>

          The file has no Escape/keydown handler anywhere:
            $ grep -n "Escape\|keydown" components/modules/photos-module.tsx
            (no matches)

          It *imports* the correct primitive but does not use it here:
            $ grep -n "ui/modal" components/modules/photos-module.tsx
            → imports Modal, used for other dialogs in the same file.

          For contrast, components/ui/modal.tsx:36-70 implements exactly the
          missing behaviour (focus trap, Escape, scroll lock, focus restore).
Impact:   A keyboard-only or screen-reader user who opens a photo cannot close
          it. Focus stays on the page behind the opaque bg-black/95 overlay, so
          they are operating UI they cannot see, with no way back. The page
          behind also keeps scrolling under the overlay.
Fix:      Replace the hand-rolled overlay with <Modal> (className can widen it),
          or, if the bespoke chrome must stay, add role="dialog" aria-modal
          aria-label, an Escape handler, initial focus, a Tab trap and
          document.body.style.overflow lock — i.e. reuse the effect in
          components/ui/modal.tsx rather than re-implement it.
          ArrowLeft/ArrowRight should also drive prev/next while it is open.
Status:   OPEN
```

---

## C2-02

```
[CLAUDE-2][HIGH][A11Y] 55 visible field labels are not programmatically attached to their control
File:     app/(app)/feedback/feedback-board.tsx:109 (and 54 more, 22 files)
Problem:  The codebase has TWO correct labelled-field primitives, and 220 of its
          294 <label> elements wrap their control properly. But 55 labels are
          rendered as a *sibling* <label> with no htmlFor, next to a control
          with no id. The text is on screen, and it is a <label>, but nothing
          associates the two — so the control has no accessible name at all.
Evidence: Scanner over all 1,000+ .tsx files (brace-aware JSX attribute parse,
          label open/close depth tracking):

            <label> total=294  htmlFor=19  wrapping-control=220
            ORPHAN (no htmlFor, no nested control) = 55   across 22 files

          Concrete instance — app/(app)/feedback/feedback-board.tsx:109-111:
            <label className={label}>{t('feedbackFeedbackBoard.category')}</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>

          The <label> closes before the <select> opens, the <select> has no id,
          and the <label> has no htmlFor. Same shape at lines 73, 93, 98, 103,
          115, 121, 128 of that one file.

          More: app/(app)/dashboard/social/settings/page.tsx:57,61,65,69;
          app/s/[slug]/survey-form.tsx:79,85 (public survey);
          components/guardian/rules-editor.tsx:277,291,296,302,313,330,343;
          components/modules/find-time-modal.tsx:142,163,177;
          components/modules/journal-module.tsx:211,229;
          components/modules/trip-intel-module.tsx:258,273,497;
          components/modules/recipes-module.tsx:680,698,717;
          components/modules/habits-module.tsx:416,427,449;
          components/modules/notes-module.tsx:449;
          components/modules/shopping-module.tsx:494;
          components/guardian/routing-settings.tsx:191;
          app/(app)/admin/ai/ai-engine-form.tsx:42.

          The right pattern already exists and is used 1,066 times:
            components/ui/input.tsx:31  Field({label, children:(id)=>…})
              → <label htmlFor={id}> + children(id)
            components/home/field.tsx:4 Field wraps its child in <label>
Impact:   Screen-reader users hear "combo box" / "edit text" with no name on
          these controls and cannot tell what they are filling in. Clicking the
          label text also does not focus the control, which is a plain usability
          loss for everyone. `app/s/[slug]/survey-form.tsx` is a **public**
          page, so this is not confined to internal admin screens.
Fix:      Convert each site to the existing <Field> render-prop from
          components/ui/input.tsx (preferred — it also handles error/hint), or
          at minimum add htmlFor={id} + id={id} via useId(). No new primitive is
          needed; this is a mechanical migration to code the repo already has.
Status:   OPEN
```

---

## C2-03

```
[CLAUDE-2][HIGH][A11Y] 65 <select> elements ship with no accessible name of any kind
File:     components/modules/rewards-module.tsx:324 (and 64 more)
Problem:  <select> cannot fall back to a placeholder the way <input> can. 65 of
          the app's 145 <select> elements have no <label> ancestor, no htmlFor
          label, no aria-label and no id — so they are announced with no name.
Evidence: Same structural scanner as C2-02:

            select:   n=145  bare(no name at all)=65   placeholder-only=0
            input:    n=491  bare=46                    placeholder-only=228
            textarea: n=59   bare=2                     placeholder-only=39

          Instance — components/modules/rewards-module.tsx:324 (the control that
          chooses WHICH CHILD a reward is redeemed for):
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)}
              className="h-9 flex-1 min-w-0 rounded-lg bg-surface/60 border border-border px-2 text-sm text-fg focus-ring">
              {kids.map((k) => <option key={k.id} value={k.id}>{k.display_name}</option>)}
            </select>

          Instance — components/economy/economy-view.tsx:190, same role:
            <select value={who} onChange={(e) => setWho(e.target.value)}
              className="h-9 flex-1 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">

          Others include components/modules/chores-module.tsx:373,
          components/modules/reminders-module.tsx:362,370,
          components/modules/shopping-module.tsx:411,
          components/modules/recipes-module.tsx:288,
          components/modules/concierge-module.tsx:450,
          components/wallet/invest-view.tsx:185,
          components/wallet/pay-handle-manager.tsx:93,
          components/onboarding/onboarding-wizard.tsx:703,714,
          components/admin/filter-bar.tsx:35,
          components/social/studio-form.tsx:270,276,
          components/guardian/contact-list.tsx:117,
          app/(app)/dashboard/activity/activity-feed.tsx:137.
Impact:   The rewards and economy cases are the sharpest: a screen-reader user
          redeeming a reward hears an unnamed combo box listing children's
          names, with no indication that the choice determines whose balance is
          debited. Onboarding (onboarding-wizard.tsx:703,714) sets a member's
          *role* through an unnamed select.
Fix:      Wrap in the existing <Field> (components/ui/input.tsx:31), or add
          aria-label={t(...)} where the surrounding layout genuinely has no room
          for visible label text. Prefer the visible label.
Status:   OPEN
```

---

## C2-04

```
[CLAUDE-2][MEDIUM][A11Y] Four hand-rolled dialogs claim aria-modal="true" but never trap focus or handle Escape
File:     components/guardian/rules-editor.tsx:250-258
          components/guardian/contact-list.tsx:274-281
          components/app/trial-paywall-gate.tsx:55-57
          components/app/account-closed-gate.tsx:31-33
Problem:  Each declares role="dialog" aria-modal="true". aria-modal="true" tells
          assistive tech to treat everything outside the dialog as inert. None
          of the four moves focus into the dialog, traps Tab, or handles Escape.
          So the AT hides the background while the keyboard still reaches it —
          the user tabs into content their screen reader will not announce.
Evidence: components/guardian/rules-editor.tsx:250-258
            <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
              <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="rules-editor-title"

          Neither file contains an Escape handler:
            $ grep -c "Escape" components/guardian/rules-editor.tsx        → 0
            $ grep -c "Escape" components/guardian/contact-list.tsx        → 0
            $ grep -c "Escape" components/app/trial-paywall-gate.tsx       → 0
            $ grep -c "Escape" components/app/account-closed-gate.tsx      → 0

          None imports the shared Modal:
            $ grep -c "ui/modal" on all four → 0

          components/marketing/exit-intent.tsx:114 is the one hand-rolled dialog
          that DOES handle Escape — so the pattern is known in the codebase.
Impact:   Guardian rule/contact editing is keyboard-hostile. The two gates are
          worse in kind: trial-paywall-gate and account-closed-gate are supposed
          to be hard blocks on the whole app, yet a keyboard user can Tab
          straight past the overlay into the application chrome behind it. That
          is a UX hole in a *billing* gate, not only an a11y one.
          (Not claimed: that the background is functionally operable — the gates
          return early instead of rendering children, so what sits behind them
          is the app shell, not the page. Worth Claude-1 confirming.)
Fix:      Route all four through components/ui/modal.tsx, which already
          implements trap + Escape + scroll lock + focus restore. For the two
          gates, keep Escape disabled (they are non-dismissible by design) but
          still move focus in and trap it.
Status:   OPEN
```

---

## C2-05

```
[CLAUDE-2][MEDIUM][A11Y] 19 authenticated pages render no <h1> — and 11 of them render no heading at all
File:     app/(app)/dashboard/devices/page.tsx (+ 18 more)
Problem:  These pages produce no top-level heading. Eleven go further and emit
          no <h1>, <h2> or <h3> anywhere, so the page has no heading outline for
          a screen reader to navigate by. This is the authenticated-app twin of
          the already-closed F11 (five public pages had no <h1>).
Evidence: Resolved through the page → module import chain and the parent
          layout chain (app/(app)/layout.tsx and app/(app)/dashboard/layout.tsx
          were both read: neither renders a page heading).

          app/(app)/dashboard/devices/page.tsx is the whole page:
            export default async function DevicesPage() {
              await requireFeature('/dashboard/devices');
              return <DevicesModule />;
            }

          And the module it renders has no heading at all:
            $ for m in voting security expenses devices binder tax-vault \
                behavior screen-time subscriptions utilities trip-memories; do
                f=components/modules/$m-module.tsx
                echo "$f: h1=$(grep -c '<h1' $f) PageHeader=$(grep -c '<PageHeader' $f) h2=$(grep -c '<h2' $f)"
              done
            components/modules/voting-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/security-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/expenses-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/devices-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/binder-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/tax-vault-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/behavior-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/screen-time-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/subscriptions-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/utilities-module.tsx: h1=0 PageHeader=0 h2=0
            components/modules/trip-memories-module.tsx: h1=0 PageHeader=0 h2=0

          Full list of the 19 pages:
            app/(app)/parent/page.tsx
            app/(app)/admin/tiers/page.tsx
            app/(app)/admin/marketing/social/recurring/page.tsx
            app/(app)/admin/marketing/assistant/page.tsx
            app/(app)/dashboard/utilities/page.tsx
            app/(app)/dashboard/family-memory/page.tsx
            app/(app)/dashboard/family-knowledge-graph/page.tsx
            app/(app)/dashboard/family-ai-assistant/page.tsx
            app/(app)/dashboard/trip-memories/page.tsx
            app/(app)/dashboard/expenses/page.tsx
            app/(app)/dashboard/auto/accident/page.tsx
            app/(app)/dashboard/binder/page.tsx
            app/(app)/dashboard/tax-vault/page.tsx
            app/(app)/dashboard/voting/page.tsx
            app/(app)/dashboard/devices/page.tsx
            app/(app)/dashboard/subscriptions/page.tsx
            app/(app)/dashboard/security/page.tsx
            app/(app)/dashboard/screen-time/page.tsx
            app/(app)/dashboard/behavior/page.tsx

          (11 further app/(app)/dashboard/vacations/[id]/* pages initially
          flagged were confirmed FALSE POSITIVES: that segment's layout.tsx:32
          supplies the <h1>. They are excluded from the 19.)
Impact:   WCAG 2.4.6 / 1.3.1. A screen-reader user landing on Smart Home,
          Expenses, Tax Vault or Security gets a page with no announced title
          and no heading list to jump through — the only orientation cue is the
          browser tab title.
Fix:      Add <PageHeader title={…} /> (components/app/page-header.tsx already
          renders a correct <h1>) at the top of each of the 11 modules, and an
          <h1>/PageHeader to the 8 remaining pages. app/(app)/parent/page.tsx is
          a pure redirect() and needs nothing — verify and drop it from the list.
Status:   OPEN
```

---

## C2-06

```
[CLAUDE-2][MEDIUM][A11Y] Primary content rows across seven modules are clickable but not keyboard reachable
File:     components/modules/calendar-module.tsx:618,637,685,730,814
Problem:  49 non-interactive elements carry onClick with no role, no tabIndex
          and no key handler. Most are harmless backdrop scrims, but in seven
          modules the pattern is applied to the *primary content row* — the only
          way to open that record.
Evidence: Scanner (brace-aware tag parse) over app/ + components/:
            onClick on <div>/<span>/<li>/<td>… with NO role and NO key handler: 49
            elements with an interactive role but no key handler: 0

          The load-bearing ones (each is the sole affordance to open the item):
            components/modules/calendar-module.tsx:618,637,685,730,814
              <div key={`${e.id}-${e.starts_at}`} onClick={() => setSelected(e)}
                className={cn('cursor-pointer rounded-lg border p-3 transition …
            components/modules/notes-module.tsx:267,310
              <div key={note.id} onClick={() => onOpen(note)} className="group flex cursor-pointer …
            components/modules/contacts-module.tsx:191
              <div key={contact.id} onClick={() => setSelected(isSelected ? null : contact)} …
            components/modules/photos-module.tsx:331,380
              <div key={photo.id} onClick={() => setLightboxIdx(idx)} …
            components/modules/recipes-module.tsx:308
            components/modules/meals-module.tsx:372,413
            components/modules/goals-module.tsx:134
              <div className="min-w-0 flex-1 cursor-pointer" onClick={onEdit}>

          The remaining ~30 are `fixed inset-0` dismiss scrims and
          stopPropagation wrappers — lower priority, though the scrims should
          still pair with an Escape handler (see C2-04).
Impact:   Calendar events, notes, contacts, photos, recipes, meal slots and
          goals cannot be opened without a mouse. For calendar and notes these
          are the module's core interaction, so those screens are effectively
          mouse-only.
Fix:      Make the row a real <button type="button"> (or add role="button"
          tabIndex={0} plus an onKeyDown for Enter/Space). A <button> reset class
          already exists in the design system; the row markup does not otherwise
          need to change.
Status:   OPEN
```

---

## C2-07

```
[CLAUDE-2][MEDIUM][UX] 92 destructive actions are guarded only by native window.confirm()
File:     components/modules/photos-module.tsx:456 (and 91 more across 84 files)
Problem:  Deletes and other irreversible actions are confirmed with the browser's
          native confirm(). The app ships a native WebView shell (Capacitor)
          pointed at the hosted site, and it has a well-built <Modal> it is not
          using for this.
Evidence: $ grep -rnoE '\b(window\.)?confirm\(' app components --include=*.tsx | wc -l
            92
          $ grep -rlE  '\b(window\.)?confirm\(' app components --include=*.tsx | wc -l
            84
          (No alert() or prompt() anywhere — 0 each.)

          Instance — components/modules/photos-module.tsx:456:
            <button onClick={() => { if (confirm(tr('photosModule.deleteThisPhoto'))) deletePhoto(photos[lightboxIdx]); }}

          Instance — components/app/trial-paywall-gate.tsx:46, gating ACCOUNT CLOSURE:
            if (!window.confirm(t('trialPaywallGate.closeYourAccountNothingIs'))) return;

          The app is shipped as a native shell — capacitor.config.ts:
            const SERVER_URL = process.env.CAP_SERVER_URL || 'https://www.bubaly.com';
            ios: { limitsNavigationsToAppBoundDomains: true }, android: {...}
Impact:   Three separate costs. (1) i18n: the message is translated but the
            OK/Cancel buttons come from the OS locale, so a French family sees a
            French prompt with English-or-system buttons. (2) Visual: an
            unstyled system sheet in the middle of a designed app, on a screen
            that is otherwise fully themed. (3) It blocks the main thread and
            cannot carry the destructive-action affordances the design system
            has (danger tone, typed confirmation, undo).
          NOT claimed: that confirm() is suppressed in the Capacitor WebView.
          Capacitor's Android bridge does implement onJsConfirm. This is a
          consistency/i18n/UX finding, not a "the button does nothing" finding.
Fix:      Add a `useConfirm()` hook backed by components/ui/modal.tsx returning a
          Promise<boolean>, and migrate the 92 call sites. Start with the
          account-closure and money/wallet paths.
Status:   OPEN
```

---

## C2-08

```
[CLAUDE-2][MEDIUM][UX] All 354 authenticated pages share one route-group loading skeleton
File:     app/(app)/loading.tsx
Problem:  There are exactly 2 loading.tsx files under app/(app)/ for 354 pages.
          One is the route-group root, which therefore serves as the Suspense
          boundary for every segment that lacks its own. Navigating anywhere —
          Chores → Wallet, or Wallet → Wallet Settings — tears the entire
          authenticated view down to a single generic skeleton.
Evidence: $ find "app/(app)" -name 'page.tsx'    | wc -l   → 354
          $ find "app/(app)" -name 'loading.tsx' | wc -l   → 2
          $ find "app/(app)" -name 'loading.tsx'
            app/(app)/loading.tsx
            app/(app)/guardian/loading.tsx
          $ grep -rn '<Suspense' app components | wc -l    → 6

          Every other top-level segment has none:
            admin (80 pages), dashboard (215), marketplace (20), wallet (12),
            family (6), missions (2), kids (2), capture (2), services (2),
            display (2), economy/feedback/home/parent/referrals/auth (1 each).

          Guardian is the counter-example that shows the intended shape —
          app/(app)/guardian/loading.tsx renders a segment-shaped skeleton
          (cards, filter pills, a list) rather than a generic one.
Impact:   Not a correctness bug — Next.js resolves to the nearest boundary, so
          nothing is unhandled. It is a perceived-performance and layout-
          stability cost: the shell flashes on every navigation and the skeleton
          cannot match the destination, so the content shifts when it lands.
          Worst on `dashboard` (215 pages) and `admin` (80).
Fix:      Add segment-level loading.tsx for at least dashboard, admin,
          marketplace and wallet, modelled on app/(app)/guardian/loading.tsx.
          Low risk, purely additive.
Status:   OPEN
```

---

## C2-09

```
[CLAUDE-2][MEDIUM][REACT] Ten client components set state from an un-cancelled async effect
File:     components/app/notification-bell.tsx:15 (and 9 more)
Problem:  These useEffect bodies await/`.then` and then call a setter with no
          cancellation flag and no AbortController. If the component unmounts or
          the effect re-runs before the promise settles, a stale response writes
          over fresh state (or over nothing).
Evidence: Scanner: useEffect bodies containing `await`/`.then(` AND a `set[A-Z]`
          call, with none of cancel/alive/mounted/ignore/abort/active/stale/
          AbortController/signal present in the body → 10 of them:

            components/app/notification-bell.tsx:15
            components/auth/join-invite.tsx:30
            components/billing/family-delivered-value.tsx:53
            components/billing/family-value-comparison.tsx:55
            components/marketplace/quick-post.tsx:58
            components/messages/gif-picker.tsx:20
            components/modules/calendar-module.tsx:249
            components/modules/concierge-calls-module.tsx:63
            components/modules/messages-module.tsx:283
            components/vacations/trip-concierge.tsx:32

          The repo's own correct pattern, for contrast —
          components/services/service-tooltip.tsx:43:
            useEffect(() => {
              let active = true;
              void fetchOverrides().then((ov) => { if (active) setMap(mergeServiceDescriptions(ov)); });
              return () => { active = false; };
            }, []);

          The sharpest is components/messages/gif-picker.tsx:20: the debounce
          timer is cleared on cleanup, but an already-dispatched fetch is not —
            const t = setTimeout(async () => {
              …const res = await fetch(`/api/gif/search?q=${encodeURIComponent(q)}`);
              …setGifs(json.gifs ?? []); setState('ready');
            }, q ? 300 : 0);
            return () => clearTimeout(t);
          so a slow response for query "ca" can land after "cat" and repaint the
          older results.
Impact:   Out-of-order search results in the GIF picker; redundant post-unmount
          renders elsewhere. React 18 no longer warns on setState-after-unmount,
          so none of this is visible in the console — it surfaces as flicker and
          occasional wrong content.
Fix:      Adopt the `let active = true` / AbortController pattern already used
          in service-tooltip.tsx. gif-picker.tsx should use an AbortController so
          the superseded request is actually cancelled, not just ignored.
Status:   OPEN
```

---

## C2-10

```
[CLAUDE-2][MEDIUM][A11Y] The project lints for zero of the rules that would have caught C2-02, C2-03 and C2-06
File:     .eslintrc.json
Problem:  The whole ESLint config is `next/core-web-vitals`. That preset enables
          only five jsx-a11y rules (alt-text, aria-props, aria-proptypes,
          role-has-required-aria-props, role-supports-aria-props). It does NOT
          enable label-has-associated-control, click-events-have-key-events,
          no-static-element-interactions, or control-has-associated-label — the
          exact four rules that describe C2-02, C2-03 and C2-06.
Evidence: $ cat .eslintrc.json
            {
              "extends": "next/core-web-vitals",
              "ignorePatterns": ["mobile/**", "supabase/**", "node_modules/**", ".next/**"]
            }

          And the lint run is nearly silent, which is why nobody noticed:
            $ npx next lint --max-warnings=99999
            ./components/capture/document-capture.tsx
              24:31  Warning: The ref value 'generation.current' will likely have changed … react-hooks/exhaustive-deps
            ./components/modules/messages-module.tsx
              208:6  Warning: React Hook useCallback has a missing dependency: 'toastError' … react-hooks/exhaustive-deps
              278:6  Warning: React Hook useCallback has a missing dependency: 'toastError' … react-hooks/exhaustive-deps
            (3 warnings total, 0 errors, across ~1,000 .tsx files)
Impact:   This is the finding that keeps the other a11y findings from recurring.
          Without these rules every new form added to the app can reintroduce
          C2-02/C2-03 silently, and the clean lint output reads as a green light.
Fix:      Add eslint-plugin-jsx-a11y and extend plugin:jsx-a11y/recommended, or
          enable the four rules above as warnings first. Expect ~120 initial
          warnings (the counts in C2-02/C2-03/C2-06); ratchet with
          --max-warnings once the backlog is cleared. Do this AFTER the fixes,
          or land it as warn-only, so CI is not broken by the existing backlog.
Status:   OPEN
```

---

## C2-11

```
[CLAUDE-2][LOW][A11Y] Two icon-only buttons in the guardian contact list have no accessible name
File:     components/guardian/contact-list.tsx:242-243
Problem:  Edit and Delete render as a bare icon with no aria-label, no title and
          no sr-only text.
Evidence: A scan of every <button> in app/ + components/ for an icon-only body
          with no aria-label/title/sr-only/text node returned exactly two:
            components/guardian/contact-list.tsx:242
              <button onClick={onEdit} className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg transition"><Pencil className="h-4 w-4" /></button>
            components/guardian/contact-list.tsx:243
              <button onClick={onDelete} className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400 transition"><Trash2 className="h-4 w-4" /></button>

          The same file labels its other controls correctly, and
          components/modules/devices-module.tsx:97-98 shows the house pattern:
            <button … aria-label={tr('devices.edit')}><Pencil className="h-4 w-4" /></button>
            <button … aria-label={tr('devices.delete')}><Trash2 className="h-4 w-4" /></button>
Impact:   A screen-reader user hears two unnamed buttons; one deletes a guardian
          contact. Small blast radius — hence LOW — but it is a destructive
          control. Worth noting the overall result is *good*: only 2 of several
          hundred icon buttons are unlabelled.
Fix:      Add aria-label={tr('contactList.edit')} / aria-label={tr('contactList.delete')}.
Status:   OPEN
```

---

## C2-12

```
[CLAUDE-2][LOW][UX] Two admin links point at generated routes that exist only at runtime
File:     app/(app)/admin/marketing/seo/page.tsx:86-87
Problem:  A full cross-check of every literal internal href against the App
          Router tree returned exactly two paths with no matching page.tsx,
          route.ts or public/ file: /sitemap.xml and /robots.txt.
Evidence: Scanner built 484 static routes + 55 dynamic route patterns from
          app/**/{page,route}.{tsx,ts} (route groups and parallel segments
          stripped), plus every file under public/, then matched all literal
          href="/…" in app/ + components/:

            static routes: 484  dynamic: 55
            literal internal hrefs with NO matching route or public file: 2
              /robots.txt   app/(app)/admin/marketing/seo/page.tsx:87
              /sitemap.xml  app/(app)/admin/marketing/seo/page.tsx:86

          Both are in fact served — by app/robots.ts and app/sitemap.ts, which
          Next.js maps to those URLs. So these are **not broken links**.
Impact:   None at runtime. Recorded so a future link-check does not re-flag them,
          and as the evidence that link hygiene across ~1,000 components is
          otherwise perfect (0 genuine dead internal links).
Fix:      None required. If a link checker is added to CI, allowlist the two
          Metadata-file routes.
Status:   VERIFIED (not a defect)
```

---

## C2-13

```
[CLAUDE-2][LOW][REACT] 172 index-derived keys, of which the reorderable cases are worth a second look
File:     app/(app)/missions/new/plan-generator.tsx:67
Problem:  172 `key={i}` / `key={idx}` / `key={index}` usages. The large majority
          are safe (skeleton placeholders, 5-star rows, static paragraph splits,
          Array.from({length:n})). A minority key *mutable* lists by index.
Evidence: $ grep -rnEc 'key=\{(i|idx|index)\}' app components --include=*.tsx \
              | grep -v ':0' | awk -F: '{s+=$2} END{print s}'
            172

          Clearly safe, e.g.:
            app/(app)/dashboard/recipes/discover/discover-client.tsx:84
              {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-56 animate-pulse …
            app/(app)/guardian/loading.tsx:10,22,40  (skeletons)
            app/(app)/marketplace/item/[id]/page.tsx:380  (rating stars)

          Worth review — a list the user can edit in place:
            app/(app)/missions/new/plan-generator.tsx:67
              <div key={idx} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface/60 p-3">
Impact:   Where an index keys a list that can be reordered or spliced, React
          reuses the wrong DOM node — a half-typed input can jump rows. I did
          not prove any such reorder path fires, so this is reported as a review
          item, not a confirmed defect.
Fix:      Audit the non-static cases and key by a stable id. Do not mass-rewrite
          the skeleton/star cases — index is correct there.
Status:   OPEN (needs confirmation: whether plan-generator's list is reorderable
          or splice-editable in practice)
```

---

## C2-14

```
[CLAUDE-2][LOW][REACT] Three exhaustive-deps warnings, one of them a genuine ref-in-cleanup bug
File:     components/capture/document-capture.tsx:24
Problem:  The full lint run produces exactly three warnings. Two are a missing
          `toastError` dep (benign — a stable toast handle). The third is the
          classic stale-ref-in-cleanup shape and is worth fixing.
Evidence: $ npx next lint --max-warnings=99999
            ./components/capture/document-capture.tsx
              24:31  Warning: The ref value 'generation.current' will likely have changed by the
                     time this effect cleanup function runs. If this ref points to a node rendered
                     by React, copy 'generation.current' to a variable inside the effect, and use
                     that variable in the cleanup function.  react-hooks/exhaustive-deps
            ./components/modules/messages-module.tsx
              208:6  Warning: React Hook useCallback has a missing dependency: 'toastError'.
              278:6  Warning: React Hook useCallback has a missing dependency: 'toastError'.
Impact:   In document-capture the cleanup reads generation.current after it may
          already have advanced, so the cleanup can cancel the wrong generation —
          i.e. a superseded capture can tear down the current one. Low frequency,
          but it is a real correctness bug rather than lint noise.
Fix:      Copy generation.current into a local inside the effect and close over
          the local in the cleanup. For messages-module, add toastError to both
          dependency arrays.
Status:   OPEN
```

---

## Verified clean — no action needed

Recorded so a later pass does not spend time here.

1. **Horizontal overflow from wide tables — clean.** All 48 `<table>` elements
   carrying a `min-w-[…]` sit inside an `overflow-x-auto` wrapper. Checked every
   one; sampled and read the surrounding markup for
   `app/(app)/marketplace/insights/page.tsx:111`,
   `app/(app)/family/permissions/page.tsx:51`,
   `app/(app)/dashboard/journeys/page.tsx:64`,
   `app/(app)/dashboard/sync/page.tsx:118`,
   `components/modules/sports-module.tsx:356`,
   `components/social/posts-list.tsx:26`,
   `components/auto/service-client.tsx:41`,
   `components/home/service-client.tsx:48`,
   `components/modules/experience-scorecard-module.tsx:136` — all wrapped.
   No page-level horizontal scroll found at 360px from fixed widths.

2. **iOS input auto-zoom — already solved, deliberately.** app/globals.css:139-145
   forces `font-size: 16px !important` on input/textarea/select under
   `@media (max-width: 640px), (pointer: coarse)`, correctly excluding
   checkbox/radio/range/color/file, with a comment explaining why `!important`
   is required to beat Tailwind's `text-sm`/`text-xs`. This neutralises what
   would otherwise be 143 undersized controls.

3. **The shared Modal is genuinely accessible.** components/ui/modal.tsx
   implements focus move-in, a Tab trap in both directions, Escape, body scroll
   lock, focus restore to the trigger, `role="dialog"`, `aria-modal`,
   `aria-labelledby` and `aria-describedby`. The problems in C2-01 and C2-04 are
   components that *bypass* it, not defects in it.

4. **Internal link integrity — clean.** 0 genuine dead internal links across
   ~1,000 components, checked against 484 static + 55 dynamic routes. See C2-12.

5. **React hook hygiene — near-clean.** 3 lint warnings total (C2-14). No
   missing-dep loops, no uncontrolled→controlled input switches found.

6. **Touch targets — clean.** Exactly 1 `<button>` in the codebase uses an
   `h-5`/`h-6`/`h-7` height class. Icon buttons standardise on `h-10 w-10` /
   `p-1.5` inside larger rows.

7. **Error boundaries — adequate.** 16 `error.tsx` including the route-group
   root `app/(app)/error.tsx`, plus `app/error.tsx` and `app/global-error.tsx`.
   Every authenticated segment resolves to a boundary. (Contrast with
   `loading.tsx`, which is C2-08.)

8. **No dead UI from TODOs.** 6 TODO/FIXME comments in .tsx, all explanatory
   notes referencing tracked milestones (M6, M16, M23, M35, 0416); none marks an
   unimplemented rendered control. No `alert()` or `prompt()` anywhere.

---

## Method, and what this pass could not reach

- Scanners were written as brace-aware JSX parsers (tracking `{}` depth and
  string state) rather than line greps, because a naive `<input[^>]*>` regex
  terminates on the `=>` of an inline arrow handler and silently mis-reports
  attributes. An early version of the C2-02/C2-03 scan did exactly that and
  produced a wrong count; the numbers above come from the corrected parser.
- Label association was resolved structurally, by tracking `<label>` open/close
  depth in document order, so a control wrapped by a label several lines above
  is correctly counted as labelled. 220 such wrapping labels were excluded.
- `<h1>` presence was resolved through the page → component import graph AND the
  parent `layout.tsx` chain. The first attempt over-matched, because a deep
  import walk reaches `trial-paywall-gate.tsx`'s conditional `<h1>`; the 19
  pages in C2-05 were each confirmed by reading the page and its module.
- **Not reached, and honest about it:** no browser was run. Colour contrast was
  therefore not measured — the tokens (`text-muted` on `bg-surface/40`, the
  `text-[10px]`/`text-[9px]` usages) need a real contrast check against computed
  values, which needs the app running. Focus-visible rendering, actual tab
  order, and screen-reader output are likewise unverified by execution. Every
  finding above is derived from source that was read, not from a live page.
- `npx vitest run` was not executed (≈3 min, and no finding here depends on it).
  `npx next lint` was run in full; its complete output is quoted in C2-14.

---

# Session 2 (2026-09-14) — additional findings

New brief priorities Pass D (C2-01–C2-14 above) did not cover: failed-read
states, success-after-failed-write, i18n leakage, and responsive/modal
behaviour beyond the CI gate. Findings continue the C2 numbering. Written
incrementally as found.

## C2-15

```
[CLAUDE-2][MEDIUM][A11Y] Two "delight" home-surface cards drop useRealtimeQuery's error entirely, so a failed read is indistinguishable from "nothing to show today"
File:     components/memories/on-this-day-card.tsx:22
          components/moments/home-moment-card.tsx:46
Problem:  Both components destructure ONLY `{ data: rows }` from
          useRealtimeQuery, discarding `error` (and `loading`). Both already
          render `null` when there is nothing to show today (by design — they
          are meant to disappear on an ordinary day). Because the read's error
          is never captured, a genuinely FAILED read (RLS denial, network
          error, 500) hits this exact same `return null` path — the widget
          silently vanishes with no distinction from the correct "no memory
          today" / "nothing to prep for" case.
Evidence: $ grep -n "useRealtimeQuery" components/memories/on-this-day-card.tsx components/moments/home-moment-card.tsx
            components/memories/on-this-day-card.tsx:22:  const { data: rows } = useRealtimeQuery<Photo>({
            components/moments/home-moment-card.tsx:46:  const { data: rows } = useRealtimeQuery<Event>({

          Systemic check confirms this is the ONLY exception in the app: every
          other directory under components/ that calls useRealtimeQuery also
          imports the shared ErrorState component and renders it on a failed
          read (checked components/modules [118 files, 86 import ErrorState,
          0 use useRealtimeQuery without it], plus components/vacations,
          wallet, finance, family, meals, marketplace, dashboard — all clean):

            $ comm -23 <(grep -rl useRealtimeQuery components/moments --include=*.tsx|sort) \
                       <(grep -rl ErrorState       components/moments --include=*.tsx|sort)
            components/moments/home-moment-card.tsx
            $ comm -23 <(grep -rl useRealtimeQuery components/memories --include=*.tsx|sort) \
                       <(grep -rl ErrorState       components/memories --include=*.tsx|sort)
            components/memories/on-this-day-card.tsx

          For contrast, the established (correct) pattern is e.g.
          components/modules/chores-module.tsx:210-214 — `loading` guard,
          THEN an `error` guard that renders <ErrorState onRetry=…>, and only
          past both does the code reach any `.length === 0` empty-state check.
Impact:   Low-to-moderate: these are optional bonus widgets on the Home
          dashboard ("On this day" photo memories, the next-moment prep
          card), not primary data views, and they already have a legitimate
          silent-empty state, which caps the harm. But it is precisely the
          "guard that cannot fail" shape the brief calls out: a family whose
          photo read or calendar read is actually failing (bad RLS policy,
          expired session edge case, transient 5xx) sees nothing wrong —
          the card just never appears — with no signal to retry or report it.
Fix:      Destructure `error` from both hooks and, when set (and rows is
          empty), fall back to rendering nothing is still acceptable UX for a
          non-critical delight surface, but log/report the error (e.g. to the
          existing client error-reporting path) rather than discarding it
          silently, OR gate on `error` the same way every other module does
          if these are ever promoted to primary surfaces.
Status:   OPEN
```

---

## C2-16

```
[CLAUDE-2][HIGH][UX] Blog unsubscribe reports success to every visitor even when the database write fails — the exact discarded-write-error shape already shipped once in this codebase
File:     app/api/blog/unsubscribe/route.ts:22-36
Problem:  The GET handler looks up the subscriber, then does:
            await supabase.from('blog_subscribers').update({ status: 'unsubscribed', … }).eq('id', data.id);
          — the `{ error }` from that update is never destructured, never
          checked, and never logged. Two lines later the handler
          unconditionally sets `unsubscribed=1` and redirects to a "you have
          been unsubscribed" confirmation on /blog, regardless of whether the
          UPDATE actually committed.
Evidence: app/api/blog/unsubscribe/route.ts:28-36
            if (data && data.status !== 'unsubscribed') {
              await supabase
                .from('blog_subscribers')
                .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
                .eq('id', data.id);
            }
            home.searchParams.set('unsubscribed', data ? '1' : 'invalid');
            return NextResponse.redirect(home);

          The neighbouring, more-recently-touched endpoint gets this right,
          which is direct proof the correct pattern was known and just not
          applied here — app/api/blog/subscribe/route.ts:60-66:
            const { error } = await supabase.from('blog_subscribers').update({…}).eq('id', existing.id);
            if (error) return NextResponse.json({ error: t('subscribe.couldNotSubscribeRightNow') }, { status: 500 });

          This is the same shape the task brief names as already having
          shipped in this exact endpoint family ("The repo shipped this in
          blog unsubscribe") — confirmed still present in the current tree,
          not yet fixed.
Impact:   A visitor who clicks the one-click unsubscribe link in a marketing
          email, whose UPDATE fails (RLS hiccup, connection pool exhaustion,
          transient DB error — anything that makes `error` non-null), is told
          "you're unsubscribed" and closes the tab believing it. They remain
          `status: 'active'` in blog_subscribers and keep receiving digest
          emails they explicitly asked to stop. Beyond the trust/UX cost, an
          unsubscribe mechanism that can silently no-op is a compliance
          exposure (CAN-SPAM / GDPR-style consent-withdrawal expectations)
          for a **public, unauthenticated** endpoint — every future digest
          recipient is exposed to this failure mode, not just logged-in users.
Fix:      Capture `{ error }` from the update, and when it is set, either
          retry once or set `home.searchParams.set('unsubscribed', 'error')`
          and render a "something went wrong, try again / contact us" state
          instead of the success confirmation — mirroring exactly what
          subscribe/route.ts already does two files away.
Status:   OPEN
```

---

## C2-17

```
[CLAUDE-2][HIGH][UX] Google Calendar OAuth callback tells the user "connected" even when persisting the token fails
File:     app/api/google/calendar/callback/route.ts:57-70
Problem:  After exchanging Google's auth code for a token, the handler upserts
          it into user_preferences.notification_prefs WITHOUT destructuring or
          checking `{ error }`:
            await supabase.from('user_preferences').upsert({ user_id: userId, notification_prefs: merged }, { onConflict: 'user_id' });
            return redirect('connected');
          The whole block sits in a try/catch, but a Supabase query does not
          throw on a write failure — it resolves to `{ data, error }` — so an
          RLS denial, a constraint violation, or any transient DB error on
          this specific upsert is invisible to the catch and the handler falls
          straight through to `redirect('connected')`.
Evidence: app/api/google/calendar/callback/route.ts:66-70 (quoted above) — no
          `const { error }` capture anywhere around the upsert, confirmed by
            $ grep -n "upsert\|error" app/api/google/calendar/callback/route.ts
            57:    const { data: prefs } = await supabase
            66:    await supabase
            67:      .from('user_preferences')
            68:      .upsert({ user_id: userId, notification_prefs: merged }, { onConflict: 'user_id' });
            70:    return redirect('connected');
            72:  } catch (err) {
          i.e. the catch block (line 72) is the ONLY error handling in the
          function, and it cannot see a non-throwing query failure.
          For contrast, the sibling route that refreshes an already-stored
          token (app/api/google/calendar/sync/route.ts:60-62,74-76) has the
          identical unchecked-upsert shape but is lower risk — a failed
          refresh-persist there just means the next request refreshes again
          from the same stored (still-valid) token, i.e. it is self-healing.
          The callback path is not: it is the ONE TIME the token is written,
          and there is no other path that will retry it.
Impact:   A user who connects Google Calendar and hits this failure is
          redirected to /dashboard/calendar?gcal=connected — the app tells
          them the integration is live. It is not: no token was stored, so
          the very next sync attempt (or the sync page's own load) finds
          nothing to sync with. The user has no way to know their earlier
          "success" didn't take; the natural next step is to file a confusing
          bug report ("it says connected but nothing syncs") rather than
          simply reconnecting, because nothing told them it failed.
Fix:      Capture `{ error }` from the upsert and redirect to the existing
          `error` state (`redirect('error')`) when it is set, exactly as
          every other exit path in this function already does for thrown
          exceptions.
Status:   OPEN
```

---

## Verified sound (session 2)

- **The `useRealtimeQuery` error contract is honoured almost everywhere.**
  113 consumers checked; of the 111 that destructure `error`, every single one
  is used downstream (no dead/discarded `error` bindings — confirmed by a
  name-occurrence sweep), and every directory under `components/` that calls
  the hook also imports the shared `ErrorState` component (`components/modules`
  86/118 files import it and 0 call the hook without it; `vacations`, `wallet`,
  `finance`, `family`, `meals`, `marketplace`, `dashboard` all clean). Spot
  checks (`chores-module.tsx:210-214`, `finances-module.tsx:168-170`,
  `wallet-hub.tsx:104-158`) confirm the render order is correct — `loading`,
  then `error` → `<ErrorState onRetry=…>`, and only past both does an
  `.length === 0` empty-state check run. The two exceptions are C2-15.
- **Rollback-on-partial-failure in the child-login flow is a genuinely good
  pattern, not a gap.** `app/(app)/family/child-login-actions.ts:52-94` checks
  every write (`createUser`, the `family_members` link, the `child_logins`
  row, the `user_preferences` upsert) and unwinds everything already done if
  a later step fails (delete the auth user, null the link, etc.) before
  returning `{ ok: false }`. The one unchecked write in the same function
  (clearing a stale login-throttle row at line 86-88) is best-effort cleanup
  after the real action has already succeeded, not a false-success path, so
  it is not flagged.
- **The blog like/save toggle endpoints look like the same "discarded delete"
  shape as C2-16 but are not a bug.** `app/api/blog/like/route.ts:83-95` and
  `app/api/blog/save/route.ts:87-97` don't check the error of the `delete()`
  that completes a toggle after a unique-constraint conflict, but the response
  sent to the client is always a **fresh re-query** of actual DB state
  (`likeState`/`saveState`) rather than an assumed value — so even if that
  delete silently fails, the client is told the true state, not a false
  success. Read in full to confirm before excluding.
- **Non-English catalogues do NOT leak into the client JS bundle.** Checked by
  necessity, not assumption — `lib/i18n/messages.ts` statically imports all 11
  locale JSON files at module scope, and the client-only `translate()`
  function it exports falls back through `SOURCE_MESSAGES` (the en-US
  catalogue), which made me suspect webpack could not tree-shake the other 10
  out of any client bundle importing this module (which `locale-provider.tsx`,
  used app-wide, does). Verified directly against the existing production
  build already on disk (`.next/`, built 2026-09-13 by Claude-1's F-C03 work —
  not rebuilt by me): a distinctive German string
  (`"konnte nicht festgelegt werden"`, from `de-DE.json`) does not appear
  anywhere under `.next/static/chunks` (0 matches across 717 client chunk
  files) but does appear in `.next/server/chunks` (SSR only, correct). Tree-
  shaking is working; the "ships one language" claim in scopes.ts holds at
  the JS-bundle level too, not just the RSC-payload level Pass C measured.
- **The exact "raw catalogue key leaks to a visitor" class the brief names has
  real, working regression coverage — with two genuine historical incidents
  as proof it isn't theoretical.** `tests/catalogue-key-not-rendered-raw.test.ts`
  and `tests/catalogue-key-rendered-through-t.test.ts` both exist because of
  real production bugs (the footer literally showed "siteFooter.acceptableUse"
  to every visitor; `/pricing` showed "pricingContent.sharedFamilyCalendar" in
  every language). Ran both (not part of the full suite — single targeted
  files, per the audit's evidence standard):
    $ npx vitest run tests/catalogue-key-not-rendered-raw.test.ts tests/catalogue-key-rendered-through-t.test.ts
    Test Files  2 passed (2)   Tests  3 passed (3)
  One of the three is itself a proof the guard catches the bad case (a unit
  test against a known-bad fixture matching the exact pricing-page incident),
  which satisfies this audit's "prove the guard can fail" standard without me
  needing to plant a regression in product source. `tests/i18n-client-scope.test.ts`
  additionally walks the real import graph from every page and fails if a
  scoped surface's namespace list falls behind its components' t() calls —
  read in full, sound design, not run (no live gap to reproduce).
- **Hand-rolled modals size correctly at small viewports.** `components/ui/modal.tsx:90-105`
  — `max-h-[85dvh] overflow-y-auto`, a bottom-sheet layout below `sm:`, safe-
  area-aware bottom padding (`env(safe-area-inset-bottom)`), and a 40px
  (`h-10 w-10`) close target. No overflow or clipping risk at 360px width from
  the source.
- **`<img>`/`<Image>` alt text in the authenticated app is clean, matching
  Pass A's public-page result.** Scanned all 57 `<img>` and 6 `<Image>`
  elements under `components/` + `app/(app)/`: 0 missing `alt`. (One apparent
  hit, `components/blog/blog-cover.tsx:53`, was a false positive — a naive
  regex matched a literal `<img>` written inside a code COMMENT describing the
  component's behaviour; the component renders inline SVG, no `<img>` tag
  exists there at all. Recorded so a future pass doesn't re-flag it.)
- **Sticky elements read as intentional, not content-covering** — checked all
  13 files using `sticky` (`app-shell.tsx`/`admin-shell.tsx` top bars,
  `site-header.tsx`, `rules-editor.tsx`'s sticky header+footer,
  `print-sheet.tsx`, `assistant/workspace.tsx`'s segmented control). All are
  headers/toolbars/footers with backdrop blur and consistent z-index
  layering, the standard pattern for this. **Caveat, stated plainly: this is
  a source-reading judgement, not a measurement** — confirming no sticky
  element actually overlaps scrollable content at 360-400px needs the app
  running in a real viewport, which this pass did not do (no browser
  available). Not claimed as verified in the same sense as the items above.

**A note on method, since it changed a conclusion.** I re-ran an independent,
fast regex sweep for icon-only buttons with no accessible name (C2-11's
territory — the first pass reported exactly 2). Mine reported ~900. I did not
report that number. Spot-checking the first two hits
(`components/modules/decisions-module.tsx:113`, `components/modules/devices-module.tsx:92`)
showed both were false positives — one because the visible label was inside a
`{tr(...)}` expression my regex's "has text" check couldn't see through, the
other because it already carries `title={tr('devices.cycleStatus')}` and my
attribute-scope capture mis-bounded around it. This is the identical failure
mode the first pass's "Method" section already documents and built a
brace-aware parser to avoid. I trust C2-11's count over mine and did not
re-litigate it; recorded here so nobody re-derives a wrong ~900-item version
of this finding later.

---

## C2-18

```
[CLAUDE-2][MEDIUM][A11Y] Zero component-level error boundaries anywhere in the app — a render throw in any one Home widget takes down the entire dashboard, not just that widget
File:     app/(app)/home/page.tsx (797 lines, 13 distinct widget components composed inline)
Problem:  The first C2 pass verified route-level error.tsx boundaries exist
          (16 files) and called that "adequate" — true for the question it
          asked, but it did not examine GRANULARITY. There is no per-widget
          error isolation anywhere in the codebase: zero uses of a component
          named ErrorBoundary, and zero <Suspense> boundaries wrap any Home
          widget (Suspense exists in exactly 6 places app-wide, none of them
          Home). Home composes HomeMomentCard, OnThisDayCard, TimeOfDayFocus,
          AskBar, NeedsAttention, WorkingOn, CompletedByBubaly,
          TimeSavedBanner, FamilyValueComparison, ReferralHomeCard,
          DoOneThingCard, OutcomesStrip and more, all as plain inline JSX in
          one server-rendered tree.
Evidence: $ grep -rl "ErrorBoundary\b" . --include=*.tsx --include=*.ts | grep -v node_modules
            (no matches — the string does not exist anywhere in app source)
          $ grep -rn "<Suspense" app components --include=*.tsx
            6 matches total, in signup/login/billing/join/marketplace-nav —
            none in app/(app)/home/page.tsx or any widget it renders.
          $ grep -n "^import.*components/" "app/(app)/home/page.tsx" | wc -l
            13
          Because React's error boundary is a class-component concept with no
          function-component equivalent, and none exists in this codebase, a
          thrown error during the render of ANY of those 13 widgets is caught
          only by the nearest ancestor error.tsx — which for Home is the
          route-group root (app/(app)/error.tsx) or dashboard layout's, i.e.
          the boundary that also covers chores, calendar, finances and every
          other authenticated surface reachable from that layout.
Impact:   A defect confined to one small, low-stakes widget (say, a null
          check missed in a date-formatting helper inside ReferralHomeCard or
          OutcomesStrip) currently has the blast radius of the WHOLE Home
          dashboard: every family member who opens the app sees a full error
          screen instead of "everything except one card". This is the
          inverse of graceful degradation — the app has no mechanism to
          degrade partially, only wholly. It compounds C2-15 in the other
          direction: C2-15 is a widget that fails silently (too quiet);
          this is the app having no way for ANY widget to fail quietly even
          if it wanted to.
Fix:      Add a small class-component <WidgetErrorBoundary fallback={null}>
          (or a name matching house style) and wrap each independently-
          optional Home card in it, so one widget's exception renders nothing
          (or a small inline retry) instead of replacing the page. Prioritise
          Home first — it is the highest-traffic, most widget-dense page —
          then apply the same wrapper to other dashboards that compose many
          independent data sources in one tree (e.g. any *-module.tsx that
          itself renders several unrelated sub-panels).
Status:   OPEN
```

---

# Findings from the parallel audit session (merged 2026-09-13T23:51Z)

Two audit sessions ran against this repository at the same time. Both
wrote to this path, so git saw an add/add conflict. **Neither side is
discarded** — the rule is that no worker's findings are deleted, and that
applies across sessions as much as within one. The other session's file
follows verbatim; it uses a different finding format, which is left as it
was written rather than reformatted.

# Claude-2 — Frontend / UI / UX / Responsive / Accessibility

Owned by Claude-2. No other worker writes findings here.

Created by Claude-1 as an empty template so the file exists for you; nothing
below the line is authored by anyone but you.

## Finding format

    [CLAUDE-2][SEVERITY][AREA] Short title
    - **File/path:**
    - **Problem:**
    - **Evidence:**            <- a command, output, probe or measurement
    - **Impact:**
    - **Recommended fix:**
    - **Status:** OPEN | VERIFIED | FIXED | BLOCKED

Severities: CRITICAL, HIGH, MEDIUM, LOW.
Evidence means something reproducible. "Looks wrong" is not a finding.

Before modifying any source file, check `audit/status.md` FILES-TOUCHED for
every other worker. If someone else holds it, audit it and record a
recommendation instead of editing.

---

## Findings

_(none yet)_

---
---

# ══════════════════════════════════════════════════════════════════
# SESSION 2 — 2026-09-14 — THE BROWSER PASS (public surface only)
# ══════════════════════════════════════════════════════════════════

Everything above this line was derived by **reading source**. Everything below
was derived by **running Chromium against the production build on
`http://localhost:3210`**. This section closes the gap `finalaudit.md` names as
blocking completion:

> - [ ] Run a browser: contrast, tab order, screen-reader output (Pass D).

New findings in this section are numbered `C2-B01`… so they never collide with
the session-1 `C2-01`…`C2-14`. Nothing above was edited or deleted.

## STATUS

```
CURRENT:   COMPLETE — browser pass over the public marketing/auth surface.
COMPLETED:
  - axe-core 4.12 over 23 public routes x 2 viewports (1280 / 390) = 46 runs,
    all HTTP 200, 0 script errors.
  - Colour contrast measured in BOTH themes: 23 routes x 2 viewports x 2 themes
    = 92 further axe runs, plus a design-token ratio table and a hand-rolled
    gradient-aware sampler for the 2,263 nodes/theme axe could not compute.
  - Real tab order (key-by-key), focus-visibility deltas, keyboard operation of
    the nav, mobile drawer, language picker, FAQ tabs+accordion and the cookie
    consent banner + preference centre.
  - Accessibility-tree (ARIA) snapshots of /login, /contact, the consent dialog,
    the language listbox and the FAQ panel — this is the "screen-reader output"
    half of the gap, done through the a11y tree rather than a live SR.
  - Responsive: overflow + tap-target measurement at 390px and 360px with
    REAL touch emulation (hasTouch/isMobile), which is what makes the
    `coarse:` (pointer:coarse) utilities apply.
  - 17 new findings, C2-B01-C2-B17 (2 HIGH, 10 MEDIUM, 5 LOW)
    + 9 verified-clean items (one of them amended after a browser re-check)
    + 3 method corrections to my own first measurements.
    C2-B17 and the third correction are in the Addendum at the end of the file.
NEXT:      nothing queued. Awaiting Claude-1 triage.
FILES-TOUCHED: audit/claude-2.md ONLY. **No application source was modified.**
           Throwaway scripts + JSON/PNG evidence live in
           /tmp/claude-0/-home-user-Bubaly/c1fd8263-765f-561d-b8eb-99365eb20176/scratchpad/
           (scan.mjs, keyboard.mjs, focus2.mjs, touch.mjs, contrast2.mjs,
            contrast3.mjs, tokens.mjs, aria.mjs, lightform.mjs, cta.mjs → out/*.json, out/*.png)
BLOCKERS:  Supabase is stubbed with dummy credentials -> NO session exists, so
           app/(app) (354 pages) could not be opened at all. Pass D's findings
           about the authenticated app REMAIN STATICALLY DERIVED. Also
           unreachable: /s/[slug], /gift/[token], /pay/[handle], /blog/[slug],
           /customers/[slug] — every one needs a row from the database.
           See "BLOCKED — what a browser still could not see" at the end.
           Empty DB-backed lists are NOT reported as defects anywhere below.
LAST-UPDATE: 2026-09-14
```

## How the theme actually works — a correction to the brief

The task brief said `data-theme` / `prefers-color-scheme` drive the theme. In
this app **neither is true**, and getting this wrong silently invalidates a
contrast pass, so it is recorded first:

- The theme is a **class** on `<html>` — `.dark` or `.light` (`app/globals.css:29`,
  `components/theme/theme-script.tsx`). `data-theme` is **never set**
  (measured: `document.documentElement.getAttribute('data-theme')` → `null`).
- The source of truth is `localStorage['bubaly-theme']`, defaulting to `'dark'`.
- `prefers-color-scheme` is consulted **only** when the stored value is
  literally `'system'`. Measured on `/login` with three emulated OS settings:

```
colorScheme=light        -> html class "dark", body rgb(3,9,15),  prefersLight=true
colorScheme=dark         -> html class "dark", body rgb(3,9,15),  prefersLight=false
colorScheme=no-preference-> html class "dark", body rgb(3,9,15),  prefersLight=true
```

  A first-time visitor whose OS is in light mode gets the dark theme. That is a
  deliberate product default (the code says so) and is **not** filed as a
  defect — but it means a contrast pass driven by `prefers-color-scheme` alone
  would have measured the dark theme twice and never seen the light one.
  Every light-theme measurement below was taken by pinning
  `localStorage['bubaly-theme']='light'` via `addInitScript` in a dedicated
  browser context, and each run asserts the resulting `<html class>` before it
  measures. 92/92 runs reported the theme they asked for.

---

## C2-B01

```
[CLAUDE-2][HIGH][A11Y] `.focus-ring` is an UNCONDITIONAL ring: 202 call sites paint a focus indicator permanently, so focus itself is invisible
File:     app/globals.css:179-181  (the definition)
          compiled: .next/static/css/efe55d1639ee1e52.css
          worst public call sites: components/ui/input.tsx:5 (every Input /
          Textarea / Select in the product), components/i18n/language-picker.tsx:113
          and :160, components/marketing/faq-accordion.tsx:20,
          components/marketing/faq-tabs.tsx:64, components/theme/theme-toggle.tsx,
          components/marketing/site-footer.tsx:107
Problem:  .focus-ring is written as a plain component class, not a state variant:

            .focus-ring { @apply outline-none ring-2 ring-brand/60 ring-offset-2 ring-offset-bg; }

          which compiles to an unconditional rule:

            .focus-ring{outline:2px solid transparent;outline-offset:2px;
              --tw-ring-color:rgb(var(--brand)/0.6);--tw-ring-offset-width:2px;
              box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),...}

          It therefore does two harmful things at once:
            1. it paints the brand ring ALL THE TIME, on every element that
               carries the class; and
            2. `outline:2px solid transparent` suppresses the browser's own
               focus outline.
          The result is that focusing the element changes NOTHING — the
          "focus indicator" was already on. WCAG 2.4.7 Focus Visible (AA) is
          failed, not by omission but by a ring that never turns off.

          Source counts (grep over app/ + components/):
            bare `focus-ring`            202 occurrences
            `focus-visible:focus-ring`    16 occurrences
          The 16 correct ones are almost all in components/marketing/site-header.tsx.

Evidence: (1) Measured on the rendered homepage while
          `document.activeElement === document.body` (NOTHING focused).
          8 elements carrying bare `.focus-ring` were painting the full ring:

            {"tag":"button","cls":"...rounded-full glass transition focus-ring h-8 w-8...",
             "boxShadow":"rgb(3, 9, 15) 0px 0px 0px 2px, rgba(116, 75, 232, 0.6) 0px 0px 0px 4px, ...",
             "outline":"solid 2px"}
            {"tag":"button","text":"en-USUSUnited States · English", ... same ring ... }
            + the six footer social links ("Bubaly on Facebook" … "Bubaly on TikTok")

          (2) Before/after on the SAME element, with a 400ms settle so the
          150ms Tailwind `transition` cannot skew the read
          (`[data-testid="language-picker"] > button`):

            before: outline "solid 2px rgba(0, 0, 0, 0)"
                    boxShadow "rgb(3, 9, 15) 0px 0px 0px 2px, rgba(116, 75, 232, 0.6) 0px 0px 0px 4px, ..."
            after : outline "solid 2px rgba(0, 0, 0, 0)"
                    boxShadow "rgb(3, 9, 15) 0px 0px 0px 2px, rgba(116, 75, 232, 0.6) 0px 0px 0px 4px, ..."
            changed: FALSE      matchesFV: true      isActive: true

          Byte-identical. The element matches `:focus-visible`, it IS the active
          element, and its computed style does not move.

          (3) /login, the most important public form, with activeIsBody === true:
          BOTH text inputs, the submit button, the theme toggle and the language
          trigger all render
            "rgb(3, 9, 15) 0px 0px 0px 2px, rgba(116, 75, 232, 0.6) 0px 0px 0px 4px"
          Focusing the email input returns the byte-identical box-shadow.
          Screenshots: out/login-nothing-focused.png, out/login-light.png —
          every control on the sign-in card wears a purple ring simultaneously.

          (4) The language menu, open, 11 options: out/language-menu-open.png
          shows all eleven `role="option"` buttons ringed at once. There is no
          way to see which one the keyboard is on.
Impact:   Keyboard-only and low-vision users cannot tell where focus is on the
          sign-in form, the sign-up flow, the contact form, the FAQ accordion,
          the language menu or the theme toggle — i.e. on every interactive
          control that does not live in the marketing header. It is also a
          plain visual defect for everyone: the product's own screenshots show
          a login form where every field looks focused.
Fix:      One-line root fix — make the class a state variant, then delete the
          16 `focus-visible:` prefixes that exist only to work around it:
            .focus-ring { @apply outline-none; }
            .focus-ring:focus-visible { @apply ring-2 ring-brand/60 ring-offset-2 ring-offset-bg; }
          (or move the whole thing into `@layer utilities` as
          `focus-visible:ring-2 …` and keep the prefix at call sites.)
          **Do not ship this without C2-B04.** The permanent ring is currently
          the only thing that makes a text input's boundary visible; turning it
          off while the 1.28:1 border stands would leave the fields with no
          visible edge at all. The two must land together.
          Regression guard (this is the F-D10 lesson again — no lint rule or
          test could see this): assert in a Playwright test that
          getComputedStyle(el).boxShadow differs before and after focus for one
          element of each class.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B02

```
[CLAUDE-2][HIGH][A11Y] Every primary CTA on the marketing site is white text at 3.68:1 — axe cannot see it because the background is a gradient
File:     components/marketing/site-header.tsx:106,109 (10px text)
          components/marketing/cta.tsx / sections.tsx (hero + section CTAs, 14px)
          components/marketing/faq-tabs.tsx:66 (the SELECTED tab)
          app/(marketing)/pricing/pricing-content.tsx ("Start Family Basic")
Problem:  The brand CTA is `bg-gradient-to-r from-blue-500 to-violet-600` with
          white text. Measured computed style, on the live homepage:

            backgroundImage: linear-gradient(to right, rgb(59, 130, 246), rgb(124, 58, 237))
            color:           rgb(255, 255, 255)
            fontSize:        10px / 14px, fontWeight 500-600

          Over the violet end (124,58,237) white is 5.90:1 — fine. Over the
          BLUE end (59,130,246) white is **3.68:1**. The text is centred in a
          wide pill, so its left-hand glyphs sit on the bluest part of the run.
          At 10px/600 and 14px/600 this is normal-size text, so WCAG 1.4.3
          (AA) requires 4.5:1. It fails.
Evidence: Hand-computed from the measured colours (sRGB relative luminance):
            L(white)              = 1.0000
            L(rgb 59,130,246)     = 0.2355
            ratio = (1.0 + 0.05) / (0.2355 + 0.05) = 3.68 : 1     need 4.5 : 1
          Independently produced by the gradient-aware sampler on 11 of 12
          scanned routes for the header CTA alone
          (out/contrast3.json, theme=dark, "Get Started Free", 10px, 3.68:1).

          Controls measured carrying exactly this gradient + white text:
            "Get started"            10px 600   (mobile header CTA)
            "Get Started Free"       10px 600   (desktop header CTA)
            "Get Started Free"       14px 600
            "Start Free Trial"       14px 600   (hero)
            "Read the Trust Center"  14px 600
            "Start free, no card"    14px 600
            "Start Family Basic"     14px 600   (/pricing)
            FAQ selected tab         14px 500   (/faq) — the SELECTED state is
                                                 the least readable one
          Why the axe pass missed it: over 92 contrast runs axe returned
          **4,603 `incomplete` node instances**, the single largest reason being
            326 x "Element's background color could not be determined due to a
                   background gradient"
          axe declines to judge gradient backgrounds, so the product's most
          important buttons are exactly the elements its report is silent about.
Impact:   The main conversion control on every marketing page is below the AA
          text-contrast floor, at 10px in the header. Low-vision users, and
          anyone outdoors on a phone, lose the primary call to action.
Fix:      Darken the blue stop until white clears 4.5:1 — `blue-600` #2563eb
          gives 4.68:1 with white; `blue-700` #1d4ed8 gives 6.30:1. Changing
          only the FIRST stop keeps the gradient's look. Alternatively raise the
          10px header CTAs to >=14px and keep them on the violet end.
          Add a unit test over the token pair, since no scanner will catch this.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B03

```
[CLAUDE-2][MEDIUM][A11Y] The LIGHT theme's semantic status colours are below AA — and light is the theme nobody had ever rendered
File:     app/globals.css (the `.light` token block)
Problem:  Dark and light do not have equivalent contrast. In dark every semantic
          token is comfortable (7-12:1). In light, three of them fall below the
          4.5:1 body-text floor and two fall below even the 3:1 large-text/UI
          floor. Measured from the computed custom properties on a rendered page
          in each theme (out/tokens.json):

            token pair                 DARK          LIGHT
            --fg      on --bg         17.53:1       15.85:1     ok / ok
            --muted   on --bg          7.60:1        4.91:1     ok / ok (thin)
            --muted   on --surface     7.25:1        5.27:1     ok / ok
            --brand-text on --bg       6.96:1        6.36:1     ok / ok
            --brand-fg on --brand      5.36:1        5.04:1     ok / ok
            --info    on --bg          7.87:1        4.82:1     ok / ok (thin)
            --danger  on --bg          7.13:1      **4.09:1**   ok / FAIL AA body
            --danger  on --surface     6.80:1      **4.38:1**   ok / FAIL AA body
            --success on --bg          9.64:1      **2.91:1**   ok / FAIL even 3:1
            --warning on --bg         11.74:1      **2.70:1**   ok / FAIL even 3:1
            --warning on --surface    11.20:1      **2.89:1**   ok / FAIL even 3:1
            --brand   on --bg          3.73:1        4.70:1     large/UI only / ok
Evidence: `--danger` is not theoretical on the public surface — it is the colour
          of the required-field marker and of form error text. Measured live on
          /login in the light theme:

            required asterisk: text "*", color rgb(213, 70, 70), 14px,
            on card rgb(255,255,255)  ->  4.38 : 1     (AA body needs 4.5)

          `--success` / `--warning` are used for status chips and toasts, which
          live behind the login wall, so I could not render them (see BLOCKED).
          The token ratios above are measured, the chip usage is not.

          Why axe reported none of this: axe skips single-character content
          ("Element content is too short to determine if it is actual text
          content" — 81 such incompletes across the runs), and no error/success
          state was on screen during an unauthenticated crawl.
Impact:   In the light theme the marker that says a field is mandatory, and the
          colour that says "this went wrong", are the least legible text on the
          page. The dark theme hides the problem entirely, which is why eleven
          prior passes did not see it.
Fix:      Re-derive the light-theme `--danger`, `--success` and `--warning`
          ramps against `--bg` and `--surface` for >=4.5:1 as TEXT (they are
          currently picked as though they were only fills). Keep the current
          values as separate `--*-fill` tokens if the lighter hue is wanted for
          backgrounds. A 20-line unit test over the token table would pin this.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B04

```
[CLAUDE-2][MEDIUM][A11Y] Text inputs have no visible boundary of their own: border 1.28:1 (light) / 1.38:1 (dark), fill identical to the card
File:     components/ui/input.tsx:4-5  (`base`, shared by Input, Textarea, Select)
Problem:  `base` is `bg-surface/60 border border-border`. Measured on the live
          /login card:

                              LIGHT                         DARK
            input border      rgb(222, 228, 240)            rgb(35, 45, 62)
            input fill        rgba(255, 255, 255, 0.6)      rgba(9, 16, 26, 0.6)
            card background   rgba(255, 255, 255, 0.72)     rgba(9, 16, 26, 0.72)
            border : fill        **1.28 : 1**                  **1.38 : 1**
            fill   : card        **1.00 : 1**                  **1.00 : 1**

          WCAG 1.4.11 Non-text Contrast (AA) requires 3:1 for the visual
          information needed to identify a user-interface component. The fill
          is indistinguishable from the card behind it (1.00:1), so the border
          is the only boundary — and the border is at 1.28:1.
Evidence: out/login-light.png and out/login-nothing-focused.png. The fields are
          currently legible ONLY because C2-B01's permanent ring outlines them.
Impact:   A low-vision user cannot see where the text fields are. Today the bug
          in C2-B01 is masking it.
Fix:      Raise `--border` (dark 1.44:1 / light 1.19:1 against `--bg` — both far
          under 3:1), or give form controls a dedicated `--border-input` token
          at >=3:1 against `--surface`. **Sequence matters: this must land with
          or before C2-B01**, or fixing the focus ring will make every input
          invisible.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B05

```
[CLAUDE-2][MEDIUM][A11Y] The cookie preference centre declares aria-modal="true" and manages no focus at all — the public instance of the F-D04 class
File:     components/marketing/consent-manager.tsx:140-150 (PreferenceCenter)
Problem:  Same defect class as finalaudit F-D04, but in a FIFTH file that F-D04
          does not list, on a page every visitor sees, and reached from the
          consent banner that blocks the bottom of every marketing route.
            <div className="fixed inset-0 z-[80] …" role="dialog" aria-modal="true" …>
          `aria-modal="true"` tells assistive tech everything outside is inert.
          Nothing moves focus in, nothing traps Tab, nothing handles Escape.
Evidence: Driven by keyboard only, on a fresh no-storage context:
            open via Enter on "Manage preferences"
            dialog present:        {"label":"Privacy preferences","aria-modal":"true"}
            focus after open:      {"none": true}     <- focus fell to <body>
            Tab x 16 walk:
              1 Close            inDialog=true
              2 Analytics        inDialog=true  (role=switch)
              3 Personalization  inDialog=true
              4 Email updates    inDialog=true
              5 Text updates     inDialog=true
              6 Reject non-essential  inDialog=true
              7 Accept all       inDialog=true
              8 Save choices     inDialog=true
              9 (body)
             10 "Skip to content"      inDialog=FALSE   <- escaped the dialog
             11 "Bubaly home"          inDialog=FALSE
             12-16 the whole site nav  inDialog=FALSE
            escapedDialog:         true
            Escape pressed -> stillOpenAfterEscape: true
          The ARIA tree is otherwise good — `dialog "Privacy preferences"`, the
          four toggles expose `role=switch` with `aria-checked` and names.
          The semantics are right; the focus behaviour is absent.
Impact:   A screen-reader user opening privacy preferences tabs out of a dialog
          their AT has been told is modal, into content it will not announce,
          with no Escape. This is the consent surface, so it is also the one
          dialog with a regulatory reason to be operable.
Fix:      Route it through components/ui/modal.tsx, which already implements
          focus move-in, Tab trap, Escape, scroll lock and focus restore. If the
          bespoke chrome must stay, lift that effect verbatim.
          Note the banner itself (role="dialog", no aria-modal) is correctly
          NON-modal and needs no trap — only the preference centre does.
Status:   OPEN — VERIFIED IN BROWSER (new file; extends F-D04 to the public surface)
```

---

## C2-B06

```
[CLAUDE-2][MEDIUM][A11Y] The language listbox sits BEFORE its trigger in the DOM, so Tab walks out of the open menu; arrow keys do nothing
File:     components/i18n/language-picker.tsx:96-141 (listbox) vs :152-176 (trigger)
Problem:  The menu is rendered above the trigger in source order and positioned
          with `absolute bottom-full`. Visually it is a popup over the button;
          in the tab sequence it is eleven stops BEFORE it. It also declares
          `role="listbox"` / `role="option"` but implements none of that
          pattern's keyboard contract: no roving tabindex, no
          aria-activedescendant, no Arrow/Home/End handling, and every option is
          a natively-focusable `<button>` (so all eleven are tab stops).
Evidence: Driven from the trigger on the live homepage:
            children of [data-testid=language-picker] in DOM order:
              ["listbox", "button"]                 <- menu first, trigger second
            optionCount: 11
            Enter on trigger      -> listbox opens, focus STAYS on the trigger
            Tab                   -> "Bubaly on Facebook" (the next footer link) —
                                     focus left the open menu entirely
            ArrowDown             -> focus unchanged (still the trigger)
            Shift+Tab from trigger-> option "Português (Portugal)" — the LAST
                                     option, i.e. the only way in is backwards
            Escape                -> menu closes, focus returns to the trigger  (correct)
          ARIA tree is good: `listbox "Choose your language"` with
          `option "English (United States)" [selected]` and ten more.
Impact:   A keyboard user who opens the language menu and presses Tab — the
          natural next key — is thrown out of it into the footer, with the menu
          still open behind them. Reaching a language requires guessing
          Shift+Tab and then walking the list backwards from Portuguese. Bubaly
          ships eleven locales; this is the control that selects them.
Fix:      Render the listbox AFTER the trigger in source order (keep
          `absolute bottom-full` for the upward placement), move focus to the
          selected option on open, give options `tabIndex={-1}` with a roving
          index, and handle ArrowUp/ArrowDown/Home/End/Enter. Escape and the
          focus-restore already work and should be kept.
          (Its options also carry bare `focus-ring` — see C2-B01 — so even with
          arrow keys added, the moving focus would still be invisible.)
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B07

```
[CLAUDE-2][MEDIUM][A11Y] Footer link tap targets are 11px tall on a phone (WCAG 2.5.8 requires 24px); the legal row is 17px
File:     components/marketing/site-footer.tsx:122  (`text-[10px] text-muted`)
          components/marketing/site-footer.tsx (bottom legal row + ConsentReopenLink)
Problem:  The footer's four link columns render at `text-[10px]`, which at the
          default line-height gives an 11px-high hit area with no padding. WCAG
          2.2 Success Criterion 2.5.8 Target Size (Minimum), level AA, requires
          24x24 CSS px. The "inline in a sentence" exception does not apply —
          these are stacked navigation links in a `<ul>`.
Evidence: Measured at 390x844 with REAL touch emulation
          (`isMobile:true, hasTouch:true`, so `@media (pointer: coarse)` applies
          — confirmed `pointerCoarse: true` on every run). Present on 10 of 10
          marketing routes measured:

            a 106x11  "What Bubaly handles"      text-[10px] text-muted
            a  64x11  "How it works"
            a  34x11  "Pricing"
            a  55x11  "Mobile app"
            a  68x11  "Kitchen Mode"
            a  80x11  "Handled for you"
            a  61x11  "Trust Center"
            a  22x11  "Blog"
            a  39x11  "Contact"
            a  19x11  "FAQ"
            a  76x11  "Create account"
            a  30x11  "Log in"
            a  84x11  "Switch to Bubaly"
            a  68x11  "Privacy Policy"
            a  82x11  "Terms of Service"
            a  77x11  "Acceptable Use"
            a  66x11  "Cookie Policy"
            a  40x17  "Privacy"        (bottom legal row)
            a  32x17  "Terms"
            a  85x17  "Acceptable Use"
            a  43x17  "Cookies"
            button 85x17 "Privacy choices"   (the consent re-open control)

          Passing 24px but under the 44px touch guideline, for completeness:
            button  98x32 "Accept all"            (consent banner)
            button 172x34 "Reject non-essential"
            button 163x32 "Manage preferences"
            button  40x40 theme toggle in the AUTH layout — see C2-B14
Impact:   18 links per page, including every legal link and the control that
          re-opens privacy choices, are an 11px-tall strip on a phone. Anyone
          with a motor impairment, and most people on a moving bus, will miss.
Fix:      `py-1.5` (or `min-h-6` / `coarse:min-h-11`) on the footer `<li>`
          anchors and on the legal row. The footer already knows how — its
          social icons carry `coarse:min-h-11 coarse:min-w-11` and measure 36px
          (44 on touch). The text links were simply never given it.
          Raising `text-[10px]` to `text-xs` would fix the target and C2-B15
          at once.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B08

```
[CLAUDE-2][MEDIUM][A11Y] The shared Field primitive exposes "required" as a red asterisk and nothing else — no aria-required, no aria-invalid, no aria-describedby
File:     components/ui/input.tsx:31-60 (Field)
Problem:  Field renders `{required && <span className="ml-0.5 text-danger">*</span>}`
          INSIDE the `<label>`, and passes `required` to nothing. It also
          renders `hint` and an `error` with `role="alert"` as loose siblings,
          with no `aria-describedby` linking them to the control and no
          `aria-invalid` on the control when an error is showing.
Evidence: Accessibility tree of /login `<main>` (Playwright ariaSnapshot):

            - textbox "Email*":
                /placeholder: you@example.com
            - textbox "Password*":
                /placeholder: ••••••••

          No `[required]` state. The name is the literal string "Email*" — a
          screen reader says "Email star, edit text". Attribute audit on the
          same page:

            {name:"email",    labelText:"Email*",    requiredAttr:false,
             ariaRequired:null, ariaInvalid:null, ariaDescribedby:null}
            {name:"password", labelText:"Password*", requiredAttr:false,
             ariaRequired:null, ariaInvalid:null, ariaDescribedby:null}

          And with a real failed submit driven through the browser, the error
          renders correctly but stays unlinked:

            [role=alert] text: "Network problem — check your connection and try again."
            colour rgb(23,28,42) 14px on rgb(255,255,255) -> 16.99:1  (contrast fine)
            input aria-invalid: null      no aria-describedby anywhere on the form

          (The message wording is the Supabase stub failing, which is expected
          here; what is being measured is the wiring of the error, not its text.)
          Same shape on /contact: `textbox "Your name*"`, `textbox "Email*"`,
          `combobox "What's this about?"`, `textbox "Message*"` — all named,
          none required-marked.
Impact:   Required fields are announced as optional. When submission fails, the
          alert fires once into the live region and is then orphaned: a user who
          tabs back to the field hears the name and placeholder with no
          indication that this is the field that is wrong. Field is the primitive
          behind ~1,066 call sites, so the fix is one file for the whole product.
Fix:      In Field: pass `required` through to the control (`aria-required` or
          the native attribute), `useId()` the hint and error nodes, set
          `aria-describedby` to whichever is present, and set
          `aria-invalid={!!error}`. Keep the visible asterisk — add
          `aria-hidden="true"` to it so the name stops being "Email star".
Status:   OPEN — VERIFIED IN BROWSER (distinct from F-D02/F-D03, which are about
          the NAME; this is about state and description)
```

---

## C2-B09

```
[CLAUDE-2][MEDIUM][A11Y] axe `heading-order`: the footer jumps to <h4> on 24 of 46 page/viewport runs; /contact jumps h1 -> h3
File:     components/marketing/site-footer.tsx:118  <h4 className="text-[11px] font-semibold text-fg">
          app/(marketing)/contact/page.tsx:40        <h3 className="font-semibold">
          app/(marketing)/mobile/page.tsx            <h3 className="mt-4 text-lg font-semibold">iOS & Android</h3>
          app/(marketing)/how-it-works/page.tsx      <h3 className="text-[13px] …">Good morning, The Johnson Family 👋</h3>
Problem:  Every marketing page ends with four footer column titles marked up as
          `<h4>`. On the legal and content pages the deepest preceding heading is
          `<h2>`, so the document skips h3. On /contact the page's own content
          goes h1 -> h3 with no h2. On /how-it-works an `<h3>` is used for
          decorative copy inside a phone mock-up illustration.
Evidence: axe-core 4.12, rule `heading-order`, impact moderate, 26 node
          instances over 24 of the 46 structural runs. Distinct nodes:

            <h4 class="text-[11px] font-semibold text-fg">Product</h4>
              -> desktop+mobile on /security /faq /terms /privacy /cookies
                 /acceptable-use /blog /ai /contact /mobile /how-it-works
                 /family-display  (18 runs)
            <h3 class="font-semibold">Email us</h3>            -> /contact (2 runs)
            <h3 class="mt-4 text-lg font-semibold">iOS &amp; Android</h3> -> /mobile (2 runs)
            <h3 class="text-[13px] font-semibold leading-4">Good morning,<br>The Johnson Family 👋</h3>
                                                              -> /how-it-works (2 runs)

          Confirmed against the real heading outline of /faq:
            ["H1: Questions, answered", "H2: Less Managing Life. More Living It.",
             "H4: Product", "H4: Company", "H4: Get started", "H4: Legal"]
Impact:   Heading navigation is how screen-reader users skim a page. A level
          that jumps tells them a section was missed. On /faq the outline is
          also wrong in a second way — see C2-B12.
Fix:      Footer column titles -> `<h2>` (the footer is a peer of main content)
          and keep the 11px look with classes. /contact: give the three contact
          cards an `<h2>` section heading or demote them to `<p>`.
          /how-it-works: the phone-mock copy is decoration — use `<p>`.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B10

```
[CLAUDE-2][MEDIUM][A11Y] /join and /offline render no <main> landmark, so all their content sits outside any landmark — and they have no skip link either
File:     app/join/page.tsx:10-19, app/join/layout.tsx
          app/offline/page.tsx:8-17  (uses the ROOT layout, which has no chrome)
Problem:  The `(marketing)` and `(auth)` layouts both provide `<main>`; these two
          routes are outside both route groups and provide nothing. Their whole
          content is therefore in no landmark, and `SkipLink`
          (components/a11y/skip-link.tsx, which targets `#main-content`) is not
          rendered on them.
Evidence: axe-core, both viewports:
            landmark-one-main (moderate) — 4 runs:
              desktop /join, mobile /join, desktop /offline, mobile /offline
              node: <html lang="en-US" dir="ltr">
            region (moderate) — 10 node instances over the same 4 runs:
              /join    <div class="mb-8">
                       <h1 class="mt-4 text-xl font-semibold">Invite problem</h1>
                       <p class="mt-2 text-sm text-muted">This invite link is missing its token.</p>
              /offline <h1 class="text-2xl font-semibold">You're offline</h1>
                       <p class="mt-2 max-w-sm text-sm text-muted">Check your connection …</p>
          Accessibility tree of /offline's <body>, entire page:
            - img
            - heading "You're offline" [level=1]
            - paragraph: Check your connection — Bubaly will reconnect …
            - alert
          No main, no nav, no banner, no contentinfo.
Impact:   Landmark navigation ("go to main content"), which is the primary way
          screen-reader users skip chrome, finds nothing on these two pages.
          /join is the first page an invited family member ever sees.
Fix:      Wrap both in `<main id="main-content">`. For /join, adding SkipLink +
          `<main>` to app/join/layout.tsx covers it; /offline needs the element
          in the page (it renders under the root layout).
          (The "Invite problem / missing its token" copy is the correct empty
          state for a tokenless URL, not a stub artefact — the page was reached
          without a token on purpose.)
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B11

```
[CLAUDE-2][LOW][A11Y] axe `scrollable-region-focusable`: two horizontal scrollers at 390px cannot be scrolled by keyboard
File:     app/(marketing)/pricing/pricing-content.tsx:386
            <div className="mt-7 overflow-x-auto rounded-2xl border border-white/10">
          app/(marketing)/family-display/page.tsx:194
            <div className="mt-8 overflow-x-auto">
Problem:  Both become horizontally scrollable at phone width and contain no
          focusable child, so a keyboard user cannot reach the columns that are
          off-screen.
Evidence: axe-core, rule `scrollable-region-focusable`, impact **serious**,
          2 node instances — `mobile /pricing` and `mobile /family-display`
          only (both clean at 1280px, which is why a desktop-only pass would
          have missed them). This is the plan-comparison table on the pricing
          page, i.e. the content a buyer needs most.
Impact:   On a phone, a keyboard user (external keyboard, switch access) cannot
          read the right-hand plan columns at all.
Fix:      `tabIndex={0}` plus `role="group"` and an `aria-label` on the
          scrolling `<div>`, which is axe's own recommended remedy. The pricing
          table would be better as a real `<table>` with a caption.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B12

```
[CLAUDE-2][LOW][A11Y] The FAQ accordion is half-marked: aria-expanded with no aria-controls, panels with no id or role, and the questions are not headings — while the page emits FAQPage structured data for crawlers
File:     components/marketing/faq-accordion.tsx:14-34
Problem:  The trigger has `aria-expanded` but no `aria-controls`; the panel it
          opens has no `id`, no `role="region"` and no `aria-labelledby`; and the
          question is a bare `<span>` inside a `<button>` rather than a button
          inside a heading. Meanwhile app/(marketing)/faq/page.tsx renders
          `FaqStructuredData`, so Google is handed the full Q&A outline that
          assistive technology is not.
Evidence: Driven by keyboard on /faq. Operation itself is FINE:
            first trigger aria-expanded "true" -> Enter -> "false" -> Space -> "true"
          Semantics:
            aria-controls: null      button id: ""      panel id: none
            panel: <div class="border-t border-border px-5 py-4 text-sm text-muted …">
            nearest heading ancestor of the trigger: null
          Accessibility tree of the open panel:
            - tabpanel "Privacy & Security 1":
              - button "Is my family's data private?" [expanded]
              - text: Yes. Every database table enforces row-level security, …
          The answer is loose text with no association to the question.
          Real heading outline of the whole /faq page:
            H1 "Questions, answered"
            H2 "Less Managing Life. More Living It."
            H4 "Product"  H4 "Company"  H4 "Get started"  H4 "Legal"
          Thirteen FAQ questions, zero of them reachable by heading navigation.
Impact:   On a page whose entire purpose is a list of questions, heading
          navigation surfaces six headings, four of which are the footer. The
          crawler gets better structure than the screen-reader user.
Fix:      `useId()` the pair; `aria-controls={panelId}` on the button,
          `id={panelId} role="region" aria-labelledby={buttonId}` on the panel,
          and wrap each trigger in an `<h3>` so the questions join the outline
          (which also removes the h2 -> h4 jump in C2-B09).
          The sibling `faq-tabs.tsx` is a model of how to do this — see the
          verified-clean list.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B13

```
[CLAUDE-2][LOW][UX] The cookie banner is the last thing in the DOM: it is visible immediately but is more than 60 tab stops away
File:     app/(marketing)/layout.tsx:19  (<ConsentManager /> after SkipLink, header,
          main, footer, RegisterSW, ExitIntent)
Problem:  The banner appears on first load, pinned bottom-right over the page,
          and offers Accept all / Reject non-essential / Manage preferences.
          Because it renders at the end of the layout it is also at the end of
          the tab sequence, and nothing moves focus to it or announces it.
Evidence: On a fresh no-storage context the banner IS present:
            [{"label":"Cookie consent","aria-modal":null,
              "text":"We value your privacyWe use strictly-necessary cookies…"}]
          A 60-press tab walk from the top of the homepage reached: skip link,
          logo, six nav links, theme toggle, two header CTAs, and then every
          link in the page and the whole footer — and never reached
          "Accept all". The banner's three buttons come after all 60.
          The ARIA tree is otherwise correct:
            - dialog "Cookie consent": … button "Accept all",
              button "Reject non-essential", button "Manage preferences"
Impact:   A keyboard or screen-reader user must traverse the entire page before
          they can accept or reject cookies, on a control that is visually the
          most prominent thing on screen. Not a WCAG failure on its own (the
          banner is correctly NON-modal), but it inverts the experience.
Fix:      Either render ConsentManager before <main> in the layout, or move
          focus to the banner's first button when it appears and return focus on
          dismissal. Announcing it via `aria-live="polite"` would also help.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B14

```
[CLAUDE-2][LOW][UX] The theme toggle in the AUTH layout is 40x40 on touch; the identical control in the marketing header is 44x44
File:     app/(auth)/layout.tsx:24   <ThemeToggle />                       (no classes)
          components/marketing/site-header.tsx:96
            <ThemeToggle className="… coarse:min-h-11 coarse:min-w-11" />
Problem:  The marketing header opts the toggle into the touch-size utilities;
          the auth layout does not, so on /login /signup /kid-login /welcome the
          same button is 4px short in both axes.
Evidence: Measured at 390x844 with touch emulation (pointer:coarse active):
            button 40x40 "Switch to light mode"  -> /login /signup /kid-login /welcome
            (the marketing header instance does not appear in the sub-44 list)
          Passes WCAG 2.5.8 (24px) — this is a guideline/consistency miss, not a
          conformance failure, hence LOW.
Fix:      Either add the same `coarse:min-h-11 coarse:min-w-11` at the auth call
          site, or better, bake it into components/theme/theme-toggle.tsx so no
          call site can forget it.
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B15

```
[CLAUDE-2][LOW][UX] 10px is the marketing site's chrome type size: 80-156 sub-11px text nodes per page at phone width
File:     components/marketing/site-header.tsx:104,106,109 (`text-[10px]` header CTAs)
          components/marketing/site-footer.tsx:118 (`text-[11px]`), :122 (`text-[10px]`)
          components/i18n/language-picker.tsx (`text-[0.68rem]` = 10.88px)
          decorative product mock-ups: `text-[9px]`, `text-[8px]`, `text-[7px]`, `6px`
Problem:  The header's primary CTA, the whole footer and the language control
          render below 11px on a phone. WCAG sets no minimum font size, so this
          is not a conformance failure on its own — but combined with C2-B07
          (11px tap targets) and `text-muted` at 4.91:1 in the light theme it is
          the point where three near-misses stack.
Evidence: Counted at 390x844, elements with a direct text child under 11px:
            /            80 nodes      /features   156 nodes
            /how-it-works 106 nodes    /pricing     30 nodes
            /faq /security /mobile /contact /privacy  22 nodes each
            /login /signup /kid-login /welcome         2 nodes each
          Samples:
            10px   "Get Started Free"   (the primary CTA, in the header)
            10px   "Log in"
            10px   every footer link
            10.88px "en-US" / "US"      (language control)
            9px / 8px / 7px / 6px  inside the marketing phone mock-ups
Impact:   The most important control on the page is set two points smaller than
          the body copy around it.
Fix:      Raise the header CTAs and footer links to `text-xs` (12px) minimum.
          The 6-9px text lives inside decorative product mock-ups; if those are
          meant to be decoration, they should be `aria-hidden` (they are
          currently exposed to the accessibility tree as real content).
Status:   OPEN — VERIFIED IN BROWSER
```

---

## C2-B16

```
[CLAUDE-2][MEDIUM][PERF] Marketing pages block server render on SEQUENTIAL data calls: TTFB is exactly 7s, 14s or 21s depending on how many
File:     app/(marketing)/pricing/page.tsx (3 calls), /faq /features /security
          /privacy /terms /cookies /acceptable-use /ai /contact /mobile
          /how-it-works /family-display (2 calls), /reviews /reviews/new (1 call)
Problem:  Measured with curl against the running production build. The timings
          are quantised into exact multiples of ~7 seconds, which is the
          signature of N calls run one after another behind a ~7s timeout, not
          of N calls run together:

            /pricing                21.21s  21.22s  21.35s   (3 x 7)
            /faq                    14.07s  14.08s           (2 x 7)
            /features /security /privacy /terms /cookies
            /acceptable-use /ai /contact /mobile
            /how-it-works /family-display   ~14.1s each       (2 x 7)
            /reviews /reviews/new    7.06s   7.08s            (1 x 7)
            /login /signup /kid-login /welcome /join /offline  <0.05s (no calls)

          Repeated requests give the same number every time — nothing is cached.
CAVEAT:   **The absolute numbers are an artefact of the Supabase stub**: with
          dummy credentials each call runs to its timeout instead of returning
          in milliseconds, and against a real database these pages would be
          fast. That part is NOT a finding. What the stub makes visible, and
          what IS a finding, is the SHAPE: 1 call = 7s, 2 calls = 14s, 3 calls
          = 21s. If the calls were awaited together (Promise.all) the worst case
          would be ~7s regardless of count. They are awaited one at a time.
          With a real database this converts a single round-trip of latency into
          two or three, on every marketing page, on every request
          (all of these are `dynamic = 'force-dynamic'` because they read the
          locale cookie, so there is no ISR to hide it).
Impact:   Marketing TTFB — the number Core Web Vitals scores and the one a
          first-time visitor feels — is 2-3x the necessary latency. It also
          means one slow query serialises behind another rather than beside it.
Fix:      Hoist the independent reads in each marketing page into a single
          `await Promise.all([...])`. Overlaps Pass C / Claude-4's territory;
          recorded here because it was measured in this browser pass and no
          prior pass could see it. Worth Claude-1 routing to whoever owns
          delivery.
Status:   OPEN — MEASURED (numbers stub-inflated; the serialisation is real)
```

---

## Cross-checking Pass D (Rule 4 — verify, do not re-derive)

| Pass D / session-1 finding | What the browser says |
|---|---|
| **F-D02** — 55 labels detached from their control, "includes the *public* survey form at `app/s/[slug]/survey-form.tsx:79`" | **NOT REPRODUCIBLE on any reachable public page.** Every control on /login, /signup, /kid-login and /contact resolves an accessible name. The one public page F-D02 names needs a published survey slug from the database → **BLOCKED**, not cleared. |
| **F-D03** — 65 `<select>` with no accessible name | **NOT REPRODUCIBLE on the public surface.** The only public `<select>` I could render is /contact's topic picker, and the accessibility tree gives it a name: `combobox "What's this about?"` with eight named options. All 65 counted instances are in `app/(app)` → **BLOCKED**. |
| **F-D01** — photo lightbox: no role, no Escape, no trap | **BLOCKED** — `components/modules/photos-module.tsx` is authenticated-only. Stays statically derived. |
| **F-D04** — four hand-rolled `aria-modal` dialogs with no trap and no Escape | **VERIFIED as a class, and EXTENDED.** A fifth instance exists that F-D04 does not list, on the public surface: the cookie preference centre. Measured: focus never enters, Tab escapes after 8 stops, Escape ignored. See C2-B05. |
| **F-D05** — 19 authenticated pages render no `<h1>` | **Public surface is clean**: /, /pricing, /features, /faq, /security, /privacy, /terms, /cookies, /acceptable-use, /ai, /blog, /contact, /mobile, /how-it-works, /family-display, /login, /signup, /kid-login, /welcome, /join, /offline, /reviews, /reviews/new — axe raised `page-has-heading-one` on none of the 46 runs. The 19 pages themselves are authenticated → BLOCKED. |
| **F-D06** — clickable rows that are not keyboard reachable | Public equivalent is clean — the homepage "handled" cards are real `<a>` elements and appear in the tab walk at stops 14-19. The seven modules named are authenticated → BLOCKED. |
| **F-D07** — 92 `window.confirm()` guards | Authenticated → BLOCKED. No `window.confirm` on any public route. |
| **F-D10** — the lint config enables no `jsx-a11y` rules, so the class grew unseen | **Reinforced by a second, worse instance of the same pattern.** C2-B01 (`.focus-ring` painting permanently) is invisible to `next lint` AND to axe AND to every unit test in the repo — no static rule describes "this class should have been a state variant". F-D10's lesson generalises: the guards here cannot see what they are named for. The regression test proposed in C2-B01 is the kind of guard that *can* go red. |
| **C2-14 / F-D14** — lint warnings | Not re-run; nothing in this pass touches it. |

---

## Verified clean — measured, not assumed

Recorded so a later pass does not re-derive them. Each was checked in a browser.

1. **Zero WCAG AA colour-contrast violations reported by axe across the whole
   public surface, in BOTH themes.** 92 runs (23 routes x 2 viewports x 2
   themes), rule `color-contrast`: **0 violations, 0 pages affected**, in dark
   and in light. Every one of the 1,859 flagged nodes was the AAA rule
   `color-contrast-enhanced` (7:1), not AA.
   *With the limit stated plainly:* axe also returned **4,603 `incomplete`
   node instances** (≈2,263 per theme) it could not judge — 326 of them
   "background color could not be determined due to a background gradient",
   the rest overlap/obscured/too-short. So "0 AA violations" means *0 among the
   nodes axe could measure*. C2-B02 and C2-B03 are what a hand-rolled,
   gradient-aware and state-aware check found in that blind spot.
2. **No horizontal overflow anywhere.** `documentElement.scrollWidth` equals
   `clientWidth` on **46/46** runs at 1280px and 390px, and on a further 4 spot
   checks at 360px (/, /pricing, /faq, /features). Zero overflowing elements.
3. **The skip link is correct — on the `(marketing)` routes, which are the only
   ones that have it.** `Tab` #0 from a cold load of / and /pricing lands on
   `a[href="#main-content"]`, it becomes visible on focus (`sr-only` →
   `focus:not-sr-only`, measured box-shadow and a brand background appearing on
   focus), and it targets a real `<main id="main-content">`. The implementation
   in `components/a11y/skip-link.tsx` is sound and needs no change.
   **It is only mounted in `app/(marketing)/layout.tsx`** — see C2-B17 for the
   routes that do not get it.
4. **The mobile navigation drawer is keyboard-correct.** At 390px:
   `aria-label="Toggle menu"`, `aria-controls="mobile-navigation"`,
   `aria-expanded` tracks state; Enter opens it; all 8 items are reachable;
   Escape closes it and returns focus to the button
   (`expandedAfterEscape: "false"`); and when focus leaves the header the drawer
   closes itself via the `onBlur` handler (`expandedAfterWalk: "false"`), so
   there is no stranded overlay. This is the pattern F-D04's dialogs should copy.
5. **The FAQ tab strip is a correct WAI-ARIA tablist.** `role="tablist"` with an
   `aria-label`, 6 tabs, roving `tabIndex`, `aria-selected`, `aria-controls` to a
   real `role="tabpanel"`, and ArrowRight moves focus AND selection
   (measured: focus → `role=tab` "Roles & Access", `aria-selected="true"` follows).
   Every tab measures `min-h-[44px]`. `components/marketing/faq-tabs.tsx` is the
   in-repo reference implementation.
6. **The FAQ accordion *operates* correctly by keyboard** — Enter toggles,
   Space toggles. Only its ARIA wiring is short (C2-B12).
7. **The language picker's Escape handling is correct** — Escape closes the
   listbox and restores focus to the trigger (measured `afterEsc.focus` =
   the element carrying `aria-haspopup="listbox"`). Its option names are good:
   `option "English (United States)" [selected]` and ten more.
8. **`prefers-reduced-motion` is honoured globally** — `app/globals.css:474-481`
   collapses every animation and transition to 0.001ms under
   `@media (prefers-reduced-motion: reduce)`, and individual spinners carry
   `motion-reduce:animate-none`.
9. **No keyboard trap anywhere on the public surface.** Tab walks of 60 stops
   (desktop /), 34 stops (settled re-walk), 30 stops (mobile /), 16 stops inside
   the consent dialog and 14 inside the open mobile drawer all continued to move
   and all reached `<body>` or wrapped normally. `<html lang="en-US" dir="ltr">`
   is set on every route.

---

## Two corrections to my own measurements

Recorded because both would have produced a wrong finding, and the second one
nearly did.

1. **The first theme sweep measured the light theme twice.** `scan.mjs` reused
   one browser context per worker and wrote
   `localStorage['bubaly-theme']='light'` after each page's dark pass — which
   persisted, so every route *after the first in each worker* loaded light while
   being recorded as dark. It reported "0 AA contrast failures in dark"; that
   number was real but the dark coverage behind it was 4 routes, not 23. The
   pass was redone (`contrast2.mjs`) with one pinned context per theme and an
   assertion on `<html class>` before every measurement: **0/92 runs reported the
   wrong theme.** The structural (non-contrast) axe results are unaffected —
   `heading-order`, `region`, `landmark-one-main` and
   `scrollable-region-focusable` do not depend on the theme.
2. **My first tab walk read computed styles mid-transition and invented a
   catastrophe.** Reading `getComputedStyle` immediately after `Tab` caught the
   150ms Tailwind `transition` (which animates `box-shadow`) part-way — one stop
   literally returned `0.0655955px` of ring — so 17 of 34 elements looked like
   they had **no focus indicator at all**, including the entire main navigation.
   Re-measured with a 260ms settle after every keypress: elements using
   `focus-visible:focus-ring` **do** show the ring correctly, and the main nav is
   fine. **That reading is withdrawn.** What survives is narrower and real: only
   the **bare** `.focus-ring` class fails, and it fails because the ring is
   always on rather than never on (C2-B01), which is provable without any timing
   at all — the ring is present while `document.activeElement === document.body`.

---

## BLOCKED — what a browser still could not see

Listed so "we could not look" never reads as "it is clean".

| Surface | Why | Consequence |
|---|---|---|
| `app/(app)` — all 354 authenticated pages | Supabase is stubbed with dummy credentials; no session can be created (no local Supabase: no docker daemon, no CLI) | **Pass D's F-D01, F-D02, F-D03, F-D04, F-D05, F-D06, F-D07, F-D08, F-D09, F-D11 remain statically derived and unverified by execution.** The two HIGH ones (F-D02/F-D03) are counted almost entirely here |
| `app/s/[slug]` — the public survey form | Needs a published survey row | The **one public instance F-D02 cites** could not be confirmed or contradicted |
| `/gift/[token]`, `/pay/[handle]`, `/blog/[slug]`, `/customers/[slug]` | Every one needs a token or slug from the database | Detail/route-param templates unaudited in a browser |
| `--success` / `--warning` chips and toasts in the light theme | The tokens measure 2.70-2.91:1 (C2-B03) but the components that use them are behind the login wall | Token ratios are measured; the rendered components are not |
| A real screen reader (NVDA / JAWS / VoiceOver) | Not available in this container | "Screen-reader output" was covered via the **accessibility tree** (Playwright `ariaSnapshot`) plus axe's name/role/state checks. That is the computed input a screen reader speaks from, but it is not the same as hearing one |
| Windows High Contrast / forced-colors | Not emulated | `forced-colors` handling unaudited |
| Real devices / real touch | `isMobile:true, hasTouch:true` Chromium emulation only (verified `pointer: coarse` matched) | Emulated, not physical |

**Database-backed content rendered empty or fell back throughout this pass.
None of that is reported as a defect above** — it is the stub, and the one place
it produced a number worth keeping (C2-B16) is labelled with exactly what the
stub contributed and what it did not.

---

## Addendum — added after the section above was written

### C2-B17

```
[CLAUDE-2][MEDIUM][A11Y] The skip link exists but is mounted on ONE layout: 7 of 23 public routes have no way to bypass the header, and 5 of them have a <main> with no id to skip to
File:     app/(marketing)/layout.tsx:12   <SkipLink />        <- the only mount
          app/(auth)/layout.tsx:24        <main …>            <- no id, no SkipLink
          app/reviews/…                   <main …>            <- no id, no SkipLink
          app/join/page.tsx, app/offline/page.tsx             <- no <main> at all
          components/a11y/skip-link.tsx                       <- the component is fine
Problem:  `components/a11y/skip-link.tsx` carries a docstring that says exactly
          what to do — "Must be the first focusable element in the DOM — render
          it at the top of each layout, and give the corresponding <main>
          id='main-content'" — and it is honoured in one layout out of four.
          WCAG 2.4.1 Bypass Blocks (level A) applies per page, so the routes
          without it fail a level-A criterion even though the product has a
          correct implementation sitting in the repo.
Evidence: Measured per route: presence of <main>, its id, presence of
          a[href="#main-content"], and what the FIRST Tab press actually lands on:

            route        <main> ids        #main-content  skip link  first Tab stop
            /            ["main-content"]  yes            yes        A "Skip to content"   OK
            /pricing     ["main-content"]  yes            yes        A "Skip to content"   OK
            /login       ["(no id)"]       no             NO         A "Bubaly home"
            /signup      ["(no id)"]       no             NO         A "Bubaly home"
            /kid-login   ["(no id)"]       no             NO         INPUT (autofocused)
            /welcome     ["(no id)"]       no             NO         A "Bubaly home"
            /reviews     ["(no id)"]       no             NO         A "Write a review"
            /join        []                no             NO         A "Bubaly home"
            /offline     []                no             NO         (body — no focusable element on the page)

Impact:   Every sign-in and sign-up route makes a keyboard or screen-reader user
          walk the header before reaching the form. It is a small header, so the
          practical cost is low — but it is a level-A criterion, and the fix is
          two lines per layout against a component that already exists and works.
          `/offline` having no focusable element at all is a separate small
          oddity: there is nothing to Tab to, and no retry control.
Fix:      Add `<SkipLink />` and `id="main-content"` to `app/(auth)/layout.tsx`
          and to the `reviews` layout; add both plus a `<main>` to /join and
          /offline (which also closes C2-B10). Then assert it once in a test:
          every public route's first Tab stop is the skip link.
Status:   OPEN — VERIFIED IN BROWSER
```

### Correction 3 — to my own verified-clean item #3

Verified-clean item #3 above originally read "`<main id="main-content">` exists
on every `(marketing)` and `(auth)` route". **That was wrong**, and it was wrong
in the direction that matters: it turned an unchecked assumption into a clean
bill of health, which is the exact failure mode this audit keeps naming. Only
`app/(marketing)/layout.tsx` mounts `SkipLink`; the `(auth)` layout renders a
`<main>` with no `id` and no skip link. The sentence has been amended in place
and the real state is filed as C2-B17. The claim came from reading the
marketing layout and generalising — the browser check that produced the table
above took thirty seconds and should have come first.

### Revised counts for this session

| Severity | Count |
|---|---|
| HIGH | 2 (C2-B01, C2-B02) |
| MEDIUM | 10 (C2-B03, B04, B05, B06, B07, B08, B09, B10, B16, B17 — B16 is PERF) |
| LOW | 5 (C2-B11, B12, B13, B14, B15) |
| **Total new** | **17** (`C2-B01`–`C2-B17`) |

Plus 9 verified-clean items (one amended), 3 method corrections, and a
7-row BLOCKED table.
