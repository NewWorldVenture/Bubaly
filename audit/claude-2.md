# Claude-2 — Frontend · UI/UX · Responsive · Accessibility

Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-2 and by nobody else.
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

---

## Scope and method

Surface: 395 `page.tsx`, ~456 `components/**/*.tsx`, `app/globals.css`,
`design/tokens.json`, `tailwind.config.ts`, the 11 locale catalogues, and the
existing frontend guards in `tests/` (127 `*-read-boundary.test.ts`,
`modal-a11y-contract`, `mobile-touch-a11y`, `photos-a11y-labels`,
`mobile-no-horizontal-overflow`, `mobile-forms`, `brand-contrast-contract`,
`tests/e2e/overflow.spec.ts`).

Every finding below was read in the source before being written. Two were
additionally proved by **execution** rather than by reading: F2-01 by replaying
the real date arithmetic under four `TZ` values, and F2-02 by compiling
`app/globals.css` with the project's own Tailwind config and reading the emitted
rule. Those two are the ones I would defend hardest.

---

### [CLAUDE-2][CRITICAL][UI-CORRECTNESS] The family calendar puts every event on the wrong day in every timezone except UTC

_(none yet)_

---
---

# ═══════════════════════════════════════════════════════════════════
# SESSION 4 (2026-09-14) — new ground: responsive, states, forms,
# focus/motion, colour & theming, client-boundary cost, RTL.
# Everything above this line is from an earlier session and is NOT
# restated here. PR #548's closed items are excluded by instruction.
# ═══════════════════════════════════════════════════════════════════

## C2-15

```
[CLAUDE-2][HIGH][A11Y] `.focus-ring` paints its ring unconditionally and kills the outline, so 202 controls have no focus indicator at all
File:     app/globals.css:179-181  (definition)
          components/ui/button.tsx:39, components/ui/input.tsx:5,
          components/ui/modal.tsx:106, components/ui/otp-input.tsx:105 (the
          four shared primitives that carry it)
Problem:  `.focus-ring` is declared in `@layer components` with no state
          selector:

            .focus-ring { @apply outline-none ring-2 ring-brand/60
                                 ring-offset-2 ring-offset-bg; }

          `outline-none` compiles to `outline: 2px solid transparent`, which
          suppresses the browser's native `:focus-visible` outline. The ring
          that is supposed to replace it is painted ALWAYS, not on focus. Net
          effect on every element carrying the bare class: a permanent 2px
          brand halo, and **zero visual change when the element receives
          keyboard focus**. WCAG 2.4.7 (Focus Visible) fails on all of them.
Evidence: 1. The shipped stylesheet, not just the source. The last build in
             `.next/` contains the rule with no `:focus`/`:focus-visible`
             qualifier anywhere in the selector:

               $ grep -o '\.focus-ring[^{]*{[^}]*}' \
                   .next/static/css/efe55d1639ee1e52.css
               .focus-ring{outline:2px solid transparent;outline-offset:2px;
                 --tw-ring-offset-shadow:var(--tw-ring-inset) 0 0 0
                   var(--tw-ring-offset-width) var(--tw-ring-offset-color);
                 --tw-ring-shadow:var(--tw-ring-inset) 0 0 0
                   calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color);
                 box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),
                   var(--tw-shadow,0 0 #0000);
                 --tw-ring-color:rgb(var(--brand)/0.6);
                 --tw-ring-offset-width:2px;
                 --tw-ring-offset-color:rgb(var(--bg)/1)}

             The selector is `.focus-ring`, full stop.

          2. I ruled out the ring being inert. Tailwind's ring machinery needs
             `--tw-ring-inset` to be *defined* (as an empty value) or the
             `box-shadow` would be invalid at computed-value time and render
             nothing. Preflight defines it in the same stylesheet:

               $ grep -o '\*,:after,:before{--tw[^}]*}' <same file>
               …--tw-ring-inset: ;--tw-ring-offset-width:0px;…

             So the shadow is valid and the ring genuinely paints.

          3. I ruled out a state-scoped redefinition elsewhere. `.focus-ring`
             is defined exactly once in the repo:
               $ grep -rn "\.focus-ring" --include="*.css" . \
                   --exclude-dir=node_modules --exclude-dir=mobile
               ./app/globals.css:179
             and `app/globals.css` contains no global `:focus-visible` rule at
             all — the only `:focus`-family selector in the whole file is
             `.ai-composer:focus-within` at line 296:
               $ grep -n "focus-visible\|:focus" app/globals.css
               296:  .ai-composer:focus-within {

          4. I ruled out call sites gating it behind a variant. Of 218 uses,
             202 are bare:
               $ grep -rno "[a-zA-Z0-9:-]*focus-ring" --include="*.tsx" \
                   --include="*.ts" app components lib \
                 | sed 's/.*[0-9]:\(.*\)/\1/' | sort | uniq -c
                 202 focus-ring
                  16 focus-visible:focus-ring
             The 16 correct uses (e.g. app/(marketing)/page.tsx:108) prove the
             intended spelling was known — this is a slip, not a convention.

          5. Blast radius is not 202 elements but 202 *call sites*, four of
             which are the shared primitives every screen is built from:
               components/ui/button.tsx:39   → imported by 199 files
               components/ui/input.tsx:5     → imported by 134 files
                 (the `base` string is shared by Input, Textarea AND Select)
               components/ui/modal.tsx:106   → every modal's close button
               components/ui/otp-input.tsx:105
             `.btn-cta` and `.btn-inline` in globals.css:414,419 `@apply
             focus-ring` too, so they inherit it; I checked the compiled
             `.btn-cta` and the ring survives the later `shadow-glow`
             box-shadow because both declarations read the same
             `--tw-ring-*` custom properties.
Impact:   Two separate harms from one line.
          (a) Accessibility, the serious one: keyboard-only users, switch
              users and anyone who does not use a mouse cannot tell where
              focus is on essentially every button, text input, textarea,
              select and OTP box in the product — including the login and
              signup forms. The native outline that would have saved them is
              explicitly removed. This is the single highest-reach a11y defect
              I found in this pass.
          (b) Visual: every one of those controls renders a permanent 2px
              brand-violet halo with a 2px `--bg`-coloured gap. On a card
              (`bg-surface`) the gap is the wrong colour, so it reads as a
              double ring.
Fix:      One line. Scope the ring to focus-visible and keep a fallback:

            .focus-ring { @apply outline-none; }
            .focus-ring:focus-visible {
              @apply ring-2 ring-brand/60 ring-offset-2 ring-offset-bg;
            }

          (Do NOT instead rewrite the 202 call sites to
          `focus-visible:focus-ring` — that spelling also leaves
          `outline-none` unapplied in the default state, which is fine, but it
          is 202 edits for what one rule fixes. The 16 existing
          `focus-visible:focus-ring` uses keep working under the fix above,
          harmlessly double-scoped.)
          Worth adding a companion guard: a test asserting `app/globals.css`
          never defines a `.focus-ring` rule without a `:focus` selector.
Status:   OPEN
```

---

## C2-16

```
[CLAUDE-2][HIGH][THEMING] 49 colour utilities name theme tokens that do not exist, so they compile to nothing — including the background of two full-screen mobile overlays
File:     components/modules/inbox-module.tsx:299
          components/modules/front-desk-module.tsx:484   (the worst two)
          + 29 × `bg-card`, 6 × `text-foreground`, 3 × `bg-primary`,
            2 × `border-primary`, 4 more × `bg-background`
Problem:  The Tailwind theme (tailwind.config.ts) defines exactly twelve custom
          colour names: bg, surface, elevated, border, fg, muted, brand(+fg,
          soft, text), accent, success, warning, danger, info. Forty-nine class
          usages spell shadcn/ui's names instead — `card`, `background`,
          `foreground`, `primary`. Tailwind generates no rule for an unknown
          colour, so these classes are inert: the element silently renders with
          no background / inherited text colour, and nothing warns.
Evidence: 1. The names are absent from the theme. `tailwind.config.ts` uses
             `theme.extend.colors`, so the palette is Tailwind's defaults plus
             the twelve above. Tailwind 3.4.19's default colour names are:
               $ node -e "const c=require('tailwindcss/colors');
                          console.log(Object.keys(c).filter(k=>/^[a-z]+$/.test(k)).join(' '))"
               inherit current transparent black white slate gray zinc neutral
               stone red orange amber yellow lime green emerald teal cyan sky
               blue indigo violet purple fuchsia pink rose
             No `card`, no `background`, no `foreground`, no `primary`.

          2. The shipped stylesheet confirms they generated nothing, while the
             real tokens did:
               $ for c in bg-background text-foreground border-primary \
                          bg-primary bg-card bg-muted text-muted; do
                   printf "%s: " "$c";
                   grep -c -- "$c" .next/static/css/efe55d1639ee1e52.css; done
               bg-background: 0
               text-foreground: 0
               border-primary: 0
               bg-primary: 0
               bg-card: 0
               bg-muted: 1
               text-muted: 1
             (Search is a plain substring over the whole file, so a 0 means the
             string does not occur at all, not that I mis-built a selector.)

          3. I ruled out a hand-written rule supplying them. `app/globals.css`
             defines `.glass-card`, not `.bg-card`; grepping every non-vendor
             `.css` file for these class names finds nothing, and the compiled
             stylesheet above is the union of Tailwind output and globals.css.

          4. I ruled out them being prose rather than markup by reading each
             site. A scanner over app/, components/ and lib/ that strips
             numeric shades and compares the base name against the default
             palette + the twelve custom names produced the counts above; I
             then read every hit for `card`, `background`, `foreground` and
             `primary` and confirmed each is inside a `className` string:
               components/modules/decisions-module.tsx:118
                 selected?.id === d.id ? 'border-primary bg-primary/10'
                                       : 'border-border hover:bg-muted/5'
               components/modules/graph-module.tsx:141   (same shape)
               components/modules/decisions-module.tsx:182
                 cn('h-full rounded-full', r.feasible ? 'bg-primary'
                                                      : 'bg-rose-400')
               app/(app)/admin/notifications/page.tsx:56
                 "rounded-xl border border-border bg-card p-4"
             `bg-card` appears 29 times across 12 files — decisions,
             intelligence, contact-center, readiness, life-events, graph,
             routines-panel, experience-scorecard, playbook, planning,
             admin-notifications-list and admin/notifications.

          The worst instance, and why this is HIGH rather than MEDIUM:

            components/modules/inbox-module.tsx:299
            components/modules/front-desk-module.tsx:484
              <div className="fixed inset-0 z-50 bg-background flex flex-col
                   pt-[var(--safe-top)] … lg:static lg:inset-auto lg:z-auto
                   lg:w-[400px] … lg:bg-surface/30 …">

          Below `lg` (so: every phone, and tablets under 1024px) this is the
          Inbox message-detail pane and the Front Desk call-detail pane,
          rendered as a full-screen `fixed inset-0` overlay whose ONLY
          background is `bg-background`. It compiles to nothing, so the pane is
          transparent and the message list it covers shows straight through the
          message body. I checked the child (`CommDetail`,
          inbox-module.tsx:293-310) for a background of its own: its root is
          `<div className="flex flex-col h-full">` and its header is
          `border-b border-border` — neither paints one. At `lg` and above the
          `lg:bg-surface/30` variant is a real token and the panel is fine,
          which is exactly why this would survive desktop review.
Impact:   Mobile users of Inbox and Front Desk — two core modules — read
          message and call detail over a bleed-through of the list behind it.
          Separately, 29 "cards" across ten modules render with a border and no
          surface, `text-foreground` leaves text at whatever it inherits, and
          in Decisions and Graph the *selected* row has no selected styling at
          all (`border-primary bg-primary/10` → nothing), while
          decisions-module.tsx:182 draws the "feasible" score bar with no fill
          colour and the infeasible one in `bg-rose-400`, so a feasible option
          looks like an empty bar.
Fix:      Mechanical, per token:
            bg-background  → bg-bg        (the page background token)
            bg-card        → bg-surface   (matches the sibling `bg-surface/…`
                                           cards in the same components)
            text-foreground→ text-fg
            bg-primary     → bg-brand
            border-primary → border-brand
          Then add a guard, because nothing here fails loudly: a test that
          scans app/ + components/ for `(bg|text|border|ring|fill|stroke|
          from|to|via|divide)-<name>` and fails on any `<name>` that is neither
          a Tailwind default nor a key of `theme.extend.colors`. Without it the
          next shadcn-shaped snippet pasted in is silently invisible again.
Status:   OPEN
```

---

## C2-17

```
[CLAUDE-2][MEDIUM][THEMING] Design tokens hold raw RGB channels, and 14 places use them as if they were colours — so two empty-state charts and the default calendar dot render invisible
File:     components/modules/finances-module.tsx:263
          components/modules/todos-module.tsx:506
          components/modules/calendar-module.tsx:580, 858
          + 10 × `accent-[var(--brand)]` (8 files)
Problem:  Every token in `app/globals.css` is stored as a space-separated RGB
          channel triplet, not a colour — `--brand: 116 75 232;`,
          `--elevated: 18 26 40;` — precisely so Tailwind can inject
          `<alpha-value>` (`rgb(var(--brand) / <alpha-value>)`,
          tailwind.config.ts:19-36). A triplet is only a colour once wrapped in
          `rgb()`. Fourteen places use the bare `var(--token)` as a colour
          value. CSS discards the declaration as invalid at computed-value
          time, silently.
Evidence: 1. The token format, read from source:
               app/globals.css:37  --brand: 116 75 232;
               app/globals.css:33  --elevated: 18 26 40;
             and the config that consumes them correctly:
               tailwind.config.ts:23  elevated: 'rgb(var(--elevated) / <alpha-value>)'

          2. The four inline-style sites, each read in context:
               finances-module.tsx:263
                 style={{ background: spendByCat.length
                   ? `conic-gradient(${donutStops})`
                   : 'var(--elevated,#2a2a33)' }}
                 → when there is no spend yet, `background: 18 26 40` — invalid.
               todos-module.tsx:504-506
                 const stops = sum === 0
                   ? 'var(--elevated, #2a2a33) 0% 100%'  → a colour stop of
                   `18 26 40 0% 100%` makes the whole conic-gradient() invalid,
                   so the ring's `background` drops entirely.
               calendar-module.tsx:580 and :858
                 style={{ backgroundColor: row.color ?? 'var(--brand, #7c5cff)' }}
                 → a calendar row with no colour of its own gets
                   `background-color: 116 75 232` — invalid — and its 10px dot
                   is invisible.

          3. I ruled out the `#hex` fallbacks saving it. `var(--x, fallback)`
             uses the fallback only when `--x` is *not defined*. `--elevated`
             and `--brand` are both defined on `:root` (globals.css:33,37), so
             the fallback is never reached and the invalid triplet is what
             lands.

          4. The ten `accent-[var(--brand)]` checkboxes are the same mistake in
             class form, and the shipped stylesheet shows both spellings side
             by side — proof the correct one exists in this codebase:
               $ grep -o 'accent-color:[^;}]*' \
                   .next/static/css/efe55d1639ee1e52.css | sort -u
               accent-color:rgb(var(--brand)/1)     ← from `accent-brand`
               accent-color:rgb(var(--danger)/1)
               accent-color:var(--brand)            ← from `accent-[var(--brand)]`
             Counts are exactly even, 10 correct and 10 broken:
               $ grep -rno "accent-\[var(--brand)\]" --include="*.tsx" app components | wc -l
               10
               $ grep -rno "accent-brand\b" --include="*.tsx" app components | wc -l
               10
Impact:   The two donut cases land specifically on the **empty state**, which
          is the first thing a new family sees: Finances shows an opaque inner
          disc with the total, floating with no ring around it, and Todos the
          same — it reads as a half-rendered chart rather than "nothing yet".
          The calendar dot case affects any calendar row whose `color` is null.
          The checkbox case is cosmetic: those ten checkboxes render in the
          browser's default blue instead of brand violet, next to ten others
          that are correct.
Fix:      Wrap the token: `rgb(var(--elevated))`, `rgb(var(--brand))`, and
          `accent-brand` for the class form. If a literal fallback is still
          wanted, it has to go inside: `rgb(var(--elevated, 42 42 51))`.
Status:   OPEN
```

---
---

# ═══════════════════════════════════════════════════════════════════
# SESSION 5 (2026-09-14, parallel worker run) — new ground continued:
# client-boundary cost, forms, focus affordance, motion, i18n in the
# app chrome. Nothing above this line is restated. PR #548's closed
# items and my false-positive C2-12 are excluded by instruction.
# Everything below was read in this session; no source file was
# modified.
# ═══════════════════════════════════════════════════════════════════

## C2-18

```
[CLAUDE-2][HIGH][PERF/BUNDLE] The whole 13,458-key English catalogue ships as JavaScript on every page — 62% of the marketing home page's first-load JS — which is exactly what lib/i18n/scopes.ts was written to prevent
File:     lib/i18n/messages.ts:13 (import enUS), :42 (SOURCE_MESSAGES), :129 (the
          fallback that keeps it alive)
          components/i18n/locale-provider.tsx:13 (the client component that
          imports translate, and so drags the catalogue into the browser bundle)
Problem:  `lib/i18n/scopes.ts` is a careful, documented piece of work: it cut the
          catalogue OUT OF THE RSC PAYLOAD, taking a marketing page "from 246 KB
          of compressed strings to about 2 KB" (its own header comment, and
          tests/i18n-client-scope.test.ts:11-13). It did not touch the JS side.

          `components/i18n/locale-provider.tsx` is `'use client'` and imports
          `translate` from `@/lib/i18n/messages`. That module statically imports
          all eleven catalogue JSONs. Webpack tree-shakes ten of them, but
          `translate()` ends with

            const template = messages[key] ?? SOURCE_MESSAGES[key] ?? key;

          and `SOURCE_MESSAGES = enUS`. So en-US.json — 869,587 bytes on disk,
          13,458 keys — is retained and emitted into the client chunk that
          carries LocaleProvider. That chunk is in the ROOT layout's chunk list,
          so every route in the application downloads it.
