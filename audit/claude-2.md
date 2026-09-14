# Claude-2 — Frontend · UI/UX · Responsive · Accessibility

Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-2 and by nobody else.

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
