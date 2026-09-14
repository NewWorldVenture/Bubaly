# Claude-2 — Frontend / UI / UX / Responsive / Accessibility

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