Evidence: 1. The chunk exists and contains the catalogue, not a subset:
             $ head -c 300 .next/static/chunks/19933-f888ead1b718308d.js
             "use strict";(self.webpackChunk_N_E=…).push([[19933],{19933:(e,a,t)=>{
               t.d(a,{LocaleProvider:()=>d,Ym:()=>u,c3:()=>c});…
               let s=JSON.parse('{"App.couldNotSetTheDefaultDashboard":…
             — it exports LocaleProvider and inlines one JSON.parse blob.
             $ grep -o "JSON.parse('" …19933….js | wc -l  → 1
             $ grep -c "Contraseña\|Passwort\|Impostazioni" …19933….js → 0
             so it is ONE locale (en-US), not eleven. The other ten did shake out.
          2. Its size, measured:
             raw 818,132 bytes; gzip 244,556 bytes.
          3. It is loaded by the ROOT layout, i.e. by every page. From
             .next/app-build-manifest.json, the per-segment chunk lists:
               /layout                → includes 19933-f888ead1b718308d.js
               /(marketing)/layout    → includes it
               /(auth)/layout         → includes it
               /(app)/layout          → includes it
             397 of 591 entries list it; the 194 that do not are almost all
             /api/*/route entries, which emit no client JS at all.
          4. Share of first-load JS, computed as the gzip of the UNION of the
             chunk lists down each route's layout chain:
               marketing home  13 files  391,916 gz   catalogue 244,556 = 62.4%
               /login          16 files  462,403 gz   catalogue 244,556 = 52.9%
               /dashboard      26 files  503,489 gz   catalogue 244,556 = 48.6%
          How I ruled out the guards that would have made this a non-finding:
          - "The scoping already fixed it." It fixed the RSC payload only.
            app/layout.tsx:70 scopes the payload to ROOT_CHROME_SCOPE and
            (marketing)/layout.tsx:13 to MARKETING_SCOPE — and the JS chunk
            carrying all 13,458 keys is loaded alongside, unscoped.
          - "It is a lazily-loaded chunk." It is listed for the root layout
            segment, which Next emits as eager script/preload for every request
            under it. LocaleProvider is a plain static import in app/layout.tsx:7,
            not next/dynamic.
          - "It is the (app) group's deliberate trade-off." scopes.ts:59-64 does
            deliberately keep the whole catalogue for the authenticated app — but
            in the PAYLOAD, "behind a login where there is no crawler and no
            first-visit cost". The JS chunk lands on the signed-out marketing
            home page and the login screen too, which that reasoning explicitly
            does not cover.
          - "Some other client module pulls it in anyway." Only one 'use client'
            module imports @/lib/i18n/messages:
            $ grep -rln "from '@/lib/i18n/messages'" app components lib
              → locale-provider.tsx is the only one with 'use client';
                automatic-capture-card.tsx and ai-home-dashboard.tsx import
                `translate` but are server components; scopes.ts imports the type.
Impact:   Every visitor to the public marketing site downloads, parses and
          JSON.parses 818 KB of strings — for wallet errors, the admin studio,
          onboarding, marketplace copy — before the landing page is interactive.
          It is the single largest client asset in the build and it is 62% of
          that page's JavaScript. This is LCP/TBT on the one page whose job is
          conversion, and it lands on mobile data. A French visitor downloads it
          and then never reads a word of it.
Fix:      Move the interpolation primitive to a module with no catalogue import —
          `lib/i18n/translate.ts` exporting only
            translate(messages, key, params) → messages[key] ?? key
          — and have `components/i18n/locale-provider.tsx` import THAT.
          `lib/i18n/messages.ts` keeps its enUS-falling-back wrapper for the
          server callers that want it.
          One caveat that must be handled, not skipped: the SOURCE_MESSAGES
          fallback IS load-bearing in exactly one place. `app/global-error.tsx`
          renders its own <html> and so runs outside every LocaleProvider
          (app/global-error.tsx:9,18 call useTranslations()). It uses four keys —
          globalError.somethingWentWrong, .bubalyHitAnUnexpectedErrorYour,
          .tryAgain, .reloadBubaly (lines 58, 60, 77, 92). Inline those four as a
          literal fallback object in the provider's out-of-context branch.
          Everywhere else the fallback is already unreachable: the (app) group
          ships namespaces="all", and tests/i18n-client-scope.test.ts fails the
          build if a scoped surface's client components reach a key outside its
          scope — so a scoped provider always already holds the key.
          Expected saving: ~245 KB gzip off every page in the product.
Status:   OPEN
```

---

## C2-19

```
[CLAUDE-2][MEDIUM][UX/DATA] Fifteen create/edit forms await a write with no pending state: a second tap inserts the row twice, and nothing on screen says the first tap was heard
File:     components/modules/behavior-module.tsx:67 (handler) / :255 (button)
          components/modules/screen-time-module.tsx:67,94 / :226,241  (two forms)
          components/modules/binder-module.tsx:40 / :113
          components/modules/devices-module.tsx:38 / :125
          components/modules/health-visits-module.tsx:49 / :188
          components/modules/immunizations-module.tsx:51 / :182
          components/modules/security-module.tsx:71 / :179
          components/modules/subscriptions-module.tsx:63 / :200
          components/modules/utilities-module.tsx:54 / :197
          components/modules/voting-module.tsx:93 / :348
          components/modules/weekend-module.tsx:118 / :183
          components/vacations/shared.tsx:121 / :205
          components/vacations/trip-itinerary.tsx:86 / :199
          components/vacations/trip-packing.tsx:95 / :160
          components/vacations/vacations-list.tsx:75 / :163
Problem:  Each is `<form onSubmit={save}>` where `save` is an async function that
          awaits a Supabase insert/update and then closes the modal. The submit
          button is a bare `<Button type="submit">` — no `loading`, no
          `disabled` — and the handler has no re-entrance guard. Between the tap
          and the round trip completing, the button looks completely idle.
Evidence: The canonical shape, read in full at
          components/modules/behavior-module.tsx:67-83:
            async function save(e: React.FormEvent) {
              e.preventDefault();
              if (!form) return;
              const supabase = createClient();
              const row = { … };
              const { error } = form.id
                ? await supabase.from('behavior_logs').update(row).eq('id', form.id)
                : await supabase.from('behavior_logs').insert({ …row, family_id: familyId, … });
              if (error) return toastError(describeDbError(error));
              success(form.id ? 'Updated' : 'Logged');
              setForm(null);
            }
          and its button at :255  →  <Button type="submit">{…}</Button>
          Scan: a brace/string-aware JSX tag walk over app/ + components/ found
          257 `type="submit"` buttons, 73 with neither `loading=` nor
          `disabled=`; 25 of those are in 'use client' modules; 15 of THOSE sit
          under a `<form onSubmit={X}>` where `X` is declared `async` and
          performs a write. (The other 48 are server-action forms in
          app/(app)/admin/**, a different and much lower-traffic case.)
          How I ruled out the guards:
          - Re-entrance guard inside the handler: read all fifteen handlers.
            None sets or checks a flag. The only early returns are validation
            (`if (!form) return`, `if (!limitFor || !canSetLimits) return`).
          - A pending state elsewhere in the file: four of the fifteen files DO
            declare `const [busy, setBusy] = useState(false)` — and in every one
            it belongs to an AI-generate button, not the form:
              trip-itinerary.tsx:72 → :122 `loading={busy}` on "Build days from dates"
              trip-packing.tsx:58   → :116 `loading={busy}` on "Smart list"
              weekend-module.tsx:62 → :156 `loading={busy}` on "Find events"
            So the codebase knows the pattern and applies it to the slow
            *optional* action while leaving the *primary* write bare.
          - The Button primitive handling it implicitly: components/ui/button.tsx:34
            is `disabled={disabled || loading}` — it guards correctly, but only
            when a caller passes one of them. These callers pass neither.
          - The modal closing first: `setForm(null)` runs AFTER the await, so the
            form stays open and re-submittable for the whole round trip.
Impact:   On a slow or flaky connection — the common case on mobile — a parent
          taps "Log it", sees nothing happen, and taps again. Two behaviour logs,
          two immunisation records, two votes, two trip items. Some of these are
          money- or health-adjacent records that a parent then has to find and
          delete. Even with one tap the interaction has no acknowledgement at all
          until the toast fires.
Fix:      One state and two edits per form, matching what these same files
          already do for their AI buttons:
            const [saving, setSaving] = useState(false);
            async function save(e) { e.preventDefault(); if (saving) return;
              setSaving(true); try { …existing body… } finally { setSaving(false); } }
            <Button type="submit" loading={saving}>…</Button>
          The `if (saving) return` matters independently of the disabled button:
          it also stops the Enter-key path.
Status:   OPEN
```

---

## C2-20

```
[CLAUDE-2][MEDIUM][A11Y] The shared `Field` wrapper — 1,066 call sites — renders hint and error text that is programmatically unconnected to its control: no aria-describedby, no aria-invalid
File:     components/ui/input.tsx:30 (the "fully accessible" comment), :31-72
Problem:  `Field` takes `label`, `hint`, `error` and a `children(id)` render prop.
          It wires `htmlFor`/`id` correctly, which is the label half. It never
          wires the description half. The hint and the error render as sibling
          `<p>` elements with no `id`, and the control is given no
          `aria-describedby` and no `aria-invalid`.
Evidence: components/ui/input.tsx:31-72, read in full — the render prop is
          `children: (id: string) => React.ReactNode`, so the ONLY thing a call
          site can receive is the id:
            <label htmlFor={id} …>{label}{required && <span …>*</span>}</label>
            {children(id)}
            {hint && !error && <p className="text-xs text-muted">{hint}</p>}
            {error && <p className="text-xs text-danger" role="alert">{error}</p>}
          Neither <p> carries an id; nothing hands one to the control.
          Scale, from a brace-aware scan of app/ + components/:
            <Field …>              1,066 occurrences in 124 files
            … of which pass hint=     61
            … of which pass error=    13   (in 5 files: signup-form, login-form,
                                            calendar-module, contact-form,
                                            f/[id]/form-renderer)
          Project-wide there are exactly 2 uses of aria-invalid and 6 of
          aria-describedby, none of them in a Field:
            $ grep -rn "aria-invalid" app components
              app/(app)/admin/settings/social-links/social-links-form.tsx:89
              components/billing/family-value-comparison.tsx:31
          How I ruled out the guards:
          - The call sites doing it themselves: the render prop cannot pass the
            attributes through, and the two aria-invalid uses above are outside
            Field entirely. Checked the highest-traffic Field consumer,
            components/auth/signup-form.tsx:170-178 — it does everything else
            right (autoComplete="name"/"email"/"new-password", `required`,
            type="password", Button loading) and still has no aria-invalid,
            because Field gives it no way to set one.
          - role="alert" covering it: role="alert" on the error <p> makes the
            error ANNOUNCED when it appears. It does not make the field report
            itself as invalid, and it does nothing at all for the 61 hints,
            which are static and never announced.
          - A form-level summary: signup's failure path is
            `setErrors(fieldErrors(parsed.error)); return;` (signup-form.tsx:57-60)
            — no summary is rendered and focus is not moved to the first bad field.
Impact:   A screen-reader user tabbing into the signup password field hears
          "Password, required, edit text" and never hears "At least 8 characters"
          (signup-form.tsx:176). After a failed submit the field does not report
          itself invalid, so moving back through the form gives no indication
          which control is the broken one. WCAG 3.3.1 and 3.3.2.
Fix:      One file, no call-site churn. Give the two <p> elements ids derived
          from the existing useId(), and clone the node the render prop returns
          when it is a single React element:
            const hintId = `${id}-hint`, errId = `${id}-err`;
            const child = children(id);
            const described = [error ? errId : hint ? hintId : null]
              .filter(Boolean).join(' ') || undefined;
            {React.isValidElement(child)
               ? React.cloneElement(child, { 'aria-describedby': described,
                                             'aria-invalid': error ? true : undefined })
               : child}
          Falling back to `child` unchanged when it is a fragment keeps every
          existing call site working. Worth adding a lint/test gate alongside, in
          the shape of tests/icon-only-buttons-have-a-name.test.ts.
Status:   OPEN
```

---

## C2-21

```
[CLAUDE-2][MEDIUM][A11Y] Fifteen text inputs suppress the focus outline and put nothing in its place — not on themselves, not on any ancestor, not in CSS
File:     components/modules/inventory-module.tsx:148
          components/modules/todos-module.tsx:354
          components/modules/shopping-module.tsx:276
          components/modules/meals-module.tsx:464
          components/modules/messages-module.tsx:1251
          components/modules/weather-module.tsx:216
          components/modules/closet-module.tsx:213
          components/modules/contact-center-module.tsx:89, :121
          components/wallet/pay-handle-manager.tsx:100
          components/ui/phone-input.tsx:145
          components/dashboard/quick-actions.tsx:285
          components/app/command-bar.tsx:205
          components/admin/admin-shell.tsx:115
          components/admin/filter-bar.tsx:56
Problem:  Each is a `bg-transparent … outline-none` input sitting inside a
          statically-bordered wrapper. `outline-none` removes the browser's
          native :focus-visible ring; the wrapper's border never changes on
          focus; no ring, no focus-visible rule, nothing. Tabbing through these
          screens, focus simply disappears.
Evidence: A brace-aware scan of every JSX tag in app/ + components/ carrying
          `outline-none` found 125. Classified by what replaces the outline:
              21  a real ring (focus-ring / focus:ring / focus-visible:)
              69  only a focus:border colour change
              35  nothing on the tag itself
          Of those 35 I then removed, one by one, everything that is in fact
          covered elsewhere — this is where most of them went:
            - an ancestor with a Tailwind `focus-within:` class. The app-shell
              search (app-shell.tsx:54 `focus-within:border-brand`) and the blog
              search (blog-search.tsx:73 `focus-within:border-violet-400/50`)
              are guarded this way. Excluded.
            - an ancestor carrying a CSS class with a focus rule. The assistant
              composer's textarea and mic input (assistant-module.tsx:716, :741)
              sit in `.ai-composer`, and app/globals.css:296-299 defines
                .ai-composer:focus-within { border-color: …; box-shadow: 0 0 0 3px …; }
              which is a genuine 3px ring. Excluded. That rule is the only
              class-based focus rule in globals.css:
                $ grep -nE "^\s*\.[a-z-]+:(focus|focus-within|focus-visible)" app/globals.css
                  296:  .ai-composer:focus-within {
            - `tabIndex={-1}` programmatic focus targets (components/ui/modal.tsx:82
              is the dialog container, correctly outline-none). Excluded.
            - tags that were not controls: four `<PageHeader …>` hits were the
              scanner attributing a nested child's className to the outer tag.
              Excluded.
          Fifteen survive. Three read manually end to end to be sure:
            inventory-module.tsx:146-151 — wrapper is
              <label className="flex items-center gap-3 rounded-xl border border-border bg-surface/70 px-3 py-2">
              with no focus-within; input className is
              "min-h-10 w-full bg-transparent text-base outline-none placeholder:text-muted"
            todos-module.tsx:352-355 — wrapper
              "flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-1.5",
              input "w-32 bg-transparent text-sm placeholder:text-muted outline-none sm:w-40"
            admin-shell.tsx:112-119 — wrapper <label className="flex h-10 w-full
              items-center gap-2 rounded-xl border border-border …">, input
              "min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
          This is a DIFFERENT defect from C2-15. C2-15 is `.focus-ring` painting
          its ring unconditionally; these fifteen never reference `.focus-ring`
          at all. Fixing C2-15 does not touch them.
Impact:   Keyboard and switch users lose the focus indicator on the search box of
          the todo list, the shopping list, the inventory, the message composer's
          recipient picker, the admin console's global search and the command
          bar. WCAG 2.4.7. It also hits low-vision mouse users, who use the ring
          to re-find where they were.
Fix:      Two options, both one-line-per-site:
          (a) put the affordance on the wrapper, matching what app-shell.tsx:54
              and blog-search.tsx:73 already do:
                + focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/40
          (b) or drop `outline-none` from the input and let the browser draw the
              native :focus-visible outline.
          (a) is the better fit here because the visual control is the wrapper,
          not the transparent input. Either way, do NOT reach for `.focus-ring` —
          see C2-15; that class is itself broken.
Status:   OPEN
```

---

## C2-22

```
[CLAUDE-2][MEDIUM][I18N/UI] The i18n gate promises the signed-in app chrome is translated, but scans one file and not the two components that file renders — ten English strings ship in the quick-capture sheet on every authenticated page
File:     scripts/i18n-scan.mjs:32 (the gated surface), :559-566 (scanPaths)
          components/app/quick-capture.tsx:36-39, :85
          components/app/command-bar.tsx:167
Problem:  scripts/i18n-scan.mjs declares
            'app-shell': ['components/app/app-shell.tsx'],
          with the comment "The authenticated app chrome — top bar, account menu,
          sidebar, mobile nav. Every signed-in page renders this, so a regression
          here is visible on all of them at once."
          `scanPaths` walks the filesystem, not the import graph. app-shell.tsx
          itself is clean; the two chrome components it renders are not, and
          nothing scans them.
Evidence: The renders, in the gated file:
            components/app/app-shell.tsx:24  import { QuickCapture } from './quick-capture';
            components/app/app-shell.tsx:30  import { CommandBar } from './command-bar';
            components/app/app-shell.tsx:398 <QuickCapture />
            components/app/app-shell.tsx:399 <CommandBar />
          The project's OWN scanner, pointed at them:
            $ node scripts/i18n-scan.mjs --list components/app/quick-capture.tsx \
                                                components/app/command-bar.tsx
            components/app/quick-capture.tsx
                36  Task                      36  e.g. Pack lunches
                37  Note                      37  Jot something down…
                38  Event                     38  e.g. Dentist at 3pm
                39  Shopping                  39  e.g. Milk
                85  Undo
            components/app/command-bar.tsx
               167  Undo
            10 hardcoded string(s) across 2 file(s)
          All ten are rendered, not dead data:
            quick-capture.tsx:175  {t.label}                       (the four tabs)
            quick-capture.tsx:202  <Field label={active.label}>    (the field label)
            quick-capture.tsx:204  placeholder={active.placeholder}
            quick-capture.tsx:198  mixes a translated fragment with an English
                                   noun: tr('quickCapture.looksLikeA') +
                                   TYPES.find(…)!.label.toLowerCase() + tr('…tapToSwitch')
            quick-capture.tsx:84, command-bar.tsx:166, voice-module.tsx:108 also
            build user-visible text by template literal —
              `${res.count} items added`, `${…label} saved`, ` · ${res.count} items`
          How I ruled out the guards:
          - Another gated surface covering them: the surfaces are
            components/i18n, components/app/app-shell.tsx,
            components/marketing/site-header.tsx, app/(marketing),
            components/marketing, and five lib/marketing files
            (scripts/i18n-scan.mjs:26-61). components/app/ as a directory is not
            among them. scripts/i18n-scan.mjs:63 says so outright: "NOT gated:
            `everything` — ['app', 'components']".
          - The strings being internal-only: read every one at its render site,
            listed above.
          - Scanner false positives: I checked the other eleven components
            app-shell.tsx imports. The only other hit is
            free-tier-sidebar.tsx:187 "void; pinned: Set", which is TypeScript
            type text — a genuine false positive, excluded from the ten.
Impact:   Every non-English family sees the quick-capture sheet — the app's
          primary "add anything" affordance, on all 354 signed-in pages — offering
          "Task / Note / Event / Shopping" with "e.g. Pack lunches", and an
          "Undo" they must guess at, in a sheet whose other half is correctly
          translated. The gate's job is to make this impossible, and it reports
          the surface clean.
Fix:      Two parts, and the second is the one that lasts:
          1. Lift the ten strings into en-US.json and render via t(). TYPES must
             hold KEYS rather than words — the same shape lib/marketing/*.ts
             already uses for exactly this reason (scripts/i18n-scan.mjs:49-53).
          2. Make the 'app-shell' surface mean what its comment says. Either
             widen it to the directory —
               'app-shell': ['components/app'],
             — or walk imports. tests/i18n-client-scope.test.ts:21-40 already
             contains a working `resolveSpec`/`clientModulesFrom` import walker;
             the gate can use it instead of filesUnder(). Widening to the
             directory is the smaller change and catches this class permanently.
Status:   OPEN
```

---

## C2-23

```
[CLAUDE-2][LOW][A11Y/UX] The Undo toast is the only way to reverse a capture, auto-dismisses after 7 s, cannot be paused, and sits at the end of the tab order
File:     components/ui/toast.tsx:60 (the timer), :78 (the container)
          components/app/quick-capture.tsx:85, components/app/command-bar.tsx:167,
          components/modules/voice-module.tsx:109 (the three Undo toasts)
Problem:  Toasts self-destruct on a fixed timer with no pause-on-hover, no
          pause-on-focus and no way to extend:
            setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)),
                       action ? 7000 : 4200);
          When the toast carries an action that action is the only affordance for
          it, and it is rendered in a container appended after {children} at the
          very end of the provider's subtree — so reaching the Undo button by
          keyboard means tabbing past the whole rest of the page first.
Evidence: components/ui/toast.tsx:54-61 (the push/timer) and :74-78:
            <ToastContext.Provider value={api}>
              {children}
              <div className="pointer-events-none fixed inset-x-0 bottom-[…] …">
          No clearTimeout is ever called except by the dismiss/action buttons;
          there is no onMouseEnter/onFocus handler anywhere in the file.
          The three actionable toasts, each the only undo path for a write that
          already happened:
            quick-capture.tsx:83-91  success(…, { label: 'Undo', onClick: … undoCapture(…) })
            command-bar.tsx:165-168  same
            voice-module.tsx:107-112 same
          How I ruled out the guards:
          - A separate undo elsewhere: `undoCapture` has exactly these three call
            sites ($ grep -rn "undoCapture" app components). There is no history
            view or trash that re-offers it.
          - The toast being reachable another way: it is not in a live region a
            screen-reader user can jump to as a landmark, and it is not focused
            on appearance.
          What I did NOT verify: whether a given screen reader announces the
          action button. No browser or AT was run in this pass.
Impact:   WCAG 2.2.1 (Timing Adjustable) fails for every toast. Concretely: a
          keyboard-only or motor-impaired user who mis-captures an item cannot
          reach Undo inside 7 seconds, and the row stays. Everyone else loses it
          if they glance away.
Fix:      Small and local to components/ui/toast.tsx:
          - keep the timer id per toast; clear it on onMouseEnter / onFocusCapture
            of the container and restart on leave/blur. That alone satisfies
            2.2.1's "pause" for the hover and focus cases.
          - for actionable toasts, either extend the window substantially or move
            focus to the action button when one appears.
Status:   OPEN
```

---

## C2-24

```
[CLAUDE-2][LOW][MOTION] The global reduced-motion reset zeroes duration but not iteration count, so the 185 infinite spinners it covers keep re-running rather than stopping
File:     app/globals.css:473-482
Problem:  The reset is
            @media (prefers-reduced-motion: reduce) {
              *, *::before, *::after {
                animation-duration: 0.001ms !important;
                transition-duration: 0.001ms !important;
                scroll-behavior: auto !important;
              }
            }
          It omits `animation-iteration-count: 1 !important`, which the reset
          this is otherwise a copy of does include. For a finite animation the
          omission is harmless — the animation completes instantly. For an
          `infinite` one (animate-spin, animate-pulse, animate-bounce,
          .ai-orb-breathe) a 0.001 ms cycle that repeats forever is not a stopped
          animation; the element is still being re-composited every frame.
Evidence: app/globals.css:473-482 read in full (quoted above). Also
          app/globals.css:340-344, a second, narrower reduced-motion block that
          uses the correct form for the orb specifically:
            .ai-orb, .ai-orb::before, .ai-orb::after { animation: none; }
          Scale of what relies on the global block:
            animate-spin occurrences in app/ + components/ : 188
            … carrying motion-reduce:animate-none          :   3
          The 10 places that DO add `motion-reduce:*` are the tell that the team
          already treats the global reset as insufficient, applied unevenly:
            components/ui/states-client.tsx:42   (Skeleton — has it)
            components/ui/states-client.tsx:21-22 (Spinner — does NOT)
            components/ai/cards/index.tsx:131,133,134; run-status.tsx:96;
            components/concierge/{status-badge.tsx:43,run-timeline.tsx:157};
            components/modules/assistant-module.tsx:441;
            components/marketing/back-to-top.tsx:66
          How I ruled out the guards:
          - Tailwind doing it: `motion-reduce:animate-none` is opt-in per
            element, not automatic; 185 of 188 spin usages do not opt in.
          - The narrow block at :340 covering it: that block names only
            `.ai-orb` and its pseudo-elements.
          What I did NOT verify: I did not run a browser under
            prefers-reduced-motion: reduce
          to see what a 0.001 ms infinite rotation actually looks like. The claim
          here is about what the CSS says, not about observed flicker.
Impact:   Low but real: the users who asked the OS to reduce motion are the ones
          most affected by residual movement, and the shared `Spinner`
          (states-client.tsx:21-22) is the loading indicator the whole product uses.
Fix:      One line in app/globals.css:473-482:
            + animation-iteration-count: 1 !important;
          and, for the shared primitive, add `motion-reduce:animate-none` to
          components/ui/states-client.tsx:22 so Spinner matches Skeleton.
Status:   OPEN
```

---

## Verified clean this session — recorded so no one re-derives it

These cost real time to rule out. Each one is a plausible finding that turned
out to be already handled.

9.  **`prefers-reduced-motion` IS honoured globally.** app/globals.css:473-482
    applies `animation-duration/transition-duration: 0.001ms !important` and
    `scroll-behavior: auto` to `*`, `*::before`, `*::after`, plus a second
    targeted block at :340-344 for the AI orb.
    `components/marketing/back-to-top.tsx:42` checks the media query in JS before
    smooth-scrolling. The only gap is the iteration-count nuance in C2-24 — the
    headline "the app ignores reduced motion" is FALSE.

10. **`lucide-react` and `date-fns` barrel imports are not a bundle problem.**
    next.config.mjs sets no `optimizePackageImports`, which looks like an
    oversight, but Next 15.5.25 ships both packages in its DEFAULT list —
    node_modules/next/dist/server/config.js:864-865 — so the transform is on.
    Adding the option would change nothing.

11. **Dark/light theming is complete and the `dark:` variants do fire.**
    app/globals.css:29-67 defines the full dark token set on `:root, .dark` and
    :69-100 the light overrides on `.light`; every semantic colour has both.
    tailwind.config.ts uses `darkMode: 'class'`, and
    components/theme/theme-script.tsx adds a literal `light` OR `dark` class to
    `<html>` pre-paint (never neither, except in the catch branch, which adds
    `dark`). So the 122 `dark:*` utilities resolve. I had this half-written as a
    finding — "dark: can never match because light is the only class" — and it
    is wrong.

12. **The 25 widest `min-w-[…]` blocks all sit in an `overflow-x-auto`
    container.** Re-checked the two that the earlier pass's table sweep would
    have missed because they are not tables:
    components/admin/engagement-heatmap.tsx:25-26 (`overflow-x-auto` > `min-w-[640px]`)
    and app/(marketing)/pricing/pricing-content.tsx:386-387 (same shape).
    Largest is `min-w-[900px]` at app/(app)/admin/ai-activity/page.tsx:139.
    There are zero `w-[Npx]` ≥ 380 and zero inline `minWidth` anywhere in
    app/ + components/. No source of page-level horizontal scroll at 375px was
    found.

13. **The shared Modal is a correct mobile bottom sheet.**
    components/ui/modal.tsx:76-95 — `items-end … sm:items-center`,
    `max-h-[85dvh] sm:max-h-[92dvh] overflow-y-auto`, and
    `pb-[max(1rem,env(safe-area-inset-bottom))]` so the action row clears the
    home indicator. Focus restore to the trigger is at :69
    (`previouslyFocused?.focus?.()` in the effect cleanup) — so "focus is not
    restored after a modal closes" is FALSE for every dialog that uses this
    primitive. (C2-01 and C2-04 remain: those bypass it.)

14. **Loading and error states are near-universally wired on the realtime
    surfaces.** 111 files use `useRealtimeQuery`; 107 render `<ErrorState>` and
    101 render a Skeleton/LoadingBlock/Spinner. The hook itself
    (lib/hooks/use-realtime-query.ts:42-58) is careful in a way worth knowing
    about: a missing table degrades to an empty list rather than an error banner,
    and an offline read keeps the cached rows instead of showing a failure. The
    four without an ErrorState are small dashboard cards
    (concierge/working-on, concierge/run-timeline, moments/home-moment-card,
    memories/on-this-day-card). `EmptyState` is imported by 161 files. This area
    does not need another pass.

15. **The toast primitive's live-region roles are correct per tone.**
    components/ui/toast.tsx:84-85 sets `role="alert" aria-live="assertive"` for
    errors and `role="status" aria-live="polite"` otherwise. The timing problem
    is C2-23; the semantics are right.

16. **Touch targets on the shared Button are explicitly handled.**
    components/ui/button.tsx:39 carries
    `[@media(pointer:coarse)]:min-h-[44px]`, so every Button meets the 44 px
    minimum on touch without changing desktop density. Confirms the earlier
    pass's item 6 from the primitive's side.

17. **RTL is a non-issue today, and correctly prepared for.**
    lib/i18n/locales.ts:29-33 gives every Locale a `dir` field and all eleven
    shipped locales are `'ltr'`; app/layout.tsx:73 renders
    `<html lang={locale.code} dir={locale.dir}>`. Since no RTL locale ships, the
    physical-direction utilities (`ml-`, `pl-`, `left-`) throughout the codebase
    are not currently a defect. They WILL be the day an Arabic or Hebrew entry is
    added to LOCALES — that is a migration cost to note, not a bug to file.

18. **The signup form is the model the other forms should copy.**
    components/auth/signup-form.tsx:170-179 — `autoComplete="name"`,
    `autoComplete="email"` with `type="email"`, `autoComplete="new-password"`
    with `type="password"`, `required` on all three, zod validation before the
    network call, and `<Button type="submit" loading={loading}>`. Its only gap is
    the aria-invalid/aria-describedby one that belongs to `Field` (C2-20), not to
    this file.

---

## Method notes for session 5

- Every count above comes from a brace/string-aware JSX opening-tag walker
  (tracks `{}` depth, `'`/`"`/backtick state), not a line grep. A line grep over
  `<input[^>]*>` terminates on the `=>` of an inline arrow handler and
  mis-reports attributes; the earlier session hit this and so did my first draft
  of the focus scan.
- The focus scan (C2-21) went 35 → 21 → 15 as I removed, in order:
  Tailwind `focus-within:` ancestors, the `.ai-composer:focus-within` CSS rule,
  `tabIndex={-1}` containers, and non-control tags the walker had attributed a
  child's className to. The first number would have been a bad finding.
- Bundle numbers (C2-18) are the gzip of the UNION of `.next/app-build-manifest.json`
  chunk lists down each route's layout chain, computed with zlib, not estimates.
  They describe the build in `.next/` as of 2026-09-13 13:44. **No build was run**
  — Claude-1's note about four workers sharing one `.next` made that a bad idea,
  and the existing build was sufficient.
- Still not reached, same as the earlier session: no browser, so no measured
  colour contrast, no observed tab order, no screen-reader output. C2-23 and
  C2-24 say explicitly which part of each is code-derived rather than observed.
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

---
---

# Session 3 (2026-09-15) — the Expo app

## STATUS (session 3, 2026-09-15)

> NOTE: the STATUS block at the top of this file is session 2's. Rule 1 of this
> file is "append; never delete or rewrite existing content", so it has been
> left byte-for-byte alone rather than updated in place. **This block supersedes
> it.** Claude-1: when rebuilding the board, read this one.

CURRENT: **done.**
SCOPE THIS SESSION: the `mobile/` Expo app — the second application in this
  repo, which eleven prior passes had essentially not opened. The finalaudit
  "Mobile/Responsive" section is about the *web* app at phone width; the only
  two existing findings that touch `mobile/` at all are Claude-1's F-C10 (no
  tests, thin CI) and the Metro watch-folder note. Nothing had looked at the
  React Native accessibility API, the shared-token contract as the Expo app
  actually consumes it, touch targets, font scaling, or mobile i18n.
HARD LIMIT, STATED UP FRONT: **the app was never run.** No simulator, no
  device, no Metro bundle, no `expo export`, no VoiceOver, no TalkBack, no
  screenshot. Everything below is source reading plus arithmetic over
  `design/tokens.json`. Where a claim needs a device to confirm, it says so in
  its own Evidence block. "We could not look" is not "it is clean."
NEW FINDINGS: `C2-M01`–`C2-M16` (2 HIGH, 9 MEDIUM, 5 LOW, 0 CRITICAL).
  Numbered `M` so they cannot collide with `C2-01`–`C2-18` or `C2-B01`–`C2-B17`.
  One of them (C2-M03) is mostly a **web** finding that the mobile lens
  uncovered; it is filed here because it is i18n presentation, which is my
  scope, and because no other worker has it.
NOT REACHED: everything requiring a running app — see the BLOCKED table at the
  end of this section (8 rows).
FILES TOUCHED: `audit/claude-2.md` only (this append). No source file edited,
  no `npm install` run in `mobile/`, no commit.
LAST-UPDATE: 2026-09-15

---

## Is the Expo app a thin shell? No — but it is smaller than its file count suggests

Honesty first, because the brief asked for it. `mobile/` is **21 `.tsx` files**
(7 screens/layouts, 9 shared components, 5 others) plus 20 `.ts` library files.
It is a real, working companion app: sign-in, a Today dashboard, calendar,
chores with a write action, grocery with optimistic toggles, a voice assistant
with recording and transcription, and a settings modal. It is not a stub.

But its *surface* is narrow. Six of the seven screens are read-mostly; there
are exactly three write paths (complete a chore, toggle a grocery item, add a
grocery item) and everything else deep-links to the web app via
`Linking.openURL(webUrl(...))`. So the defect density below is not the density
of a 21-screen product — several findings are one line each, and I have marked
the trivial ones LOW rather than inflating them.

Two things about it are genuinely **good**, and it would be dishonest to bury
them under sixteen findings:

1. **Every touchable in the app has an accessible name.** I enumerated all 12
   `<Pressable>` sites (there are no `TouchableOpacity`/`TouchableHighlight`
   anywhere) and each one either sets `accessibilityLabel` or contains a `Text`
   child that RN derives a name from. Zero unnamed touchables — *better than the
   web app*, where C2-11 measured two unnamed icon-only buttons. The RN
   equivalent of the classic "unnamed `<button>`" defect does not exist here.
2. **The auth/session layer is a deliberate port of the web's persistent-login
   work, not a repeat of its bugs.** The brief asked whether
   `mobile/app/(auth)` repeats the web's session defects. It does not.
   `mobile/src/lib/auth-session.ts:20-25` explicitly refuses to treat
   `INITIAL_SESSION` with a null session as proof of sign-out;
   `auth-core.ts:36-50` re-implements `isRetryableAuthError` with an in-file
   comment explaining *why* it is duplicated rather than imported (Metro only
   watches `mobile/` and `design/`, so a runtime import from the web `lib/`
   would not resolve — that is the same constraint Claude-1 documented for the
   Metro watch folders, correctly reasoned about here); sessions live chunked in
   the Keychain/Keystore via `expo-secure-store`; `sign-out.ts` implements a
   revision-guarded local-scope sign-out so signing out of the phone cannot
   revoke the web session. It shares `shared/auth/refresh-fetch.ts` with the web.
   This is the *output* of the session work, arriving on mobile — the opposite
   of drift. **No finding is filed against it.**

And the shared-token pipeline itself works. `design/tokens.ts:55-58` builds
`palette(mode)` from `Object.keys(tokensJson.colors.dark)`, so a token added to
`design/tokens.json` for the web is **automatically present** in the Expo app's
`useTheme().colors` with no mobile-side change. `borderInput` is already there.
That makes C2-M01 below a missed *call site*, not a broken contract — which is
better news than the brief anticipated, and a much cheaper fix.

### Method

```
$ find mobile -type f \( -name '*.tsx' -o -name '*.ts' \) -not -path '*/node_modules/*' | wc -l
   41          (21 .tsx + 20 .ts)
$ cd mobile && npx tsc --noEmit ; echo EXIT=$?
   app/(tabs)/assistant.tsx(5,105): error TS2307: Cannot find module 'expo-audio'
   EXIT=2                       <- 1 error, and it is an ARTEFACT OF THIS BOX:
```
`mobile/node_modules` here is a partial install (341 packages; `expo-audio`,
`@expo/ui` and `@expo/metro-runtime` are absent from disk). I verified against
the lockfile that this is **not** a repo defect before reporting it as noise:

```
declared deps NOT in lockfile: none
lock root deps == package.json deps: True True
declared deps NOT on disk here: ['@expo/metro-runtime', '@expo/ui', 'expo-audio']
```
So CI's `npm ci` installs them and this error does not occur there. **With those
three excluded, the Expo app typechecks clean.** Per the brief I did not run
`npm install` in `mobile/`.

Contrast figures below are computed from `design/tokens.json` with the WCAG 2.1
relative-luminance formula, and — where a colour sits on a glass surface — over
the **composited** background (`glass` colour at its mode's alpha over `bg`),
not the raw `bg`. That composite step is why several of my numbers are slightly
worse than C2-B03's raw-token figures for the same tokens.

---

## C2-M01

```
[CLAUDE-2][HIGH][A11Y] The `borderInput` fix shipped to the web and never reached the Expo app — mobile text inputs are still at 1.28:1 / 1.38:1, with nothing masking it
File:     mobile/src/components/Field.tsx:21
Problem:  C2-B04 measured the web's text inputs at 1.28:1 (light) / 1.38:1
          (dark) border-against-fill and recommended "a dedicated
          `--border-input` token at >=3:1 against `--surface`". Claude-1 applied
          exactly that (session 3 board, and `design/tokens.json` now carries
          `borderInput` in both modes). The Expo app never got the call site:

            mobile/src/components/Field.tsx:21
              borderColor: error ? colors.danger : colors.border,
                                                   ^^^^^^^^^^^^^

          `Field` is the app's ONLY text-entry component — both sign-in fields,
          the grocery "Add an item…" box and the assistant composer.
Evidence: Computed from design/tokens.json (WCAG 2.1 relative luminance), border
          against the TextInput's own fill (`backgroundColor: colors.surface`,
          Field.tsx:22):

                                          DARK        LIGHT
            colors.border   on surface   1.38 : 1    1.28 : 1   <- shipped
            colors.borderInput on surface 3.56 : 1   3.52 : 1   <- one word away

          Those dark/light figures are the SAME two numbers C2-B04 measured in a
          real browser on the web app, and the same two Claude-1's guard test
          (tests/focus-and-boundary-contract.test.ts) re-derives from the token
          file. Three independent derivations agree.
Impact:   Worse than the web's pre-fix state, for a reason specific to RN. On
          the web, C2-B01's unconditional `.focus-ring` was accidentally
          outlining every input, which is what kept the fields visible while the
          border was at 1.28:1 — one defect masking another. **React Native has
          no such accident.** `Field` defines no focused state at all, and RN
          gives a `TextInput` no platform focus ring. So on mobile the 1.28:1
          border is the only boundary a low-vision user has, with nothing
          compensating. WCAG 1.4.11 Non-text Contrast (AA) requires 3:1.
Fix:      One word: `colors.border` -> `colors.borderInput` at Field.tsx:21.
          No token work needed — `palette()` already exposes it
          (design/tokens.ts:55-58 derives the palette from the JSON's key set,
          so the token arrived on mobile the moment it was added for the web).
          Then extend Claude-1's tests/focus-and-boundary-contract.test.ts with
          one assertion that no RN component styles an input border from
          `border`, so this cannot silently un-fix itself.
Status:   OPEN — verified by computation, NOT rendered (no simulator available)
```

---

## C2-M02

```
[CLAUDE-2][MEDIUM][A11Y] Nothing in the Expo app defines a focus state — and it ships with `supportsTablet: true`
File:     mobile/src/components/{Field,Button,ListRow}.tsx, mobile/app/**/*.tsx
Problem:  Zero components define a focused/focus-visible appearance. `Button`
          and `ListRow` style only `pressed`; `Field` styles only `error`. There
          is no `onFocus`/`onBlur` state anywhere in the app.
Evidence: $ grep -rn "onFocus\|focusVisible\|isFocused" mobile/app mobile/src --include=*.tsx
            (no output)
          mobile/app.json: "ios": { "supportsTablet": true }
Impact:   Touch users are unaffected. The people affected are iPadOS users with
          a hardware keyboard and Full Keyboard Access on, and Android users
          driving the app by D-pad or an external keyboard — RN's default
          focus affordance for a `Pressable` is minimal to none, and this app
          adds nothing. WCAG 2.4.7 Focus Visible. The web app treats this as
          important enough that C2-B01 + C2-B04 shipped together as one commit;
          the phone app has neither half.
Fix:      Give `Button`, `ListRow` and `Field` a focused style driven by
          Pressable's `({ focused })` / TextInput's `onFocus`, reusing the same
          brand ring the web uses. Cheapest correct version: a 2px
          `colors.brandText` outline at >=3:1 against the component's own fill.
Status:   OPEN — static read. **Cannot be confirmed without an iPad + Full
          Keyboard Access**; the source absence is certain, the rendered
          severity is not.
```

---

## C2-M03

```
[CLAUDE-2][HIGH][I18N] Every date and time in BOTH apps is formatted `en-US` — 160 hard-pinned call sites on the web, 1 on mobile, against 11 shipped locales
File:     mobile/src/lib/format.ts:9  (the mobile instance — one chokepoint)
          components/**, app/** (the web instance — 160 call sites, 86 files)
Problem:  The mobile lens found this; it is much larger on the web.

          mobile/src/lib/format.ts:9 — every date and time the Expo app renders
          goes through this one function:
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options })
                                                  ^^^^^^^
          The locale is pinned. `formatTime` therefore always produces
          "3:00 PM"; `dayLabel` always produces "Sat, Sep 6". The mobile app
          ships a SEVEN-locale message catalogue
          (mobile/src/lib/assistant-messages.json: en-US, de-DE, es-ES, fr-FR,
          it-IT, nl-NL, pt-PT) and resolves the device locale at
          mobile-i18n.ts:7-9 — so the app already knows the user reads German,
          and still renders 12-hour US times to them.
Evidence: $ grep -rnoE "toLocale(Date|Time)?String\('en-US'|Intl\.DateTimeFormat\('en-US'" \
              components/ app/ --include=*.tsx --include=*.ts | wc -l
            160
          $ ... -l | wc -l
            86            # files
          $ grep -rnoE "toLocale(Date|Time)?String\(locale|Intl\.DateTimeFormat\(locale" \
              components/ app/ --include=*.tsx --include=*.ts | wc -l
            59            # the locale-aware minority

          Worst offenders (call sites per file):
            components/modules/calendar-module.tsx   14
            components/modules/school-module.tsx      8
            components/modules/meals-module.tsx       7
            components/modules/sports-module.tsx      5
            components/modules/family-module.tsx      4
            app/(app)/home/page.tsx                   4

          The calendar module — the single place where date format matters most
          — is the single worst file.

          Web locale catalogue (lib/i18n/locales.ts:11-18, and 12 JSON
          catalogues in lib/i18n/messages/): en-US, en-GB, de-DE, es-ES, es-MX,
          es-US, fr-FR, fr-CA, it-IT, nl-NL, pt-PT. Seven of those eleven
          (de-DE, es-ES, es-MX, fr-FR, fr-CA, it-IT, nl-NL, pt-PT) use 24-hour
          time as the everyday convention; en-GB writes "6 Sep", not "Sep 6".
          The repo has a full, careful locale-resolution module
          (lib/i18n/resolve.ts, with a documented cookie > geo >
          accept-language > default precedence) whose answer 160 date call
          sites never ask for.
Impact:   Translated UI, untranslated time. A German family reads a fully
          localised interface and then "Fußball · 4:00 PM". This is the class of
          defect that reads as "this product was not really built for us" —
          more damaging to trust than a missing string, because it looks
          deliberate. It also silently affects en-GB, which otherwise looks
          perfectly translated.
Fix:      Mobile is one line and should go first — thread the resolved locale
          into `partsFor()` (format.ts:7-14) and pass it to
          `Intl.DateTimeFormat`; `mobileTranslate` already has the locale.
          Web: introduce one `lib/i18n/format-date.ts` helper taking the
          resolved locale, migrate the 86 files to it, and add a lint rule or a
          unit test asserting no `'en-US'` literal appears in a
          `toLocale*String` / `DateTimeFormat` call under components/ or app/.
          Exempt the genuinely correct ones deliberately: lib/services/scope.ts
          uses 'en-CA' to get YYYY-MM-DD keys and 'en-US' with hour12:false for
          an hour key — those are machine formats, not user-facing, and must be
          left pinned.
Status:   OPEN — verified by grep + reading the locale catalogue. Not rendered.
          Cross-checked against all four audit files and finalaudit.md: **no
          existing finding covers this.**
```

---

## C2-M04

```
[CLAUDE-2][MEDIUM][I18N] The Expo app translates exactly one screen; the other six and the tab bar are hardcoded English — and the seam runs through a single function
File:     mobile/app/(auth)/sign-in.tsx, (tabs)/{_layout,index,calendar,chores,
          grocery}.tsx, app/settings.tsx, app/_layout.tsx:37,
          mobile/src/lib/{auth-core,format,chores-core}.ts
Problem:  `mobile/src/lib/mobile-i18n.ts` + `assistant-messages.json` are a real,
          working 7-locale i18n layer. EVERY key in that catalogue is namespaced
          `mobileAssistant.*` — it was built for the assistant screen and stopped
          there. 4 of 19 .tsx files import it:

            $ grep -rln "mobile-i18n" mobile/app mobile/src
              mobile/app/settings.tsx          (3 calls — sign-out strings only)
              mobile/app/(tabs)/assistant.tsx  (20 calls — fully translated)
              mobile/src/components/ReconnectingScreen.tsx  (4 calls)
              mobile/src/lib/{voice-core,api,auth,assistant-core}.ts

          Everything else is English literals. A partial census:
            sign-in.tsx     "Run your family like a calm, connected team.",
                            "Sign in with the account you use on the web.",
                            label="Email", label="Password", title="Sign in",
                            "Forgot password?", "Create an account", and the
                            EXPO_PUBLIC_* misconfiguration notice (lines 57-58)
            (tabs)/_layout  all five tab labels: Today, Calendar, Chores,
                            Grocery, Assistant  (TABS const, lines 8-12)
            app/_layout:37  title: 'Settings'   (the modal header)
            index.tsx       "Chores open", "To buy", "Next 3 days", "Up next",
                            "Chores due", "All caught up.", "Ask Bubaly",
                            "Open the assistant", accessibilityLabel="Settings"
            calendar.tsx    "Calendar", "The next two weeks", "A clear
                            fortnight", "Nothing scheduled in the next 14 days…"
            chores.tsx      "Chores", "Done", "Nothing open", "Every chore is
                            done or waiting on approval."
            grocery.tsx     "Grocery", "Add an item…", "New grocery item",
                            "Add", "Your list is empty", "Add items above…"
            settings.tsx    "Appearance", "Account", "About", "Dark", "Light",
                            "Match device", "Manage family on the web",
                            "Members, invites, billing", "Notification
                            preferences", "Privacy", "Terms"
            auth-core.ts    all 8 sign-in error + validation strings
            format.ts       "Today", "Tomorrow", "All day", "No due date",
                            "Good night/morning/afternoon/evening", "Overdue · ",
                            "Due today · ", "Due "
            chores-core.ts  "To do", "In progress", "Waiting for approval",
                            "Needs another go"
Evidence: The seam is visible inside a single function —
          mobile/src/lib/auth.tsx:83-84:

            if (error?.code === 'session_write_blocked')
              return { error: mobileTranslate(deviceLocale(), 'mobileAssistant.signInRetry') };
            return { error: error ? friendlyAuthError(error.message) : null };
                                    ^^^^^^^^^^^^^^^^^ returns English literals

          One branch is localised, the next line is not, in the same return
          statement of the same function. That is the shape of a migration that
          stopped rather than a decision that was made.
Impact:   A non-English user signs in through an English form, navigates an
          English tab bar, reads English empty states and English chore statuses
          — and then reaches one screen, the assistant, that speaks their
          language. The inconsistency is more confusing than uniform English
          would be, and it makes the shipped 7-locale catalogue look broken.
Fix:      Rename the namespace (`mobileAssistant.*` -> `mobile.*`, or add a
          second `mobile.ui.*` block) and lift the ~60 strings above into it.
          The three pure modules (format.ts, chores-core.ts, auth-core.ts) should
          return KEYS, not sentences, so the pure/unit-tested layer stays
          framework- and language-free — that is the same discipline
          `assistant-core.ts` already follows by taking a `MobileTranslator`.
          Pair this with C2-M03: they are the same user's experience.
Status:   OPEN — verified by grep. Not rendered.
```

---

## C2-M05

```
[CLAUDE-2][MEDIUM][A11Y] No headings, no live regions, no hints anywhere in the Expo app — and the only two `role="alert"` uses do not announce anything
File:     all 21 mobile .tsx files; specifically mobile/src/components/Screen.tsx:23,
          mobile/app/settings.tsx:68, mobile/src/components/ReconnectingScreen.tsx:20
Problem:  React Native's accessibility API is not the web's, and three of its
          parts are entirely unused:

            $ for p in accessibilityRole=\"header\" accessibilityLiveRegion \
                       accessibilityHint accessible= allowFontScaling \
                       importantForAccessibility accessibilityElementsHidden; do
                printf '%-34s %s\n' "$p" "$(grep -rno "$p" mobile/app mobile/src --include=*.tsx | wc -l)"
              done
              accessibilityRole="header"          0
              accessibilityLiveRegion             0
              accessibilityHint                   0
              accessible=                         0
              allowFontScaling                    0
              importantForAccessibility           0
              accessibilityElementsHidden         0

          (a) **No headings.** `Screen.tsx:23` renders every screen title as
              `<AppText variant="title">` — a plain `Text`. VoiceOver's rotor
              and TalkBack's heading navigation find nothing on any of the seven
              screens. This is the RN equivalent of a page with no `<h1>`.
              `accessibilityRole="header"` is the one-prop fix and the app uses
              `accessibilityRole` correctly 15 times elsewhere, so this is an
              omission rather than an unfamiliarity.
          (b) **Nothing is ever announced.** The assistant's replies arrive as
              new `FlatList` rows (assistant.tsx:136 `<Bubble>`); errors arrive
              as `role: 'error'` bubbles; chore-action failures render at
              chores.tsx:46; grocery failures at grocery.tsx:76. None of these
              is a live region and none calls
              `AccessibilityInfo.announceForAccessibility`. A blind user sends a
              voice command to a voice assistant and is told nothing came back.
          (c) **The two `accessibilityRole="alert"` uses do not do what they
              look like they do.** settings.tsx:68 and ReconnectingScreen.tsx:20
              set `accessibilityRole="alert"` on a `Text` that appears when
              sign-out fails. In RN, `alert` is a ROLE, not a live region: it
              changes how the node is described once focus reaches it, and
              triggers no announcement on either platform. Announcing requires
              `accessibilityLiveRegion="assertive"` (Android) or
              `AccessibilityInfo.announceForAccessibility` (iOS). Both files
              read as though someone reached for the web's `role="alert"`
              semantics and got the RN prop that shares its name.
Evidence: The prop census above. `alert`'s RN behaviour: it is in RN's
          accessibilityRole enum and is documented as describing the element;
          Android live-region behaviour is a separate prop
          (`accessibilityLiveRegion`), which is at 0 occurrences here.
Impact:   Screen-reader users cannot navigate any screen structurally, get no
          feedback when an action fails, and get no feedback when the assistant
          — the app's headline feature — answers.
Fix:      Three cheap changes, in this order:
          1. `Screen.tsx:23` — add `accessibilityRole="header"` to the title
             `AppText` (fixes all seven screens at once).
          2. Wrap the error/status text in chores.tsx:46, grocery.tsx:76,
             assistant.tsx:141-142 and the two sign-out failures in a small
             `<Announce>` component that sets
             `accessibilityLiveRegion="assertive"` and calls
             `AccessibilityInfo.announceForAccessibility` on mount.
          3. Announce assistant replies the same way (or at minimum the phase
             transitions already rendered at assistant.tsx:138).
Status:   OPEN — verified by census. **Screen-reader behaviour NOT observed** —
          no device. The absence of the props is certain.
```

---

## C2-M06

```
[CLAUDE-2][MEDIUM][A11Y] Two nested-touchable mistakes: a checkbox whose state lives on the wrong node, and a role+label on a View that is not an accessibility element
File:     mobile/app/(tabs)/grocery.tsx:81-92
          mobile/app/(tabs)/assistant.tsx:226-234
Problem:  (a) grocery.tsx:81-92 — a `ListRow` with `onPress` (which renders a
              `Pressable` with `accessibilityRole="button"` and
              `accessibilityLabel={"Check Milk"}`, ListRow.tsx:30) contains, in
              its `leading` slot, a SECOND `Pressable`:

                <Pressable accessibilityRole="checkbox"
                           accessibilityState={{ checked: item.is_checked }}
                           onPress={() => toggle(item)} hitSlop={8}>

              Both call the same `toggle`. The `checked` state — the only thing
              that says whether this item is already in the cart — is on the
              INNER node. The outer node, which spans the whole row and is what
              a screen reader lands on first, announces "Check Milk, button"
              with no state at all. Nested touchables are also ambiguous for
              VoiceOver's element grouping: depending on platform the inner
              checkbox is either swallowed or announced as a duplicate control
              for the same action.
          (b) assistant.tsx:226-234 — the assistant's result cards:

                <GlassCard ... accessibilityRole={open ? 'button' : undefined}
                               accessibilityLabel={section.title}>
                  <Pressable onPress={open} disabled={!open} style={...}>

              `GlassCard` renders a plain `View` (GlassCard.tsx:9). A `View` is
              only exposed as a SINGLE accessibility element when
              `accessible={true}` is set — and `accessible=` is at 0 occurrences
              app-wide (C2-M05). So the role and label on the card are inert,
              and the `Pressable` that actually handles the press has neither a
              role nor a label: it is announced as its concatenated child text
              with no indication that it is a button or that it opens the web.
Evidence: The two code blocks above, read against RN's rule that `View` needs
          `accessible` to become an a11y element, and against the app's own
          census (`accessible=` : 0 occurrences).
Impact:   (a) A blind user cannot tell which grocery items are already checked —
          the list's entire state is invisible to them. (b) The assistant's
          result cards do not announce as actionable, so the "open this on the
          web" affordance is undiscoverable.
Fix:      (a) Collapse to ONE touchable: put `accessibilityRole="checkbox"` and
              `accessibilityState={{ checked: item.is_checked }}` on the
              `ListRow` Pressable (add both as `ListRow` props) and make the
              leading icon a non-interactive `View`/`Ionicons`. One control, one
              label, one state.
          (b) Move `accessibilityRole="button"` and `accessibilityLabel` from
              the `GlassCard` onto the inner `Pressable`, and drop them from the
              card.
Status:   OPEN — verified by source reading. Announcement order NOT observed.
```

---

## C2-M07

```
[CLAUDE-2][MEDIUM][A11Y] The theme picker's radios report `selected` instead of `checked` — and the same file's sibling pattern gets it right
File:     mobile/app/settings.tsx:35-43
Problem:  Three theme options are rendered as:

            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              ...

          For `accessibilityRole="radio"` the state key RN maps to the platform
          is `checked` — on Android it drives
          `AccessibilityNodeInfo.setChecked()`, which is what TalkBack reads out
          as "selected"/"not selected" for a radio button. `selected` maps to a
          different trait and is not what a radio's platform semantics read.
          There is also no `accessibilityRole="radiogroup"` wrapper (the
          container at settings.tsx:31 is a bare `View`), so there is no group
          context and no "2 of 3" position.
Evidence: The app's OWN sibling usage is correct — mobile/app/(tabs)/grocery.tsx:88
            <Pressable accessibilityRole="checkbox"
                       accessibilityState={{ checked: item.is_checked }}
          Same codebase, same week, correct key. This is a slip, not a
          misunderstanding, which is why it is cheap to fix.
Impact:   A TalkBack user opening Settings hears three radio buttons and cannot
          tell which theme is currently active. Small surface, but it is the
          only settings control in the app.
Fix:      `accessibilityState={{ checked: active }}` on each Pressable, and
          `accessibilityRole="radiogroup"` on the wrapping `View` at line 31.
Status:   OPEN — verified by source reading. Not heard.
```

---

## C2-M08

```
[CLAUDE-2][MEDIUM][UX] A failed refresh is completely silent on three of four list screens — the error renders only where it cannot be seen
File:     mobile/app/(tabs)/chores.tsx:66-74
          mobile/app/(tabs)/calendar.tsx:46-54
          mobile/app/(tabs)/grocery.tsx:94-102
Problem:  All three screens put the load error inside `ListEmptyComponent`:

            ListEmptyComponent={
              chores.loading ? null : (
                <View ...>
                  {chores.error ? <AppText color={colors.danger}>{chores.error}</AppText>
                                : <EmptyState ... />}
                </View>
              )
            }

          `ListEmptyComponent` renders ONLY when `data.length === 0`.
          `useAsyncData` keeps the previous `data` on a failed load
          (use-async-data.ts:26-33 sets `error` and leaves `data` untouched). So
          the failure is visible only in the one case where the list was already
          empty — precisely the case where it matters least. A pull-to-refresh
          that fails while rows are on screen spins, stops, and changes nothing:
          the user is looking at stale data believing it is current.
Evidence: use-async-data.ts:26-33 — `setDataState` is only called in the success
          branch; the catch branch sets `error` alone. And the same file's
          `RefreshControl` (chores.tsx:45) resets regardless of outcome.
Impact:   Same defect class as C2-15 on the web, in three fresh instances. A
          parent pulls to refresh the chore list on a flaky connection, sees the
          spinner complete, and acts on yesterday's data. On the chores screen
          specifically this compounds with the optimistic write at
          chores.tsx:31 — the local list can diverge from the server with no
          signal at all.
Evidence
 (positive): mobile/app/(tabs)/index.tsx:62 gets this RIGHT —
            {today.error ? <AppText variant="muted" color={colors.danger}>…</AppText> : null}
            rendered above the content, unconditionally. So the correct pattern
            exists in the app and three screens did not adopt it.
Fix:      Move each `<X>.error` out of `ListEmptyComponent` and into
            `ListHeaderComponent` (chores.tsx already has one, for `actionError`
            — merge the two), rendered whenever `error` is non-null regardless
            of `data.length`. Keep `EmptyState` in `ListEmptyComponent` for the
            genuinely-empty case. Pair with C2-M05(b) so it is announced too.
Status:   OPEN — verified by source reading.
```

---

## C2-M09

```
[CLAUDE-2][MEDIUM][UX] Raw PostgREST error text is rendered straight to the user — including "permission denied for table …"
File:     mobile/src/hooks/use-async-data.ts:30
          mobile/src/lib/queries.ts:19,37,44,53,58,64,72,77 (every query)
          rendered at chores.tsx:70, calendar.tsx:50, grocery.tsx:98,
          chores.tsx:33,46, grocery.tsx:35,49,76
Problem:  Every function in queries.ts ends `if (error) throw error;` — throwing
          the Supabase `PostgrestError` object itself. `useAsyncData` then does:

            setError(e instanceof Error ? e.message : 'Something went wrong.');

          and the screens render that string into the UI verbatim:

            <AppText color={colors.danger}>{chores.error}</AppText>

          I checked whether `instanceof Error` actually catches it, because the
          answer decides which defect this is:

            $ grep -rn "class PostgrestError" mobile/node_modules/@supabase/
              .../postgrest-js/src/PostgrestError.ts:25:
                export default class PostgrestError extends Error {

          It does. So the database's own message reaches the screen.
Evidence: The vendored doc comment in that same file, describing what those
          messages contain:
            "For permission-denied errors (`42501`), this is the literal SQL to
             fix the problem, e.g. \"Grant the required privileges to the current
             role with: GRANT SELECT ON public.users TO anon;\""
          An RLS policy gap on `chore_assignments` therefore surfaces to a
          parent as PostgREST's message about roles and grants — and the same
          path carries JWT-expiry and schema-cache messages.
Impact:   Two harms. (1) Usability: the strings are meaningless to a family-app
          user and there is no retry affordance attached. (2) Disclosure: table
          names, column names and role names leak to anyone who can trigger a
          query failure. Not a privilege escalation — this is the user's own
          client — but it is internal schema detail on a consumer screen, and it
          is the kind of string that ends up in a support screenshot.
Fix:      The app already has the right pattern next door:
          `mobile/src/lib/auth-core.ts:4-12` (`friendlyAuthError`) maps provider
          messages to actionable copy. Add the data-side twin — a
          `friendlyDataError(error)` in a pure module, mapping PostgREST codes
          (42501, PGRST116, 23505, network/abort) to catalogue KEYS, and call it
          from use-async-data.ts:30 and from the three `catch` blocks in
          chores.tsx:32-34 and grocery.tsx:33-36, 48-51. Log the raw object;
          show the mapped copy. (Doing this in a pure module also means it gets
          covered by the existing root-level mobile-core unit tests.)
Status:   OPEN — verified: PostgrestError's Error inheritance confirmed in the
          installed package; render path traced. Not observed live.
```

---

## C2-M10

```
[CLAUDE-2][MEDIUM][A11Y] Text scales with the OS font-size setting but the line boxes do not — fixed `lineHeight` against a scaling `fontSize`
File:     mobile/src/components/AppText.tsx:13-14
          mobile/src/components/ListRow.tsx:22-23
Problem:  RN's `allowFontScaling` defaults to TRUE, so the app does honour iOS
          Dynamic Type and the Android font-size setting — that part is right,
          and `allowFontScaling` / `maxFontSizeMultiplier` are at 0 occurrences
          precisely because the default is the correct one. The problem is what
          scales alongside it:

            AppText.tsx:13  body:  { fontSize: font.size.base, ..., lineHeight: 22 }
            AppText.tsx:14  muted: { fontSize: font.size.sm,   ..., lineHeight: 20 }

          `fontSize` scales with the OS multiplier; the literal `lineHeight`
          does not. At iOS "Larger Accessibility Sizes" the multiplier reaches
          roughly 3.1x — a 16pt body glyph rendered into a 22pt line box.
          Descenders clip and consecutive lines overlap.

          Compounded at ListRow.tsx:22-23, which caps the same text:
            <AppText ... numberOfLines={2}>{title}</AppText>
            <AppText variant="muted" numberOfLines={1}>{subtitle}</AppText>
          so at large sizes a chore title or a grocery item name is truncated
          rather than wrapped — and `ListRow` is the primitive behind the
          grocery list, the calendar list, the Today dashboard and every
          settings row.
Evidence: The two style objects above; the census showing zero
          `maxFontSizeMultiplier` anywhere. Note `Button.tsx:38` also overrides
          to a literal `{ fontSize: 16 }` on a `heading` variant, and
          settings.tsx:42 to `{ fontSize: 14 }` — both bypass the token scale,
          which is a smaller instance of the same "literal beats token" habit.
Impact:   Users who have enlarged system text — the largest single group of
          users with a visual impairment — get clipped and overlapping text
          across the whole app, and truncated list items. This is the
          highest-population accessibility defect in the mobile app.
Fix:      Express line height as a multiplier of the (scaled) font size rather
          than a literal: drop the `lineHeight` entries and let RN compute, or
          derive them in `AppText` from the resolved font size. Where a cap is
          genuinely needed for layout, use `maxFontSizeMultiplier` explicitly so
          the ceiling is a decision rather than an accident. Replace
          `numberOfLines` caps in `ListRow` with wrapping, or make the cap
          conditional on the current `PixelRatio.getFontScale()`.
Status:   OPEN — static read. **NOT measured**: confirming the clipping needs a
          device or simulator with Dynamic Type turned up, which is exactly what
          this environment does not have.
```

---

## C2-M11

```
[CLAUDE-2][MEDIUM][A11Y] Closes the gap C2-B03 named as unreachable: the status-colour consumer IS the mobile Pill, and composited it is worse than the raw tokens
File:     mobile/src/components/Pill.tsx:12-13 (the consumer)
          used by (tabs)/chores.tsx:57-58, (tabs)/index.tsx:76,87,
          (tabs)/calendar.tsx:42, (tabs)/assistant.tsx:206
Problem:  C2-B03 measured the light theme's `--success` / `--warning` / `--danger`
          tokens below AA and said, verbatim: "`--success` / `--warning` are used
          for status chips and toasts, which live behind the login wall, so I
          could not render them ... The token ratios above are measured, the chip
          usage is not." The `audit/claude-2.md` BLOCKED table carries the same
          row. **`mobile/src/components/Pill.tsx` is that chip**, it is
          statically readable, and its ground is worse than `bg`.

            Pill.tsx:12-13
              borderColor: color, paddingHorizontal: spacing[2], paddingVertical: 2
              <AppText variant="caption" color={color}>{label}</AppText>
                                                   // caption = 12px, weight 500

          Every use sits inside a `GlassCard`, so the real background is the
          glass composite, not `bg`:
            light: glass [16,22,40] at alpha 0.03 over bg [245,247,252]
                   => effective fill [238.1, 240.2, 245.6]
Evidence: Computed from design/tokens.json, WCAG 2.1 relative luminance, 12px
          text (needs 4.5:1):

            LIGHT theme        on raw --bg   on GlassCard (real)
              warning            2.70 : 1      **2.54 : 1**
              success            2.91 : 1      **2.75 : 1**
              danger             4.09 : 1      **3.85 : 1**
              info               4.82 : 1        4.54 : 1   (marginal)
              muted              4.91 : 1        4.63 : 1   (marginal)
              brandText          6.36 : 1        5.99 : 1   ok
            DARK theme: all six between 6.50 and 10.97 : 1 — comfortable.

          So the composite makes B03's already-failing figures worse by
          0.16-0.24, and pushes `info` and `muted` from "thin pass" to
          "marginal". The Pill's BORDER is drawn in the same colour, so the
          chip's outline fails 1.4.11's 3:1 too, for warning and success.

          Which chips these are, concretely:
            chores.tsx:57  Pill tone="warning"  -> "Waiting for approval"
            chores.tsx:49  tone="danger"        -> an OVERDUE chore
            assistant.tsx:206 tone="success"/"danger" -> whether the assistant's
                           action actually worked
          The three pieces of status a family most needs to read at a glance.

          Separately, the same `danger` token is used for BODY error text at
          16px (needs 4.5:1) at chores.tsx:46,70, calendar.tsx:50,
          grocery.tsx:76,98, assistant.tsx:142, settings.tsx:68 —
          **4.09:1 on `bg`, 3.85:1 on a GlassCard.** Every error message in the
          mobile app is below AA in the light theme.
Impact:   Upgrades C2-B03 from "token ratios measured, usage unverified" to
          "usage verified, and the usage is worse than the token table implied".
          It also shows the defect is not web-only: the same JSON file feeds both
          apps, so re-deriving the light ramp fixes both at once.
Fix:      As C2-B03 — re-derive light-theme `danger`/`success`/`warning` against
          BOTH `bg` and the glass composite for >=4.5:1 as text, keeping the
          current values as separate `*Fill` tokens if the lighter hue is wanted
          for backgrounds. Add the glass composite to whatever contrast test
          lands (Claude-1's C1-S3-03 notes the repo has no WCAG formula anywhere
          outside the new guard) — testing against `bg` alone would pass values
          that fail in situ.
Status:   OPEN — computed, not rendered. **This is evidence FOR C2-B03, not a
          separate defect**; Claude-1 should merge it into B03 rather than
          count it twice in any severity total.
```

---

## C2-M12

```
[CLAUDE-2][LOW][A11Y] All 17 icons are exposed to screen readers as glyph text
File:     17 `<Ionicons>` sites across mobile/app and mobile/src
Problem:  `@expo/vector-icons` renders an icon as a `<Text>` containing a
          private-use-area codepoint, and sets NO accessibility props of its own.
          Purely decorative icons are therefore accessibility elements that
          announce an unmapped character (or, on some TalkBack versions, nothing
          at all, leaving a silent focus stop).
Evidence: $ head -30 mobile/node_modules/@expo/vector-icons/build/createIconSet.js
            import { Text, PixelRatio } from 'react-native';
          $ grep -rln "accessibilityElementsHidden\|importantForAccessibility" \
              mobile/node_modules/@expo/vector-icons/
            (no output)
          And in this app: `accessibilityElementsHidden` 0,
          `importantForAccessibility` 0, `accessible=` 0.
          Decorative instances include EmptyState.tsx:20, index.tsx:94,
          assistant.tsx:122, and every `leading` icon in settings.tsx:52-65 —
          all of which sit beside text that already carries the meaning.
Impact:   Extra silent or garbled stops while swiping through a screen. Low
          severity, wide surface.
Fix:      Add `accessibilityElementsHidden` + `importantForAccessibility="no"`
          (or wrap in a `View` with `accessible={false}`) on the decorative
          instances. The icons that ARE the only content of a control
          (index.tsx:42, assistant.tsx:104, sign-in.tsx:45, the three at
          assistant.tsx:164/176 and grocery.tsx:89) must NOT be hidden — their
          parents already carry the label, so hiding the glyph is correct there
          too.
Status:   OPEN — verified in the installed package. Not heard.
```

---

## C2-M13

```
[CLAUDE-2][LOW][A11Y] One touch target under 44pt — and the rest are right because they read the shared token
File:     mobile/app/(tabs)/grocery.tsx:88
Problem:  The grocery check circle is `Ionicons size={26}` with `hitSlop={8}`:
          26 + 8 + 8 = **42 x 42**, under the 44pt iOS and 48dp Android floors.
Evidence: I measured all 12 Pressables:
            sign-in.tsx:44      icon 22 + hitSlop 12  = 46      ok
            index.tsx:41        icon 24 + hitSlop 12  = 48      ok
            assistant.tsx:103   icon 24 + hitSlop 12  = 48      ok
            assistant.tsx:128   pv 12x2 + lineHeight  ~46      ok
            assistant.tsx:143   minHeight 44                    ok
            assistant.tsx:149   48 x 48 explicit                ok
            assistant.tsx:169   48 x 48 explicit                ok
            assistant.tsx:227   multi-line card                 ok
            index.tsx:107       GlassCard, title+caption        ok
            settings.tsx:40     minHeight layout.touchTarget    ok
            Button.tsx:26       minHeight layout.touchTarget    ok
            ListRow.tsx:19      minHeight layout.touchTarget    ok
            grocery.tsx:88      26 + 8 + 8 = 42                 UNDER
          Mitigation, stated honestly: that checkbox sits inside a `ListRow`
          whose content View is `minHeight: layout.touchTarget` (44) and whose
          Pressable fires the SAME `toggle`, so a near-miss still works. The
          42x42 element is nonetheless the one a user aims at.
          Secondary note: `design/tokens.json` `layout.touchTarget` is a single
          `44` used on both platforms; Android's guidance is 48dp, so every
          `minHeight: layout.touchTarget` control is 4dp under the Android
          floor. That is a token decision, not a mobile bug.
Impact:   Marginal — one control, with a working fallback.
Fix:      `hitSlop={12}` at grocery.tsx:88 (26+24 = 50). Separately, consider
          `touchTarget: { ios: 44, android: 48 }` in design/tokens.json, or just
          raising it to 48 for both.
Credit:   Worth recording the positive: the mobile app sizes its controls from
          `layout.touchTarget` in the SHARED token file rather than from
          literals. That is the pattern this repo keeps failing to use
          elsewhere, used correctly here.
Status:   OPEN — computed from source. Not measured on a device.
```

---

## C2-M14

```
[CLAUDE-2][LOW][UX] The system keyboard renders light while the app renders dark
File:     mobile/src/components/Field.tsx (no `keyboardAppearance`),
          mobile/app.json:"userInterfaceStyle": "automatic"
Problem:  `keyboardAppearance` is at 0 occurrences app-wide, so on iOS the
          keyboard always uses the system appearance. The app's product default
          is DARK regardless of the OS (`design/tokens.json` `theme.default:
          "dark"`, resolved at theme-core.ts:25-28 — anything other than an
          explicit 'light' resolves dark). So on a light-mode iPhone, a user who
          has never opened Settings gets a dark app with a light keyboard, and
          the same mismatch in any other native surface the OS styles.
Evidence: `grep -rn keyboardAppearance mobile/` -> no matches.
          app.json:"userInterfaceStyle": "automatic" (native follows the OS)
          vs theme-core.ts:13 DEFAULT_THEME = DEFAULT_THEME_MODE = 'dark'.
          These two defaults disagree by construction on a light-mode device.
Impact:   Cosmetic, but it is the most-seen native surface in the app and it
          appears on the sign-in screen — the first screen anyone sees.
Fix:      `keyboardAppearance={mode === 'dark' ? 'dark' : 'light'}` in
          `Field.tsx` (it already has `mode` available via `useTheme`). Decide
          deliberately whether `userInterfaceStyle` should be `"dark"` to match
          the product default, or whether the product default should become
          `system` — right now neither was chosen, they just differ.
Status:   OPEN — static read.
```

---

## C2-M15

```
[CLAUDE-2][LOW][BUILD] Three declared mobile dependencies are referenced nowhere; one of them adds a native module to every build
File:     mobile/package.json
Problem:  Reference counts across mobile/app, mobile/src, mobile/app.json and
          mobile/scripts:
            @expo/ui            0     <- SwiftUI / Jetpack Compose primitives
            expo-system-ui      0
            react-dom           0
            @expo/metro-runtime 0     <- but required indirectly by expo-router
            react-native-screens 0    <- but required indirectly by react-navigation
          The last two are legitimate at zero direct references and are NOT part
          of this finding. `@expo/ui` and `expo-system-ui` are genuinely unused —
          neither is imported and neither appears in app.json's `plugins`.
          `react-dom` is only needed for `expo start --web`, and app.json has no
          `web` block.
Evidence: $ for d in ...; do grep -rl "$d" mobile/app mobile/src mobile/app.json mobile/scripts | wc -l; done
          (counts above)
Impact:   `@expo/ui` in particular ships a native module into every EAS build
          for nothing — build time, binary size, and a native surface the app
          does not use. Minor, but this is a two-app repo where `mobile/` has
          its own lockfile and its own CI job, so unused native deps are easy to
          leave behind unnoticed.
Fix:      Remove `@expo/ui`, `expo-system-ui` and `react-dom` from
          mobile/package.json; re-run `npm install` in `mobile/` to update its
          lockfile; confirm with `npx expo-doctor` (already wired as
          `npm run doctor`).
Status:   OPEN — verified by reference count. Removal not attempted (the brief
          forbids `npm install` in mobile/ in this environment).
```

---

## C2-M16

```
[CLAUDE-2][LOW][UX] An invalid EMAIL reports its error underneath the PASSWORD field
File:     mobile/app/(auth)/sign-in.tsx:24-30, 60-61
Problem:  `submit` puts every validation and sign-in failure in one `error`
          state, and that single state is passed to the second `Field` only:

            sign-in.tsx:60  <Field label="Email"    ... />          <- no error prop
            sign-in.tsx:61  <Field label="Password" ... error={error} />

          `validateCredentials` (auth-core.ts:14-20) returns "Enter your email."
          and "That doesn't look like an email address." — both of which render
          under the password box, in danger red, with the PASSWORD field's border
          also turned red (Field.tsx:21 `borderColor: error ? colors.danger : …`).
          So an email typo visually marks the password as the invalid field.
Evidence: The two lines above plus Field.tsx:21,27.
Impact:   Small but genuinely misleading — the user retypes the password. It also
          means the error is not programmatically associated with the field it
          describes, which is the RN counterpart of a missing
          `aria-describedby` (and there is no such association for either field
          — `Field` renders its error as a sibling `AppText`, not as
          `accessibilityHint` or an `accessibilityLabel` extension, and
          `accessibilityHint` is at 0 occurrences app-wide per C2-M05).
Fix:      Split the state into `emailError` / `formError`, route
          `validateCredentials`' first two messages to the email `Field`, and
          keep sign-in failures as a form-level message above the button. While
          there, extend `Field` to fold its `error` into the input's
          `accessibilityHint` so the association exists for screen readers too.
Status:   OPEN — verified by source reading.
```

---

## Verified clean (mobile) — recorded so a later pass does not re-derive

| Checked | Result |
|---|---|
| Unnamed touchables (the RN "unnamed `<button>`") | **0 of 12.** Every Pressable has an `accessibilityLabel` or a `Text` child. Better than the web (C2-11 found 2). |
| `TouchableOpacity` / `TouchableHighlight` | **0 uses.** The app is uniformly on `Pressable`. |
| Touch target sizes | 11 of 12 meet 44pt, and do so by reading `layout.touchTarget` from `design/tokens.json`. The twelfth is C2-M13. |
| Shared-token pipeline | **Works.** `design/tokens.ts:55-58` derives `palette()` from the JSON key set, so `borderInput` was available to mobile the moment it was added for the web. The contract did not drift — one call site (C2-M01) was missed. |
| Auth / session handling in `mobile/app/(auth)` | **No finding.** Deliberate port of the web's persistent-login work: `INITIAL_SESSION`-null is not sign-out (auth-session.ts:20-25), retryable-error parity with `lib/auth/session.ts` with the duplication justified in-file (auth-core.ts:22-35), chunked SecureStore, revision-guarded local-scope sign-out (sign-out.ts), shared `shared/auth/refresh-fetch.ts`. Careful, not careless. |
| Safe-area handling | Correct as far as source can show. `SafeAreaProvider` at the root (_layout.tsx:52); `Screen` uses `edges={['top','left','right']}` (bottom is the tab bar's / the list's `paddingBottom`), which is the right choice for tab screens and is landscape-correct given `"orientation": "default"` + `supportsTablet: true`. Not verified on a notched device. |
| Keyboard avoidance | Present and correct-shaped on all three screens with a text input above the fold: sign-in.tsx:35, grocery.tsx:61, assistant.tsx:110 — `behavior="padding"` on iOS, undefined on Android (which relies on `adjustResize`), with `keyboardVerticalOffset={90}` on the two tab screens and `keyboardShouldPersistTaps="handled"` throughout. Not verified with a keyboard up. |
| Does text scale with OS font size at all? | **Yes** — RN's `allowFontScaling` defaults true and nothing disables it. The defect is the fixed line boxes (C2-M10), not the scaling itself. |
| Dark-theme contrast, all pairings | Comfortable: 6.50-17.53:1 across fg/muted/brandText/brandFg/info/danger/success/warning on bg, surface and the glass composite. Only the borders fail in dark, which is C2-M01's territory. |
| Mobile typecheck (CI parity) | Clean. 1 error, entirely from a locally-missing `expo-audio`; lockfile verified consistent with package.json, so `npm ci` in CI does not hit it. |

## BLOCKED — what this session could NOT reach

These are the reasons a later pass with a device would still be worth running.
**None of the rows below should be read as "clean".**

| Not reached | Why | What it would settle |
|---|---|---|
| Any rendered mobile screen | No simulator, no device, no Metro bundle | Every contrast figure above is computed from tokens, not sampled from pixels |
| VoiceOver / TalkBack output | No device | C2-M05, M06, M07, M12 — the *source* absences are certain, the announced result is inferred |
| Dynamic Type at Larger Accessibility Sizes | No device | C2-M10's clipping and overlap; currently a source-level inference |
| Focus behaviour with an iPad hardware keyboard | No device | C2-M02's real severity |
| Keyboard-up layout on a small phone | No device | Whether the `keyboardVerticalOffset={90}` on grocery/assistant is right for every device height |
| Safe-area on a notched device and in landscape | No device | Whether `edges={['top','left','right']}` leaves anything under the home indicator on the `scroll={false}` screens |
| `expo export` / a real Metro bundle | Not run (and CI does not run it either — Claude-1's finding on the Metro watch folders stands unverified for the same reason) | Whether the three-root import graph actually bundles |
| The three write paths end-to-end | No Supabase locally (Claude-1 session 3: Docker unusable, no Supabase CLI) | Whether C2-M08's silent-failure path and C2-M09's raw-error path produce what the source says they will |

## Severity tally — session 3

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 2 | C2-M01, C2-M03 |
| MEDIUM | 9 | C2-M02, M04, M05, M06, M07, M08, M09, M10, M11 |
| LOW | 5 | C2-M12, M13, M14, M15, M16 |
| **Total new** | **16** | `C2-M01`–`C2-M16` |

Note for the merge: **C2-M11 is evidence for the existing C2-B03**, not an
independent defect — it closes the "could not render the chips" gap B03 itself
flagged. Count it once. And **C2-M03 is predominantly a WEB finding** (160 call
sites in 86 files) that the mobile lens surfaced; file it wherever the web
findings live, not under Mobile.

Running total for this file: 18 (sessions 1-2) + 16 = **34 findings**,
7 HIGH / 18 MEDIUM / 9 LOW / 0 CRITICAL.
- **File:** `components/modules/calendar-module.tsx:81-95` (`weekStart`, `daysOfWeek`), `:173`, `:309`, `:319`, `:330`, `:351`, `:405`, `:414`, `:437`
- **Problem:** the calendar keys events into day buckets, and keys the day
  columns, with **two different clocks**.

  The column key is a *local-midnight* `Date` pushed through `toISOString()`:

  ```ts
  // :81  weekStart()
  const d = new Date();
  d.setDate(d.getDate() - day + offset * 7);
  d.setHours(0, 0, 0, 0);        // LOCAL midnight
  …
  // :173 / :437
  const dStr = d.toISOString().slice(0, 10);   // that instant re-read in UTC
  ```

  The event key is the event's true instant, also read in UTC:

  ```ts
  // :309 / :319 / :330 / :351
  const key = new Date(e.starts_at).toISOString().slice(0, 10);
  ```

  Local midnight is not UTC midnight, so the two keys only agree when the
  browser's UTC offset is exactly zero.
- **Evidence — executed, not reasoned.** The two functions were lifted verbatim
  into `cal.mjs` and run under four zones. A 09:00 **local** event on each of the
  seven rendered days:

  | TZ | result |
  |---|---|
  | `UTC` | all 7 days land in the right column |
  | `Europe/Amsterdam` | **all 7 wrong** — each lands one column to the right; the 7th (Sunday) lands in column **−1**, i.e. no column has its key and it is **not rendered at all** |
  | `Asia/Tokyo` | identical to Amsterdam — all 7 wrong, Sunday vanishes |
  | `America/New_York` | 09:00 events correct |

  Re-run with a 20:00 local event (`cal20.mjs`):

  | TZ | result |
  |---|---|
  | `America/New_York` | **all 7 wrong**, Sunday vanishes |
  | `America/Los_Angeles` | **all 7 wrong**, Sunday vanishes |

  So: in UTC+ zones essentially *every* event is displaced; in UTC− zones every
  **evening** event is displaced. Sample output:

  ```
  TZ = Europe/Amsterdam
    local Mon Sep 14 2026 09:00 -> eventKey 2026-09-14  colKey[0]=2026-09-13  lands in column 1 *** WRONG ***
    local Sun Sep 20 2026 09:00 -> eventKey 2026-09-20  colKey[6]=2026-09-19  lands in column -1 *** WRONG ***
  TZ = America/New_York   (20:00 local)
    local Mon Sep 07 2026 20:00 -> eventKey 2026-09-08  colKey[0]=2026-09-07  lands in column 1 *** WRONG ***
  ```

  The same `today` value is also wrong: `:405`
  `const todayStr = today.toISOString().slice(0, 10)` where `:338`
  `today = new Date(); today.setHours(0,0,0,0)` — so in every UTC+ zone the
  "today" highlight (`:175 isToday`, `:430`) sits on **yesterday**.
- **Impact:** this is the family calendar — the product's most-used shared
  surface. Six of the eleven shipped locales (`nl-NL`, `de-DE`, `fr-FR`,
  `es-ES`, `it-IT`, `pt-PT`) are UTC+1/+2, where the defect is total: a school
  pickup entered for Tuesday is displayed under Wednesday, and anything on the
  last rendered day of the week disappears from the grid entirely while still
  existing in the database. In the Americas it is the evening — the part of a
  family's day that is actually scheduled. The month grid, week grid, day view,
  mobile day list, the "today" marker and the sidebar's upcoming list all read
  from these same maps.
- **Fix:** key both sides off **local** civil date, never `toISOString()`:

  ```ts
  const ymdLocal = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  ```

  Replace all nine `toISOString().slice(0, 10)` call sites in this file with
  `ymdLocal(...)`. (`lib/finance/timeline.ts:159` has a `ymd` helper, but it is
  deliberately `getUTC*` for deterministic tests — do not reuse it here; this
  needs the local-civil one.) Then guard it: a test that runs the bucketing under
  `TZ=Europe/Amsterdam` and `TZ=America/New_York` and asserts each event lands in
  its own column. Revert the fix and it must go red in both zones.
- **Status:** OPEN — proven by execution
- **Note for Claude-1:** 41 other `.tsx` files use the same
  `toISOString().slice(0,10)` / `.split('T')[0]` day-key idiom
  (`components/modules/meals-module.tsx`, `school-module.tsx`,
  `health-module.tsx`, `sleep-module.tsx`, `screen-time-module.tsx`,
  `components/wallet/allowance-view.tsx`, `components/finance/bills-view.tsx`,
  `components/dashboard/*-dashboard.tsx`, …). I proved the defect only in
  `calendar-module.tsx`; the others need the same read before any of them is
  claimed. They are a strong lead, not a finding.

---

### [CLAUDE-2][HIGH][A11Y] `.focus-ring` paints a ring that is always on and removes the one that means "focused"

- **File:** `app/globals.css:179-181`; **202 unscoped** call sites across `app/` and `components/`, including `components/ui/input.tsx:5` (the shared `Input`, `Textarea` **and** `Select`) and `app/globals.css:414` (`.btn-primary`) and `:419` (`.chip`)
- **Problem:** the utility is declared unconditionally — no `:focus`, no
  `:focus-visible`:

  ```css
  .focus-ring {
    @apply outline-none ring-2 ring-brand/60 ring-offset-2 ring-offset-bg;
  }
  ```

- **Evidence — compiled, not inferred.** Built with the project's own config
  (`npx tailwindcss -c tailwind.config.ts -i app/globals.css -o out.css`), the
  emitted rule is:

  ```css
  .focus-ring {
    outline: 2px solid transparent;         /* ← the native focus outline, suppressed */
    outline-offset: 2px;
    --tw-ring-shadow: var(--tw-ring-inset) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color);
    box-shadow: var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow, 0 0 #0000);
    --tw-ring-color: rgb(var(--brand) / 0.6);
  }
  ```

  No `:focus` or `:focus-visible` selector is attached. The full stylesheet
  contains **11** `:focus-visible` rules and not one of them restores an outline
  globally. One of the eleven is `.focus-visible\:focus-ring:focus-visible` — the
  *correct* form, emitted because 16 call sites do write
  `className="focus-visible:focus-ring …"`.

  **The split is not random.** Counted precisely (every occurrence, not every
  line): **218** total in `.tsx`, of which **16** are `focus-visible:focus-ring`
  and **202** are bare. All 16 correct ones are on the signed-out surface and the
  kid login — `app/(marketing)/page.tsx:108`,
  `components/marketing/site-header.tsx:81,115,135,143,146`,
  `switching-band.tsx:81`, `decisions-band.tsx:55,59`,
  `hero-outcomes.tsx:47,77,81`, `handled-ledger.tsx:79`,
  `components/auth/kid-login-form.tsx:49,60,63`. The marketing surface was fixed
  and the authenticated app was not — which matches Pass A having audited the
  public site and nothing having audited this one.
- **Impact:** two failures in one declaration. (1) The ring is painted on every
  such element at all times, so it carries no information. (2)
  `outline: 2px solid transparent` is an author-origin rule and therefore beats
  the UA `:focus-visible` outline, so the browser's own focus indicator is gone.
  Net: **a keyboard user cannot see where focus is** on the primary button, on
  every shared text input, select and textarea, and on 202 elements in total —
  essentially the whole signed-in product.
  WCAG 2.1 AA 2.4.7 Focus Visible. `tests/modal-a11y-contract.test.ts` verifies
  the modal *traps* focus — it has nowhere visible to trap it to.
- **Fix:** scope the rule to focus only:

  ```css
  .focus-ring:focus-visible {
    @apply outline-none ring-2 ring-brand/60 ring-offset-2 ring-offset-bg;
  }
  ```

  This is a one-line change and needs no edit at any of the 202 call sites (they
  keep writing `className="… focus-ring"`), and the 16 that already write
  `focus-visible:focus-ring` keep working (the variant then compiles to
  `…:focus-visible:focus-visible`, which still matches). Then a guard: assert the compiled
  `.focus-ring` selector ends in `:focus-visible`, and assert no rule sets a
  transparent outline outside a focus selector. Revert and it must go red.
- **Status:** OPEN — proven by compilation

---

### [CLAUDE-2][HIGH][STATE] A failed Guardian profile read renders the factory defaults, and saving then overwrites the family's real call-routing settings

- **File:** `app/(app)/guardian/settings/page.tsx:23-33` → `components/guardian/routing-settings.tsx:80-102, 114-125` → `app/(app)/guardian/actions.ts:209-223`
- **Problem:** the page reads the member's Guardian profile and discards the
  error:

  ```ts
  const [{ data: profile }, { data: member }] = await Promise.all([
    (db.from('guardian_member_profiles') as …).select('*')
      .eq('family_id', familyId).eq('member_id', memberId).maybeSingle(),
    settle(supabase.from('family_members')…),
  ]);
  ```

  A refused or failed read gives `profile === null`, which is indistinguishable
  from "this member has no profile yet". `RoutingSettings` then seeds its form
  from a hard-coded `defaults` object (`routing-settings.tsx:80`,
  `const [form, setForm] = useState<Profile>(profile ?? defaults)`), and the
  Save button posts that form:

  ```ts
  const res = await upsertMemberProfileAction({
    member_id, ai_persona_name, ai_greeting_template, voicemail_greeting,
    default_mode_unknown, default_mode_known, default_mode_suspected_spam,
    context_overrides,
  });
  ```

  which is an **upsert on the existing row**:

  ```ts
  .upsert(payload, { onConflict: 'family_id,member_id' })
  ```

- **Impact:** a transient read failure turns the settings page into a silent
  reset. The parent sees a normal, populated form (it looks like their settings),
  changes one thing, saves — and `ai_persona_name`, `ai_greeting_template`,
  `voicemail_greeting`, `context_overrides` and three of the seven routing modes
  are overwritten with the factory defaults. Nothing warns, and the previous
  values are not recoverable from the UI. Concretely: a household that had set
  `default_mode_unknown: 'blocked'` silently becomes `'ai_handle_first'` —
  unknown callers start getting through.
- **Fix:** destructure `profileError` and return an `ErrorState` (the pattern
  `app/(app)/marketplace/reviews/page.tsx:39-47` already uses) rather than
  rendering the form. Do not let `RoutingSettings` fall back to `defaults` on
  anything but a *confirmed* absent row — pass an explicit
  `{ status: 'ok' | 'absent' | 'error' }` instead of `Profile | null`, which is
  the type that makes the two indistinguishable. Also wrap the first query in
  `settle()`: the second already is, so a transport rejection on the profile read
  currently still rejects the whole `Promise.all` and takes the page to the error
  boundary.
- **Status:** OPEN

---

### [CLAUDE-2][HIGH][STATE] "No members yet." on /family/members is unreachable by any successful read — it can only mean the read failed

- **File:** `app/(app)/family/members/page.tsx:22-27, 43-55`
- **Problem:**

  ```ts
  const { data: members } = await supabase
    .from('family_members').select('*')
    .eq('family_id', ctx.active.familyId).eq('is_active', true).order('created_at');
  …
  {members && members.length > 0 ? ( … ) : <MiniEmpty icon={UsersRound} text={t('members.noMembersYet')} />}
  ```

  `members.noMembersYet` is `"No members yet."` (`lib/i18n/messages/en-US.json:7412`).
- **Evidence — the empty state is logically impossible.** `requireUserContext()`
  (`lib/supabase/auth.ts:118-126, 185-206`) reads `family_members` for the caller
  with `.eq('is_active', true)`, returns `{ needsFamily: true }` when that comes
  back empty, and `requireUserContext` then provisions a family and re-resolves
  before returning. So by the time this page's body runs, `ctx.active` names a
  family in which the **caller themselves** is an active member. A correct read
  of the same table, same family, same `is_active` filter therefore returns at
  least one row, always. The `length === 0` branch is only reachable when `data`
  is `null` — i.e. when the error this page never looks at is set.
- **Impact:** the one branch that fires exclusively on failure is the branch that
  reports success-with-no-data. A parent whose read is refused (RLS regression,
  an unapplied migration on a fresh environment, a PostgREST error) is told their
  household is empty — the E-01 defect from `finalaudit.md`, on a UI surface, with
  a proof that the message can never be true.
- **Fix:** destructure `error`, log it, and render `ErrorState` with a retry.
  Then assert the property rather than the string: given the page's own
  `requireUserContext` contract, a successful read must never produce the empty
  branch — a test that drives the page with a failing read and asserts the error
  state, and with an empty-but-successful read and asserts it is treated as the
  impossible case it is.
- **Status:** OPEN

---

### [CLAUDE-2][HIGH][STATE] The whole AI Call Guardian surface — five pages — discards every read error, and none is guarded

- **Files:**
  - `app/(app)/guardian/page.tsx:34` — eight reads in a raw `Promise.all`, **every** error discarded
  - `app/(app)/guardian/history/page.tsx:28-35` — `{ data: communications, count }`, error discarded
  - `app/(app)/guardian/rules/page.tsx:19` — `{ data: rules }`, error discarded
  - `app/(app)/guardian/contacts/page.tsx:20` — `[{ data: contacts }, { data: members }]`, both discarded
  - `app/(app)/guardian/settings/page.tsx:23` — see previous finding
- **Problem and evidence:** none of the five destructures `error`, and none of
  the five appears in the 165 files covered by the 127
  `tests/*-read-boundary.test.ts` guards (list extracted from each test's own
  `readFileSync(...)` path). What the user sees on a failed read, traced through
  the rendering path:

  | page | failed read renders |
  |---|---|
  | `/guardian` | `stats={{ totalCalls: 0, blockedToday: 0, scamsBlocked: 0, screened: 0 }}` (`:106-109`) — a safety dashboard asserting **"0 scams blocked today"** |
  | `/guardian/history` | header `"{count ?? 0} total"` → `0 total`, and `CallHistory` receives `[]`, whose `groups.size === 0` branch (`components/guardian/call-history.tsx:115-119`) renders **"No communications match your filters."** |
  | `/guardian/rules` | no routing rules |
  | `/guardian/contacts` | no trusted contacts |

- **Impact:** Guardian is the product's safety feature — it decides which calls
  and texts reach a child, and it is the surface a parent opens *because* they
  are worried about a caller. On a failed read it does not say "we could not
  load this"; it makes a positive safety claim ("nothing was blocked today",
  "no communications") over a log that may be full of blocked scam calls. This is
  exactly `E-01`, one product surface at a time, and `/guardian/history` also
  mislabels it: the text says "match your filters", so a parent whose read failed
  is invited to clear a filter that is not the problem.
- **Fix:** destructure and check `error` on all eight+ reads; switch the raw
  `Promise.all` calls to `settleAll` so a transport rejection degrades instead of
  hitting `app/(app)/guardian/error.tsx`; render `ErrorState` (or
  `PartialReadBanner`, which `app/(app)/dashboard/activity/page.tsx` already uses
  and `tests/activity-page-read-boundary.test.ts` already pins) instead of a
  zeroed stat card. Give `CallHistory` a distinct empty state for "no
  communications at all" versus "none match your filters". Then add
  `tests/guardian-read-boundary.test.ts` in the shape of the existing 127.
- **Status:** OPEN

---

### [CLAUDE-2][MEDIUM][STATE] The family audit trail reports "No activity recorded yet" over a read it never checked

- **File:** `app/(app)/family/activity/page.tsx:23-35, 60`
- **Problem:**

  ```ts
  const [{ data: logs }, { data: members }] = await settleAll([
    supabase.from('audit_logs').select('id, action, resource, …').eq('family_id', …),
    supabase.from('family_members').select('user_id, display_name').eq('family_id', …),
  ]);
  …
  ) : <MiniEmpty icon={Activity} text={t('activity.noActivityRecordedYet')} />}
  ```

  `settleAll` is used correctly for *transport* failures — but it delivers the
  failure as `{ data: null, error }` in the shape the caller is expected to
  handle, and this caller destructures only `data`. Its own header comment
  (`lib/supabase/settle.ts:17-23`) says so: *"The caller's existing error
  handling then runs for transport failures too."* There is none here.
  `activity.noActivityRecordedYet` = `"No activity recorded yet."`
  (`lib/i18n/messages/en-US.json:558`).
- **Impact:** `audit_logs` is the record of who changed what in the household —
  the surface a parent checks when something looks wrong. A refused read renders
  the same screen as a clean history. Of the two failure directions available
  here, this is the one that hides evidence.
- **Fix:** destructure `logsError`/`membersError`, log, and render `ErrorState`
  or `PartialReadBanner`. `app/(app)/dashboard/activity/page.tsx` is the model
  and already has a guard; this page is its `/family` twin and has neither.
- **Status:** OPEN

---

### [CLAUDE-2][MEDIUM][STATE] /family/permissions tells the user a failed read is an unapplied database seed

- **File:** `app/(app)/family/permissions/page.tsx:17-20, 78`
- **Problem:** `const { data: perms } = await supabase.from('permissions').select(…)`
  — error discarded. The empty branch renders
  `t('permissions.permissionRulesLoadFromThe')`, which is
  `"Permission rules load from the database once the policy seed is applied."`
  (`lib/i18n/messages/en-US.json:8287`).
- **Impact:** worse than a blank. Every other empty state here at least says
  nothing; this one **diagnoses**, and diagnoses wrongly. A read failure on the
  permission matrix is reported to the operator as "your seed has not run",
  which sends them to the migrations when the fault is the read. It is the same
  class as `app/api/behavior/insight/route.ts:62`'s own comment — *"invited to
  start logging what they had already logged"* — with a more specific wrong
  instruction.
- **Fix:** check the error and render `ErrorState`. Keep the seed message for the
  genuine `data.length === 0` case only.
- **Status:** OPEN

---

### [CLAUDE-2][MEDIUM][STATE] A failed `child_logins` read makes every child's existing login look absent

- **File:** `app/(app)/dashboard/family-access/page.tsx:23-39`
- **Problem:**

  ```ts
  const [{ data: members }, { data: logins }] = await settleAll([ …, 
    supabase.from('child_logins').select('member_id, username').eq('family_id', familyId),
  ]);
  const usernameByMember = new Map((logins ?? []).map((l) => [l.member_id, l.username]));
  const list: AccessMember[] = (members ?? [])
    .filter((m) => usernameByMember.has(m.id) || m.user_id === null)
    .map((m) => ({ …, username: usernameByMember.get(m.id) ?? null }));
  ```

  Both errors discarded. If the `child_logins` read fails while the members read
  succeeds, `usernameByMember` is empty, so every managed member renders with
  `username: null` — which the page's own comment says means *"no login yet
  (user_id null → can be given one)"*.
- **Impact:** the parent is shown a Kid Logins page on which children who already
  have a username and PIN appear to have none, and is invited to create one. The
  child's existing credential is not visible to correct, and the "create"
  affordance is offered for an account that exists. On the reverse failure
  (members read fails, logins succeeds) the page renders an empty manager for a
  family that has children.
- **Fix:** check both errors; render `ErrorState` if either failed. This page
  hands out credentials — it should refuse to render a partial view rather than
  degrade into one.
- **Status:** OPEN

---

### [CLAUDE-2][HIGH][A11Y] Calendar events, note cards and photo rows can be opened with a mouse and by no other means

- **Files:**
  - `components/modules/calendar-module.tsx:618`, `:637`, `:685`, `:730`, `:814` — the event chip in **all five** views (mobile all-day, mobile timed, month grid, week time-grid, day list)
  - `components/modules/notes-module.tsx:267`, `:310` — note rows and note cards
  - `components/modules/photos-module.tsx:376` — photo list rows (opens the lightbox)
  - `components/modules/recipes-module.tsx:308`, `meals-module.tsx:372`/`:413`, `goals-module.tsx:134`, `contacts-module.tsx`, `files-hub-module.tsx`, `scan-module.tsx:115`, `documents-module.tsx:613`
- **Problem:** the handler is on a bare `<div>` with `cursor-pointer` and nothing
  else — no `role`, no `tabIndex`, no key handler:

  ```tsx
  <div key={`${e.id}-${e.starts_at}`} onClick={() => setSelected(e)}
       className={cn('cursor-pointer rounded-lg border p-3 …')}>
  ```

  ```tsx
  <div key={note.id} onClick={() => onOpen(note)}
       className="group flex cursor-pointer items-center gap-4 px-4 py-3 …">
  ```
- **Evidence:** a scan of `app/` + `components/` for `onClick` on
  `div|span|li|td|tr|p|section|article|ul|h1..h6` with no `onKeyDown`/`onKeyUp`/
  `onKeyPress` and no interactive `role` and no `aria-hidden` returns **44**
  sites. Roughly half are `<div className="fixed inset-0" onClick={close} />`
  dropdown dismiss-catchers, which are harmless (empty, unfocusable) — those are
  **not** counted as defects here. The list above is the remainder, each read in
  full.
- **Impact:** WCAG 2.1.1 Keyboard, at Level A. A keyboard-only or
  switch-access user can reach the calendar and see the events, and cannot open
  one. Same for a note, a photo and a recipe. The elements are also invisible to
  a screen reader as controls: they are announced as text. `photos-module.tsx`
  is the sharp case — `tests/photos-a11y-labels.test.ts` deliberately asserts the
  *upload dropzone* is `role="button"` + `tabIndex` + `onKeyDown`, so the correct
  pattern is already written, tested and sitting in the same file as line 376
  which does not use it.
- **Fix:** for each, either wrap the content in a real `<button type="button">`
  with `text-left` (preferred — free focus, free Enter/Space, free role), or add
  `role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}` plus an `aria-label`.
  `components/modules/photos-module.tsx`'s dropzone is the in-repo reference.
- **Status:** OPEN

---

### [CLAUDE-2][MEDIUM][A11Y] 74 icon-only buttons have no accessible name, and the destructive ones are the majority

- **Files (each verified by reading the line):** `components/modules/medical-records-module.tsx:288,289,344,345,375` · `billing-module.tsx:1215,1251,1304,1338,1575` · `notes-module.tsx:161,219,227,283,284,345,348,475` · `recipes-module.tsx:249,379,383,689,709` · `calendar-module.tsx:131,132,598,609` · `journal-module.tsx:96,97` · `immunizations-module.tsx:141,142` · `health-visits-module.tsx:146,147` · `celebrations-module.tsx:122` · `weekend-module.tsx:174` · `messages-module.tsx:853,857` · `shopping-module.tsx:211,278` · `reminders-module.tsx:310` · `front-desk-module.tsx:412` · `inbox-module.tsx:207` · `weather-module.tsx:219` · `concierge-module.tsx:226,444` · `family-tree-module.tsx:240,243` · `components/guardian/rules-editor.tsx:163` · `contact-list.tsx:242,243` · `components/wallet/pay-handle-manager.tsx:79` · `invest-view.tsx:71,73` · `wallet-dashboard.tsx:128` · `components/vacations/shared.tsx:157,158` · `trip-packing.tsx:141` · `trip-itinerary.tsx:151,159,160` · `components/auto/service-client.tsx:51` · `components/home/service-client.tsx:60` · `pros-client.tsx:103` · `components/display/display-grid.tsx:738,739,740` · `kitchen-timers.tsx:130` · `components/dashboard/calendar-sync-panel.tsx:124` · `components/capture/capture-shell.tsx:173` · `components/admin/admin-row-actions.tsx:33` · `ticket-row-actions.tsx:33` · `app/(marketing)/blog/blog-search.tsx:83` · `app/(app)/admin/marketing/reviews/review-row.tsx:52`
- **Problem:** `<button onClick={…}><Trash2 className="h-4 w-4" /></button>` — no
  `aria-label`, no `title`, no `sr-only` text anywhere in the button.
- **Evidence:** brace-balanced scan of every `<button>` in `app/` +
  `components/`, keeping only buttons whose entire body is JSX icon elements
  (or a ternary between two icon elements) and which carry no `aria-label`,
  `aria-labelledby`, `title` or `sr-only` descendant — **74**. Four were then
  opened and read to check the scanner rather than trust it
  (`medical-records-module.tsx:288-289`, `notes-module.tsx:215-230`,
  `calendar-module.tsx:594-614`, `billing-module.tsx:1208-1220`); all four are
  real. The scanner's earlier, looser version produced 903 and 256 — both wrong,
  because they counted `{t('…')}` as "not text". Those numbers are discarded and
  recorded here only so the 74 is not mistaken for the same kind of count.
- **Impact:** WCAG 4.1.2 Name, Role, Value. A screen-reader or voice-control
  user hears "button" and cannot distinguish **Edit** from **Delete** — and on
  this list the pair is usually side by side: delete an insurance policy
  (`medical-records-module.tsx:289`), delete a financial transaction
  (`billing-module.tsx:1215`), delete an immunisation record
  (`immunizations-module.tsx:142`), delete a Guardian routing rule
  (`rules-editor.tsx:163`). The existing guards
  (`tests/mobile-touch-a11y.test.ts`, `tests/photos-a11y-labels.test.ts`) cover
  exactly five files between them, and none of these 74 is in those five.
- **Fix:** add `aria-label` to each (the labels already exist as catalogue keys
  for the neighbouring text buttons in most of these files). Then replace the
  file-by-file guards with the repo-wide one: run the brace-balanced scan in a
  test and assert the offender list is empty. The scanner is in
  `/tmp/.../scratchpad/claude-2/iconbtn2.py` and is small enough to port to
  vitest; port the *strict* filter, not the loose one.
- **Status:** OPEN

---

### [CLAUDE-2][MEDIUM][A11Y] In light mode four semantic text colours fail WCAG AA, and 504 elements use them as text

- **File:** `design/tokens.json:44-60` (light palette), mirrored verbatim at `app/globals.css:70-85`
- **Evidence — computed from the shipped token values** using the WCAG 2.1
  relative-luminance formula:

  | light-mode pair | ratio | AA normal text (4.5) |
  |---|---|---|
  | `accent` `#e97a4a` on `bg` `#f5f7fc` | **2.67** | fail |
  | `accent` on `surface` `#ffffff` | **2.86** | fail |
  | `warning` `#c58e18` on `bg` | **2.70** | fail |
  | `warning` on `surface` | **2.89** | fail |
  | `success` `#1fa57a` on `bg` | **2.91** | fail |
  | `success` on `surface` | **3.12** | fail (AA-large only) |
  | `danger` `#d54646` on `bg` | **4.09** | fail (AA-large only) |
  | `danger` on `surface` | **4.38** | fail |
  | `muted` on `bg` | 4.91 | pass |
  | `fg`, `brandText`, `info` | 4.82 – 17.0 | pass |

  Dark mode passes everywhere (lowest pair: `brandText` on `elevated`, 6.07).
  Usage as **text**, not as background: `text-danger` 294, `text-success` 127,
  `text-warning` 55, `text-accent` 28 — **504** sites across `app/` +
  `components/`.
- **Impact:** light mode is a user-selectable theme (`.light` at
  `app/globals.css:70`). In it, the colours that carry the highest-stakes
  meanings — an error (`danger`), a warning, a success confirmation — are the
  least legible on the page. `tests/brand-contrast-contract.test.ts` guards
  `brand` vs `brand-text` and asserts nothing about these four.
- **Fix:** darken the four light-mode triples until each clears 4.5:1 on
  `bg` **and** `surface` (both are needed; `surface` is `#ffffff` and is the
  tighter of the two for these hues). Then extend
  `brand-contrast-contract.test.ts` to compute the ratio for every
  (foreground token × background token) pair actually used as text, in both
  modes, from `design/tokens.json` — so the check moves with the tokens instead
  of being re-derived by hand.
- **Status:** OPEN

---

### [CLAUDE-2][MEDIUM][RESILIENCE] 47 pages still batch Supabase reads with raw `Promise.all` — the exact pattern `settleAll` was written to retire

- **Files:** 47 `page.tsx` files use `await Promise.all([…])` over Supabase
  queries. Fifteen of them import neither `settleAll` nor `settle`; six of those
  fifteen also never mention `.error` anywhere in the file:
  `app/(app)/dashboard/dining/page.tsx`, `app/(app)/dashboard/food/page.tsx`,
  `app/(app)/dashboard/planning/page.tsx`, `app/(app)/guardian/page.tsx`,
  `app/(app)/referrals/page.tsx`, `app/(marketing)/blog/page.tsx`.
- **Problem:** `lib/supabase/settle.ts:1-23` states the failure mode and names
  the incident:

  > *"One rejection rejects the batch, so a page that carefully logs res.error
  > for all twenty of its reads still dies on an unhandled rejection and renders
  > the error boundary — 'This page hit a snag' — instead of the degraded view it
  > was designed to show. **That is what took out /dashboard while the production
  > database was reporting CONNECT_TIMEOUT.**"*

  79 pages adopted it. These 47 did not.
- **Impact:** the same production incident, on 47 other routes, with no code
  change required to reproduce it — only an unreachable database.
  `app/(marketing)/blog/page.tsx` is the one on the **public** surface, so it is
  a signed-out visitor who meets the error boundary. `app/(app)/guardian/page.tsx`
  is the safety dashboard from the finding above, which additionally shows zeroed
  stats when the read merely *fails* rather than rejecting.
- **Fix:** mechanical — `Promise.all` → `settleAll` at each site, then check the
  `error` each result now reliably carries. Claude-1's Sweep 1 counts 155
  adopters across the repo and calls adoption "good"; this is the page-level
  residue of the same question, with the six worst named.
- **Status:** OPEN

---

### [CLAUDE-2][MEDIUM][I18N] Guardian's safety vocabulary is hardcoded English in `lib/`, on a surface the i18n gate cannot see

- **File:** `lib/guardian/scam.ts:108-121` (`SCAM_TYPE_LABELS`), `trust.ts:23-29` (`TRUST_LABELS`), `pipeline.ts:20-34` (`ROUTING_MODE_LABELS` + descriptions), `seasonal.ts:32-107`, `learning.ts:166-171`, `rules.ts:115`, `ai-screen.ts:192`
- **Evidence:** `node scripts/i18n-scan.mjs --list lib/guardian` →
  **45 hardcoded string(s) across 7 file(s)**. The strings are the product's
  safety words:

  ```
  lib/guardian/scam.ts:108-121   Robocall · Warranty Scam · IRS / Government Scam ·
                                 Grandparent Scam · Tech Support Scam · Bank / Payment Scam ·
                                 Social Security Scam · Medicare Scam · Romance Scam · Phishing
  lib/guardian/pipeline.ts:29-34 "Bubaly AI screens the caller; connects or summarizes."
                                 "Call is declined immediately."
  lib/guardian/trust.ts:23-29    Immediate Family · Close Family · Trusted Friend · Blocked
  ```

  These are rendered directly into the UI — `components/guardian/call-history.tsx:174,177,184`
  (`TRUST_LABELS[…]`, `ROUTING_MODE_LABELS[…]`, `SCAM_TYPE_LABELS[…]`) inside a
  component that otherwise calls `t()` on every other string in the same JSX.
  `GATED_SURFACES` (`scripts/i18n-scan.mjs:26-61`) contains seven entries, all
  `i18n-ui` / `app-shell` / `marketing-*`. Nothing covers `lib/guardian`.
- **Impact:** the app ships **11** locale catalogues
  (`lib/i18n/messages/{de-DE,en-GB,en-US,es-ES,es-MX,es-US,fr-CA,fr-FR,it-IT,nl-NL,pt-PT}.json`).
  A Dutch or Spanish family reading why a call was blocked gets a fully
  translated page with the *reason* in English — "Grandparent Scam",
  "Suspected Spam", "Call is declined immediately". This is the class the gate
  was built for, in the gate's own words at `scripts/i18n-scan.mjs:40-42`:
  *"Copy parked in a data structure under lib/ is the blind spot this gate exists
  for."* They pointed it at `lib/marketing/*` and not at `lib/guardian`.
- **Fix:** make the label maps hold catalogue **keys** and resolve them at the
  component (`lib/marketing/consent-ui.ts` is the in-repo pattern — it is in
  `GATED_SURFACES` as `marketing-lib-copy` precisely because it does this). Lift
  the 45 strings into all 11 catalogues, then add a `guardian-copy` entry to
  `GATED_SURFACES`. In that order — the gate's README says adding a surface is a
  promise.
- **Note:** Claude-1 has the adjacent finding for `lib/server/ai-access.ts` and
  the missing `api-errors` surface. Different files, same missing gate; the fix
  is one shared `GATED_SURFACES` edit covering both.
- **Status:** OPEN

---

### [CLAUDE-2][MEDIUM][I18N] Every date, time and money value in the app renders in US English regardless of locale

- **File:** `lib/utils/format.ts:24-49` (`fmtDate`, `fmtTime`, `fmtDateTime`, `fmtRelative`), `:70-71` (`fmtMoney`); plus 245 direct `toLocaleDateString('en-US' …)` / `toLocaleTimeString('en-US' …)` / `toLocaleString('en-US' …)` / `Intl.*Format('en-US' …)` call sites in `app/`, `components/` and `lib/`
- **Problem:** the shared formatters every surface uses are monolingual by
  construction:

  ```ts
  export function fmtDate(value, pattern = 'EEE, MMM d') { … return format(d, pattern); }   // date-fns, default (en-US) locale
  export function fmtRelative(value) {
    if (isToday(d)) return `Today, ${format(d, 'h:mm a')}`;      // literal English
    if (isTomorrow(d)) return `Tomorrow, ${format(d, 'h:mm a')}`;
    return formatDistanceToNow(d, { addSuffix: true });          // "in 3 days", English
  }
  const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  export const fmtMoney = (cents: number) => CURRENCY.format(cents / 100);
  ```

  `date-fns` `format` takes a `locale` option and is never given one. `fmtMoney`
  has 86 call sites and is fixed to USD. Separately, 245 sites bypass the helpers
  and hardcode `'en-US'` inline — e.g. `components/modules/calendar-module.tsx:602,606,640,641`,
  `app/(app)/home/page.tsx:584,657,726,746`, `app/(app)/dashboard/conflicts/page.tsx:16-21`.
- **Evidence that the locale is available and simply unused:**
  `components/i18n/locale-provider.tsx:63-65` exports `useLocale()`, and only
  **ten** components call it. The server equivalent is resolved in the root
  layout for every request.
- **Impact:** a Dutch family sees `Tue, Sep 15` instead of `di 15 sep`,
  `3:30 PM` instead of `15:30` (12-hour time is not used in most of the eleven
  locales), `in 3 days` instead of `over 3 dagen`, and `$12.50` for a household
  that does not use dollars. `families.timezone` exists in the schema
  (`supabase/migrations/0002_tables.sql:26`) and there is a careful
  `lib/time/zoned.ts`; none of it reaches these formatters. Note this is the
  *behaviour* half of the i18n story — the catalogues are thorough, so the
  effect is a page that is correctly translated with every date, time and price
  in it still in US format.
- **Fix:** thread the active locale into `lib/utils/format.ts` (date-fns ships
  `locale/nl`, `de`, `fr`, `es`, `it`, `pt`), lift `Today,`/`Tomorrow,` into the
  catalogues, and give `fmtMoney` a currency argument sourced from the family
  row rather than a module-level constant. Then sweep the 245 inline `'en-US'`
  sites onto the helpers. A gate is cheap here: fail CI on a literal `'en-US'`
  anywhere under `app/` or `components/`.
- **Status:** OPEN

---

### [CLAUDE-2][LOW][UX] Destructive actions in the medical and money modules delete on a single click with no confirmation

- **File:** `components/modules/medical-records-module.tsx:289` → `:191-196`; `components/modules/billing-module.tsx:1215` → `:879-884`
- **Problem:**

  ```tsx
  <button onClick={() => deletePolicy(p.id)} className="text-muted hover:text-danger"><Trash2 … /></button>
  ```
  ```ts
  async function deletePolicy(id: string) {
    const sb = createClient();
    const { error: err } = await sb.from('insurance_policies').delete().eq('id', id);
    if (err) { toastError(t('medicalRecordsModule.couldNotDelete')); return; }
    success(t('medicalRecordsModule.deleted'));
  }
  ```

  No `confirm()`, no modal, no undo. Same shape at `billing-module.tsx:879`
  (`deleteTransaction`) and `:886` (`deleteBudget`). The button is also the
  unlabelled icon-only one from the finding above, sitting immediately beside an
  identical-looking Edit.
- **Impact:** one mis-aimed tap permanently deletes an insurance policy (insurer,
  policy number, group number, RX BIN/PCN, card images) or a financial
  transaction. On a phone the two icons are ~14px apart.
- **Fix:** route both through the shared `Modal` confirm the codebase already
  uses elsewhere (`components/modules/notes-module.tsx:227` at least calls
  `confirm(t('notesModule.deleteThisNote'))`), or make the delete undoable from
  the success toast. Note `notes-module.tsx:284` uses a bare
  `confirm('Delete?')` — hardcoded English and uninformative; fix that in the
  same pass.
- **Status:** OPEN

---

### [CLAUDE-2][LOW][FORMS] The admin marketing surface — 40 pages — ships without submit-pending state or labelled controls

- **Files:** `app/(app)/admin/marketing/**` — worst offenders `seo/page.tsx`, `platform/page.tsx`, `reputation/page.tsx`, `competitive/page.tsx`, `content/page.tsx`, `proposals/page.tsx`
- **Evidence:** 89 `<form action={serverAction}>` elements across `app/` +
  `components/` have no `useFormStatus`, no `pending`, no `isPending` and no
  `disabled` anywhere in the form body — **all 89 are under
  `app/(app)/admin/marketing/`**. Separately, a scan for `<input>`/`<select>`/
  `<textarea>` with no `aria-label`, no `placeholder`, no wrapping `<label>` and
  no `id`↔`htmlFor` pair returns 151, of which ~100 are on the same pages
  (`seo/page.tsx` 9, `platform/page.tsx` 6, `content/page.tsx` 4, …). They share
  one idiom: `const inputCls = 'h-10 w-full rounded-lg …'` and a bare
  `<select name="status" defaultValue="active" className={inputCls}>`.
- **Impact:** a double-click double-submits (creating two campaigns, two
  segments, two blog entries), and the fields are unnamed to assistive tech.
  Bounded: this is the internal admin console, one or two operators, behind the
  admin authz gate. Recorded because it is a consistent *tier* rather than
  scattered slips — the family-facing app is markedly better, and a reader
  comparing the two should know the difference is real.
- **Fix:** one shared `<SubmitButton>` using `useFormStatus()` (React 19 /
  Next 15 both support it) applied across the 89 forms, and a `<Field>` wrapper —
  `components/ui/input.tsx:30-60` already exports exactly that and these pages do
  not import it.
- **Status:** OPEN

---

### [CLAUDE-2][LOW][A11Y] The shared `Field` announces an error but never marks the field invalid

- **File:** `components/ui/input.tsx:30-60`
- **Problem:** `Field` renders `<p className="text-xs text-danger" role="alert">{error}</p>`
  and hands the child only an `id`. Nothing sets `aria-invalid` on the control,
  and nothing associates the message with it via `aria-describedby` — so the
  error is announced once when it appears, and a user who tabs back to the field
  afterwards is told nothing about it.
- **Impact:** WCAG 3.3.1 Error Identification is partially met (the message
  exists and is announced) but the field itself never reports its state. Affects
  every form built on the shared primitive.
- **Fix:** give the render-prop the pieces it needs —
  `children(id, { 'aria-invalid': !!error, 'aria-describedby': error ? errorId : hint ? hintId : undefined })` —
  and put `id={errorId}` on the `<p>`. Small, central, and fixes every consumer
  at once.
- **Status:** OPEN

---

## What I checked and found CLEAN

Recorded at the same weight as the findings, because a pass that reports nothing
has to show what it looked at.

### [CLAUDE-2][INFO][RESPONSIVE] Wide tables are correctly contained — every one of them
- **Evidence:** `tests/mobile-no-horizontal-overflow.test.ts` only scans
  `components/modules/*.tsx`. I ran the same check over **everything else** in
  `app/` + `components/`: every `<table>` outside that directory, requiring
  `overflow-x-(auto|scroll)` on the table's line or within four lines above.
  **0 offenders.** Independently, a scan for `min-w-[…]`/`w-[…]` ≥ 360px with no
  responsive prefix returns 26 sites and **all 26 are tables already inside an
  `overflow-x-auto` wrapper** — plus `components/admin/engagement-heatmap.tsx:26`,
  whose `min-w-[640px]` sits inside `<div className="overflow-x-auto">` at line 25.
  The guard's coverage gap is real but the code behind it is clean.
- **Status:** VERIFIED

### [CLAUDE-2][INFO][A11Y] Image alternative text is complete
- **Evidence:** brace-balanced scan of every `<img>` and `<Image>` in `app/` +
  `components/` for a missing `alt` prop → **1 hit**, and it is a false positive:
  `components/blog/blog-cover.tsx:53` is the word `<img>` inside a doc comment
  (*"Fills its container (like an `<img>` with object-fit: cover)"*). Actual
  offenders: **zero**.
- **Status:** VERIFIED

### [CLAUDE-2][INFO][A11Y] The skip link is present, correct, and wired to a real target
- **Evidence:** `components/a11y/skip-link.tsx` renders
  `<a href="#main-content" className="sr-only … focus:not-sr-only …">`, is the
  first element in **both** layouts (`app/(marketing)/layout.tsx:15`,
  `components/app/app-shell.tsx:349`), and both render
  `<main id="main-content">` (`layout.tsx:17`, `app-shell.tsx:387`). WCAG 2.4.1
  satisfied on both halves of the product. *Caveat:* its own
  `focus:outline-none focus:ring-2` is written with the `focus:` variant and is
  therefore unaffected by the `.focus-ring` defect above.
- **Status:** VERIFIED

### [CLAUDE-2][INFO][MOBILE] The iOS zoom-on-focus rule is correct and non-defeatable
- **Evidence:** `app/globals.css:138-144` —
  `@media (max-width: 640px), (pointer: coarse)` over `input:not([type=checkbox])…`,
  `textarea`, `select` with `font-size: 16px !important`. The `!important` is
  load-bearing (the shared `Input` is `text-sm sm:text-base`, i.e. 14px on
  mobile, and a Tailwind class selector would otherwise win) and
  `tests/mobile-forms.test.ts` pins both the `!important` and the
  `(pointer: coarse)` half. The only uncovered control type is
  `[contenteditable]` — and `grep -rn contentEditable app components` returns
  **0**, so there is nothing to cover.
- **Status:** VERIFIED

### [CLAUDE-2][INFO][CLIENT-BUNDLE] No heavy library is pulled into a client bundle
- **Evidence:** `recharts`, `framer-motion`, `lodash`, `chart.js`, `three`,
  `d3`, `exceljs`, `jspdf` — **0** `'use client'` components import any of them.
  `date-fns` appears in 2, which is the intended tree-shaken use. Pass N already
  proved no non-`NEXT_PUBLIC_` env var reaches the browser; this is the size
  question rather than the secrets question, and it is also clean.
- **Status:** VERIFIED

### [CLAUDE-2][INFO][STATE] Client-side async surfaces model loading and error properly
- **Evidence:** only 26 components fetch from a `useEffect`, and the two most
  data-heavy were read end to end.
  `components/settings/privacy-center.tsx:40` defines
  `type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ok'; data: T }`
  and renders all three branches (`:189-191`, `:221-223`, `:256-258`), checking
  `recentRes.error || exportsRes.error` before committing (`:79-81`).
  `components/modules/weekly-briefing-module.tsx:333-334` keeps `loading` and
  `error`, disables the button while pending (`:393`) and renders the error
  (`:401-403`). `grep -c 'catch\s*{\s*}'` over all `.tsx` in `app/` +
  `components/` → **0** empty catch blocks. This is the honest half of the same
  question the `/guardian` finding answers badly — the defect is confined to
  server-rendered reads, not to client fetches.
- **Status:** VERIFIED

### [CLAUDE-2][INFO][A11Y] Async results are announced
- **Evidence:** 117 `aria-live` / `role="status"` / `role="alert"` attributes
  across `app/` + `components/`. The shared toast
  (`components/ui/toast.tsx:84-85`) gets the severity split right —
  `role="alert"` + `aria-live="assertive"` for errors, `role="status"` +
  `aria-live="polite"` otherwise — which is the WCAG-correct pairing and is the
  path most async results in the app take.
- **Status:** VERIFIED

### [CLAUDE-2][INFO][STATE] Read-error handling is broadly solid — the gaps are a named minority
- **Evidence:** 149 of the 184 `page.tsx` files that read Supabase import
  `ErrorState`; 79 use `settleAll`; 127 `*-read-boundary.test.ts` guards cover
  165 files; `PartialReadBanner` exists and is pinned by
  `tests/activity-page-read-boundary.test.ts`. `app/(app)/marketplace/reviews/page.tsx:39-47`
  is a model instance and carries a comment explaining *why* the empty state
  would have lied. The findings above are the 35-page residue, and the two
  clusters within it — `/guardian/*` (5 pages) and `/family/*` (3 pages) — are
  contiguous, which is what makes them worth naming as clusters rather than as
  eight separate slips.
- **Status:** VERIFIED

### [CLAUDE-2][INFO][A11Y] Focus management inside the shared Modal is genuinely implemented
- **Evidence:** `tests/modal-a11y-contract.test.ts` pins `role="dialog"`,
  `aria-modal="true"`, `aria-labelledby={titleId}` via `useId()`, Escape-to-close,
  a Tab trap with a defined focusable set, `previouslyFocused = document.activeElement`
  + restore on close, background scroll-lock, and
  `aria-label="Close dialog"` on the icon-only close. Hand-rolled overlays that
  bypass it are separately pinned by `tests/mobile-overlay-dialog-a11y.test.ts`
  for four files. This is real, not a filename. The one thing it cannot give
  you is a *visible* place for the trapped focus to land — see the `.focus-ring`
  finding.
- **Status:** VERIFIED

---

## Summary — Claude-2

**17 findings: 1 CRITICAL, 4 HIGH, 7 MEDIUM, 3 LOW, 9 INFO (clean).**

Two were proved by running code rather than reading it, and those are the two
I would put first: the calendar's day bucketing (replayed under four `TZ`
values; wrong in every zone but UTC) and `.focus-ring` (compiled with the
project's own Tailwind config; the emitted rule has no focus selector and
suppresses the native outline).

The rest divide into three groups:

1. **A refused read reported as a fact**, on the UI surfaces Pass E deliberately
   left out of scope — `/family/members` (where the empty state is provably
   unreachable by any successful read), `/family/activity`, `/family/permissions`,
   `/dashboard/family-access`, and all five `/guardian` pages. `/guardian/settings`
   is the worst of them because a failed read does not merely mislead: saving
   afterwards overwrites the family's real call-routing configuration.
2. **Keyboard and screen-reader access**, where the codebase has good primitives
   and uneven adoption — calendar events openable only by mouse, 74 unnamed
   icon-only buttons, light-mode semantic colours below AA.
3. **Locale behaviour**, where the catalogues are thorough and the *formatting*
   is not — 245 hardcoded `'en-US'` formatters, a monolingual USD-only shared
   formatter, and Guardian's safety vocabulary sitting in `lib/` where the i18n
   gate cannot see it.

**Checked and clean:** table containment, image `alt`, the skip link, the iOS
16px input rule, heavy libraries in client bundles, empty `catch` blocks,
`aria-live` coverage, client-side loading/error modelling, and the shared Modal's
focus contract.

**Method notes, recorded because the README asks for them.** Four of my own
counts were wrong before they were right, and all four are recorded rather than
quietly fixed:

1. An icon-only-button count of **903**, then **256**, before the strict filter
   gave **74**. The first two counted `{t('…')}` as "not text" — the regex was
   measuring itself.
2. A first pass at unlabelled form controls flagged `components/ui/input.tsx`,
   which is the *correct* primitive: `Field` supplies the label through a
   render-prop the scanner could not follow.
3. **A correction I made after writing the finding.** The `.focus-ring` entry
   first said "218 call sites" and "used correctly once out of 219". That came
   from reading the first 20 lines of a grep. Counting every *occurrence* rather
   than every matching line gives **218 total, 16 correct, 202 bare** — and the
   16 turned out to be the whole marketing surface plus the kid login, which
   makes the finding sharper, not weaker: the public site was fixed and the
   signed-in app was not. The corrected numbers are in the finding.
4. The unwrapped-`<table>` scan initially looked like it would produce a long
   list from the 26 `min-w-[≥360px]` hits; reading them showed all 26 are
   already inside `overflow-x-auto`. That one became an INFO, not a finding.

Every number that remains above survived being checked against the file.

**No source file was modified.** Everything here is a recommendation for
Claude-1 to apply.

---

## Note on the merge

A second session created `# Claude-2 — Frontend / UI / UX / Responsive / Accessibility` as an empty template on `main`. It carried
no findings, so this file keeps the worker output above; nothing was lost.
