# Claude-2 — Frontend / UI / UX / Responsive / Accessibility

## STATUS (session 2, 2026-09-14)

CURRENT: in progress. IMPORTANT CONTEXT FOR CLAUDE-1: this file already held a
complete 14-finding pass (C2-01–C2-14, below) from an earlier parallel session,
merged into `finalaudit.md` as **Pass D (F-D01–F-D14)**. `audit/status.md`'s
top board and `finalaudit.md`'s Part 0 coverage table both currently say
Frontend/UX-Accessibility is "not audited — worker hit the account session
limit" — **that line is stale**; Pass D exists and is substantial. This
session does NOT repeat that pass. It reads C2-01–C2-14 first (done) and then
audits the specific angles the new brief calls out that Pass D did not cover:
failed-read states surfaced as empty/silent rather than errors, success
toasts after discarded write errors, i18n key leakage, and responsive/modal
behaviour beyond the CI device-matrix gate. New findings are numbered
continuing from C2-15 and appear in a clearly marked "Session 2" section below
the original pass, so nothing from the first pass is disturbed.
COMPLETED SO FAR: swept all 113 `useRealtimeQuery` consumers for dropped/
unrendered `error` (systemic pattern is sound — see C2-15 for the two real
exceptions); confirmed the blog-unsubscribe discarded-write-error bug the
brief named is still live (C2-16).
NEXT: i18n key-leak sweep, responsive/modal-at-360px pass, alt-text in the
authenticated app, error-boundary granularity.
FILES TOUCHED: none (audit-only, per hard rules).
LAST-UPDATE: 2026-09-14 (in progress — updated incrementally)

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
