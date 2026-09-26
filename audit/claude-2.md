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
