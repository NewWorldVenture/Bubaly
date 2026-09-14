# Bubaly — Final Audit

The single consolidated audit of bubaly.com. Sections 1–19 are the consolidated
view; **Part II** below is the evidence, kept verbatim, pass by pass.

**How this file is built.** Four workers audit in parallel and each writes only
its own file under `audit/`. Claude-1 merges them here and is the only account
that writes to this file. Worker findings are merged, deduplicated, and cited
back to the worker that found them; nothing verified is ever dropped on a
rebuild.

| worker | area | source file |
|---|---|---|
| Claude-1 | coordinator · architecture · integrations | `audit/claude-1.md` |
| Claude-2 | frontend · UI/UX · responsive · accessibility | `audit/claude-2.md` |
| Claude-3 | backend · API · database · auth · security | `audit/claude-3.md` |
| Claude-4 | QA · features · flows · performance · edge cases | `audit/claude-4.md` |

**The rule this audit is built on:** nothing closes on reasoning. A finding
closes when a command, a probe, a replayed database or a rendered page
demonstrates it — and wherever a fix is claimed, the check was also run against
the *broken* state to prove it was not passing vacuously. That discipline has
caught nine defects in this audit's own instruments, four of them found only by
deliberately breaking the thing being guarded.

---

# 1. Executive Summary

Fifteen passes (A–O) over fifteen surfaces, plus the four-worker parallel
audit now running. **63 named findings from the passes, and counting from the
workers.** The codebase
is in good structural health; the defects cluster in one recognisable shape.

**The shape.** Nearly every serious finding here is the same defect wearing
different clothes: **a control that is real on the screen and absent behind it.**

- Family Autopilot was a Plus feature on the sidebar and ran nightly for every
  family on the platform (**F15**).
- 24 of 62 paid features were enforced by a padlock icon; the URL was the bypass
  (**F16**).
- 20 endpoints behind feature-gated pages had no entitlement check — the `fetch`
  was the bypass, mostly on the surface that costs money per call (**F18**).
- A child could clear the family chore board, mint chores for a sibling, and
  self-approve a reward (**F20**, **F21**) — manager-only on the screen, nothing
  underneath.
- The AI Assistant page was gated at `basic` while the published Free plan sells
  it, *and* `/api/ai` behind it had no plan check at all — the gate backwards on
  both halves at once (**L-01**, **L-03**).
- The password vault demands step-up MFA on the page, and no policy in the schema
  references `aal` (**O-03**); a child could read, change and delete the family's
  stored card PIN (**O-01**).

**The second shape** is silence: a write whose result is discarded, followed by
something claiming it happened. Eight in Pass C, plus **E-01**, **F-a**, **F-b**.
`logAudit`'s `catch` block could never run, so every caller lost audit rows and
nothing said so. An emergency escalation recorded `push_sent: true` for a
notification that was never written.

**What is genuinely strong.** RLS is on for all 491 tables with no blanket
policy (**Pass G**). Every export of every `'use server'` module authenticates
its caller (**Pass D**, 0 findings). No `readOnly` AI tool can write (**Pass J**,
0 findings). No server secret is reachable from the browser bundle (**Pass N**,
0 findings). The money tables carry three manager-gated restrictive write guards
and survive a concurrency probe. 310 migrations replay clean; 20 behavioural
probes pass in CI.

**What is left, and whose it is.** Nine items, none of them a code defect this
audit can close: the production migration ledger (**F5**/**F-001**) needs a
credentialed operator; **F6** needs config; **F19**'s remaining 35 unmetered AI
routes, **O-02**'s credential reads and **SEC-001**'s public media bucket are
product decisions; migrations `0296` and `0297` are authored, replay clean, and
deliberately **not applied** to production.

---

# 2. Critical Issues

| id | finding | state |
|---|---|---|
| **O-01** | A child could read, change and delete the family's stored card PIN. `family_credentials` allows categories `card` and `pin`, stores `secret` as plain text, and all four policies were `is_family_member`. Proved: a `child` on an `aal1` session READ the PIN, UPDATED it, DELETED the row. | **Fixed** — `0297`, **not applied to production** |
| **I-01** | A social restriction could be removed by the person it restricted. Deleting the override row restores the higher default, returning `publish_posts` to someone a parent deliberately stopped. | **Fixed** — `0296`, **not applied to production** |
| **S-01** | **A guest could accept an invite as a parent.** `invites_update` was created with a `USING` clause and **no `WITH CHECK`**; Postgres then reuses `USING` as the write check, and that clause's invitee branch constrains exactly one column — `email`. So the invited person could rewrite `family_id` and `role` on their own row, and `accept_invite()` (SECURITY DEFINER) copies both straight into `family_members`. Found by **Claude-3**, reproduced end to end by Claude-1: a babysitter invited as `guest` issued one `update invites set role='parent'`, accepted through the ordinary flow, and **joined the household as a parent**. No second family, no guessed UUID — the `family_id` is in her own invite row, which `invites_select` lets her read. `authenticated` holds UPDATE on the table by Supabase's default privileges, so it is one PostgREST PATCH with no app code involved. | **Fixed** — `0298`, **not applied to production** |
| **Q-01** | **A child's spendable balance was totalled from part of the ledger, and spends raced.** `bucketBalanceCents` fetched the whole `wallet_transactions` history over PostgREST with **no bound** and reduced it in JavaScript. PostgREST caps at `db-max-rows`, so on a busy bucket it totalled the first page — **Claude-4 measured $92.00 reported against a real $40.00** on 1,052 rows. It also read-then-inserted with no lock: **two simultaneous $8 spends against $10 both posted, balance −$6.00**. Six other money operations go through locking RPCs; this was the one spend path that did not, and `requestSpendAction`'s own docstring says *"Never overdraws"*. | **Half fixed** — the read is paged (deployable, no migration); the race needs an RPC |
| **U-01** | **The family calendar put every event on the wrong day outside UTC.** Day columns were keyed from a *local-midnight* `Date` through `toISOString()`; events from their true instant, also through `toISOString()`. Those agree only at offset zero. Found by **Claude-2**, replayed by Claude-1: in `Europe/Amsterdam` and `Asia/Tokyo` **0 of 7** days matched their own column and the seventh day's events keyed to a date no column carried, so they **did not render at all**; in `America/New_York` events from 21:00 and in `America/Los_Angeles` from 19:00 landed a column late. Six of the eleven shipped locales are UTC+1/+2. | **Fixed** — `lib/time/local-day.ts` + 19 guard cases |

**All three fixes are authored, replay clean, and are gated behind F5. Until the
ledger is repaired, all three defects are live in production** — and S-01 is a
remote privilege escalation to parent of a household, reachable by anyone who
holds a pending invite.

### The correction S-01 forces on this audit

**Pass I examined this exact policy and recorded it as *"exactly right"*:**

> | `invites` | `can_manage_family`, plus an update clause letting the invited person accept their **own** invite by matching their JWT email | exactly right |

That row is wrong, and the reason it is wrong is worth more than the row. Pass I
read the `USING` clause and asked whether its *predicate* was correct. It never
asked whether `WITH CHECK` was **present**. An absent clause has no text to
read, so a review that reads policy expressions cannot see it — and the whole of
Pass I was conducted that way.

`docs/audit/invite-cannot-rewrite-what-it-grants-check.sql` closes it
behaviourally and pins the structural cause: a `w`-command policy with
`polwithcheck IS NULL` fails the probe, whatever its `USING` says. The same
question should be asked of every other UPDATE policy in the schema — recorded
as the next task in `audit/claude-1.md`.

---

# 3. High Priority

**Fixed and live:** F1, F9 (closed as a recorded decision), F10, F15, F16, F18,
F20, C-01 … C-05, C-07, E-01, F-a, F-b, H-01, L-01, L-02, L-03, **P-01**,
**U-02**, **P-02**, **P-03**, **U-03**, **P-04**, **U-04**, **S-03** (app half), **S-04** (repo), **S-05** (the `families` half, repo), **W-01**, **W-02**, **W-04** (copy half), **X-01**, **U-05**, **Y-01**.

| id | finding | found by | state |
|---|---|---|---|
| **P-01** | **Vacation Planner and Weekend Planner gated on hrefs the catalog did not contain**, so `resolveFeatureEntitlement` returned `allowed: true` for every family at all 21 call sites. The sidebar rendered both as unlocked (it reads the resolved tier, not `minLevel`), and `/api/vacations/ai` and `/api/weekend/discover` — a model call and a Ticketmaster/SeatGeek fan-out on the deployment's own keys — were open to Free. Neither feature appeared on the published `/pricing` grid, which is generated from the same catalog: the product sold neither and the code gave both away | **Claude-4**, verified by Claude-1 | **Fixed** |

| **U-02** | A failed Guardian profile read renders the **factory defaults**, and Save is an `upsert onConflict: family_id,member_id` — so saving over a failed read **overwrites the family's real call-routing configuration**, `default_mode_unknown` included. The E-01 class with teeth: not a wrong answer, a destroyed setting | **Claude-2**, verified + fixed by Claude-1 | **Fixed** |
| **P-02** | **Three of the six routing rows the Guardian settings form renders had no writer anywhere in the application.** `save()` named three fields by hand and the action's input type accepted the same three, so `default_mode_immediate`, `default_mode_close` and `default_mode_trusted` only ever held their column DEFAULT — while `resolveFromProfile` (`lib/guardian/pipeline.ts:144`) routes every inbound call from immediate family, close family and trusted friends through exactly those three. Changing one highlighted the new mode, answered "Settings saved", and reverted on reload | **Claude-1** (found reading U-02's save path) | **Fixed** |
| **P-03** | A greeting the family **deleted came back**: `form.ai_greeting_template \|\| undefined` turned a cleared field into an omitted key, and the upsert left the old text in the column. Neither the AI greeting nor the voicemail greeting could be removed once set; both columns are nullable, so there was a correct value to write | **Claude-1** (same path) | **Fixed** |
| **U-03** | `.focus-ring` (`app/globals.css:179`) emits `outline: 2px solid transparent` plus an unconditional ring and **no `:focus-visible` selector** — so the ring is always on and the native focus indicator is suppressed. 218 uses, **16 correct**, and all 16 are on the marketing surface plus kid login: the public site was fixed, the signed-in app was not. One-line fix, no call-site edits | **Claude-2**, verified + fixed by Claude-1 | **Fixed** |
| **P-04** | **Classes the app uses that compile to nothing.** `btn-primary` (one admin button), `no-scrollbar` (**13** tab strips), `bg-card`, `prose-family`, and six colour-opacity modifiers off the scale (`/12`, `/8` — `bg-brand/10` emits, `bg-brand/12` does not), two of them on the **public** pricing and security pages: each renders with no background, border, divider or scrollbar suppression, and neither CSS nor the build reports an unknown class. **Eight fixed.** Three further families are confirmed by compiling each token — shadcn-style tokens this theme never defines (`bg-primary`, `text-foreground`, `bg-background`, `bg-surface-2`), `tailwindcss-animate` classes with `plugins: []`, and more off-scale values — are **all fixed** — 134 replacements across 54 files, with `scripts/audit-unstyled-classes.mjs` now reporting zero and `tests/every-class-in-the-app-styles-something.test.ts` holding it there (five positive controls plant a known-bad token each, because with every real offender fixed a clean sweep is otherwise indistinguishable from a blind one). The inventory was **47** class names across 54 files — 23 off-scale opacity modifiers, ten shadcn theme tokens this theme never defines (`bg-card`, `bg-primary`, `text-foreground`, `bg-background`…), four `tailwindcss-animate` classes with `plugins: []`, and the rest. Getting that number honest took four corrections: 157→65 (a regex read `k === 'high'` as a class), 65→35 (Tailwind escapes a comma as `\2c ` **with a trailing space**, truncating every `grid-cols-[minmax(0,1fr)_…]`), 35→51 (the sweep could not see a literal whose tokens are ALL unstyled — `className="h-4.5 w-4.5"`), 51→47 (an argument to a function that *computes* a class is not a class) | **Claude-1** (found checking a line number in U-03's report) | **Fixed** |
| **U-04** | The whole AI Call Guardian surface — five pages — discards every read error, and none appears in the 127 `*-read-boundary` guards. A failed read renders **"0 scams blocked"** on the safety dashboard, **"0 contacts"** on the trust graph, "no routing rules", and "No communications match your filters" over a log that may be full of blocked scam calls — plus "No activity recorded yet" over `/family/activity`'s audit trail | **Claude-2**, verified + fixed by Claude-1 | **Fixed** — `/guardian` now carries a `PartialReadBanner` naming each failed read and its stat tiles take `number \| null`, so a count nobody read renders an em dash rather than a zero; the other four return an `ErrorState`; `CallHistory` tells an empty log from a filtered one. 14 rendered cases, 5 of them negative controls; reverted, 9 of 14 fail |
| **U-05** | Calendar events, note cards and photo rows are bare `<div onClick>` — mouse-only, WCAG 2.1.1 | **Claude-2** (44 sites), recounted at **22** and fixed by Claude-1 | **Fixed.** Of 49 non-native `onClick` elements, 21 are empty `inset-0` dismiss catchers and 7 are `stopPropagation` wrappers; **22** are defects — the calendar chip in all **five** views, the note row and card, both photo views, the recipe card, the contact row, two empty meal slots, the goal row, three upload dropzones and three mouse-only dismissals. Claude-2's list also named `files-hub-module.tsx`, which was already correct (its dropzone is a real `<button type="button">`); it was the one entry with no line number. **The recommended fix is wrong for 8 of the 22**: `role="button"` has *presentational children*, so putting it on the note row would have told assistive technology to ignore the Pin/Copy/Delete labels **X-01 had just added**. Those 8 take a real nested `<button>` over their content region, with the row keeping its `onClick` as a mouse convenience. `scripts/audit-keyboard-operable.mjs` reports which of the two shapes each site is, with every exemption structural rather than a filename list; `tests/every-click-can-be-made-with-a-keyboard.test.ts` holds it at zero with 6 positive and 12 negative controls. Reverted all 14 files: the sweep fails naming all 22 and the other 19 cases pass |
| **Y-01** | **The photos lightbox was a keyboard trap, and both Guardian editors could not be closed from the keyboard.** The lightbox covers the screen and had **no key handling at all** — Escape did nothing and the only exit was clicking the backdrop (WCAG 2.1.2, Level A). It mattered more the moment U-05's fix made the tiles that open it operable: fixing 2.1.1 would have walked keyboard users into a trap. And `guardian/contact-list.tsx` + `rules-editor.tsx` both declare `role="dialog" aria-modal="true"` and build the shell **by hand** instead of through `components/ui/modal.tsx`, *which handles Escape* — so neither closed on Escape and both scrims sat in the accessibility tree with no `aria-hidden` | **Claude-1** (found auditing U-05) | **Fixed.** The lightbox closes on Escape and moves with the arrows, since Previous/Next already sit either side of the image; both Guardian editors close on Escape and their scrims are `aria-hidden`. That the two editors duplicate `ui/modal.tsx` rather than use it is recorded, not refactored |
| **X-01** | **82 icon-only buttons had no accessible name** — a screen-reader or voice-control user hears "button" and cannot tell Edit from Delete, and on these lists the pair sits side by side: an insurance policy, a financial transaction, an immunisation record, a Guardian routing rule. Two Claude-2's list did not reach are **approve and reject on a child's investment order**. And `wallet-activation.tsx:78` is a checkbox drawn as a `<button>` inside a `<label>` — it looks labelled on screen and had no accessible name at all, because a `<label>` names a form control, not a button | **Claude-2** (74), recounted at 82 and fixed by Claude-1 | **Fixed.** 28 reusable `a11y.*` labels translated into all seven catalogues; 62 applied automatically for unambiguous icons, 20 by hand because an `X` beside a `Check` means **Reject** not Close, and five automated labels corrected because a button that switches icons needs a label that reads the state. `tsc` then found 15 errors of one kind — the detector took each file's FIRST `useTranslations()`, but these files hold several components each with its own in its own scope. Guarded by `tests/every-icon-button-has-a-name.test.ts` with three positive and **eight negative** controls (the over-reporting matters: Claude-2's first two formulations gave 903 and 256 by treating `{t('…')}` as "not text"). The existing `i18n-client-scope` guard then caught a defect the fix introduced — `a11y.clearSearch` on the blog's search field would have rendered as a raw key to every visitor |

| **S-02** | The child-PIN throttle is keyed on the **submitted** string while the lookup is `.ilike()`, and `_` is both a legal username character and a SQL wildcard. 16 distinct throttle buckets all resolved to one account — `2^(L-2)` per account, which exceeds the 10,000-PIN keyspace at L≥13 | **Claude-3** | **Already fixed** — by `adaa04d8` (#545), before the finding was written; `app/(auth)/actions.ts` uses `.eq()` and `tests/child-login-username-is-not-a-pattern.test.ts` guards it. Claude-3's evidence came from one of the **81 stale git worktrees** under `.claude/worktrees/`, which still hold the pre-fix line: a filesystem grep reads code that was fixed hours earlier |
| **S-03** | `child_logins`' policy is *named* "Managers manage" and *predicated* on `is_family_member`. A child UPDATE'd and DELETE'd a sibling's login — permanent lockout with no UI recovery — and `resetChildPinAction` trusts that table's `user_id` for `admin.auth.admin.updateUserById`. **Verification made it worse than HIGH:** a child repoints their own row at a PARENT's auth user, asks that parent to reset their PIN, and the parent's password becomes a value the child chose — child→parent takeover with the parent's own hand on the button | **Claude-3**, verified + fixed by Claude-1 | **Fixed in the app; RLS half queued.** `resetChildPinAction` now resolves the auth user from `family_members` and refuses a disagreement or a manager target — that closes the takeover on production **today**, without waiting for the ledger. `0299_child_logins_write_boundary.sql` closes the rest (sibling lockout, planting a mapping) and is **not applied**. Probe's negative control: *"a child REPOINTED 1 login mapping(s) at another auth user — this is the reset-PIN takeover"* |
| **S-04** | `audit_logs` lets any member forge `actor_id` — a child filed a `delete wallet_transactions` row naming the parent — including `family_id IS NULL` rows the admin **Security** page renders with the service client. `0260_trust_ledger_lockdown.sql` fixed precisely this on `trust_audit_logs` and left `audit_logs` open | **Claude-3**, verified + fixed by Claude-1 | **Fixed in the repo; NOT applied.** `0300_audit_logs_says_who_wrote_it.sql` pins `is_family_member(family_id) and actor_id = auth.uid()` and drops the null-family branch. It PINS rather than drops (0260's approach) because fourteen callers append on the caller's own client and `household-trail-check.sql` states that intent — all fourteen already pass their own `ctx.user.id`. Negative control: *"a child ATTRIBUTED a wallet deletion to the parent \| a child wrote a family_id IS NULL row into the platform security feed"*. **No application half exists** — the forgery is a direct PostgREST INSERT, so only RLS can refuse it, and it stays open in production until the ledger is repaired |
| **S-05** | 163 CASCADE foreign keys with no supporting index. Measured on one of the 36 a family delete must resolve: **5,715 buffers / 52.9 ms → 4 buffers / 0.18 ms** | **Claude-3**, verified + part-fixed by Claude-1 | **The `families` half FIXED in the repo (NOT applied)**; 191 further constraints recorded as the owner's tradeoff. Counted from the catalogue: **227** unindexed across the four hot parents, not the finding's ~100 — 36 on `families`, 158 on `family_members`, 22 on `vacations`, 11 on `child_wallets`. `0301_family_erasure_indexes.sql` closes the 36 (generated from the catalogue, not hand-listed; 36 → 0 on a fresh replay), with a CONCURRENTLY variant for production because a migration runs in a transaction and `concurrently` cannot. Re-measured on **`ai_messages`** — one of four tables `family-scoped-index-check.sql` says it *"checked and left alone"*, on the correct grounds that its page query has another selective column: **4,990 buffers / 21.4 ms → 55 / 0.064 ms**. That exclusion is right about the READ and silent about the DELETE, and all four excluded tables are in the erasure path. The probe gains a **generic** assertion naming no table, plus its own can-this-fail self-test |
| **W-01** | **"Run now" twice paid the allowance twice.** `runDueAllowancesAction` advanced the schedule by id alone, with no `.lte('next_run_on', today)`, so two overlapping runs both matched the row and both credited — while the cron forty lines away in another file always claimed correctly, and the action's own docstring called the two idempotent. Re-raced on two connections against a replay of 313 migrations: **blind shape `ledger_rows=2 cents_credited=2000`, claimed shape `ledger_rows=1 cents_credited=1000`**. Reachable from a plain button with two tabs or a double-tap during the nightly cron, and `wallet_transactions` is append-only, so the correction is a manual reversal row | **Claude-4**, verified + fixed by Claude-1 | **Fixed** — the action now claims exactly as the cron does; race preserved as `docs/audit/allowance-double-pay-race.sh` |
| **W-02** | **Two test defects around that money path, and the second is the worse kind.** `tests/allowance-cron-idempotency.test.ts` asserted the property of ONE hardcoded file while its own header stated it of "manual trigger" too, so the second implementation shipped unguarded; and `tests/wallet-allowance-persistence.test.ts:13` asserted the **exact text** of the defective update, so the one-line fix for a live double-pay would have turned the suite red — a guard that makes the fix look like the regression. The idempotency guard now **discovers** every schedule-advance site and asserts it found both by name; the persistence test asserts its own property instead of a formatting choice. Second instance of this class in the session, after `tests/mobile-fullscreen-panel-safe-area.test.ts` anchoring on a dead CSS class | **Claude-4**, verified + fixed by Claude-1 | **Fixed** — against the defective action the idempotency guard fails 3 of 13 naming the file, and the persistence file passes |

**P-01 is the mirror of L-01.** L-01 gated a feature the plans sell; P-01 gave
away two the plans never mention. Same file, opposite direction, and both
invisible because three declarations disagreed and nothing compared them.

| **W-03** | **`/dashboard/home` is sold as Plus, listed for Basic, and opened for Basic.** Three declarations of one fact: the catalogue that generates `/pricing` says `plus`, the sidebar says `minLevel: 1`, the pages say `requirePlanLevel(1)` — and the AI routes behind them gate on the catalogue, so a Basic family is invited into a screen where every AI button answers 403. Same family as L-01 and P-01 | **Claude-4**, verified by Claude-1 | **OPEN — owner's decision.** Unlike P-01 the catalogue is not the outlier here: it agrees with the published pricing page, so the consistent fix RAISES the gate and takes a screen away from Basic families who have it today. That is a comms decision, not a code one; the three-way table is recorded in `audit/claude-1.md` so whoever decides has the whole picture |
| **W-04** | **`/dashboard/experience` can only ever be empty, and its empty state told the family to run a SQL file.** Nothing in `app/` or `lib/` writes `experience_audits` — only `database.types.ts` and the reader mention it — while the nav entry is `minLevel: 0`, so the page is in **every** household's sidebar. Its only reachable state ended *"Run seed_experience_audits_one_family.sql to populate a baseline."*, in hardcoded English | **Claude-4**, verified by Claude-1 | **Copy FIXED** — replaced and lifted into all seven catalogues, with `tests/no-user-facing-copy-names-an-internal-file.test.ts` sweeping the catalogue for anything that reads like a file to run. It found one other, allowed with its reason (Super Admin → Users, where the reader deploys Bubaly and running the seed IS the remedy) — the rule is "no filenames in front of a family", not "no filenames". **The empty feature is OPEN**: build the writer or take it out of the nav, and `memory.md` forbids an agent touching the sidebar unasked |

**Open, and owner-owned:**

| id | finding | why it is still open |
|---|---|---|
| **F5 / F-001** | Production's migration ledger records only `0001–0003` against 439 tables and 957 policies, so every push halts at the baseline guard | needs a credentialed operator; the guard is correct and must not be disabled |
| **F21** | A child could grant themselves a reward | app half fixed and live; the durable half is a migration waiting on F5 |
| **O-02** | A child can still **read** every stored credential | a product decision — the page is called "Wi-Fi & Passwords" and `wifi` is a category. Three options are set out in Pass O |
| **O-03** | The vault's step-up MFA has no RLS counterpart — zero policies across 491 tables reference `aal` | the naive fix is wrong: `requireAal2` skips families with no enrolled factor, so an `aal2` policy locks them out of their own vault |
| **SEC-001** | The `family-media` bucket is public; signed URLs are tracked separately | owner's tracked work. **H-01** closed the part that needed no migration |

---

# 4. Medium Priority

F2, F4, F6, F7, F11, F17, F19, C-06, C-08, K-01, K-02, M-01, and Pass B's
F-002 … F-020. Each is recorded in full in Part II with its evidence.

Two worth pulling forward because they are still open:

- **F6** — family email routing is unconfigured (`CONTACT_CENTER_INBOUND_SECRET`,
  MX records). Operator config, not code.
- **F19** — 35 of 39 AI routes run unmetered. Pass L closed the assistant,
  because the published plans had already decided it. The rest is a pricing
  decision, and Pass F19 sets out the three options and their costs.

---

# 5. Low Priority

F3, F8, F12, F13, F14. All either fixed or closed with the reason recorded —
**F12** ("the 404 page ships no server-rendered markup") is deliberately *not*
fixed, because the fix costs more risk than the defect.

---

# 6. Architecture

Next.js App Router, Supabase Postgres with RLS as the tenancy boundary, Vercel
hosting, an Expo mobile client sharing `design/tokens`, and an AI layer with a
closed tool registry and a trust engine.

**The boundary that carries the system.** Hosted Supabase grants `anon` and
`authenticated` full DML on every table it creates — 488 of 491 here — so RLS is
not one layer of defence, it is the only one. `docs/audit/pg-bootstrap.sh`
reproduces that grant model deliberately, so the local harness is never *safer*
than production. That decision is why Passes G, I, K and O could be answered at
all.

**The recurring architectural fault** is the one in §1: a policy expressed in the
UI layer and not in the layer that enforces it.
`lib/server/feature-entitlement.ts` is the corrective — one resolver that a
page, a cron, a webhook and an API route all call, so "the gate was real on the
screen and absent in the pipeline behind it" cannot recur by omission. It is not
yet used everywhere.

**Two implementations of one concept, found by sweeping the anti-drift helpers.**
Adoption is good — `settleAll` 155 files, `notify` 70, `readAll` 27, `logAudit`
13 — with one exception at the exact place the helper was written for.
`lib/server/ai-access.ts` says `authenticateAI` mirrors `app/api/ai/route.ts`
*"so the two AI edges cannot drift in what they accept"*; that route still has a
private `authenticate()` and never adopted it. The authorization logic has not
drifted — read side by side, every branch and code matches. The **copy** has: the
route translates, the shared helper hardcodes six English strings, and ten route
handlers serve them. It lands hardest on the Expo client, which sends a bearer
token and no cookie, so `Accept-Language` is its only locale signal. Invisible
because `GATED_SURFACES` in `scripts/i18n-scan.mjs` covers the marketing surface
and the app shell and nothing under `app/api` or `lib/server` — not a rule broken,
a surface the rule was never pointed at.

**Scheduling.** Every `/api/cron/*` route has a schedule and every schedule names
a route that exists — verified by set-comparing the routes on disk against
`vercel.json` and `scripts/cron-dispatch.mjs`. All 24 are scheduled **twice**,
deliberately: Vercel Hobby fails a deployment scheduling anything finer than
daily, so `vercel.json` carries daily-safe schedules and the real cadences live
in the dispatcher. The design rests on one sentence — *"the routes are idempotent,
so a Vercel daily run and a GitHub run of the same route never conflict"* — which
is load-bearing for all 24 and which nothing verifies. It has already been false
once: **F-014**. Recommended fix in `audit/claude-1.md`: run each route twice
against the replayed database and assert the second run writes nothing new.

**Layering is clean.** `grep -rn "from '@/app/" lib shared` returns 0, so the
dependency direction is one-way and Pass N's RPC-boundary reasoning holds without
exception.

**Known structural debt:** `middleware.ts` carried a hand-maintained PUBLIC list
until it was lifted into `lib/auth/route-access.ts` with a totality test; the
migration ledger's baseline gate blocks all schema delivery; and the audit's own
`docs/audit/*-check.sql` probes are now load-bearing infrastructure that CI runs
by glob.

---

# 7. Frontend

**Claude-2: 26 entries — 1 critical, 4 high, 7 medium, 3 low, 9 recorded clean.**
Full detail in `audit/claude-2.md`.

The frontend's defining weakness is the **E-01 class on the screen**: a read
whose error is discarded, and an empty state shown in its place. Six surfaces:

| surface | what a failed read renders |
|---|---|
| `/guardian` (5 pages) | ~~"0 scams blocked" on the safety dashboard; "No communications match your filters" over a possibly-full log~~ (**U-04 — FIXED**: a `PartialReadBanner` names each failed read, the stat tiles take `number \| null` so an unread count is an em dash and never a zero, and the other four pages return an `ErrorState`) |
| `/guardian/settings` | ~~the factory defaults — and Save then **upserts them over the family's real config**~~ (**U-02** — **FIXED**: the read goes through `settleAll`, `profileError` returns an `ErrorState` before anything savable renders, and the prop is now `{status:'ok'\|'absent'\|'error'}` so a failed read cannot be mistaken for an absent row again) |
| `/family/members` | "No members yet." — provably unreachable by any *successful* read, since `requireUserContext()` guarantees the caller is an active member. That branch fires **only** on failure |
| `/family/activity` | ~~"No activity recorded yet" over the audit trail~~ (**FIXED** with U-04 — the error `settleAll` already delivered is now read) |
| `/family/permissions` | misdiagnoses a failed read as an unapplied database seed |
| `/dashboard/family-access` | existing kid logins appear absent |

**47 pages still batch reads with raw `Promise.all`** — the pattern
`lib/supabase/settle.ts` was written to retire after it "took out /dashboard" in
production. Six have no error handling at all, including the public
`app/(marketing)/blog/page.tsx`.

**And a whole class of defect nothing in the toolchain reports (P-04, fixed).** An
unknown class is not an error in CSS, in Tailwind, or in `next build`; the element
simply renders without what was asked for. **47 class names** were in that state:
28 cards on `bg-card` with no background, `bg-primary` / `text-foreground` /
`bg-background` / `bg-surface-2` (shadcn's vocabulary, used as if this theme
defined it — it names them `brand`, `fg`, `bg`, `elevated`), `btn-primary` on an
admin Save button, `no-scrollbar` on thirteen tab strips, the onboarding wizard's
`animate-in fade-in slide-in-from-bottom-2` against `plugins: []`, and 23 colour
opacities that are not multiples of five — `bg-brand/10` works, `bg-brand/12`
resolves to nothing, and two of those were on the public pricing and security
pages. All fixed, and held at zero by a guard that compiles the real stylesheet
with the real config.

Already established: the whole 848 KB i18n catalogue was serialized into every
page (**F9**, closed as a recorded decision); five public pages had no `<h1>`
(**F11**); page titles doubled the brand (**F8**); seeded placeholder records
were rendered as real customer testimonials (**F10**).

---

# 8. Backend

*Consolidated from `audit/claude-3.md` — worker running; findings merged as they land.*

Established: Pass D (every `'use server'` export authenticates its caller,
0 findings), Pass F (public route handlers, 2), Pass K (caller-supplied tenant
ids, 2), Pass C/E (discarded write results and read errors, 11).

---

# 9. Database

Pass B covers the data layer in depth (F-001 … F-020): `anon` held INSERT/UPDATE/
DELETE on all five money tables (**F-003**); six nightly jobs silently stopped at
1,000 rows because PostgREST caps a response whatever `.limit()` asks for
(**F-008**, and **F-011** records that the *fix* had the same defect); 59 reads
asked for more rows than the server would ever return (**F-013**); nine
family-scoped reads were sequential scans of whole tables (**F-018**); a family's
"today" was Greenwich's today on every surface showing a day (**F-017**).

310 migrations replay into a fresh database with 0 failures. 20 behavioural
probes run in CI by glob, so a probe added tomorrow runs tomorrow.

---

# 10. Security / Auth

Passes D, F, G, I, K, N, O. The headline results:

- **RLS**: on for every one of 491 tables, no blanket `using (true)` outside four
  named reference-data exemptions (**Pass G**, `blanket-policy-check.sql`).
- **Role boundaries**: governance tables are gated well — `parent_approvals`
  pins the *shape* of the row, not merely membership. Two tables disagreed with
  themselves: `social_access_permissions` (**I-01**) and `family_credentials`
  (**O-01**).
- **Client bundle**: no server secret is reachable (**Pass N**). All eight
  `NEXT_PUBLIC_*` variables are public by construction.
**Claude-3's sweep: 12 entries, 9 defects and 3 evidenced-clean**, every database
claim made by `set_config('request.jwt.claim.sub', …)` + `set role authenticated`
and reading back real rows, against a 310-migration replay with the 20 existing
probes green. Detail in `audit/claude-3.md`.

**Reported as loudly, the zeros:** 65/65 `SECURITY DEFINER` functions pin
`search_path` · 7/7 unchecked-tenant privileged RPCs denied to both client roles
· all 31 anon-executable definers read individually and each gated · 76/76
body-reading route handlers bounded · 7/7 missing-secret branches fail closed ·
all five webhook families verify and dedupe · 36 `.or()` sites non-injectable ·
`family_members` write policies correct · no float money · `x-bubaly-family-id`,
`active_family_id` and `next=` all re-derived server-side · MFA, sign-out, the
OAuth callback and the SSRF guards each tried and did not yield.

**Every UPDATE policy asked S-01's question.** 175 policies; **13 have no
`WITH CHECK`**, and 13 is not 13 findings: absent `WITH CHECK` means Postgres
evaluates `USING` on the NEW row, so a *single* `can_manage_family(family_id)`
still forces the row into a family the caller manages. Eleven are that shape and
safe. The dangerous shape is a **disjunction** whose branch pins a column other
than the authorization one — and **the invite policy was the only one**.
`notifications_update` can turn a personal notification into a family-wide one
(low), and `profiles_update_self` lets a user rewrite their own `email` with no
unique index (medium) — checked specifically against `is_super_admin()`, which
reads the **JWT** email and not `profiles.email`, so it is not an escalation.

- **Tenancy**: `is_family_member(family_id)` is membership-WIDE by design, which
  is correct for a parent with two households — and means the application filter
  is what narrows a query to one. Two routes did not supply it (**K-01**,
  **K-02**).

---

# 11. UX / Accessibility

- **U-03 — focus is invisible across the signed-in app. FIXED.** `.focus-ring`
  suppressed the native outline and painted its ring unconditionally, with no
  `:focus-visible`; 202 of 218 uses are the bare form, including the shared
  `Input`, `Textarea` and `Select`. Keyboard users could not see where they were.
  The DECLARATION is now scoped, which fixes all 202 call sites without editing
  one of them — and Tailwind hoists the pseudo-class onto the two component
  classes that `@apply focus-ring`, so `.btn-cta` and `.btn-inline` split into a
  focus rule carrying the ring and a base rule carrying everything else.
  `tests/the-focus-ring-only-shows-on-focus.test.ts` compiles the real stylesheet
  with the real config and asserts on the emitted CSS; reverted, 4 of 6 fail.
- **X-01 — 82 icon-only buttons had no accessible name. FIXED.** Recounted from
  Claude-2's 74 against the current tree. The destructive ones are the majority, and
  a screen-reader user was offered an unlabelled control that deletes — including
  approve and reject on a child's investment order. 28 reusable `a11y.*` labels now
  cover them, and `tests/every-icon-button-has-a-name.test.ts` sweeps the whole app
  rather than the five files the two previous guards named between them.
- **U-05 — 22 controls a mouse could operate and a keyboard could not. FIXED.**
  The calendar event chip in all five views, the note row and card, both photo
  views, the recipe card, the contact row, two empty meal slots, the goal row and
  three upload dropzones. WCAG 2.1.1 Keyboard, Level A. **The obvious fix would
  have undone X-01:** `role="button"` has *presentational children*, so putting it
  on a row that holds its own action buttons tells assistive technology it may drop
  their semantics — silencing the Pin, Copy and Delete labels the previous tranche
  had just added. So 8 of the 22 take a real nested `<button>` over their content
  region and keep the row's `onClick` as a mouse convenience; the leaves take the
  role. No `aria-label` where the element already shows text, because `role="button"`
  names itself from its contents and a fixed label would break WCAG 2.5.3.
- **Y-01 — the photos lightbox was a keyboard trap. FIXED.** No key handling at
  all: Escape did nothing and the only exit was clicking the backdrop (WCAG 2.1.2).
  Making the tiles operable would have walked keyboard users straight into it. Both
  Guardian editors had the same gap, because they build a `role="dialog"` shell by
  hand rather than through `components/ui/modal.tsx`, which handles Escape.
- **In light mode, four semantic text colours failed WCAG AA. FIXED, web and Expo.**
  `--accent` 2.67, `--success` 2.91, `--warning` 2.70 — the first three below even the
  3:1 large-text floor — and `--danger` 4.09, across **506** `text-*` sites, 295 of
  them `text-danger`. Dark mode was 7.13–11.74 throughout, which is how it survived:
  the app's own default theme is the dark one, so nobody developing in it saw the
  failing combination. Fixed in **four lines** rather than 506 renames, by darkening
  the light-mode tokens with hue and saturation held and stopping at the first value to
  reach 4.5:1. Safe because the non-opacity fills these tokens also drive — 21
  `bg-danger`, 16 `bg-success`, 7 `bg-warning` — are every one a dot, bar or progress
  fill rather than a text background, and where one does carry white text the ratio
  *improves* (4.38 → 4.84), contrast being symmetric. **`design/tokens.json` held the
  same four values and the Expo app imports it directly**, so the same defect was live
  on mobile; both updated, and `tests/design-tokens.test.ts` would have failed on the
  drift. `tests/brand-contrast-contract.test.ts` now **measures** the ratios instead of
  only asserting that a `--brand-text` token exists — it was green for a stylesheet
  with four failing text colours, the same class as the three other guards this audit
  found pinning a solution rather than a property.
- **The shared `Field`** announces an error but never sets `aria-invalid`.
- **Destructive actions in the medical and money modules delete on one click**
  with no confirmation.
- **Every date, time and money value renders in US English** regardless of locale.
  **Mechanism FIXED; the conversion is ratcheted.** Measured: **252** hardcoded-locale
  formatter sites in 144 files, not 245 — and **24 independent money formatters**, not
  one. `lib/utils/format.ts` was locale-blind in four ways: English month and day
  names, 12-hour AM/PM in locales that use a 24-hour clock, `fmtRelative` saying
  **"Today,"** in hardcoded English, and `new Intl.NumberFormat('en-US')` pinned at
  module scope. `lib/i18n/locales.ts` says in its own header that the unit is a full
  locale because *"a family in Mexico and a family in Spain both read Spanish but
  expect different dates, currency and vocabulary"* — and nothing consumed it for
  either. `createFormat(code, t?)`, `useFormat()` and `await getFormat()` now exist,
  matching the `useTranslations()`/`getTranslations()` idiom, built on `Intl` rather
  than date-fns-with-a-locale because a pattern like `'EEE, MMM d'` hardcodes the
  **order** as well as the names — date-fns with a German locale gives German names in
  American order. **`components/` is now at zero** — every date, time and money value a component renders follows the reader: the shared formatter, the Family Wallet's 79 money sites, and 117 date sites across 60 components. **252 → 123**, and what remains is `app/` (44) and `lib/` (79), a meaningful share of which is correct as en-US (AI prompts, crons and exports, Super Admin, the locale as data);
  `tests/hardcoded-locales-only-go-down.test.ts` holds the remainder as a ceiling that
  can only fall. **The currency is deliberately NOT localised**: a US family's wallet
  is in dollars whichever language they read, so the currency stays a caller's argument
  (eight tables carry a `currency` column) while only the separators follow the
  locale — `"12,50 $"` is how German writes twelve and a half US dollars.
  **And the non-breaking separators are load-bearing.** The first version of the shared
  formatter normalised U+202F *and* U+00A0 to an ordinary space across every helper —
  correct for the AM/PM gap, whose character changed with ICU 72, and wrong for money
  and numbers: `de-DE` puts a NON-BREAKING space between amount and symbol so the
  figure cannot be split across a line, and `fr-FR` and `pt-PT` use U+202F and U+00A0
  as their *thousands separator*. The ratchet, the typechecker and sixteen existing
  formatter cases were all green over it, because those cases asserted
  `toContain('12,50')` — which a flattened separator still satisfies. Only an assertion
  on the exact rendered string found it. Normalisation is now scoped to the date/time
  path and the property is pinned. The lesson generalises: on a formatter, assert the
  whole string.
- **Guardian's safety vocabulary** — scam types, trust levels, routing labels —
  is 45 hardcoded English strings in `lib/`, on a surface `GATED_SURFACES`
  cannot see. The same blind spot as Claude-1's finding on `lib/server/ai-access.ts`:
  the i18n gate covers marketing and the app shell, not `lib/` or `app/api`.

**Recorded clean, at equal weight:** the skip link (correct, wired to a real
`<main id="main-content">` in both layouts) · `alt` text (0 real offenders) ·
`aria-live` across 117 sites with the toast severity split correct · focus
management inside the shared Modal · client-side loading/error modelling ·
0 empty `catch {}`.

---

# 12. Performance

**F9** — the i18n payload. **F-018** — nine family-scoped reads were full table
scans at 700k rows; now index scans. **F-008**/**F-011**/**F-013** — the
PostgREST row ceiling, which is a correctness *and* performance defect.
**M-01** — shared-cache headers.

**Claude-4: 8 sweeps, 24 findings**, every money claim raced on a 310-migration
replay with two connections genuinely in flight. Detail in `audit/claude-4.md`.

**Q-01 is the row ceiling again, on money.** Pass B recorded it three times —
**F-008** (six nightly jobs silently stopped at 1,000 rows), **F-011** (the fix
for F-008 had the same defect), **F-013** (59 reads asked for more rows than the
server would ever return) — and `tests/no-limit-above-the-row-cap.test.ts` was
written to close it. That guard looks for `.limit(n)` where n exceeds the cap,
so a read with **no `.limit()` at all** is invisible to it. Its own header names
the consequence it could not see: *"wallet balances totalled from part of the
ledger"*.

Six ledger totals were unbounded and all six are now paged: `bucketBalanceCents`
and the second balance derivation in `lib/wallet/server.ts`, the invest bucket
balance, the savings-goal progress total, the invest portfolio, and the holdings
the Money Mentor is told about.

**A count not reported:** the first sweep for this flagged **nine** sites, and
**six were `.insert()` or `.update()` chains** — a write has no row ceiling to
exceed. The guard now requires `.select(`.

**Still open — the race.** `bucketBalanceCents` reads and `debitSpendBucket`
inserts, with nothing between them. `wallet_decide_spend` is the shape to copy:
it locks the bucket `for update`, recomputes the total in SQL, and refuses with
`insufficient_funds`. It cannot be reused as-is because it decides an existing
approval row rather than posting a fresh spend, so this needs its own RPC — and
a migration, behind **F5**. Authoring a money RPC without being able to race it
end to end would be worse than recording it, so it is recorded.

---

# 13. Mobile / Responsive

CI runs a mobile device matrix (iPhone SE / iPhone / Pixel / iPad, Chromium-
emulated) gating every PR on no horizontal overflow and no sub-16px inputs.
An Expo client lives under `mobile/` and shares `design/tokens`.

**Recorded clean by Claude-2:** wide tables are contained — 0 unwrapped `<table>`
outside the guarded directory, and all 26 wide `min-w` elements are already
wrapped. The iOS 16px zoom-on-focus rule is correct and its `!important` is
load-bearing. No heavy library is pulled into a client bundle.

---

# 14. Integrations

Stripe (billing, Connect, Issuing, Treasury), Twilio (SMS, voice, WhatsApp,
transcription), Resend (email), Google / Microsoft / Apple calendar sync,
Alexa + Siri Shortcuts + Home Assistant via the assistant bridge, web push
(VAPID), and the social publishing platforms.

Established: provider webhooks each authenticate themselves — `hasCronAuthorization`,
`validateTwilioSignature` (over the full signed URL, so a `familyId` in the query
string is authenticated by the HMAC), `verifyAlexaRequest` (signature, chain to a
trusted root, 150-second replay window), Stripe's `constructEvent`. The Contact
Center's four inbound webhooks were unreachable until they were added to the
public middleware prefixes — middleware answered the provider's POST with a 307
to the HTML login page, so the route's own authentication never ran. The same
defect had hidden the assistant bridge's two entry points.

**Provider degradation, checked.** `twilioFetch` throws on any non-2xx and on an
unconfigured account, so Twilio fails loud rather than no-op. `hasEncryptionKey()`
guards both sync OAuth callbacks and redirects rather than storing a plaintext
token. `isAIConfigured()` gates the assistant with a 503 and a code. One provider
path is not clean, and it is the one that matters most.

### Guardian scam screening cannot say that it did not run *(High, open)*

`lib/guardian/scam-ai.ts` falls back to deterministic pattern matching down
**three** paths — no API key, an unparseable model reply, a thrown provider error
— and `ScamDetectionResult` (`{ isScam, scamType, confidence, signals,
recommendation }`) has **no field distinguishing them**. A regex verdict and a
model verdict are the same object, `confidence` included.

The consumers are the Guardian inbound SMS and WhatsApp handlers: the surface
that tells a family whether a message reaching their child is a scam. With no key
configured — the state of any deployment that has not set one — every inbound
message is screened by a word list and reported with a number that reads as
analysis. The provider error is swallowed by a bare `catch {}`.

The codebase already names this class, in a comment on
`app/api/behavior/insight/route.ts`: *"the sharpest silence on this list… it
answers 200 with a warm sentence that is indistinguishable from coaching."* The
recognition did not reach this file. **Fix:** add `source: 'ai' | 'patterns'` and
a `degradedReason`, record it on the screening row, and show the family
"screened by pattern matching" rather than a confidence.

### An emergency escalation records parents as notified who were not *(Medium, open)*

`app/api/guardian/escalate/route.ts:112` pushes a member onto `notifiedIds`
**before** attempting anything, and writes the row with
`notified_member_ids: notifiedIds`. `smsSent` itself is correct — set only after
`sendSms` resolves, which is C-02's fix applied properly — but `notifiedIds` is
the same defect one level down and C-02 did not reach it. `pushSent` comes from a
single family-wide `notifications` row (`user_id: null`), so it cannot stand in
for an individual; `smsSent` is one boolean for the whole loop. If the first
parent's SMS succeeds and the second's throws, the row reads `sms_sent: true`
with **both** listed as notified. The bare `catch { /* non-fatal */ }` is the only
send path in the codebase that discards the error without logging — the three
Contact Center callers all `console.error` — so there is no way to reconstruct
who was actually reached.

---

# 15. Testing / QA

**1,191 test files · 13,677 tests**, plus 20 SQL boundary probes and a Playwright
suite including the mobile matrix. CI gates on typecheck, lint, test, build,
migration replay, `ON CONFLICT` inferability against a real catalogue, the RLS
probes, and E2E.

**The finding that matters most in this section is about the tests themselves.**
Nine times this audit found a defect in its own instruments, and four were caught
only by reverting a fix to confirm the guard went red:

| what was wrong | how it was caught |
|---|---|
| A brace-matcher took the first `{` after the parameters as the body — and landed in the **return type**. Three formulations returned 33, then 48, then 52 "unguarded actions"; the compiler returns 12 | the count moved with the regex |
| A sweep required `.from('t')` on the same line as its `await`, so it read clean over two live defects | a reverted fix still passed |
| A request-shape rule anchored at `^` read `typeof body.memberId === 'string' ? …` as *derived* — passing over the exact defect it was written for | a reverted fix left the general case green |
| `expect(route).toContain('accessDeniedResponse')` still matched after the `return` was deleted, because the **import** remained | a reverted fix still passed |
| `failures := failures || 'text'` parses the literal as an **array literal**; the probe failed with a type error instead of naming the boundary | the negative control printed the wrong error |
| A probe granted itself privileges and left them, so the suite's answer depended on what ran before it (**F-015**) | running the suite twice |
| The money-safety probe asserted a concurrency it never tested (**F-019**) | reading what it actually did |
| `tests/route-plan-gate.test.ts` asserts each route's **source text** — that `refuseUnlessEntitled(` was typed, not that it refuses anyone. Three of its twenty rows named hrefs the catalog did not contain, so the gate they assert returned `allowed: true` for every family. Green on all three, and would stay green with the catalog emptied | **Claude-4**, from the behavioural side |
| `tests/wallet-allowance-persistence.test.ts` asserts the **exact text** of the defective allowance update, so the one-line claim predicate that stops a double-pay turns the suite red. The test blocks its own fix | **Claude-4**, by applying the fix to a scratch copy |
| `tests/no-limit-above-the-row-cap.test.ts` checks `.limit(n > cap)` and is structurally blind to a read with **no limit at all** — which is how a wallet balance came to be totalled from one page | Claude-1, from Q-01 |
| **The 20-probe boundary suite was green over S-01 the whole time.** It asserts default-deny — can family B reach family A's rows — and never that a *granted* branch pins the columns it does not intend to grant. An invitee legitimately reaching her own row is the granted branch; what she may then WRITE into it was never asked | **Claude-3**, from the exploit |
| A route-level scan for cron idempotency reported **11 of 24 routes with none** — including `notifications`, the one route **F-014** already proved idempotent. It dedupes inside `generateFamilyNotifications` on `related_id`; the mechanism is not visible at the route's own level | reading the helper, before the number was written down |

---

# 16. Broken / Incomplete Features

**P-01 — two features the product does not sell and the code gives away.**
`/dashboard/vacations` (a 13-tab trip workspace) and `/dashboard/weekend` gated
on hrefs absent from `FEATURE_CATALOG`. `resolveFeatureEntitlement` returns
`{ allowed: true }` for an href it cannot find — deliberately, so routes
predating the catalog keep working — so both were free to every family while the
nav advertised them as Basic+ and the pricing grid listed neither. Found by
**Claude-4**; verified and fixed by Claude-1, with two guards. Details in
`audit/claude-4.md`.

**Claude-4 also found:** `/dashboard/home` + 6 sub-pages are sold as Plus on
`/pricing`, locked at Plus in the sidebar, and opened at Basic by
`requirePlanLevel(1)` — so a Basic family opens a Plus screen where every AI
button answers 403. And the **Experience Scorecard** is in every family's
sidebar at `minLevel: 0` while **nothing anywhere writes `experience_audits`**;
its only reachable state is an empty state reading *"Run
seed_experience_audits_one_family.sql to populate a baseline."*

Established: the AI Assistant (**L-01**) — a permanently pinned sidebar button
that produced a billing upsell for a feature the Free plan sells. `AI_MONTHLY_ALLOWANCE`
sat at "unlimited for everyone" under a comment saying numbers would arrive
"when the plans define them"; the plans had defined them all along (**L-02**).
`endEmergencyAction` writes no audit row at all — recorded, not fixed, because
inventing scope mid-pass is how an audit stops being checkable.

---

# 17. Technical Debt

- **The migration ledger** (**F5**/**F-001**) — the largest single item. It
  blocks all schema delivery, including two authored security fixes.
- **71 migrations sit outside the pinned `0240–0254` release manifest**, so the
  forward-release preflight refuses. Re-pinning is a review decision.
- **Two Google client secrets** exist in a chat transcript and should be rotated.
- **i18n fragment debt** — `lib/i18n/messages/INVARIANT.txt` documents strings
  left identical across languages and names the ones that are technical debt
  rather than decisions.
- **`endEmergencyAction`** writes no audit row.
- **The marketing E2E flake** — `context.newPage()` shares the BrowserContext
  HTTP cache with the `page` fixture, and Playwright's retry reuses it, so the
  assertion measures cache state it does not control. Mechanism recorded; one-line
  fix available.

---

# 18. Recommended Fix Order

1. **Repair the production migration ledger** (**F5**/**F-001**). Everything
   below it in this list is blocked by it, including two live Critical defects.
2. **Apply `0298`, then `0296` and `0297`**, the moment 1 is done. `0298` first:
   **S-01** is a remote privilege escalation to parent of a household and is live
   in production right now. `I-01` and `O-01` are live too.
3. **Decide O-02** (which credentials are family-wide) and implement it. A child
   reading the family's card numbers is not waiting on anything but a decision.
4. **Decide O-03** and implement the `aal2`-or-no-factor helper.
5. **Rotate the two Google client secrets.**
6. **Configure family email** (**F6**) — operator config.
7. **Decide F19** for the remaining 35 AI routes.
8. **Re-pin the forward-release manifest** across the 71 migrations outside it.
9. **SEC-001** — signed URLs for `family-media`.
10. Worker findings, in the severity order this file records them.

---

# 19. Verification Checklist

Run before calling any of this done:

```bash
npx tsc --noEmit                       # clean
npm run lint                           # 0 errors (4 pre-existing warnings)
npx vitest run                         # 1,207 files / 13,825 tests
npm run db:audit:queries               # 491 tables, 78 functions, 141 routes resolve
npm run db:audit:migrations            # no version collisions
bash docs/audit/pg-bootstrap.sh        # 314 migrations, 0 failed
bash docs/audit/run-probes.sh          # 23/23 behavioural probes
npm run build                          # exits 0
npm run test:e2e                       # includes the mobile device matrix
```

And, for anything this audit adds:

- [ ] The fix was **reverted** and the guard confirmed to go red.
- [ ] A database claim was proved against a **real replay**, acting AS the role.
- [ ] A zero-finding pass records **what it checked**, not only that it checked.
- [ ] A count from a pattern match was cross-checked against the parser or the
      catalogue before being written down.
- [ ] No test was skipped, weakened, or quarantined to get green.
- [ ] No migration was applied to production by an agent.

---
---

# Part II — The evidence, pass by pass

Everything below is preserved verbatim. It is what the consolidated sections
above are summarising, and it is where the proof for each finding lives.


Fifteen audits of bubaly.com, kept in one file because one file is the record.

They ran over **different surfaces** and none supersedes another:

| Pass | Surface | Findings | Numbering |
|---|---|---|---|
| **A — Public surface** | marketing pages, SEO and crawler contract, robots/sitemap, headers, titles, i18n payload, plan entitlement, role entitlement, child sign-in | 22 | `F1`–`F22` |
| **B — Data layer** | Supabase reads and writes, RLS and grant boundaries, nightly jobs, the build/data-cache boundary, calendar-day correctness, query plans, money concurrency, and the audit's own probes | 19 | `F-001`–`F-019` |
| **C — Write honesty** | every place a write's result is discarded and something downstream then claims it happened: audit trails, emergency notifications, provider disconnects, the unsubscribe, scheduler counters | 8 | `C-01`–`C-08` |
| **D — Server-action authorization** | every export of every `'use server'` module: whether it establishes who is calling, and whether authenticating a caller actually constrains which family they may write to | 0 | — |
| **E — Read honesty** | the mirror of C: a read whose error is discarded, where something downstream then treats the absence it returns as a fact | 1 | `E-01` |
| **F — Public API routes** | every `route.ts` under a PUBLIC middleware prefix, which reaches the handler with no session: does it authenticate itself, and does it only claim what it can support | 2 | `F-a`, `F-b` |
| **G — RLS completeness** | all 491 tables in a real replayed catalogue: is RLS on, and is any policy a blanket `true` | 0 | — |
| **H — Storage object paths** | the Storage buckets Passes A–G never looked at: which are public, and what protects an object in one | 1 | `H-01` |
| **I — Role boundaries** | the question Pass D left open: not who is calling or which family, but which ROLE — can a child reach what a parent decides | 1 | `I-01` |
| **J — What the AI may do** | the 94-tool registry: does a tool that declares it cannot write actually not write, given that the write gate believes the declaration | 0 | — |
| **K — Tenant scope on the request path** | the step after D: a handler that has authenticated its caller and then takes an id out of the request body — is that id checked against the household the request is about | 2 | `K-01`, `K-02` |
| **L — Offer versus gate** | the published plans in `lib/constants/plans.ts` against the catalog that opens a page and the allowance that meters a request: is a family served what it was sold | 3 | `L-01`–`L-03` |
| **M — State that outlives its request** | the three places a value produced by one request is read by another — module scope on a warm instance, `unstable_cache` keys, and shared HTTP caches — where the boundary has already been evaluated and cannot be evaluated again | 1 | `M-01` |
| **N — What the browser downloads** | every module a client bundle can reach: does any of them read an environment variable that is not `NEXT_PUBLIC_`, given that such a read is inlined as a literal into JavaScript the browser receives | 0 | — |
| **O — Where a secret is stored** | the 27 columns in the schema holding a token, a key or a password: which is encrypted, which is a capability, and which is protected by nothing but family membership | 3 | `O-01`–`O-03` |

**Where they touch, stated plainly.** Passes A and B meet in only two places:

- **The production migration ledger** is the same blocker in both — Pass A's
  **F5** and Pass B's **F-001**. A reaches it from the CI workflow (the access
  token cannot link the project), B from the database (the ledger records only
  `0001–0003`, so the baseline guard halts the push). Both are true, both are
  the same wall, and both need the same credentialed operator.

  Three findings in this file are still open, and only this one is a blocker:
  the ledger (A's **F5** / B's **F-001**) and A's **F6** both need a
  credentialed operator, and A's **F19** is a pricing decision for the owner
  rather than a defect.
- **The sitemap** appears in both, and they are *different defects*. Pass A's
  **F1**/**F3**/**F14** are about which URLs it listed — 435 that answered 404,
  the homepage twice, nine that canonicalise elsewhere — fixed on `main` by
  #526. Pass B's **F-012** is about the file being *stale*: correct URLs, but a
  six-day-old copy of the blog served from Next's build Data Cache, and frozen
  for a year. #526's URL work and F-012's freshness fix are both in the current
  file, and neither pass would have found the other's defect.

**Pass C shares a surface with Pass B and no findings with it.** Both read
Supabase writes; B asked whether the right rows are written and who may write
them, C asked a narrower question — when a write is refused, does anything
notice? Run against `main` after B's fixes, C found eight instances B had not
recorded, and B found none of C's. The one place they nearly met is
`lib/server/push.ts`: C-08's prune counter was ALSO found independently on the
`codex/final-production-audit-20260912` branch, which is the only duplicate
across all three passes and is noted at C-08.

**Pass D found nothing, and that is the finding.** It is recorded in full
because a pass that reports zero has to be at least as well evidenced as one
that reports eight — otherwise "we checked" and "we could not see" read the
same on the page. What it checked is a surface none of A, B or C covered: every
export of a `'use server'` module is an HTTP endpoint with its own action id,
callable without the component that normally calls it. 487 of them exist. The
pass is at Pass D below, together with the false-positive class that nearly got
33 non-defects reported as findings.

**Pass K is Pass D's question one step further along.** D asked whether a
server action knows WHO is calling; K asks, of route handlers, whether a handler
that already knows who is calling checks that an id in the request body belongs
to the household the request is about. The two findings are the same class on
two surfaces and neither is a cross-tenant breach: RLS holds, and it holds
membership-wide on purpose, so what crossed was one household of the caller's
own into another of the caller's own. Pass K also records the sixth
pattern-based miscount in this file — its own guard read clean over the very
defect it was written for, and was caught by reverting the fix.

Everything else is disjoint.

---

# Part 0 — Consolidated view

Maintained by **Claude-1** (coordinator). This part is a roll-up **over** the
detailed passes below, not a replacement for them: every entry points at the
finding that carries the evidence. Nothing below Part 0 is rewritten or removed
when this view is rebuilt.

Worker findings live in `audit/claude-1.md` … `audit/claude-4.md`; `audit/status.md`
is the board. Only Claude-1 edits this file.

**Honesty rule for this part:** a heading with no findings says so. An area no
worker has audited yet is recorded as *not yet audited*, never as "clean" —
*"we checked"* and *"we could not see"* must not read the same on the page.

## Coverage as of this rebuild

| Area | Audited by | Depth |
|---|---|---|
| Public surface, SEO, entitlement, child sign-in | Pass A (F1–F22) | deep |
| Data layer, RLS, grants, cron, query plans, money concurrency | Pass B (F-001–F-020) | deep |
| Architecture / integration seams | Claude-1 | in progress — config contract, cron auth, service-role boundary done |
| Frontend / UI / responsive / accessibility | Claude-2 | **running** |
| Backend / API / auth / security | Claude-3 | **running** |
| QA / flows / performance / edge cases | Claude-4 | **running** |

# Executive Summary

Two deep passes are complete (41 findings, `F1`–`F22` and `F-001`–`F-020`), and
a coordinator pass on architecture and integration is in progress. **Three
findings remain open, and exactly one is a release blocker.**

The blocker is the production migration ledger (A's **F5** / B's **F-001**):
production carries the full schema but a three-row ledger, so every release
touching `supabase/` halts at the baseline guard. It needs a credentialed
operator; agents must not apply it.

The most consequential finding of this pass is **F-020**, because of what it
says about the others: the documented procedure for clearing that blocker
**did not work**, and had never been tested. It cited two guards as proof and
neither could observe the property it claimed. Replayed against production's
actual condition it stopped on the first file. That is now fixed, rehearsed,
and enforced by CI on every pull request.

The pattern worth carrying into the remaining passes: **the failures here are
mostly guards that could not see what they were named for** — a sweep that read
one line at a time (Pass C), a probe that granted itself privileges (F-015), a
concurrency check that never ran two things at once (F-019), an index test that
could not see `UNIQUE` declarations, a replay that ran only against an empty
database (F-020). Verifying that a guard fails when it should is the single
highest-yield check in this repository.

# Critical Issues

| # | Finding | Status |
|---|---|---|
| **F-020** | The documented production-recovery procedure did not work — `db push` stopped on `0004` and left the guard unclearable | **FIXED** + CI gate |

# High Priority

| # | Finding | Status |
|---|---|---|
| **F5 / F-001** | Production migration ledger records only `0001`–`0003`; every schema release is blocked | **BLOCKED — operator** |
| F15 | Family Autopilot ran for every family on the platform | fixed |
| F16 | Paid features enforced only by the sidebar padlock | fixed |
| F18 | Endpoints behind gated pages had no gate | fixed |
| F20 | A child could clear the chore board | fixed |
| F21 | A child could grant themselves a reward | fixed (app) · `0295` awaiting operator |
| F22 | A child's username was matched as a pattern | fixed |
| F1 | The sitemap advertised 435 dead URLs | fixed |
| F9 | The entire i18n catalogue ships on every page | closed as a decision |
| F10 | Seeded records presented as real customer stories | fixed |
| F-003 | `anon` held INSERT/UPDATE/DELETE on all five money tables | fixed · `0290` awaiting operator |
| F-005 | Every blog post not baked in at build time returned 500 | fixed |
| F-006 | Any signed-in user could claim another household's AI jobs | fixed · `0292` awaiting operator |
| F-008 | Six nightly jobs silently stopped at 1,000 rows | fixed |
| F-010 | Notification generation failed outright for affected households | fixed · `0293` awaiting operator |
| F-011 | The fix for F-008 had the same defect it was written to fix | fixed |
| F-012 | The sitemap was six days stale and would have stayed stale for a year | fixed |
| F-013 | 59 reads asked for more rows than the server would ever return | fixed |
| F-014 | Notification dedupe failed on every run | fixed |
| F-017 | A family's "today" was Greenwich's today | fixed |
| F-018 | Nine family-scoped reads were sequential scans | fixed |
| F-019 | The money-safety probe asserted concurrency it never tested | fixed |
| CLAUDE-1 | Nothing enforced migration idempotency, so it could regress silently | fixed (CI gate) |
| CLAUDE-1 | Two branches independently claimed migration version `0295` | fixed (renumbered `0296`) |
| CLAUDE-1 | A merge would have reopened the child-self-approval hole | fixed |
| CLAUDE-1 | `/api/health` reported `ok` while a missing `CRON_SECRET` silently 401'd all 24 scheduled jobs, and a missing `CHILD_LOGIN_SECRET` disabled child sign-in | fixed |
| CLAUDE-1 | Five nightly jobs answered HTTP 200 while counting their own failures; no cron route writes a durable run record | fixed |

# Medium Priority

| # | Finding | Status |
|---|---|---|
| **F6** | Family email is built but not routed | **OPEN — operator config** |
| **F19** | Most AI endpoints run unmetered | **OPEN — pricing decision for the owner** |
| F2 | `robots.txt` omitted 20 authenticated surfaces | fixed |
| F4 | The test named for F1's property could not observe it | fixed |
| F7 | The family email gate existed only on the screen | fixed |
| F11 | Five public pages had no `<h1>` | fixed |
| F17 | The documented tier map disagreed with the enforced one | fixed |
| F-004 | The money-boundary probe could not catch F-003 in CI | fixed |
| F-007 | The additive-migrations guard flagged a revoke as destructive | fixed |
| F-009 | A provider error in the mailer took down the whole cron run | fixed |
| F-015 | A probe granted itself privileges and left them, poisoning the suite | fixed |
| F-016 | The documented crawl workflow drops a live session cookie into the tree | fixed |
| CLAUDE-1 | `/api/contact-center` was public as a prefix, not as exact paths | fixed |
| CLAUDE-1 | A runtime gate fails on this Node and passes on CI's | **OPEN — worker collision** |

# Low Priority

| # | Finding | Status |
|---|---|---|
| F3 | The homepage was published twice | fixed |
| F8 | Page titles doubled the brand | fixed |
| F12 | The 404 page ships no server-rendered markup | closed — recorded |
| F14 | Nine sitemap URLs declare themselves non-canonical | fixed by #526 |
| **F13** | Unknown top-level paths redirect to login | **SUPERSEDED — see below** |
| CLAUDE-1 | The service-role boundary was real but inherited from an incidental `next/headers` import rather than declared | fixed (hardening) |
| CLAUDE-1 | Mobile imported from a folder Metro does not watch; safe only because the import is type-only, and no CI job bundles the app | fixed (guard added) |

# Architecture

Claude-1's scope. Detail in `audit/claude-1.md`.

- **F-020** and its CI gate are the substantive architectural findings of this
  pass: the repository's recovery story depended on a property (migration
  idempotency) that nothing enforced and one guard actively misrepresented.
- **Migration numbering is a cross-branch race.** `schema_migrations` has a
  PRIMARY KEY on `version`, but the guard that protects it
  (`tests/migration-version-safety.test.ts`) can only see one branch at a time.
  Two branches took `0295` simultaneously. The guard did its job *after* the
  merge, which is the only moment it can — worth knowing when several sessions
  author migrations in parallel, as they are now.
- **Merge direction carries security weight.** Resolving a conflict toward the
  branch rather than toward `main` silently reverted a fix in one case
  (rewards) and would have widened an auth boundary in another (contact-center).
  On this repository a merge conflict in an auth or money path deserves the same
  scrutiny as the original change.

# Frontend

**Not yet audited this pass.** Claude-2's scope; `audit/claude-2.md` is empty.
Pass A covered public marketing pages for SEO, headings and titles (F1–F14) but
did not audit component behaviour, state handling, loading/error states, or
responsive layout.

# Backend

Covered in depth by Pass B for the data layer (reads, writes, cron, caching) and
by Pass A for entitlement and authorization on gated endpoints (F16, F18, F19).
**Route-by-route API auditing is Claude-3's scope and has not started.**

# Database

Pass B's core surface, plus Claude-1's F-020 work.

- 308 migrations, replay 0 → 308 clean, and now **re-appliable** onto a populated
  schema (the F-020 gate).
- 19 boundary probes under `docs/audit/`, globbed by `run-probes.sh`, all passing.
- Open: the production ledger (F-001). Five migrations (`0290`, `0292`, `0293`,
  `0295`, and #541's `0296`) are authored, tested, and **not in production**.

# Security/Auth

- Pass A found and closed four privilege-escalation classes (F15, F16, F18, F20,
  F21, F22) — all but F21's migration half are live.
- Pass B closed the money-table grant hole (F-003) and cross-household AI job
  claiming (F-006).
- Claude-1 this pass: prevented a merge from reopening F21's app half, and
  narrowed `/api/contact-center` from a public prefix to five exact paths.
- Claude-1 verified the **service-role boundary** by planting a `'use client'`
  page that imports `createServiceClient`: the build fails, and the key's value
  is absent from every emitted client chunk. It failed *before* the change too
  (via `next/headers`), so the boundary was sound and the fix is hardening — the
  protection is now declared rather than inherited. Recorded that way rather than
  as a closed vulnerability.
- All 24 cron routes enforce `hasCronAuthorization`, which is correctly
  fail-closed (`!!secret &&`, so an unset secret cannot become a matchable
  `Bearer undefined`). Now asserted per-route by a test rather than by grep.
- **A full authorization sweep over all 146 API routes is Claude-3's scope and
  has not started.**

# UX/Accessibility

**Not yet audited this pass.** Claude-2's scope. Pass A touched `<h1>` presence
on five public pages (F11); nothing else here is accessibility coverage.

# Performance

Partial. F9 (i18n payload, closed as a decision), F-018 (nine sequential scans
turned into index scans, measured at 700k rows), F-008/F-011/F-013 (row-ceiling
correctness, which is also a throughput property). **Systematic performance work
— bundle size, render cost, query N+1, cold start — is Claude-4's scope and has
not started.**

# Mobile/Responsive

**Not yet audited this pass.** Claude-2's scope. CI runs a mobile device matrix
(iphone-se / iphone / pixel / ipad) asserting no horizontal overflow and no
sub-16px inputs, so there is a standing gate; no one has audited beyond it.

# Integrations

Claude-1's scope, in progress.

- CI (`ci.yml`): five jobs; the Database job now carries the idempotency gate.
- Supabase: service-role vs anon client split; production ledger blocked (F-001).
- Vercel: deploys on merge to `main`; code fixes reach production, schema does not.
- Provider webhooks: Twilio (contact centre, Guardian), email inbound — each
  authenticates in its own handler; middleware must let them through, which is
  the exact-path narrowing above.
- **Cron observability:** 0 of 24 routes write a durable run record, so the HTTP
  status is the only signal a run failed. Five routes answered 200 while counting
  failures; all five now answer 502, matching the other 19.
- **Config contract:** 79 distinct env vars, no central schema. `/api/health` now
  reports a `FEATURE_ENV` tier as `degraded`/200 — the six secrets whose absence
  silently disables a whole subsystem. Previously invisible; see High Priority.
- **Not yet audited:** push/APNs, calendar feed subscribers, AI provider fallbacks.

# Testing/QA

- 13,641 unit tests across 1,187 files on #541's merged tree; 15,806 on #510's.
- 19 SQL boundary probes; E2E with a mobile device matrix.
- **The recurring defect class is vacuous guards** — see the Executive Summary.
  Claude-4 should treat "revert the fix and confirm the test fails" as the
  standard for any guard it reviews, not an optional extra.
- Open: `tests/stream-cancellation-runtime.test.ts` is Node-patch-sensitive.

# Broken/Incomplete Features

- **Family email** (F6) — built, not routed. Operator config.
- **AI metering** (F19) — most AI endpoints run unmetered. Owner decision.
- **`endEmergencyAction` writes no audit row at all** — recorded in Pass C as a
  missing feature rather than a discarded result.
- Five migrations authored but not applied to production (see Database).

# Technical Debt

- `docs/PENDING_PROD_MIGRATIONS.md` describes a baseline that is 70+ migrations
  behind; the range sentence has been corrected twice by the range simply growing.
- 17 historical duplicate migration versions were renamed; `ci-dedupe-migration-versions.mjs`
  remains as a no-op safety net.
- Four baseline `react-hooks/exhaustive-deps` lint warnings.
- `finalaudit.md` is now large enough that three concurrent sessions conflict in
  it on nearly every merge. Part 0 exists partly to give a stable place to read
  the state without diffing the whole file.

# Recommended Fix Order

1. **Operator: repair the production ledger** (F-001 / F5), following
   `docs/runbooks/LB-016-…md` §4 — now rehearsed end to end. This unblocks
   everything below it.
2. **Operator: apply the five held migrations** — `0290` (money grants),
   `0292` (privileged RPC), `0293` (`related_id` type), `0295` (reward
   redemption), `0296` (social-access delete). Until then F-003, F-006, F-010,
   F21 and I-01 are only half-live.
3. **Operator: route family email** (F6).
4. **Owner: decide AI metering** (F19).
5. Pin or guard the Node-sensitive runtime test.
6. Run the three unstarted worker passes (Claude-2, -3, -4).

# Verification Checklist

Commands, with what a good answer looks like. Everything here was run this pass
unless marked.

- [x] `npx tsc --noEmit` → clean
- [x] `npm run lint` → 0 errors (4 baseline warnings)
- [x] `npx vitest run` → all pass (13,641 on #541's tree)
- [x] `npm run build` → exits 0
- [x] `npm run db:audit:migrations` → no collisions
- [x] `npm run db:audit:queries` → every table, column, function, route resolves
- [x] `bash docs/audit/verify-pg.sh up` → all migrations applied, 0 failed
- [x] `bash docs/audit/rehearse-ledger-repair.sh` → **FAILED: 0**, `0004` recorded
- [x] `bash docs/audit/run-probes.sh` → 19/19
- [x] `node scripts/check-conflict-targets.mjs` → every target inferable
- [x] Gate proven load-bearing: plant an unguarded `create policy`, confirm the
      rehearsal fails **and** the from-scratch replay does not
- [x] Service-role boundary: plant a `'use client'` importer, confirm the build
      fails **and** confirm the control (guard removed) fails too — otherwise you
      are reporting a hole that was never open
- [x] `/api/health` degraded tier proved load-bearing by reverting the branch
- [ ] Frontend / accessibility pass (Claude-2)
- [ ] API authorization sweep over all 146 routes (Claude-3)
- [ ] End-to-end flow + edge-case pass (Claude-4)
- [ ] Production: ledger repaired and five migrations applied (operator)

---

# Pass A — Public surface (F1–F22)

Full audit of bubaly.com: what was checked, what was found, what was fixed, and
what remains — with an owner for every remaining item. Every finding here was
reproduced against the live site or the real code path before being written
down; nothing is inferred from a filename or a comment.

**Audit status: reopened, then complete again.** Twenty-two findings, and the
arithmetic stated exactly rather than approximately:

| | |
|---|---|
| **Fixed in code** | **15** — F2, F4, F7, F8, F10, F11, F15, F16, F17, F18, F20, F22 from this audit; F1, F3, F14 on `main` via #526, whose sitemap implementation superseded mine and which I withdrew in its favour |
| **Written, proven, not yet live** | **1** — F21's durable half. The trigger can only land as a migration, and the migration workflow is F5's blocker; CI replays and probes it on every pull request. Its client-side half — the app no longer deciding status, decider or price — *is* live |
| **Closed without a code change** | **4** — F9 (a decision, with the design and the numbers recorded), F12 (recorded; the fix is not worth its risk), F13 (correct as built — fail-closed routing), F19 (a pricing decision the owner has to make; the numbers are below) |
| **Blocked on credentials** | **2** — F5 (Supabase access token *and* the ledger baseline gate) and F6 (`CONTACT_CENTER_INBOUND_SECRET` + MX records) |

One further observation was **disproved and withdrawn** after re-checking: a
reading that two pages shipped no metadata, which was my own extraction bug.

Nothing is left unexamined or unassigned.

- **Audit opened:** 2026-09-13
- **Audit closed:** 2026-09-13
- **Reopened:** 2026-09-13 — F7 was not a one-off but a *shape*: an entitlement
  stated where a user can see it and absent where it is enforced. Every paid
  feature was re-checked for that shape. It recurred four more times: in a
  nightly cron (F15), across 24 pages and their shared write path (F16), in the
  documentation that describes the tiers (F17), and behind 20 endpoints — 14
  under `/api/ai` and six outside it (F18)
- **Production head at open:** `f9c4d7a1` (#522)
- **Scope:** public marketing surface, authenticated app surface, API boundary,
  SEO/crawler contract, security headers, build and test health, and the
  operator-owned items inherited from earlier work.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Sitemap advertised 435 URLs that answer 404 (29% of it) | High | **Fixed on main by #526**; my implementation withdrawn in its favour |
| F2 | `robots.txt` omitted 20 authenticated surfaces, `/admin` among them | Medium | **Fixed** — and #526 did *not* cover this |
| F3 | Homepage published twice in the sitemap (`…com` and `…com/`) | Low | **Fixed on main by #526** |
| F4 | The test named for F1's property only grepped source | Medium | **Fixed** |
| F5 | Supabase production migration workflow cannot authenticate | High | **Half closed** — the token reads production again (verified 2026-09-13); the ledger baseline gate remains. See *Production, read for real* |
| F6 | Family email routing not configured (`CONTACT_CENTER_INBOUND_SECRET`, MX) | Medium | **Operator — config** |
| F7 | Family email is gated on the screen only — inbound pipeline has no plan check | Medium | **Fixed** — owner chose Family+ |
| F8 | Page titles doubled the brand (`… — Bubaly · Bubaly`) | Low | **Fixed** |
| F9 | Whole 848 KB i18n catalogue serialized into every page | High (perf) | **Closed — decision recorded** |
| F10 | Seeded placeholder records shown as real customer stories on the homepage and /pricing | High | **Fixed** |
| F11 | Five public pages had no `<h1>` at all | Medium | **Fixed** |
| F12 | The 404 page ships no server-rendered markup | Low | **Closed — recorded, not worth the fix** |
| F13 | An unknown top-level path redirects to login instead of 404 | Low | **By design — no change** |
| F14 | Sitemap lists 9 `/blog?category=` URLs whose canonical points at `/blog` | Low | **Fixed on main by #526** |
| F15 | Family Autopilot (Plus) ran nightly for *every* family — both things that run it had no plan check | High | **Fixed** |
| F16 | 24 of 62 paid features were enforced only by the sidebar padlock — the URL was the bypass | High | **Fixed** |
| F17 | The documented route→tier map disagreed with what is enforced on 19 of 55 routes | Medium | **Fixed** |
| F18 | 20 endpoints behind feature-gated pages had no entitlement check — the fetch was the bypass, mostly on the surface that costs money per call | High | **Fixed** |
| F19 | `AI_MONTHLY_ALLOWANCE` is enforced on 4 of the 39 AI routes; 35 run unmetered | Medium | **Partly closed by Pass L** — the assistant is metered (the plans had already decided it); the other 35 remain an owner decision |
| F20 | A child could delete any chore on the family's board, and mint chores for a sibling | High | **Fixed** |
| F21 | A child could self-approve a reward redemption — the third decision forgery, and the only one left unguarded | High | **Half fixed and live; the durable half awaits the F5 operator** |
| F22 | A child's username was matched as a LIKE **pattern**, so every wildcard spelling was a fresh brute-force budget against their PIN | High | **Fixed** |

---

## F1 — The sitemap advertised 435 dead URLs *(High, fixed)*

**What was wrong.** The live sitemap carried 1,508 URLs. 435 of them — 29% —
were of the form `/blog/Seed <uuid>`, and every single one answered **404**.

Sampled 8 seed URLs and 8 real ones; the split was total:

```
404  /blog/Seed b40afaf9-4b6e-43ff-b617-f2e682cca0f8
404  /blog/Seed 0665c96f-735b-4819-906c-38c0ca07a83b     (8/8 seed → 404)
200  /blog/a-simple-system-for-a-calm-approach-to-holiday-hosting
200  /blog/planning-a-road-trip-playlist-a-calm-practical-guide   (8/8 real → 200)
```

They also carried a literal **space** in the path, which is not a valid `<loc>`.

**Root cause.** Two halves of the same system disagreed about what exists.

- `app/sitemap.ts` builds blog entries from `getAllPosts()`, which filters
  through `publicRows` → `isSyntheticBlogSeedSlug`. That filter is correct: run
  against all 435 live slugs it caught **435 of 435**.
- But the sitemap *also* emits `platformEntries` from the `marketing_pages`
  table, which stores a `path` directly and had **no seed filter of any kind**.
  Any published row was emitted verbatim.
- The renderer refuses them: `getPost()` (`lib/blog/posts.ts:196`) begins
  `if (isSyntheticBlogSeedSlug(slug)) return undefined;`, and the page then calls
  `notFound()`.

So `marketing_pages` advertised what `blog_posts` refused to render. The file's
own comment already stated the rule it was breaking: *"a sitemap must never point
at a 404."*

**Fix.** `app/sitemap.ts` gained two exported, unit-tested helpers:

- `isAdvertisablePlatformPath()` — rejects a platform path under `/blog/` whose
  slug the renderer will refuse, applying the *same* predicate the renderer uses,
  so the two cannot diverge again. Also rejects non-rooted paths, which closes an
  absolute-URL row (`https://evil.example/x`) that the old
  `path.startsWith('/')` check already handled but nothing pinned.
- `canonicalSitemapUrl()` — collapses a stored root path of `/` onto the static
  spelling `''` (see F3).

**Verification.** Reverted the fix and re-ran: the two new behavioural cases fail,
and pass again once restored.

## F2 — `robots.txt` omitted 20 authenticated surfaces *(Medium, fixed)*

**What was wrong.** `app/robots.ts` carried the comment *"Authenticated app
surfaces should not be indexed"* above a list of four: `/dashboard`,
`/onboarding`, `/api`, `/auth`.

The authenticated route group holds **22 segments**, and probing production found
**20 gated surfaces absent from that list** — every one answering 307 to `/login`:

```
/account /admin /capture /display /economy /family /feedback /guardian
/home /kids /library /marketplace /missions /money /parent /pay
/referrals /services /settings /wallet
```

`/admin` alone is 80 pages, including the super-admin console.

**Severity, stated honestly.** This is **not** a data leak. Every one of these
redirects to login while signed out, so there is nothing for a crawler to index.
What was wrong is narrower: the stated policy did not match the implementation,
crawl budget was spent discovering them, and — the part that actually matters —
a future route that answers 200 anonymously would have inherited no protection.

**Fix.** `DISALLOWED_APP_PATHS` now names all 24 paths. A new test derives the
segment list from `app/(app)` on disk and fails when a segment is added without a
matching entry, so the list cannot fall behind. A separate case asserts the
public marketing routes are still allowed — `/family-display` is public while
`/family` and `/display` are not, so a naive prefix rule would have taken it down
with them.

**Verification.** Restoring the four-entry list fails 3 of the 6 cases.

## F3 — The homepage was published twice *(Low, fixed)*

The sitemap contained both `https://www.bubaly.com` and `https://www.bubaly.com/`.
`STATIC_ROUTES` spells the root as `''`; a `marketing_pages` row spelled it `/`.
The dedupe keys on the URL **string**, so the two never collapsed. Fixed by
`canonicalSitemapUrl()`; pinned by a test asserting exactly one homepage entry
and, separately, that the whole sitemap contains no duplicate URL at all.

## F4 — The test named for F1's property could not observe it *(Medium, fixed)*

`tests/marketing-sitemap-closed-loop.test.ts` — the file named for this exact
property — never ran the sitemap. All three cases read `app/sitemap.ts` as text
and asserted that certain substrings appeared in it. A grep cannot tell you what
a function emits, which is why a 29%-dead sitemap shipped under a green test.

Demonstrated rather than asserted: against the pre-fix code, **all three
source-grep cases still pass** while the new behavioural ones fail.

The three original cases are kept — they do pin real wiring — and five cases were
added that execute `sitemap()` against a stubbed database and assert on the URLs
it returns. The Supabase stub is a `Proxy`, not a fixed method list, so adding a
`.limit()` or `.range()` to either query cannot silently turn the suite into a
false pass.

## F5 — Production migrations cannot be applied *(High, operator — credentials)*

The **Supabase production migrations** workflow fails on every push:

```
Authorization failed for the access token and project ref pair:
"Your account does not have the necessary privileges to access this endpoint."
```

`Link production project` fails and every apply/verify step after it is
**skipped**, so no migration reaches production.

Two independent blockers, and fixing one alone changes nothing:

1. **The access token lost its privileges.** Not caused by any recent PR — the
   19:16 and 22:24 runs on 2026-09-12 failed identically. It *is* a regression
   though: the 2026-09-07 run got past `link` and read the real production
   catalogue (441 tables, 978 policies). So the token or project ref was revoked,
   rotated, or had its role changed since.
2. **The baseline gate stops it by design.** `hasUnrecordedBaseline` throws while
   `profiles_insert_self` exists without a recorded migration `0004` — exactly
   production's state. `scripts/audit-production-migration-state.mjs` says so
   outright: *"Repairing it is a credentialed operator action."*

Migrations have therefore never been auto-applying; production's schema is
hand-managed per the runbook. **Deliberately not touched** — the repo forbids
agents applying migrations or stamping the ledger.

**Consequence to be aware of:** `docs/PENDING_PROD_MIGRATIONS.md` records the
production ledger as holding only `0001-0003`, and warns that a missing ledger
entry does *not* prove the schema is absent (441 tables exist). So the state of
any given migration in production is genuinely unknown from here.

## F6 — Family email is built but not routed *(Medium, operator — config)*

The code path is complete and merged (#516, #517): addresses are provisioned at
onboarding, the reserved namespace is held back, the inbound webhook is reachable,
and replies go out *as* the family. Two config steps remain, both requiring
credentials this session does not have:

- `CONTACT_CENTER_INBOUND_SECRET` in Vercel
- MX routing for `bubaly.com` → `/api/contact-center/email?key=…`

Current live behaviour is correct for that state: `POST /api/contact-center/email`
answers **401** (verified three times), meaning the route runs and refuses. Before
#516 it answered 307 → `/login`, so the route never executed at all.

## F7 — The family email gate existed only on the screen *(Medium, fixed)*

**Corrected once on re-examination, then resolved.** I first recorded this as "a
Free family is given an address it cannot see", which understated it. Tracing the
whole path found no plan check anywhere except the screen:

| Stage | Gate, before |
|---|---|
| Contact Center screen | `requirePlanLevel(2)` — a bare literal |
| Address provisioning at onboarding | **none** — ran for every tier |
| Inbound webhook | **none** |
| `lib/contact-center/{server,address,provision}.ts` | **none** |

So a **Free** family had a working `@bubaly.com` address that received mail,
filed it, ran the AI concierge over it and auto-replied **as the family**. The
only thing they could not do was open the inbox.

**Resolved: the owner chose Family+.** All three surfaces now read one constant,
`FAMILY_EMAIL_MIN_PLAN_LEVEL` in `lib/constants/plans.ts`. The bare
`requirePlanLevel(2)` is gone — a literal in one file is what let the other two
drift in the first place, so moving the feature between tiers is now a change to
that line rather than a hunt through three files.

Two details that carry the risk:

**Ordering.** Provisioning is gated *before* the webhook, deliberately. Gating
the webhook first would strand mail addressed to an address a family still
holds. With provisioning closed, a family below the line has no address for
anything to arrive at, and the webhook check covers the single case left: an
address issued while the family was Family+ and still resolvable after a
downgrade.

**An unreadable plan is not an unentitled family.** `resolveFamilyPlanLevel`
throws when the subscription read fails, and the webhook catches that separately
and answers **503**, exactly as its other read failures do. Answering 200 would
tell the provider the message was handled — no retry, and no copy of it
anywhere — so a teacher's email would be gone because a database read blipped.
That case has its own test, and reverting the 503 to a 200 fails it.

The same throw sits inside onboarding's provisioning block, which is still
wrapped and still last, so a subscription blip cannot turn a completed signup
into a retry.

Verified non-vacuous three ways: reverting the page to its literal, the webhook's
503 to a 200, and the provisioning gate each fail exactly the case that covers
them.

**One follow-up worth doing when MX is live (F6).** A refused message currently
answers `{ ok: true, skipped: 'plan' }` — acknowledged and logged, matching this
route's existing idiom for a recipient it will not process. A real bounce would
be kinder to the sender, who otherwise learns nothing. Not built here because
nothing is routed to the webhook yet, so there is no live behaviour to preserve
or break.

## F8 — Page titles doubled the brand *(Low, fixed)*

Live on 2026-09-13:

```
<title>Security &amp; Privacy — Bubaly · Bubaly</title>
<title>Contact Bubaly · Bubaly</title>
```

The root layout formats titles with `template: '%s · Bubaly'`, so a title that
already ends in the brand gets it twice. The titles come from the admin SEO store
(`marketing_seo_pages`, read by `getSeoPage`), not from the i18n catalogue —
confirmed: **0** catalogue strings end in "— Bubaly".

That makes correcting the rows the wrong fix: the store is admin-editable free
text, so the next brand-suffixed title reintroduces it. The template owns the
brand, so `titleWithoutDoubledBrand()` now opts a self-branded title out of the
template using Next.js's own `absolute` mechanism.

Only a *trailing* brand counts. "Bubaly — The AI Family Operating System" leads
with the name and still wants the suffix. The regex requires a separator before
the brand, so "Meet the Bubalys" is untouched — pinned by its own case.

`openGraph.title` keeps the plain string: it carries no brand template of its
own and was never doubled.

## F9 — The entire i18n catalogue ships on every page *(High — perf; closed as a decision)*

**Measured, not estimated.** `app/layout.tsx` passes the whole merged catalogue
to `LocaleProvider`, which is a `'use client'` component — so React serializes
all of it into the RSC payload of every page.

| | |
|---|---|
| `/login` HTML | 906,263 bytes raw, **255 KB brotli** |
| of which one RSC script | 870,633 chars — **98%** |
| `en-US.json` on disk | 848.5 KB, 13,449 keys |

Proven rather than inferred from the size match: five strings from sections with
nothing to do with signing in — `wallet`, `kids`, `marketplace`, `guardian`,
`benchmarksPage` — appear **verbatim** in the `/login` HTML, 5 of 5.

### What the public site actually needs

Computed as a transitive import closure from each route group's pages, keeping
client components and everything they import, then collecting every string
literal that is a real catalogue key (not only those inside a `t(...)` call):

| scope | client files | keys | size | share of catalogue |
|---|---|---|---|---|
| marketing | 81 | 324 | 21 KB | **2.6%** |
| auth (`/login`, `/signup`, `/welcome`, `/kid-login`) | 62 | 89 | 5 KB | **0.6%** |
| signed-in app | 1,122 | 8,282 | 442 KB | 55.7% |

So the public marketing site ships **793 KB to deliver 21 KB of value** — the
pages every first-time visitor and every crawler sees.

### The key sets for marketing and auth are provably complete

The danger in pruning is a key a static scan cannot see, which renders as the
raw key (`calendar.addEvent`) in front of a person. For these two groups that
was checked exhaustively rather than sampled:

- **9 dynamic `t(variable)` call sites** across both groups, all of the form
  `t(item.labelKey)`.
- Every one reads from a **static module inside the closure** — `MARKETING_NAV`
  (`lib/constants/navigation`), `VALUE_ROWS`/`VALUE_TIERS`
  (`lib/marketing/value`), the consent categories, and the local `LINKS` map in
  `components/auth/legal-consent.tsx`. None comes from the database or from user
  input.
- Checked directly: **36 of 36** keys reachable through those dynamic sites are
  present in the computed set. **Zero missing.**

### Why it is still not shipped

Two candidate mechanisms, both blocked, and the third disproved outright:

1. **A global client-only subset** (no path detection, one code path, 40%
   saving) is **unsafe, and I disproved it rather than assuming**: **123
   catalogue keys are defined as literals in server components and handed to
   client components as props** — `admins.tab.users`, `supportTickets.tab.open`,
   `runHistory.filterActive`, `familyCfo.subscription`,
   `displaySetup.stepInstallTitle` and 118 more. Every one would render as a raw
   key. The scan could be widened to catch these, but that is whack-a-mole: the
   next unanticipated pattern breaks a page in production.
2. **Scoping by request path** needs the pathname in the root layout, which
   means a header set in `middleware.ts`. That file's own comment documents that
   mishandling its request/response pair causes Supabase to treat a reused
   refresh token as stolen and **revoke the entire session family**. Threading a
   header through its five return points is not verifiable here.
3. **A nested provider** — the cleanest option, and no restructure at all. The
   root layout keeps `LocaleProvider` but is given only the keys every route
   *outside* `app/(app)` can reach; `app/(app)/layout.tsx`, which already
   exists, renders a nested `LocaleProvider` carrying the full catalogue, and
   the inner context simply wins for signed-in pages.

   Measured: the root set is **702 keys — 44 KB of 793 KB (5.5%)**, covering
   marketing, auth, onboarding, library, join, pay, gift, reviews, `/s` and
   offline together. Public pages drop by ~94%; signed-in pages carry the extra
   44 KB, which is the whole cost and is paid behind a login.

   Completeness was checked the same way as before, and **only three keys are
   uncovered**, all in one file:

   ```
   marketingDisplay.mockScheduleTitle  app/(marketing)/family-display/page.tsx
   marketingDisplay.mockAskTitle       app/(marketing)/family-display/page.tsx
   marketingDisplay.mockHandledTitle   app/(marketing)/family-display/page.tsx
   ```

   They are defined in that server page and passed to a client component, so
   the generator must scan non-`(app)` server files for key literals too — the
   same pattern that makes a global subset unsafe, but here it is three keys in
   one file rather than 123 across the admin console.

The common blocker is verification: the entire risk surface of all three is
**client-side hydration**, and a browser cannot run in this environment. Chromium
dies in the proxy relay for every host (see *Method*), so the one thing that
would prove a scoped payload still renders every string cannot be run.

**Recommendation.** Take option 3. Leave the signed-in app on the full catalogue
via the nested provider — it holds 1,122 client files and the 123 server-defined
keys, past what inspection can cover, and it sits behind a login where payload
matters least. Handle the three `marketingDisplay.*` keys, generate the root set,
and add a test that regenerates it and fails on any drift; then the failure mode
reduces to "is a key missing", which is a static property a test can settle
exhaustively without a browser.

That is a deliberate, evidence-backed decision to defer, not an open question:
the measurements, the safety proof, the counterexamples, and the mechanism are
all settled. What remains is a person running it in a browser once.

## F10 — Seeded records presented as real customer stories *(High, fixed)*

Found by crawling the internal links on the live public pages.

The **homepage** and **/pricing** both rendered a section headed **"Family
stories"**, introducing its contents as quotes *"In the family's own words"* —
and the contents were three database seed rows:

```
Seed Case Studies #450   Seed Summary value 450   Seed Result Metric value 450
Seed Case Studies #180   Seed Summary value 180   Seed Result Metric value 180
Seed Case Studies #90    Seed Summary value 90    Seed Result Metric value 90
```

Each linked to a detail page that answered **200** with
`<h1>Seed Case Studies #450</h1>` at `/customers/seed-case_studies-450`.

This is the same class as F1 — seeded rows reaching a public surface — but worse
in kind: F1 published dead links, while this published *invented customers* under
a heading that explicitly claims they are real families.

**Why `is_published` could not have caught it.** The seeder sets `is_published`
true; that flag is exactly what made them public. The rows are identifiable only
by the seeder's slug convention, `seed-<table>-<n>`.

**Fix.** `isSyntheticSeedSlug()` joins `publishedOnly()` in the shared reputation
helpers, so the list readers on both pages exclude them, and
`loadPublishedCaseStudy()` refuses one **before touching the database** so a link
surviving in a cache or a search index cannot still render one. The list and the
detail page agreeing is the whole point — F1 existed precisely because two
readers of the same content did not.

Deliberately narrow: testimonials have no `slug` column at all, so they pass
through untouched, and the guard requires the marker at the *start* of the slug
so a genuine story like `seeds-of-change` or `seed-starting-with-kids` is not
swept up. Both are pinned.

**Still worth doing separately:** the rows remain in the database. The site no
longer renders them, which is the visible outcome, but deleting them is an admin
action (Super Admin → Marketing, or SQL) that this session has no credentials
for.

## F11 — Five public pages had no `<h1>` *(Medium, fixed)*

Verified against production: `/faq`, `/contact`, `/mobile` and `/family-display`
each returned **zero `<h1>` elements**, starting their document outline at `<h2>`.

All four used `SectionHeading` for their **page title**, and that component
hard-coded `h2`. Pages with a hand-rolled hero (`/`, `/pricing`, `/features`)
render exactly one `<h1>` and were unaffected — which is why this only hit the
pages that reused the shared component.

A missing `h1` costs screen-reader users their primary means of orienting on a
page, and removes the strongest on-page relevance signal for search.

**Fix.** `SectionHeading` takes an optional `as="h1"`, defaulting to `h2` so
every existing section heading is unchanged. The five page titles set it. The
class list is identical at either level and a test asserts that — this is a
document-outline fix and those pages must look exactly as they did.

**The fifth page.** The structural test caught `/resources/benchmarks`, which
live probing could never have found: it 404s while its publication flag is off.
Same defect, same fix.

**A vacuous test, caught and fixed.** The first version of the sweep passed even
with the fix reverted. The JSDoc I had just written on `SectionHeading` contains
the literal `as="h1"` as an instruction to callers, so every page importing that
module matched on the comment. Found by reverting one page and watching the test
stay green — precisely the failure F4 is about. The sweep now strips comments
before scanning, and reverting `/faq` correctly fails and names it.

## F12 — The 404 page ships no server-rendered markup *(Low, closed — recorded)*

A dead URL under a public prefix correctly answers **404**, but the response body
contains no rendered content — only an unresolved React Suspense placeholder:

```html
<body><div hidden=""><!--$?--><template id="B:0"></template><!--/$--></div>
```

69 characters of markup, against 6,133 on the homepage. The words "Page not
found" appear exactly once in the response, escaped inside the JSON flight
payload — never as HTML. Confirmed on two separate dead URLs.

So the 404 page is blank until JavaScript loads and hydrates it.

**Scope checked, and it is narrow.** All 17 public pages were measured and every
one ships real markup (6 KB–92 KB). This is specific to the not-found path, not
systemic.

**Severity, honestly.** Visitors with JavaScript — effectively all of them — see
the correct page after hydration, and the HTTP status is already correct, so the
SEO impact is minimal. The cost is a blank screen on a slow connection and
nothing at all without JS. Recorded with evidence rather than fixed, because the
fix touches how `not-found.tsx` resolves translations and the payoff is small;
worth doing deliberately rather than as a drive-by.

## F13 — Unknown top-level paths redirect to login *(Superseded — main #544 fixed it a third way)*

`/nope` answers **307 → `/login?redirect=%2Fnope`** rather than 404. Paths under
a known public prefix behave correctly: `/blog/nope`, `/features/nope` and
`/customers/nope` all return 404.

The cause is the middleware's allowlist: a path that is not public is treated as
a protected app route. **That is the correct posture** — failing closed is what
keeps an unlisted route from leaking, and the entire `/api/contact-center` and
assistant-bridge history on this codebase is about routes that were *missing*
from an allowlist. The cost is that a typo'd marketing URL lands on a login page
and search engines see a soft 404 instead of a hard one.

Deliberately **not changed** at the time: trading fail-closed routing for a nicer
typo experience is a bad exchange, and weakening auth routing is off-limits.
Recorded so the trade-off is known rather than rediscovered.

> **Superseded on 2026-09-13 by main #544** — and the reasoning above is why this
> note matters rather than a quiet edit. This entry told a future reader the
> change was off-limits. It is not, because #544 did not take either side of the
> trade-off as stated. It added an explicit **`PROTECTED`** list alongside
> `PUBLIC` in `lib/auth/route-access.ts`, so a path is now one of three things
> rather than two:
>
>     isPublic    -> serve it
>     isProtected -> require a session      (fail-closed, unchanged)
>     neither     -> fall through to the router, which 404s
>
> An unlisted app route is still protected, because app routes live under
> prefixes that are in `PROTECTED`. `/nope` is under neither list, so it is a
> path with no route and answers 404. Fail-closed routing is preserved exactly;
> the soft 404 is gone.
>
> The general lesson is worth more than the fix: a finding closed as "an
> unavoidable trade-off" is a finding that stopped looking for a third option.
> **Do not revert #544 on the strength of the paragraph above it.**

---

## F14 — Nine sitemap URLs declare themselves non-canonical *(Low, fixed on main by #526)*

**Not my find.** A parallel audit session raised it on
[#526](https://github.com/NewWorldVenture/Bubaly/pull/526); I verified it
independently before recording it:

```
GET /blog?category=Parenting          -> 200
     <link rel="canonical" href="https://www.bubaly.com/blog"/>
```

`app/sitemap.ts` emits one entry per blog category — 9 of them. Each answers 200
but names `/blog` as its canonical, so the sitemap asks Google to index URLs the
pages themselves declare are not the canonical version. A sitemap entry and a
canonical pointing elsewhere are a contradiction; the entries are dropped from
the index and the crawl budget is spent anyway.

Same family as F1 — the sitemap claiming something the site does not support —
and it is in this audit's scope. I missed it: I checked whether sitemap URLs
**resolved**, which they do, and never checked whether they were **indexable**.
Worth naming as a gap in my method, not just a gap in the sitemap.

**Deliberately not fixed here.** #526 rewrites the same file with a broader
`canonicalUrl()` — trailing-slash normalisation, per-segment percent-encoding,
and refusal of query strings, fragments, non-relative paths and anything
`robots.txt` disallows, reading that disallow list from `robots.ts` so the two
cannot drift. That is a better fix than a second patch of mine would be, and two
PRs rewriting `app/sitemap.ts` in different directions helps nobody.

### Overlap with #526, stated plainly

#526 independently found and fixed F1 (the 435 dead seed URLs) and F3 (the
duplicate homepage). Its approach is broader on URL hygiene; mine has one
property worth preserving in whichever lands second — `isAdvertisablePlatformPath()`
applies **the same predicate the renderer uses** (`isSyntheticBlogSeedSlug`), so
the sitemap and the blog page cannot drift apart again, which is the root cause
F1 actually had.

The rest of this branch — robots coverage, the seeded customer stories, the
missing `<h1>`s, the brand-doubled titles — does not overlap #526 at all.

---

## F15 — Family Autopilot ran for every family on the platform *(High, fixed)*

F7 closed a gate that existed on the Contact Center screen and nowhere in the
pipeline behind it. That is a shape, not an incident, so every paid feature was
re-checked for it. Autopilot had the same one, and worse consequences.

`/dashboard/autopilot` is `requireFeature`-gated, and `resolveAutopilotSuggestionAction`
re-checks the tier before it writes. Both are correct. But the two things that
actually *run* Autopilot checked nothing:

| Entry point | Guard it had |
|---|---|
| `GET /api/cron/autopilot-scan` | none — `from('families').select('id').limit(5000)`, then scan each |
| `POST /api/autopilot/scan` | `requireUserContext()` — a session, not an entitlement |

So the nightly cron ran the full Plus feature for every family on the platform.
`runAutopilotScan` is not a read: for a family that never bought it, it

- wrote behavioural traits to `family_digital_twin_profiles`,
- auto-created `reminders` rows and `grocery_items` (the "auto-executed" path),
- inserted `autopilot_suggestions`, and
- sent push/email through the notifications service.

The gating made that worse rather than safer. A Free family got reminders and
shopping-list entries they did not create, and notifications about them — then
could not open `/dashboard/autopilot` to see where any of it came from, because
the page redirects them to billing, and could not dismiss a suggestion, because
the action returns `accessDenied`. The only surface that explained the writes was
the one they were refused.

### The fix — one resolver, not a fourth copy

`requireFeature` could not be reused here: it resolves the caller's session and
then throws a `redirect`, which a cron has neither of. That is exactly why every
pipeline that *did* check had hand-rolled its own copy of "tier → level →
compare" — `lib/server/ai-access.ts`, `lib/services/trips/confirmation-import.ts`
and `lib/services/onboarding-calendar/access.ts` each hold a different one — and
why the two above simply skipped it.

So the resolution moved into `lib/server/feature-entitlement.ts`, and
`requireFeature` became a wrapper over it. The page guard and the pipelines now
compute entitlement with the same function; they cannot drift again without
someone deleting the call.

Both entry points now refuse, and the interesting part is what they do when the
plan cannot be *read*. `resolveFamilyPlanLevel` throws on a failed subscription
read, and an unreadable plan is not an unentitled family — the F7 lesson,
applied again:

- the cron counts it as a **failure** for that family (502 overall), never a
  skip, so a subscription blip cannot silently stop Autopilot for a paying
  family while the run reports success;
- the route answers **503**, not 403, so a paying family is never told they need
  to upgrade to something they already bought.

### Proof, not a green test

`tests/autopilot-plan-gate.test.ts` drives both real routes against an in-memory
database holding one Free and one Plus household, and asserts which family ids
`runAutopilotScan` was handed. Four mutations were applied to confirm the
assertions bite — the cron gate, the route gate, "unreadable plan → skip", and
"unreadable plan → 403" — and each failed the suite before being reverted. The
one source-reading case in the file is the one claim that *is* about source:
that `requireFeature` no longer holds its own copy of the comparison.

## F16 — Paid features enforced only by the sidebar padlock *(High, fixed)*

The sidebar already refuses every paid feature to a family below its tier.
`featureAccessByTier` returns `'locked'`, and `NavEntry` then renders a padlock
and an upgrade prompt **instead of a link** — never a dead link, deliberately.
So the product tells a Free family, in the UI, that they do not have these.

**24 of the 62 paid features did not check on the server.** Each page called
`requireUserContext()` and rendered. Typing the URL was the entire bypass.

| Tier | Pages |
|---|---|
| Plus | `/dashboard/family-automation`, `family-cfo`, `family-coo`, `family-digital-twin`, `family-emergency`, `family-health`, `family-operations`, `family-school`, `family-stress`, `/missions` |
| Basic | `/dashboard/activity`, `announcements`, `assistant`, `concierge`, `concierge/runs`, `insurance`, `kitchen`, `memories`, `migrate`, `pets`, `readiness`, `social`, `trip-intel`, `/referrals` |

Part of this was already known and written down — `docs/AI_FAMILY_OS_IMPLEMENTATION_MAP.md`
records "Tier/allowance enforcement for AI | **missing** | … no `requireFeature`
on either page" — but only for the two AI pages, and it had not been connected
to the other 22.

### It was not only reading

`lib/family/actions.ts` is the generic write path for eleven family tables. It
checked the signed-in user and, for sensitive tables, the member's role. It did
not check the plan. So a Free family could **write** Plus-feature data:
automation rules, emergency plans and contacts, stress signals, and behavioural
profiles in `family_digital_twin_profiles`.

Nine of those eleven tables now resolve to a feature and are gated through the
same `resolveFeatureEntitlement` the pages use. Two are not, and the omission is
deliberate and commented rather than silent: `family_ai_recommendations` and
`family_milestones` are each rendered by several pages that are not catalog
features at all, so there is no one feature a write to them belongs to, and
guessing would gate a surface nobody decided to gate.

Three further choices worth stating, because each could reasonably have gone the
other way:

- **Delete is not gated.** A family that drops a tier keeps the right to remove
  rows they made. Access is gated; ownership is not.
- **`setRecommendationStatus` and `resolveAutomationRun` are not gated.** Both
  resolve an item that already exists rather than create new use of the feature,
  and gating them would strand a downgraded family's pending items.
- **Super-admins bypass**, exactly as they do on the page, so preview still
  works.

### Two tiers that were themselves the mistake — now free

`/dashboard/migrate` ("Switch to Bubaly", the competitor-import wizard) and
`/referrals` (refer-a-friend) were both Basic in the catalog. The sidebar had
always shown them locked to a Free family, but nothing enforced it until the fix
above — so the day enforcement arrived, a Free family lost the wizard that brings
their data across from a competitor and the page that refers a friend.

Raised here as "the fix is the tier, not the gate", and the owner made that call
on 2026-09-13. **Both are `free` now.** An on-ramp you have to buy before you can
use it is not an on-ramp, and a referral programme switched off for everyone who
has not paid refers nobody.

The `requireFeature` calls stay on both pages. At the free tier they pass
everyone, and if either tier ever moves back, enforcement follows without anyone
having to remember those two pages exist. That is the whole point of the fix: the
tier is now the only thing that decides, and it is one line.

### Proof

`tests/paid-features-enforced-server-side.test.ts`. The sweep is derived from
the catalog rather than a list, so a new paid feature added without a guard
fails it. Comments are stripped before matching — a JSDoc mentioning the guard
is how the F11 sweep went vacuous once already — and one case proves the
detector itself by pointing it at a page that genuinely has no guard. The write
path is exercised for real against an in-memory database: a Free family is
refused and nothing is written, a Plus family's identical write lands, and an
unreadable plan produces a *different* message, because telling a paying family
to buy what they already own is the failure mode that matters.

Three mutations were applied and each failed the suite before being reverted.

## F17 — The documented tier map disagreed with the enforced one *(Medium, fixed)*

`ROUTE_PLAN_LEVEL` in `lib/constants/plans.ts` maps 58 routes to a minimum plan
level. Nothing reads it — `docs/AGENT_HANDOFF.md` says so outright
("`ROUTE_PLAN_LEVEL` is documentation only"). It was maintained by hand.

Of the 55 routes it shares with the enforced catalog, **19 disagreed** — a third
of the table. Not marginally, either: it documented `/dashboard/rewards`,
`/dashboard/sports`, `/dashboard/home` and `/dashboard/briefing` as *cheaper*
than they are enforced, and `/dashboard/chores`, `/dashboard/meals`,
`/dashboard/school` and six others as *dearer*.

That matters because three other documents cite it as fact —
`MARKET_DOMINATION_AUDIT.md` twice, `STRATEGY_WORK_QUEUE.md` once, and
`AI_FAMILY_OS_IMPLEMENTATION_MAP.md` builds an argument on
`ROUTE_PLAN_LEVEL['/dashboard/assistant']=0`. A stale table nothing executes is
still read by people, and by whoever writes the next audit.

The catalog routes are now **derived** from `FEATURE_CATALOG`, so they cannot
drift again. Only the five routes that are not catalog features at all
(`/dashboard`, `/dashboard/settings`, `/dashboard/billing`, `/dashboard/trust`,
`/dashboard/relationship`) are still stated by hand, because the catalog has
nothing to say about them. A test pins that the derivation stays derived: adding
a hand-written entry that contradicts the catalog fails it.

## F18 — Endpoints behind gated pages had no gate *(High, fixed)*

Thirty-nine routes live under `/api/ai`. Every one of them calls a model, which
is the only surface in this application that costs money per request. Of those:

| Guard | Count |
|---|---|
| `assertAIAccess` — feature, tier **and** the monthly allowance | 4 |
| `authenticateAI` — identity only; it resolves a caller and stops there | 5 |
| a hand-rolled `resolveFamilyPlanLevel` comparison | 4 |
| a session and a per-minute rate limit, and nothing else | **26** |

The second row is worth reading twice: `authenticateAI` sounds like the gate and
is not one. Two of the five routes that rely on it — `ai/voice/speak` and
`ai/voice/transcribe` — are model calls.

Fourteen of those 26 sit directly behind a page that `requireFeature` refuses.
`/api/ai/resolve-conflict` serves `/dashboard/conflicts` (Plus).
`/api/ai/briefing` serves `/dashboard/briefing` (Plus). The page refused; the
endpoint behind it did not, and a `fetch` is not harder to send than a URL is to
type.

Each mapping was established by finding the component that calls the endpoint
and the page that hosts it, not by matching names:

| Endpoint | Called from | Page it serves |
|---|---|---|
| `ai/resolve-conflict` | `family/conflict-resolver` | `/dashboard/conflicts` (Plus) |
| `ai/briefing` | `lib/briefing/cache-isolation` | `/dashboard/briefing` (Plus) |
| `ai/assist`, `ai/import` | `modules/inbox-module`, `modules/concierge-module` | `/dashboard/inbox`, `/dashboard/concierge` |
| `ai/chef` | `modules/kitchen-dashboard` | `/dashboard/kitchen` |
| `ai/flyer` | `modules/scan-module` | `/dashboard/scan` |
| `ai/health/coach` | `modules/health-module` | `/dashboard/health` |
| `ai/home/diagnose`, `find-pro`, `forecast` | the three `home/*` clients | `/dashboard/home` |
| `ai/home/utility-savings` | `modules/utilities-module` | `/dashboard/utilities` |
| `ai/savings` | `modules/savings-coach-card` → `subscriptions-module` | `/dashboard/subscriptions` |
| `ai/trip` | `modules/trip-intel-module` | `/dashboard/trip-intel` |
| `ai/auto/accident` | `auto/accident-client` | `/dashboard/auto` |

The same sweep run outside `/api/ai` found six more, most of which also call a
model:

| Endpoint | Called from | Page it serves |
|---|---|---|
| `behavior/insight` | `modules/behavior-module` | `/dashboard/behavior` |
| `weekend/discover` | `modules/weekend-module` | `/dashboard/weekend` |
| `vacations/ai`, `vacations/weather` | `vacations/trip-concierge`, `trip-weather` | `/dashboard/vacations` |
| `social/ai` | `social/studio-form` | `/dashboard/social` |
| `notifications/generate` | `modules/notifications-module` | `/dashboard/notifications` |

All twenty now refuse through `refuseUnlessEntitled`, which resolves through
the same function the page does. The refusal happens **before the rate limiter
and before the provider call**, which the tests pin explicitly: a gate placed
after the model would refuse the family and still have paid for the answer.
`ai/assist` is served by two modules, so it accepts either — requiring both
would refuse someone the page in front of them allows.

Two more were checked and deliberately left alone. `/api/paperwork/capture` and
`/api/paperwork/link` are reached from `/capture`, which is not a catalog
feature, so there is no one feature a call to them belongs to — the same
reasoning that left `family_milestones` open in F16. `/api/assistant` and
`/api/assistant/alexa` are unauthenticated **by design** and correctly so: the
token is the authorization (like the ICS feeds), they rate-limit by IP *before*
the token lookup so the endpoint cannot be used to guess tokens at speed, and
the Alexa one verifies Amazon's signature and answers a bare 403 when it cannot
be proven — with no speech, so a prober learns nothing.

One near-miss worth recording. `components/marketing/switching-band.tsx` appears
in a grep for `/api/ai/flyer`, which looked for a moment like a public marketing
component calling an authenticated AI endpoint. It is a comment citing the route
as evidence that a claim in the copy ships. Checked before it was written down.

`/api/ai/gift` is genuinely public and is *correct*: documented as such,
IP-rate-limited both in memory and durably, scoped to one already-secret gift
token, and read-only. It is the model the other routes should have followed.

## F19 — Most AI endpoints run unmetered *(Medium, open — a pricing decision)*

F18 fixed *entitlement*. It did not fix *metering*, and the two are different
questions.

`lib/server/ai-access.ts` defines `AI_MONTHLY_ALLOWANCE` per plan level and
enforces it — for the **4** routes that call `assertAIAccess`. The other 35 have
at most a per-minute rate limit, which bounds a burst, not a month. A family on any
tier can call `/api/ai/chef`, `/api/ai/meals/plan`, `/api/ai/journal`,
`/api/ai/notes` and twenty more as often as they like, all month, and each call
is a paid model request.

This is **not** written up as a defect to fix, because the fix is a pricing
decision and both directions cost something:

- **Meter them all against the existing allowance.** Simple, consistent, and it
  changes what paying customers can do today — a Basic family that uses the meal
  planner daily would start hitting a wall it has never hit.
- **Meter only the expensive ones.** Truer to cost, and needs per-route budgets
  nobody has set.
- **Leave them unmetered** and accept the exposure, which is what happens now,
  but deliberately rather than by omission.

What is *not* a live risk: every one of these routes requires a session, a
family, and now — where the page is gated — an entitlement. The exposure is a
signed-in family's own usage, not the open internet.

Twelve of the 26 unguarded routes were left ungated by F18 on purpose: they
serve features that are Free (`ai/journal`, `ai/habits`, `ai/meals/plan`,
`ai/notes`, `ai/schedule`, `ai/relationship`, `ai/pantry-chef`), or they fan out
across a dozen modules and would need a per-`kind` mapping (`ai/insights`), or
they are the assistant itself (`ai`, `ai/chat`). For those, metering — not
entitlement — is the right instrument, which is exactly the decision above.

The numbers an owner needs are here; the choice is theirs.

## F20 — A child could clear the chore board *(High, fixed)*

The plan sweeps asked who may use a feature. This one asks who may use it
*within* a family, and it is the same shape with a different subject.

The chores board has four manager-only writes. Two were defended and two were
manager-only on the screen alone:

| Board action | UI | Server |
|---|---|---|
| Approve a submission | `manager &&` | ✅ trigger `chore_assignment_decision_guard` (0223) |
| Pay a chore reward | `manager &&` | ✅ `isManager` in `payChoreRewardAction` + manager-only wallet RLS (0217) |
| **Add a chore** | `manager &&` | ❌ nothing |
| **Delete an assignment** | `manager &&` | ❌ nothing |

Nothing behind the screen agreed. The actions took any signed-in member,
`createChore` and `deleteChoreAssignment` scope by family and not by role, and
the RLS on `chore_assignments` is `is_family_member` for **all four**
operations (migration 0004 applies one membership-only policy set across 21
family tables). So a child could delete any chore on the board — including one
assigned to them — and mint chores assigned to a sibling, with points.

### Why this is the gap and not the design

The team had already reasoned about exactly this class. Migration 0223 closed
`update chore_assignments set status='approved'` by a child, and its own header
calls it "an accountability/integrity forgery, not a money-minting one", the
sibling of the `chore_submissions` forge closed in 0222.

Deleting the assignment reaches the same end from the other direction. A child
who cannot forge *completion* can simply remove the row: the chore is gone from
the board, and so is the record that it was ever owed. Closing one and not the
other is not a decision anyone made — 0223 enumerates the statuses a member may
drive and never mentions the delete.

### The fix, and where it sits

`isManager` in the two server actions, refusing before the service is reached.

The action layer rather than the service, for two reasons. It is where the
screen's claim lives; and it is where `payChoreRewardAction` — the board's third
manager-only write, and the one that moves money — already puts it, so the
board's writes now check in one consistent place. The service stays reachable by
the assistant's path, which the Trust Engine governs separately and which this
audit did not examine.

**Defence in depth is the right follow-up and is deliberately not in this
change.** The repo's own pattern (0222, 0223) is a database trigger alongside the
code check, and a `can_manage_family()` guard on delete would be its natural
sibling. But the migration ledger is the subject of F5: the baseline is
unrepaired and the workflow cannot authenticate, so adding a migration that
cannot be applied would enlarge a backlog that is already blocked. It belongs
with the operator who fixes F5, and is recorded here rather than half-done.

### The open half: who may advance a status

`ChoreRow` carried the comment *"Assignee can advance their own chore's status;
managers can act on any."* Neither half was true. The control renders for every
member regardless of assignee, and `setChoreProgress` scopes by family only — so
any member can advance any chore, including submitting a sibling's chore they
did not do.

That comment is now corrected to say what the code does, rather than the rule
being implemented quietly. Enforcing "assignee, or a manager" is a product
decision: it is a real restriction on a board families may drive
collaboratively, and unlike the delete there is no screen-level claim being
violated — the UI and the server already agree. It needs an owner's call, not a
patch.

### Three candidates checked and cleared

Run against every component that gates UI on `isManager`, the same sweep also
looked at:

- `setLocationSharing` — no role check, and **correct**: it writes only the
  caller's own `member_locations` row. A member turning their own sharing off is
  the point.
- `saveAISettingsAction` — no role check in the action, and **correct**:
  `updateAISettings` refuses a non-manager in the service, one layer down.
- `savePlace` / `deletePlace` / `setGeofenceEnabled` — already `isManager`-gated.

Recording what the sweep cleared matters as much as what it caught: three of the
four plausible instances were already right.

## F21 — A child could grant themselves a reward *(High; half fixed and live, half awaiting the operator)*

F20 found one gap the team's own `0222`/`0223` work had left. Looking for the
rest of that family found the other, and it is the more direct of the two.

`reward_redemptions` shipped in `0028` with a single policy —
`FOR ALL … USING is_family_member(family_id) WITH CHECK is_family_member(family_id)`
— and no trigger. Both of its write paths were **direct browser writes** that
chose `status`, `decided_by` *and* `cost_points` client-side:

| Path | Write |
|---|---|
| `chores-module.tsx` → `redeem()` | insert; `status` = `'approved'` when the client believed the member was a manager |
| `rewards-module.tsx` → `requestReward()` | insert; the same choice |
| `rewards-module.tsx` → `decide()` | update; `status` straight from the caller |

**The choice was the client's.** A child could insert a redemption already
marked `approved` with `decided_by` pointing at themselves, or approve one
sitting in the queue — and set `cost_points` to whatever they liked in the same
request.

This is the **third** of three decision surfaces in the chores and rewards
economy. `0222` closed the submission forge, `0223` the assignment-status forge,
and this was the only one left open. Like them it **mints no money**: the points
economy is separate from the wallet, which is manager-only under `0217`. It is
an accountability forgery, in the exact words `0223`'s own header uses.

### The half that ships without the migration

Both write paths go through `app/(app)/dashboard/rewards/actions.ts`. The role is
resolved from the session rather than asserted by the caller, `decided_by` is the
session's own member, and `reward_title` and `cost_points` are read from the
reward instead of accepted from the request.

That last one is the quieter half of the finding: `cost_points` is a deliberate
snapshot so history survives the reward being edited (`0028`), and a snapshot the
spender supplies is not a snapshot — a child could ask for an expensive reward at
a cost of zero points, and the balance the board renders would never know.

Reads stay in the client. Both screens subscribe to the table through
`useRealtimeQuery`, which is the point of a live board; it is the writes that had
to move, and the test forbids those specifically rather than any mention of the
table.

This does **not** close the finding. `reward_redemptions` is reachable from
PostgREST whatever these actions do, so the forgery is now a hand-crafted API
call rather than a browser console. A smaller door, not a shut one.

### The half that shuts it, and cannot be applied

Migration `0295` is the sibling of `0222` and `0223`:

- **Guarded**: `approved`, `rejected`, `fulfilled` — the three a parent decides.
- **Left to the member**: `requested` and `pending` (asking), and `cancelled`
  (withdrawing your own ask, which needs no parent). A guard that blocked those
  would break the queue it exists to protect.
- **Allowed through**: the service role, an unauthenticated migration or seed,
  and `can_manage_family()`.

No legitimate flow breaks: the only code that sets a guarded status is a
manager's own click in the two modules above, and the service role.

### Proven before it was written down

`docs/audit/reward-redemption-decision-check.sql` runs as a real `authenticated`
session under RLS and asserts **both** directions — child insert-as-approved,
approve-from-queue and mark-fulfilled all refused; child request and child cancel
allowed; parent approve and fulfil allowed.

It was run against a local PostgreSQL 16 with the trigger present (six assertions
pass) and with it dropped, where it fails on the first case: *"a child inserted
an APPROVED reward redemption"*. CI replays it against the fully bootstrapped
schema on every pull request — `run-probes.sh` globs rather than lists, so it
runs without anyone registering it.

### What is not done

**The migration is not applied, and cannot be.** That is F5: the workflow cannot
authenticate and the ledger baseline is unrepaired, in that order. Until an
operator clears both, the direct-to-PostgREST forgery is live in production and
the guard sits in the repository, replayed and probed by CI, waiting.
`docs/PENDING_PROD_MIGRATIONS.md` records it alongside the others, so it is
visible rather than inferred from the absence of a row.

This is the one finding in this audit whose fix I could write but not land.

## F22 — A child's username was matched as a pattern *(High, fixed)*

`lib/auth/child-throttle.ts` states the stakes in its own header: *"a 4-digit
PIN is only 10,000 combinations and kid usernames are guessable (suggested from
the display name), so unthrottled sign-in is a real account-takeover risk."* The
throttle it implements is the control that makes a 4-digit PIN survivable — five
failures per username per fifteen minutes, then an escalating lockout.

Sign-in resolved the account with `.ilike('username', username)`. In SQL LIKE,
**`_` matches any single character**. `USERNAME_RE` anchors both ends to
`[a-z0-9]`, so `%` and an edge underscore are refused — but it permits `_` in
between:

| Typed | Valid username? | `ILIKE` matches |
|---|---|---|
| `a%ice` | no | — |
| `alic_` | no | — |
| `a_ice` | **yes** | `alice` |
| `a___e` | **yes** | `alice` |

Verified against PostgreSQL 16 rather than reasoned about: `where username ilike
'a_ice'` returns `alice`; `where username = 'a_ice'` returns nothing.

### Why that broke the throttle rather than the password

On its own a wildcard match is not a bypass — the attacker still needs the PIN,
and sign-in proceeds as `row.username`, the real account. What it broke is the
budget.

The throttle is keyed on the username **as typed** (`child_login_throttle.username`),
while the lookup treated that same string as a **pattern**. So every wildcard
spelling was a different throttle key pointing at one real account:

```
alice → a_ice  al_ce  ali_e  a__ce  a_i_e  al__e  a___e      (7 spellings)
```

Eight keys × five failures = **40 attempts per fifteen minutes instead of 5**. An
eight-character username yields 63 spellings — **320 per window**. The per-IP
limiter (30/min) is then the only remaining bound, and it is per-IP, not
per-account, so it does not constrain an attacker with addresses to spend.

### The fix

`eq`, not an escape. Both sides are already lowercased by `normalizeUsername` —
the create path normalizes before inserting and sign-in normalizes before looking
up — so the case-insensitive match was buying nothing and costing the throttle
its purpose. `eq` removes the metacharacter class rather than escaping it.

The same change is applied to the "is this username free?" check in
`child-login-actions.ts`, which had the same `ilike` and was therefore answering
about a *different* login than the one being created. Over-strict rather than
under-strict, but wrong either way.

**This is consistent with the repository, not a new idea in it.** `escapeLike`
and inline `%_` escaping already appear in a dozen service queries — home, trips,
inventory, groceries, meals, finances. The two lookups that did not escape were
the two on the authentication path.

### What was left alone

Roughly a dozen `ilike('…', '%term%')` search queries do not escape. In a search
box an unescaped `_` makes the match slightly fuzzier and nothing more — there is
no throttle keyed on the term and no credential behind it. Widening this change
to cover them would have buried a security fix inside a refactor.

## Reconciliation with #526 — how the sitemap findings actually landed

#526 merged to `main` as `61ad4bb0` while this branch was open, and it rewrote
both files this audit touched. The overlap was predicted and written down before
it happened; this records the outcome.

**F1 and F3: #526's implementation won, and mine was withdrawn.** Its rule is
stronger than the one I shipped. I filtered the registry's `/blog` rows through
the same predicate the renderer uses; #526 observes that the `marketing_pages`
registry is a **path overlay** — a row decorates a path, it is not a claim that
the path resolves — and so lets a registry row mint a URL only for a prefix the
registry itself renders. `/blog` is served from `blog_posts`, so no registry row
can publish a `/blog` URL at all.

That **subsumes** the seed filter rather than duplicating it: if none can
publish a blog URL, none can publish a wrong one. My `isAdvertisablePlatformPath`
and `canonicalSitemapUrl` are deleted; `canonicalUrl()` and
`isRegistryRenderedPath()` do the work, and also cover percent-encoding, query
strings and fragments that mine did not.

One of my tests asserted the behaviour I had built — that a *real* blog path from
the registry is still advertised. Under #526 that is deliberately false. The case
is rewritten to assert the new rule and to say why it inverted, rather than being
deleted.

**F2 was not covered by #526, and still is not.** It kept the four-entry list
(`/dashboard`, `/onboarding`, `/api`, `/auth`). The 20 missing authenticated
surfaces are still this branch's finding, and the fix is now **better placed than
where I first put it**: #526 moved the disallow list into
`lib/marketing/sitemap-urls.ts` and made `canonicalUrl()` refuse any URL beneath
it, so robots and the sitemap cannot contradict each other. Expanding that shared
constant to all 24 surfaces therefore fixes robots **and** stops the sitemap from
ever listing them.

That coupling introduced one hazard worth pinning: the matcher is `=== p` or
`startsWith(p + '/')`. A looser `startsWith(p)` would now drop the **public**
`/family-display` from both robots and the sitemap, because `/family` and
`/display` are both on the list. Verified empirically and pinned by its own test.

---

## Verified healthy (no action)

| Area | Evidence |
|---|---|
| Security headers | CSP with `frame-ancestors 'none'` and `object-src 'none'`, HSTS `max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restricting camera/mic/geolocation to self |
| Public routes | 21 public routes probed; all 200 except the two noted below |
| `/onboarding` 307 | Correct — gated, redirects to login |
| `/resources/benchmarks` 404 | **By design.** Gated on an admin publication flag so an unpublished page is indistinguishable from one that never existed. The sitemap already refuses to list it unless published. Not a defect |
| Page metadata | All 17 public pages carry a real `<title>`, description and canonical. An earlier reading that `/how-it-works` and `/login` had none was **my own extraction bug**, re-checked and withdrawn — both are correct |
| API boundary | Every public-allowlisted API route refuses an unauthenticated request: contact-center email 401, sms/voice/transcription 401 each (with provider-shaped bodies), assistant 401, alexa 403, stripe webhook 400, forms 422. Nothing answered 200 with data |
| Production revision | `/api/build-info` reports `f9c4d7a1…`, matching `main` — production is current |
| Typecheck | `tsc --noEmit` clean |
| Lint | 0 errors (2 pre-existing `exhaustive-deps` warnings, untouched) |
| Test suite | 1,150 files / 13,102 tests passing |
| Security headers | see above — CSP, HSTS, frame/nosniff/referrer/permissions all present |
| Domain redirects | `http://bubaly.com`, `https://bubaly.com` and `http://www.bubaly.com` all 308 to `https://www.bubaly.com`; trailing slash 308s to the canonical path. An initial `000` reading on the apex was a transient blip — it resolved cleanly on all three retries, so it is not reported as a finding |
| Accessibility basics | one `<h1>` per page (after F11), all images carry `alt`, `lang` set, skip link present, single `<main>` landmark |
| Server-rendered content | all 17 public pages ship 6 KB–92 KB of real markup; only the 404 path does not (F12) |
| Programmatic SEO routes | `/compare`, `/guides`, `/alternatives`, `/audiences`, `/questions`, `/glossary` render from `marketing_pages` and simply have no published rows yet — feature built, content pending. Not a defect |
| Unresolved work markers | 38 `TODO`/`FIXME` in source; the substantive ones are migration-gated and explicitly marked "owner approval required", i.e. blocked behind F5. None independently closeable |
| Health endpoint | `status: ok` — env, database ~98ms, auth ~90ms, serviceRole ~508ms |
| Auth gating | All 20 authenticated segments answer 307 to `/login` when signed out |

### Checked during the entitlement sweeps, and sound

These were examined because they were the *next plausible instance* of a shape
this audit kept finding. None of them was one. Recording that matters: an audit
that lists only defects says nothing about what was actually looked at, and the
next person needs to know which stones were already turned.

| Area | What was checked | Why it is sound |
|---|---|---|
| **Payment webhooks** | `/api/webhooks/stripe`, `/money`, `/resend` | All three verify signatures before touching anything — Stripe via `constructEvent`, Resend via HMAC with `timingSafeEqual`. All fail **closed** when the secret is unset (503, not "allow"). Stripe additionally bounds the body and dedupes by event id under a claim token. This matters more than it looks: every plan gate in F15–F18 rests on `subscriptions`, and this is what writes it |
| **SSRF on user-supplied URLs** | `public-calendar-fetch`, `public-document-fetch`, `public-media-fetch` | Textbook-correct, including the case most implementations miss. Private/loopback/link-local CIDRs blocked; DNS resolved once and the address **pinned** into a per-request agent, so neither a rebinding race nor a pooled connection nor an environment proxy can reach an address that was never validated; `autoSelectFamily: false` so Happy Eyeballs cannot pick an unchecked one; https only |
| **Public write surface** | 15 unauthenticated API routes | Every one that accepts a body bounds it and rate-limits by IP, most through `enforceRequestRateLimit` (durable, cross-instance) rather than memory alone. The two without a limiter are a token-keyed idempotent GET and a small CDN-cached read — neither has anything to abuse |
| **AI memory read privacy** | "what Bubaly worked out about each person" | The panel tells a non-manager *"Only a parent or adult can see…"*, and for once the claim is kept where it should be: `listMemoryProfile` returns `traits: []` to anyone who is not a manager, so the empty state is the only state they can reach. Its comment reasons about the exact harm — *"A reliability score about a sibling is not a child's business"* |
| **Notification recipients** | `notify()` → `resolveRecipients` | Scoped to `family_id = scope.familyId` and `is_active`, so no member can address a notification outside their own family |
| **Role checks that looked missing** | `setLocationSharing`, `saveAISettingsAction`, the locator's place writes | All correct. The first writes only the caller's own row; the second is refused a layer down in `updateAISettings`; the third was already `isManager`-gated. Three of the four candidates in that sweep were already right — only the chore board (F20) was not |

## What remains, and who owns it

Nothing here is unexamined. Each item is closed with a decision or assigned to
someone who has access this session does not.

| Item | Owner | Next step |
|---|---|---|
| **F5** Supabase migration workflow | Operator | The access token or project ref lost its privileges some time after 2026-09-07. Restore it, **then** repair the ledger baseline — the gate throws by design until `0004` is recorded, and that is explicitly a credentialed operator action. `docs/PENDING_PROD_MIGRATIONS.md` claimed "connectivity works" until this audit corrected it; it now states the failure and that fixing the token alone is not sufficient |
| **F6** Family email routing | Operator | Step-by-step in [`docs/runbooks/family-contact-center-routing.md`](docs/runbooks/family-contact-center-routing.md) — written during this audit because none existed. Set `CONTACT_CENTER_INBOUND_SECRET` in Vercel, redeploy, point `bubaly.com` MX at an inbound-parse provider aimed at `/api/contact-center/email?key=…`. Until then the webhook correctly answers 401 |
| **F10** Seed rows in the database | Operator | The site no longer renders them. Deleting the three `case_studies` rows is a Super Admin action |
| **F9** i18n payload | Engineering | Design settled, safety proven, and the mechanism now needs no middleware or restructure — a nested provider in `app/(app)/layout.tsx` with a 702-key (44 KB) root set. Three named keys to cover first. Needs one person to confirm a marketing page renders in a browser, which this environment cannot do |


## Dependency security — closed, nothing to fix

`npm audit` reports 8 advisories (3 moderate, 5 high). **None of them affect
bubaly.com**, and that was checked rather than assumed: every package was
resolved against the production dependency tree.

| package | in production tree |
|---|---|
| `js-yaml`, `tar`, `brace-expansion`, `browserslist` | no |
| `@xmldom/xmldom`, `vitest`, `@vitest/mocker`, `baseline-browser-mapping` | no |

`npm audit --omit=dev --audit-level=moderate` — the exact command CI runs —
reports **0 vulnerabilities**. All 8 are build and test tooling that never
reaches the deployed artifact.

So there is no site finding here. Upgrading the dev toolchain is ordinary
maintenance, not audit remediation, and worth noting it cannot be done casually:
`npm audit fix` cannot even produce a plan on this tree (it exits with an
internal npm error), so it would mean a hand-managed lockfile rewrite against a
13,000-test suite for no change to what users run.

## Method, and what it could not reach

Findings were established by probing the live site and reading the real code
path, then reproduced before being recorded. Each fix was checked for
non-vacuity by reverting it and confirming the new tests fail.

That discipline paid twice, and both are recorded rather than quietly corrected:

- **A finding withdrawn.** An early reading that `/how-it-works` and `/login`
  shipped no title, description or canonical was my own extraction bug. Both are
  correct. Re-checked and struck.
- **A vacuous test caught.** The first version of the F11 sweep passed with the
  fix reverted, because the JSDoc it was testing contains the literal `as="h1"`.
  Found by reverting a page and watching the test stay green — the same failure
  as F4, in the fix for F11.

**One limitation worth stating plainly, so nothing above is over-read.** No
browser could run in this environment. Chromium launches but every navigation
dies inside the agent proxy relay (`ws_closed_mid_exchange`, 39 bytes received)
for *every* host, including `www.google.com` — so it is the relay, not the site.
`curl` through the same proxy works, and every finding above rests on that or on
the code.

So the following were **not** checked and are not claimed: client-side console
errors, hydration behaviour, visual layout and responsive rendering, and
interactive flows (forms, the consent manager, the language picker). A local
production server was started to close the gap and reproduced the routing
behaviour, but could not exercise data-backed pages — without real Supabase
credentials they answer 500 before reaching the code under test.

This is also the single reason F9 is a decision rather than a fix: its entire
risk surface is hydration, which is precisely what could not be exercised here.

---

# Pass B — Data layer (F-001–F-019)

A running, evidence-based audit of bubaly.com. Every entry records what was
checked, **how**, and what the check actually returned. Nothing is marked closed
on reasoning alone — a finding closes only when a command, probe, or rendered
page demonstrates it, and wherever a fix is claimed the check was also run
against the broken state to prove it was not passing vacuously.

- **Audit head:** `ed85df8a` (main, after Pass A's fixes) + this pass
- **Scope:** 395 pages · 140 API routes · 306 migrations · 1,170 unit-test files
- **Environment:** full local Supabase stack (all 306 migrations replayed), seeded
  anchor household, real browser sign-in.

Two entries in this file record the audit correcting *itself*: F-011 (the helper
written to fix silent truncation had the same defect) and F-015 (a probe granted
itself privileges and left them, so the suite's answer depended on what ran
before it). Both were found by re-checking a closure rather than trusting it, and
F-002 records reasoning that was wrong and what replaced it.

---

## 1. Status summary

| Area | Check | Result |
|---|---|---|
| Types | `tsc --noEmit` | ✅ clean |
| Lint | `next lint` | ✅ 0 errors (4 pre-existing `react-hooks/exhaustive-deps` warnings) |
| Unit tests | `vitest run` | ✅ 13,537 tests |
| Build | `next build` | ✅ exits 0 |
| Schema ↔ code | `db:audit:queries` | ✅ 491 tables, 77 functions, 140 routes resolve |
| Migration names | `db:audit:migrations` | ✅ 307 files, no collisions |
| Migration replay | fresh DB, 0 → 307 | ✅ all applied, 0 failed |
| Migration **re**-apply | populated DB, replay from `0004` | ✅ 0 failed (was 18 — F-020) |
| i18n | `i18n:gate` | ✅ all declared surfaces clean |
| RLS boundaries | 15 probes, fresh 307-migration replay, run 2× | ✅ 15/15 each time (F-015 made it repeatable) |
| Authenticated routes | 353-route crawl | ✅ 351 ok, 1 gate redirect, 0 failures |
| Public content routes | unknown-slug probe | ✅ 404s (was one 500 — see F-005) |
| API authorization | guard-vs-public-list sweep | ✅ 140/140 accounted for |
| E2E | 108 specs + 2 gated journeys | ✅ all pass (a journey caught F-006) |
| Nightly jobs | all 11 cron routes exercised end to end | ✅ clean (F-008, F-009, F-010, F-014) |
| Whole-table reads | live PostgREST, 3 real tables | ✅ complete and distinct (F-008, F-011) |
| Row-ceiling honesty | scan of `app/` + `lib/` | ✅ 0 limits above the cap (was 59 — F-013) |
| Notification dedupe | 5 cron runs, duplicate-group count | ✅ no new duplicates (F-014) |
| Public sitemap | 1,049 published posts vs the served file | ✅ 1,049 listed (was 1,048 — F-012) |
| Calendar-day correctness | day keys vs DATE columns, 9 zones | ✅ family zone on every user-facing surface (F-017) |
| Query plans | family-scoped reads at 700k rows | ✅ index scan, was a full scan (F-018) |
| Money under concurrency | 2 simultaneous auths vs one balance | ✅ exactly 1 approves (F-019) |
| Production DB | migration ledger | ⚠️ **blocked — F-001** |

---

## 2. Open findings

### F-001 · Production migration ledger records only `0001–0003` — owner action

**Severity:** high · **Status:** OPEN, cannot be closed from a sandbox
· **Same wall as Pass A's F5**, reached from the database rather than from CI

Production carries 439 tables and 957 policies but a three-row ledger. Every
push to `main` therefore halts at the baseline guard in
`scripts/audit-production-migration-state.mjs` before `supabase db push` runs:

```
{"migrationVersions":["0001","0002","0003"],"tableCount":439,"policyCount":957,
 "requiresBaselineReview":true,"moneyWrites":{"exploitable":false}}
Existing production policies have no recorded baseline migration 0004.
Historical replay is blocked... Repairing it is a credentialed operator action.
```

The guard is correct — it is what keeps the held `0240–0254` bundle
(`docs/PENDING_PROD_MIGRATIONS.md`, unresolved requester-privacy findings) from
auto-applying. **Consequence:** every migration from `0276` on, including
**`0290` below**, replays cleanly in the repo but is *not applied to
production*. Needs an operator following `docs/runbooks/LB-016-…md` §4.

F-001 is the only finding still open. Everything else in this file closed with a
command, probe, or rendered page behind it.

**What this means for what actually shipped.** The code for every fix here is on
`main`. The four migrations are not, and cannot be until an operator runs them,
so two closures are only half-live in production:

| Fix | Code on `main` | Needs migration | State in production until an operator runs it |
|---|---|---|---|
| **F-010** `notifications.related_id` is a key, not a uuid | — | **`0293`** | The column is still `uuid`, so the generic notification pass still rejects every composite dedupe key |
| **F-014** dedupe read batched | ✅ | depends on `0293` | The batching is live, but the read it protects cannot succeed until `0293` lands |
| **F-003** `anon` write grant on the money tables | — | **`0290`** | Still open in production |
| **F-006** privileged-RPC lockdown re-asserted | — | **`0292`** | `0253`/`0204` may still be undone later in the chain |
| Everything else (F-002, F-005, F-007–F-009, F-011–F-013, F-015, F-016) | ✅ | none | Fully live |

The `Supabase production migrations` workflow fails on every push for the reason
Pass A's F5 records, so this is not a matter of waiting — it needs the operator
action in both F5 and F-001. Agents must not apply migrations to production
(`docs/PENDING_PROD_MIGRATIONS.md`), and this one did not.

**What changed for the operator this pass.** The repair procedure in
`LB-016 §4` would not have worked. Replayed against a database that already
carries the schema — production's actual condition — `supabase db push` stopped
on the *first* file it tried, and left `0004` unrecorded, so the guard would not
have cleared either. That is now fixed and rehearsed end to end: see **F-020**.
The finding stays open because the credentials are the operator's and applying
migrations is not an agent action, but it is no longer open on top of a
procedure that does not run.

---

## 3. Closed this pass

### F-002 · Unbounded reads — the survey, and the reasoning in it that was wrong

**Severity:** medium · **Status:** CLOSED (see F-008 and F-013); the honest bound is now enforced, not assumed

243 reads use `.from(...).select(...)` with no `.limit()`, no `.single()` and no
`head:true` count. Classified by what they actually grow with:

- **122 are not family-scoped** — they grow with the whole platform.
- **121 are family-scoped** — they grow with one household.

The genuinely dangerous subset (F-008) is fixed, and a subset this entry had
**wrongly** put in the "accepted" pile is now fixed too — see F-013. The
reasoning that failed was this: a read carrying an explicit `.limit(n)` was
counted as bounded on purpose. For fifty-nine of them `n` was above the server's
row ceiling, which means it was never applied at all; they were unbounded reads
that merely looked deliberate. Re-measuring per family is what exposed it —
single households already hold 6,500 `habit_logs` and 3,709 `graph_entities`, so
"a problem that is not occurring" was not true when this entry was written.

What remains accepted is the reads whose bound is real (`n` at or below the
ceiling) or whose table is small admin/config data. That subset is now guarded
rather than asserted: `tests/no-limit-above-the-row-cap.test.ts` fails on any
`.limit()` above the cap, so the category cannot quietly refill.

---

### F-003 · `anon` held INSERT/UPDATE/DELETE on all five money tables

**Severity:** high (defence-in-depth) · **Status:** CLOSED — migration `0290`

`docs/audit/wallet-write-rls-check.sql` invariant 6 failed against a real
Supabase database:

```
A-08 FAIL: anon holds INSERT on wallet_transactions —
the restrictive guards are `to authenticated` and would not apply
```

The restrictive manager guards from `0254` are `TO authenticated`, and a
restrictive policy only ANDs with requests made **as a role it names** — for an
anonymous request they are simply absent. The grant layer is the only thing
closing that path, and it had never been closed: Supabase's default privileges
grant `arwdDxt` on every new `public` table to `anon`, and no migration revoked
it. All five money tables carried it.

**Not exploitable as found, and `0290` does not claim otherwise.** The only
permissive INSERT policy is also `TO authenticated`, so an anon insert is
refused for want of any permissive policy. Verified directly:

```
set role anon; insert into public.wallet_transactions (...) values (...);
ERROR:  new row violates row-level security policy for table "wallet_transactions"
```

What `0290` restores is the layer that makes that robust: one future permissive
policy written `TO public` — the exact stray shape `0275` had to sweep away —
would otherwise open an anonymous mint path no restrictive guard would catch.
Reads are deliberately left alone; the public gift flow writes through
`createServiceClient()`, so nothing legitimate loses a write.

### F-004 · The money-boundary probe could not catch F-003 in CI

**Severity:** high (false assurance) · **Status:** CLOSED — `pg-bootstrap.sh`

F-003 had been passing in CI for its entire life. `docs/audit/pg-bootstrap.sh`
built its roles by hand and granted `anon` only `SELECT`, so the shim was
**safer than production** — the wrong direction for a boundary harness. The
probe asserted something true of the shim and false of every real database.

The shim now reproduces Supabase's real default privileges, and does it *before*
migrations run, which is when they take effect on a real project — granting
after the migrations would have re-granted exactly what `0290` revokes and
silently undone it.

Proven non-vacuous end to end: re-granting `insert` to `anon` on the shim
reproduces `10/11 passed · FAILED: wallet-write-rls-check.sql`; revoking it
returns `11/11 passed`.

### F-005 · Every blog post not baked in at build time returned 500

**Severity:** high · **Status:** CLOSED

`/blog/none` answered **500** where all twelve sibling content routes answered
404. The server log gives the mechanism:

```
Error: Page changed from static to dynamic at runtime /blog/none, reason: cookies
```

`app/(marketing)/blog/[slug]/page.tsx` declared `revalidate = 3600` with
`dynamicParams = true`, but resolves locale per request through
`getTranslations()` → `cookies()`. Declaring ISR while reading cookies is not a
no-op: Next prerenders the route, sees the cookie read on a later request, and
throws. With `dynamicParams = true` that is a 500 for **every post published
since the last deploy** and for every unknown slug a crawler tries — where 404
is the right answer.

`app/(marketing)/blog/page.tsx` and `app/(marketing)/faq/page.tsx` carry the
same shape; there the served page is the stale prerender and the background
revalidation fails forever, so the page silently stops updating. All three are
now `dynamic = 'force-dynamic'`, which is what a per-request locale actually
means. A sweep confirms no other `revalidate` route reads cookies.

### F-006 · Any signed-in user could claim another household's AI jobs

**Severity:** high (cross-tenant) · **Status:** CLOSED — migration `0292`

`claim_ai_runs` is `SECURITY DEFINER` and scoped to the whole platform, not to a
family. `authenticated` held EXECUTE on it. Acting as an ordinary member of
family A:

```
set role authenticated; set request.jwt.claim.sub = '<member of family A>';
select * from public.claim_ai_runs(10, 60);
-> claimed ids: 00000000-0000-4000-8000-00000000ab01   (a run owned by family B)
```

So any signed-in user could lease AI runs belonging to any other household,
pull them out of the real worker's queue, drive the run state machine across
tenants, and read back the run ids. The same grant was open on
`claim_marketing_generation_jobs` (also to `anon`) and on the three
`loyalty_*` ledger functions.

**This had already been fixed twice.** `0253` revoked `claim_ai_runs` from
public/anon/authenticated and *raised an exception* if the revoke had not taken;
`0204` did the same for the loyalty trio. Both lockdowns were undone later in
the chain: Supabase's default privileges grant EXECUTE on functions straight to
anon and authenticated, so a later `create or replace` (`0263` re-creates
`claim_ai_runs`) hands the grant back. `0253`'s check passed because it verified
**its own moment**, not the final state — which is the only state a database
runs in.

`0292` re-asserts all five at the end of the chain. Verified after the fix: a
member and anon both get `42501 permission denied` through PostgREST, and
`service_role` still executes. The gated E2E journey that asserts exactly this
(`authenticated.spec.ts:150`, "Only the server worker may claim AI jobs") now
passes, having failed before.

### F-007 · The additive-migrations guard flagged a revoke as destructive

**Severity:** low · **Status:** CLOSED

`tests/migrations-are-additive.test.ts` scans for a bare `\btruncate\b`, so
`revoke insert, update, delete, truncate … from anon` in `0290` read as
destructive DDL — though it *removes* the ability to truncate. The guard already
masked one legitimate TRUNCATE (the trigger-event declaration); it now masks the
privilege list of a GRANT/REVOKE too. Both directions are pinned: a revoke is
allowed, and `REVOKE TRUNCATE … ; TRUNCATE TABLE public.history;` is still
rejected, so the mask cannot launder a real statement.

### F-008 · Six nightly jobs silently stopped at 1,000 rows

**Severity:** high · **Status:** CLOSED — `lib/supabase/read-all.ts`

PostgREST answers an unbounded `select()` with at most `db-max-rows` and reports
nothing — no error, no short-read signal. Measured against the live local
project, on real tables, through the real helper:

```
calendar_events  unbounded=1000  readAll=2012  distinct=2012  error=null
graph_entities   unbounded=1000  readAll=3709  distinct=3709  error=null
notifications    unbounded=1000  readAll=1420  distinct=1420  error=null
```

The unbounded read returns exactly 1,000 rows of a 2,012-row table and calls it
the table. `distinct == total` also shows the paged read neither repeats nor
skips a row across page boundaries.

This is not a scale-someday problem — **single households already exceed the
ceiling** in the seeded data:

```
habit_logs        max rows for one family: 6500
pet_care_records                           4000
graph_entities                             3709
calendar_events                            1906
notifications                              1402
```

Six cron jobs read their driving table with no pagination, so past 1,000 rows
each silently did part of its work and reported success:

| Job | Driving read |
|---|---|
| `weekly-digest` | every family |
| `notifications` | every family |
| `push-scan` | every family |
| `chore-reminders` | every open assignment due this week |
| `calendar-feeds` | every subscribed feed |
| `checkout-abandoned` | every pending checkout session |

All six now read through `readAll`. It is deliberately **not** applied where a
bound is correct — an admin list wants a limit, not every row. Nine unit tests
pin the behaviour (see F-011 for the two that matter most).

Verified by running each route end to end against the live stack:

```
weekly-digest        {"sent":0,"failed":1}                        [502]
notifications        {"ok":false,"families":16,"created":100,…}
push-scan            {"ok":true,"families":16,…}                  [200]
chore-reminders      {"sent":0,"failed":1}                        [502]
calendar-feeds       {"ok":false,"feeds":3,"synced":0,"failed":3} [502]
checkout-abandoned   {"pending":0,"abandoned":0,"fired":0}        [200]
```

The 502s are local delivery failures — no real Resend key, fake feed URLs — and
are now *reported* rather than crashing the run (F-009).

### F-009 · A provider error in the mailer took down the whole cron run

**Severity:** high · **Status:** CLOSED — `lib/email.ts`

`sendReactEmail` is typed `Promise<{ ok: boolean }>` and every caller is built on
that: the weekly digest counts a failure per family and moves on. But it only
handled the SDK's `{ error }` return — a *thrown* provider error (network
failure, or a malformed key, which surfaces from inside the client as a bare
`TypeError: b is not a function`) escaped and took the caller with it.
Observed: `GET /api/cron/weekly-digest` → **500**, mid-run, abandoning every
family after the first.

Now wrapped, so the function keeps its contract. After the fix the same route
answers `{"sent":0,"failed":1}` — it completes and reports instead of crashing.
Five unit tests pin it, including the exact `TypeError` shape.

### F-010 · Notification generation failed outright for affected households

**Severity:** high · **Status:** CLOSED — migration `0293`

`notifications.related_id` was typed `uuid`, but three subsystems deliberately
store a **composite dedupe key** in it — that is what the column is for, since
the generic pass skips any candidate whose `(type, related_id, user_id)` already
exists:

```
lib/server/notifications.ts   'moment:<eventId>:<date>'  (so a recurring
                              occurrence pings at most once), 'conflict:<ids>'
lib/services/approvals        .in('related_id', candidates.map(c => c.dedupe_key))
lib/ai/tools/notifications    related_id: z.string().nullish()
```

Postgres rejected every one:

```
Notification generation failed for family 11111111-…:
invalid input syntax for type uuid: "moment:3fd2b8f5-…:2026-09-14"
```

The throw is caught per family, so the cron reported success overall — while
that household received **no notifications at all** from the run, not merely no
moment reminder. Five of sixteen seeded families hit it on one pass.

The column was the outlier: polymorphic, qualified by `related_type`, with no
foreign key and no index, and a read-side helper (`entityIdFrom`) whose job is
to pick the uuid back out of a colon-delimited string. `0293` widens it to
`text` — lossless. Measured before and after on the same cron run:

| | before | after |
|---|---|---|
| uuid errors | 5 | **0** |
| families failing generation | 5 | **0** |
| notifications created | 100 | **117** |
| `push-scan` | 502, `failed: 5` | **200, `failed: 0`** |

---

### F-011 · The fix for F-008 had the same defect it was written to fix

**Severity:** high · **Status:** CLOSED — `lib/supabase/read-all.ts`

Found by comparing `readAll` against `lib/supabase/read-all-pages.ts`, a paging
helper that already existed in the repo and did one thing differently.

`readAll` asked for rows `0–999`, and treated **any page shorter than 1,000 as
the end of the table**. That is only true if the server never returns fewer rows
than the range requests — and returning fewer rows than requested is precisely
what `db-max-rows` does. `db-max-rows` is a per-project setting; 1,000 is the
default, not a guarantee. Against a project set lower, the helper written to
prevent silent truncation reproduced it, and worse — advancing by the range
*requested* rather than the rows *received* also skips the rows in between:

```
table rows:            2011
server cap per page:   500
old loop returned:     500 rows, error=null
households lost:       1511
```

Two rules now hold, and both are pinned by tests that fail without them:

- **Advance by the rows received**, never by the range requested.
- **Stop only on an empty page.** A short page is not proof of the end; it is
  equally the signature of a cap. One extra round trip tells them apart.

A page that reports neither rows nor an error is now a failure rather than an
ending — "no data, no reason" is the exact shape of the truncation being
guarded against.

Three hand-rolled paging loops existed; there is now one. `readAllPages` keeps
its stricter contract (any failure yields *no* rows, so a partial read can never
be mistaken for a household's complete history) and delegates the loop. Its
pre-existing test — *"continues when a server returns fewer rows than the
requested range"* — passes unchanged against the shared implementation, which is
what proves the contract survived consolidation.

### F-012 · The sitemap search engines read was six days stale, and would have stayed stale for a year

**Severity:** high · **Status:** CLOSED — `lib/blog/posts.ts`, `app/sitemap.ts`
· Distinct from Pass A's F1/F3/F14, which were about *which URLs* it listed;
this is about the file being a stale copy. Both fixes are in the current file.

The live sitemap listed **1,048** blog URLs. The database held **1,049**
published posts. One article was simply absent from the file search engines use
to discover content.

It was not a paging bug, an RLS bug, or a missing row. `app/sitemap.ts` was
prerendered, and Next patches `fetch`: for a route it prerenders, the response
goes into the build Data Cache under the route's revalidate. The route declared
none, so the entry was written with Next's "forever" value and no tag able to
clear it. Decoded straight out of `.next/cache/fetch-cache`:

```
url:        …/rest/v1/blog_posts?select=slug,title,excerpt,…&published=eq.true
rows:       1000                     (a second entry held the remaining 48)
revalidate: 31536000                 ← one year
tags:       []                       ← nothing can revalidate it
written:    2026-09-07 23:50
```

1,000 + 48 = the 1,048 in the shipped sitemap. A build on **2026-09-13** served
its blog list from entries written **six days earlier**, and Vercel restores
`.next/cache` between deploys — so redeploying would not have fixed it. Every
article published from that day on would have been invisible in the sitemap for
a year. On a site whose organic surface *is* its blog, that is the whole point
of publishing.

Why it stayed invisible: `getAllPosts` ended in a bare `catch { return []; }`.
The failure had no voice.

Fixed in three parts, each verified:

1. **The reads leave the cache.** The blog's Supabase client passes its own
   `fetch` with `cache: 'no-store'`, so every query this module makes is
   covered — not just the one that was noticed. The blog pages themselves are
   `force-dynamic`, so nothing there was ever cached and nothing there changed.
2. **The route says what it is.** `export const dynamic = 'force-dynamic'` on
   `app/sitemap.ts`. `no-store` alone already forced this, but only by *throwing*
   during Next's trial static render — which is how the third part surfaced.
3. **The catch stops swallowing framework control flow.** `unstable_rethrow(error)`
   runs before the fallback in both readers. Next signals "this route cannot be
   static" by throwing out of the fetch; swallowing it hands Next an empty
   article list and lets it prerender and ship that. It had in fact already
   written such an artifact — a 4,055-byte sitemap with no posts in it.

Because the route now renders per request, it also stopped reading what it does
not use: `getAllPostRefs` selects `slug, published_at` instead of all thirteen
card columns — kilobytes per crawl instead of about a megabyte.

Before and after, against the running production build:

```
before   1048 blog <loc>   audit-fixture-post absent    227,217 bytes
after    1049 blog <loc>   audit-fixture-post present   227,389 bytes, 141–226 ms
```

Also fixed while here: `published_at` alone ordered the paged blog read, and
**717 of the 1,049 published rows share a date with another row**. Two pages are
two separately planned queries, so a tied boundary is free to move between them
— repeating one row and dropping another. The read now orders by
`published_at, slug`.

Four tests pin all of it, and **three of the four fail** when the fix is
reverted (`cache: 'force-cache'`, no `force-dynamic`, no `unstable_rethrow`) —
so the guard is not passing vacuously.

### F-013 · Fifty-nine reads asked for more rows than the server would ever return

**Severity:** high · **Status:** CLOSED — `readAll(…, { max })`

`.limit(n)` for n above the row ceiling is not a bound. It is a silent
truncation wearing the costume of a deliberate choice: PostgREST caps a response
at `db-max-rows` whatever the client asked for, so the number in the source reads
as a considered ceiling in review and returns 1,000 in production.

Measured against the live project, with the app's own numbers:

```
habit_logs       table=6500   asked .limit(5000) → got 1000
graph_entities   table=3709   asked .limit(4000) → got 1000
graph_edges      table=999    asked .limit(8000) → got  999   (under the cap: honest)
```

**Fifty-nine call sites** had written such a limit. What each one was actually
doing:

| Read | Wrote | Got | Consequence |
|---|---|---|---|
| `habit_logs` (AI habit coach) | 5,000 | 1,000 | streaks computed from a sixth of the history |
| `graph_entities` (`loadFamilyGraph`) | 4,000 | 1,000 | the AI reasons over a quarter of the household's graph — under a docstring promising never to present a partial view as current |
| `wallet_transactions` (×5 surfaces) | 2,000–20,000 | 1,000 | balances and the reconciliation page totalled from part of the ledger |
| `ab_events` per chunk | 100,000 | 1,000 | every experiment conversion rate a 1,000-row sample, read as exact |
| `calendar_events` (migration de-dupe) | 5,000 | 1,000 | an import re-adds events it cannot see |
| `transactions`, `mkt_touchpoints`, `marketplace_saves`, … | 2,000–10,000 | 1,000 | counts and sums reported as exact |

This is not a scale-someday problem — **single households already exceed the
ceiling** in the seeded data: `habit_logs` 6,500, `pet_care_records` 4,000,
`graph_entities` 3,709, `calendar_events` 1,906, `notifications` 1,402.

Every site now reads through `readAll`/`readAllAsQuery` with `max` set to the
number its author meant, which is honoured by paging to it. `readAllAsQuery`
answers in the `{ data, count, error }` shape a query answers, so a read inside a
`settleAll([...])` batch swaps one expression and nothing else moves.

`tests/no-limit-above-the-row-cap.test.ts` scans `app/` and `lib/` and fails on
any `.limit(n > 1000)`, with its own non-vacuity case pinning that the scan
catches the pattern and does not fire on a real bound or on prose describing the
rule. Verified after: typecheck clean, 13,108 tests, 353-route crawl with 0
failures, all 11 cron routes complete, and each of the 20 changed pages returns
200.

### F-014 · Notification dedupe failed on every run, so every run re-notified

**Severity:** high · **Status:** CLOSED — `lib/server/notifications.ts`, `lib/services/approvals`

Found by reading the server log after exercising the cron routes:

```
[notifications] dedup read failed { familyId: …, error: { message: 'URI too long\n' } }
[service:approvals] reminder dedupe read failed { familyId: …, error: { message: 'URI too long\n' } }
```

A PostgREST filter travels in the **query string**. Since `0293` (F-010) these
ids are no longer uuids — `related_id` carries a composite dedupe key such as
`moment:<eventId>:<date>` — and a few hundred of them build a request line past
the gateway's limit. Measured, by binary search against the live project:

```
  50 ids → URL  3168 bytes → 200
 100 ids → URL  6268 bytes → 200
 150 ids → URL  9418 bytes → 414
```

The code already named the consequence, in a comment written beside the read:
*"A failed dedup read leaves `seen` empty, so every candidate would pass the
filter and re-insert as a duplicate."* That is exactly what was happening, every
run, unnoticed — because the failure only logs, and the run still reports success.
The damage was measurable in the database: **117 duplicate
`(type, related_id, user_id)` groups holding 1,300 rows.** The approvals path
failed the other way, skipping the family every tick rather than duplicating.

Both reads now batch through `lib/supabase/chunked-in.ts` — the helper that
exists for this exact failure — at 50 ids per request, which the measurement
above puts at ~3 KB.

Proof, on the running production build:

```
before   [notifications] dedup read failed … URI too long   (every run)
after    URI-too-long errors: 0 · dedupe failures: 0
run 1    approvals reminded: 334 across 1 family   ← had been skipped every tick
run 2    approvals reminded: 0                     ← dedupe now suppresses
3 further runs → duplicate groups 117 → 117        ← no new duplicates
```

### F-015 · A probe granted itself privileges and left them, poisoning the suite

**Severity:** high · **Status:** CLOSED — `docs/audit/rls-isolation-check.sql`

The audit's own instrument was unsound, which makes it the most important finding
here: **a probe suite whose answer depends on what ran before it is not
evidence.**

`rls-isolation-check.sql` carried a bare

```sql
grant execute on all functions in schema public to authenticated;
```

so that one call below it could run as `authenticated`. It never revoked it. That
single statement undoes the deliberate revokes in `0204`/`0253`/`0292` and hands
`authenticated` EXECUTE on `claim_ai_runs` and the four loyalty RPCs — **the exact
cross-tenant hole F-006 closed.**

Probes glob alphabetically, so `privileged-rpc-grants-check` (**p**) ran *before*
`rls-isolation-check` (**r**) and passed; every run after that saw a poisoned
database. Observed directly: 13/13, then the same probe failing on a re-run
against the same database, naming all five RPCs. I had previously written that
flip off as my own out-of-order manual SQL. That was wrong — the leak was in the
suite, and saying so is the point of keeping this entry.

Two things were fixed:

1. **The grant is gone.** It was never needed: `CREATE FUNCTION` grants EXECUTE
   to PUBLIC, so `authenticated` can already call that RPC. Verified on a
   pristine 305-migration replay, before any probe ran —
   `has_function_privilege('authenticated', 'marketplace_create_circle', 'EXECUTE')`
   is already true, while all five privileged RPCs read service-role-only.
2. **An assertion that was only true because of the grant was corrected.**
   Invariant 5 matched `sqlerrm ilike '%not authorized%'`, the in-function check.
   With EXECUTE revoked from `authenticated` *and* PUBLIC, Postgres refuses the
   call outright — `42501: permission denied for function` — which is the
   *stronger* boundary, and the probe was reading it as a failure. It now accepts
   either, and still fails if the call SUCCEEDS, which is the thing that must
   never happen.

Now repeat-stable, which it was not before:

```
run 1  == probes: 13/13 passed ==
run 2  == probes: 13/13 passed ==
run 3  == probes: 13/13 passed ==
and after all three, the five privileged RPCs still read
  authenticated=false  anon=false  service_role=true
```

### F-016 · The documented crawl workflow drops a live session cookie into the working tree

**Severity:** low · **Status:** CLOSED — `.gitignore`

`npm run crawl:login` writes `cookies.json` — a real Supabase session cookie for
whatever account signed in — into the repository root, and `crawl:routes` reads
it back. Both are documented workflows and were run several times during this
audit, so the file lands in the working tree routinely. It was **not** gitignored:

```
$ git status --short
?? cookies.json
$ git check-ignore -v cookies.json
(no match)
```

Nothing had committed it, but the next `git add -A` by anyone following the
documented steps would have. Now ignored, with the reason written beside the
entry so it is not "tidied away" later by someone who reads it as a stray
artifact:

```
$ git check-ignore -v cookies.json
.gitignore:36:cookies.json	cookies.json
```

### F-017 · A family's "today" was Greenwich's today, on every surface that shows a day

**Severity:** high · **Status:** CLOSED — `dayKeyInTz` adopted across the
user-facing surfaces; the background remainder is allowlisted with reasons

A DATE column in this schema holds the day on the family's kitchen wall.
`new Date().toISOString().slice(0, 10)` answers the day at Greenwich. Nineteen
files compared one against the other.

This is not an edge case. Measured across every minute of a day:

```
America/Los_Angeles   420 min/day wrong   (29.2%)
America/New_York      240 min/day wrong   (16.7%)
Asia/Tokyo            540 min/day wrong   (37.5%)
Australia/Sydney      600 min/day wrong   (41.7%)
```

For a Californian household that is **every evening from 5pm**.

Proven end to end against the database, at 18:30 on a Sunday in Los Angeles:

```
instant                : 2026-09-14T01:30:00Z
family wall clock      : Sunday, September 13, 2026 at 6:30 PM
the family's today     : 2026-09-13
page's today (UTC)     : 2026-09-14   ← what meal_plans was queried with

  the page rendered  →  "Monday pasta — tomorrow"
  the family was eating →  "Sunday roast — eaten TONIGHT"
```

The same instant rolled `weekStart` forward too, so **"this week" silently became
next week every Sunday evening**.

Three findings within the class were worse than a wrong list:

- **The family display.** A wall-mounted kitchen screen took the *server's*
  midnight (`setHours(0,0,0,0)`), which on a UTC host is 17:00 in California —
  the screen turned over to tomorrow's schedule in the middle of the afternoon,
  every day. It now uses the family's day bounds.
- **Medication reminders.** `generateFamilyNotifications` bounded "doses already
  logged today" at UTC midnight. In California that window opens at 17:00 local,
  so the morning dose looked untaken and the family was reminded again; in Tokyo
  it opens at 09:00 the *previous* local day, so yesterday's dose was mistaken
  for today's and **the reminder never fired**. A missed medication reminder is
  the worse of the two.
- **Allowance scheduling.** A parent setting up an allowance on Sunday evening
  in California had `next_run_on` dated from Monday.

The fix was already written and documented. `lib/services/scope.ts` has carried
`dayKeyInTz` / `zonedDayBoundsMs` all along, and its own header names this exact
bug — *"a household in America/Los_Angeles sees tomorrow's day key for the last
seven hours of every day"*. Four surfaces used it; nineteen never adopted it.
This finding is about adoption, not about inventing a mechanism.

Two helpers were missing and are added: `addDaysToDayKey` and `weekStartDayKey`,
both string-in/string-out so they never touch an instant and cannot be knocked
off by a DST transition. Measured: from local midnight on 26 Oct 2026, adding
seven *fixed* days lands at 23:00 on 1 Nov — a day short of the calendar answer.
The window where that bites is 26–31 Oct, which is precisely why spot-checking
one date misses it.

**Converted:** kitchen, readiness, agents, intelligence, planning, moments,
family-cfo, food, display, wallet actions, and the medication window in
`lib/server/notifications.ts`.

**Not converted, each with its reason**, recorded in the guard's allowlist rather
than left looking overlooked: `lib/network/aggregate-server.ts` (platform-wide
aggregation — UTC bucketing is what a cross-household benchmark should use),
`app/api/cron/wallet-allowance/route.ts` (platform-wide cron; bounded at one day
early for families west of UTC), and five background derivations that take a
`familyId` but no zone, so converting them means threading one through.

`tests/family-day-not-greenwich-day.test.ts` fails on any new surface that builds
a Greenwich day key beside a DATE filter without reaching for the zone helpers,
and a second case fails if an allowlist entry outlives its reason — an allowlist
that rots is how the next regression hides. Reverting the kitchen fix fails it;
restoring it passes. `tests/family-day-key-arithmetic.test.ts` pins the helpers,
including both DST directions.

One correction worth recording: my first two attempts at the DST assertion had
the direction backwards, and I only got it right by measuring across a year
rather than reasoning about it. Spring-forward arrives an hour *late* and stays
inside the right day; it is the autumn transition that lands on the previous
evening.

### F-018 · Nine family-scoped reads were sequential scans of whole tables

**Severity:** medium · **Status:** CLOSED — migration `0294`

A read filtered by `family_id` on a table with no index *leading* on that column
scans the whole table — every other household's rows included. The cost then
grows with the **platform**, not with the family, which is the shape that looks
fine in staging and becomes a page-load problem at scale. RLS sharpens it: the
policies gate on `family_id`, so the predicate is applied to every row on every
read whether or not the application also filters on it.

Measured on `sync_job_runs` loaded with **700,000 rows across 2,000 households**
— a year of quarter-hourly calendar syncs — running the query the sync history
page actually issues:

```
before   Parallel Seq Scan   38,258 buffers   ~46 ms   (46, 48, 46 ms)
after    Index Scan               54 buffers   ~0.30 ms (0.33, 0.30, 0.28 ms)
```

~150× faster, ~700× fewer buffers, and bounded by one family's rows.

Nine tables were in that state, each indexed in the order its page queries, so
one index serves both the filter and the sort:

| Table | Index |
|---|---|
| `sync_job_runs` | `(family_id, started_at desc)` |
| `guardian_routing_rules` | `(family_id, priority)` |
| `social_post_variants` | `(family_id, post_id)` |
| `activation_events` | `(family_id, milestone)` |
| `allowance_rules`, `meal_vote_options`, `meal_vote_ballots`, `move_boxes`, `crm_contacts` | `(family_id)` |

**What was deliberately left alone, and why it matters to the finding.** A first
pass flagged 27 more tables. Checked against `pg_index` rather than against the
migration text, **23 of those already had a leading index** from a `UNIQUE` or
`PRIMARY KEY` declaration on `family_id` — my SQL-text parser simply could not
see those forms. The remaining four — `ai_messages`, `member_badges`,
`marketplace_listing_shares`, `social_publish_jobs` — are each read by
`family_id` *alongside* a primary key or another indexed column, so the other
index already does the selective work and a `family_id` index would buy nothing
and cost write throughput.

So the rule is not "every family-scoped read needs a `family_id` index". It is
"a family-scoped read needs **some** selective index", and only nine had none.

That correction is the reason this closed as a SQL probe rather than a unit
test. `docs/audit/family-scoped-index-check.sql` asserts against `pg_index`,
where a UNIQUE or PK declaration is visible as the index it really creates;
reading the migration SQL for the same fact is what produced 23 false positives.
The probe also proves it can fail — it drops one index inside a transaction,
confirms the assertion notices, and rolls back — because a check that cannot
detect the state it forbids is decoration. Verified: 14/14 probes on a fresh
307-migration replay, twice, with the dropped index still present afterwards.

### F-019 · The money-safety probe asserted concurrency it never tested

**Severity:** medium (instrument) · **Status:** CLOSED — `docs/audit/wallet-concurrency-check.sql`

The product is correct. The *check* was not, and after F-015 that is a finding in
its own right.

`wallet-overspend-check.sql` says it proves `wallet_reserve_card_auth` "counts a
pending hold against the balance (so concurrent auths serialize under its FOR
UPDATE lock)". It runs a fixed **sequential** sequence. Nothing in it ever runs
two authorizations at once, so the single property most worth knowing about a
child's wallet — *you cannot spend the same dollar twice by tapping twice* — was
inferred from the presence of a lock rather than demonstrated.

Raced for real, two `$8` authorizations against a `$10` balance on separate
connections:

```
with FOR UPDATE (the shipped function)
  A-15 OK: 1 of 2 simultaneous $8 authorizations approved against $10; $8.00 held

with FOR UPDATE removed
  A-15 FAIL: 2 of 2 simultaneous $8 authorizations approved against $10 (a=t, b=t)
```

Two approvals is a child spending **$16 of a $10 balance**. So the lock is
load-bearing, the shipped behaviour is right, and that is now evidence instead
of an assumption.

Two things about the probe itself are worth recording, because both are mistakes
I made and then had to correct:

- **The seed cannot live in the `do $$` block.** That block is one transaction,
  its writes stay uncommitted, and a dblink session taking `FOR UPDATE` on those
  rows waits on it forever. The first draft hung exactly that way. The seed is
  now plain top-level statements, which psql commits one at a time.
- **Two plain `dblink()` calls are not a race.** They run one after the other,
  each in its own committed transaction — which proves a hold is counted *across*
  transactions, a weaker claim, and the same kind of overclaim this finding is
  about. It now uses `dblink_send_query` / `dblink_get_result` so both are
  genuinely in flight before either is collected.

Where `dblink` is unavailable the probe SKIPs with a notice rather than failing:
a check that cannot run is not a check that found a problem, and conflating the
two teaches people to ignore red.

Verified: 15/15 probes on a pristine 307-migration replay, and 15/15 twice in a
row on a used one.

### F-020 · The documented production-recovery procedure did not work

**Severity:** high · **Status:** closed — 18 migrations made re-appliable, and
the rehearsal is now a CI gate

`LB-016 §4.1` is the procedure an operator follows to unblock production. Its
whole basis is one sentence:

> Every migration in this repository is **additive and idempotent** … So the
> ledger does not need to be *told* what is applied; it repairs itself by letting
> `supabase db push` run from `0004`, where the already-applied migrations no-op
> and the genuinely missing ones land.

It cited two things as proof. **Neither one showed what it was cited for.**

- `tests/migrations-are-additive.test.ts` bans `DROP TABLE` / `DROP COLUMN` /
  `TRUNCATE` / `DROP TYPE`. That is *additive*. It says nothing about applying
  anything twice.
- The CI replay applies all 307 migrations to an **empty** database. On an empty
  database `create policy` has nothing to collide with, so the replay cannot
  observe idempotency even in principle.

Additive is not idempotent, and nothing in the repository had ever asserted the
property the recovery depends on. The one situation that exercises it is the one
situation it had never been run in: a database that *already carries the schema*
— which is precisely production.

**What the evidence said.** `docs/audit/rehearse-ledger-repair.sh` reproduces
production's condition exactly — full schema, ledger holding only `0001`–`0003`
— and replays from `0004` the way `db push` does: version order, each file in
its own transaction, a ledger row per success. Against the history as it stood:

```
re-applied cleanly (no-op as claimed): 286
FAILED:                               18
The operator's push would STOP at:
  0004_rls.sql :: ERROR: policy "profiles_insert_self" for table "profiles"
                         already exists
0004 recorded: 0  -> requiresBaselineReview would still be TRUE
```

It stopped on the **first file it tried**. And because `0004` never recorded,
`hasUnrecordedBaseline` would still have been true afterwards: the operator
would have spent the maintenance window and come out with the ledger no more
repaired than when they went in, the release still blocked, and no indication
of which of the remaining 17 files would have stopped them next.

**Why it broke.** Five ordinary Postgres statements are not idempotent and had
no guard: `create policy`, `create trigger`, `create table`, `create index`, and
`alter publication supabase_realtime add table`. Worth naming: **`create policy`
has no `IF NOT EXISTS` form in any Postgres version**, so there is no way to
write one that is safe to re-run — it must be preceded by a `drop policy if
exists`. `0004` already did that for three of its policies and not for the
others, which is the clearest possible sign this was an oversight rather than a
decision.

**The fix.** Each of the 18 follows the convention its own neighbours already
used — `drop policy if exists` first, `create or replace trigger`, `create index
if not exists`, `create table if not exists`, `add column if not exists`,
`create or replace function`, and a `pg_publication_tables` existence check
around the publication adds. Two needed more than a substitution:

- **`0018`** creates its policies inside `execute format(...)` over a table
  list. A static `drop policy if exists` cannot name a table that only exists as
  `%I` at run time, so the drop had to go *inside* the loop as its own
  `execute format`.
- **`0226`** failed for an entirely different reason, and it is the interesting
  one. It seeds 525 blog posts whose hero images are credited `LoremFlickr (CC)`.
  `0238` later installs a trigger that refuses any hero image whose licence it
  cannot identify, and `0231` nulls every LoremFlickr hero out. Replayed from
  scratch that ordering is fine — the rows go in before the trigger exists. But
  replayed against a populated schema the trigger is **already installed** when
  `0226` runs, and it rejects all 525 rows. So the seed was re-introducing
  exactly the data the product had decided to remove, and only the accident of
  ordering hid it. Seeding those three columns `NULL` reaches the identical end
  state (`0231`'s update now matches nothing; `0232`/`0235` still attach the
  real Unsplash covers) without ever putting an unverified licence in the table.

`0112` was left alone: it already had the publication guard, and the blanket
transform had nested a second, redundant one inside it. Reverted.

**After:**

```
re-applied cleanly (no-op as claimed): 304
FAILED:                               0
0004 recorded: 1
requiresBaselineReview would now be FALSE — the guard clears on its own
```

A from-scratch replay is unchanged at **307 applied / 0 failed**, checked after
every stage of the change rather than once at the end.

**It cannot silently break again.** The rehearsal is now the last step of the
`Database (migration replay · RLS boundary probes)` CI job. It runs last because
it rewrites the ledger and replays everything, so nothing may depend on the
database after it — and it is valuable *because* the job's earlier step already
applied every migration once, which means the rehearsal applies each of them a
**second** time. A migration added tomorrow is checked for idempotency on the
pull request that introduces it, not in a maintenance window years later.

I confirmed the gate actually fails rather than assuming it would, by adding a
deliberately unguarded `create policy` as `0999` and running the job's two steps
in order:

```
== migrations applied: 308, failed: 0 ==      <- the existing replay is happy
FAILED: 1
  0999_tmp_regression_probe.sql :: ERROR: policy "tmp_regression_probe" for
                                          table "profiles" already exists
REHEARSAL EXIT=1
```

The existing from-scratch replay passes it without complaint, which is the whole
point: the new step catches a class of defect the old one structurally could
not. The probe was then deleted and both runs re-verified clean.

The script refuses any `PGHOST` that is not a unix socket or the loopback
interface. That is a reachability test rather than a name allowlist — production
is a remote host, and neither a unix socket nor loopback can reach it from
anywhere — so it holds regardless of what a host is called.

**What this does not do.** It does not apply anything to production. F-001 is
still open and still an operator action. What changed is that the procedure the
operator will follow has now been executed end to end against a faithful
reproduction of production's condition, instead of being asserted.

## 4. Closed previously (regression-checked this pass)

| ID | Finding | Still closed by |
|---|---|---|
| C-001 | `weekly-digest` read `status`/`assignee_id` off `chores`; filtered `meal_plans` on `planned_for` — every digest skipped | `db:audit:queries` |
| C-002 | Meals AI insight selected `meals.servings` (a `recipes` column) | `db:audit:queries` |
| C-003 | `getUserContext` threw on `AuthSessionMissingError` — expired cookie became a full-page error | `auth-context-error-contract.test.ts` |
| C-004 | A failed `user_preferences` read took down every authenticated page | same test |
| C-005 | 14 chrome-mounting sections had no `error.tsx` | re-verified: every section with a layout has one |
| C-006 | `app_settings` RLS-enabled with no policy since `0023` | `0276` |
| C-007 | OAuth callback bounced a just-signed-in user to `/login` | `auth-callback-boundary.test.ts` |
| C-008 | Sign-out unreachable from two gates (`<a href>` vs POST-only route) | `persistent-login.test.ts` |
| C-009 | `/dashboard/conflicts` emitted unbounded HTML | crawl: renders clean |
| C-010 | Knowledge Center showed English under translated headings | `0277` |
| C-011 | `rpc('public_handled_stats')` undefined — marketing figures silently zero | `0278` |
| C-012 | `privacy-export` failed nightly 00:00–04:00 UTC | suite green |

---

## 5. Reviewed, not a defect

- **Service-role client in `dashboard/settings` and `dashboard/billing`.** Both
  read global, non-secret config (referral config; Stripe fee display) under
  `(app)/dashboard/layout.tsx`, whose `AppFrame` calls `requireUserContext`. No
  user input reaches either query.
- **17 `TODO(migration …)` markers.** Each names a schema change deliberately
  deferred for owner approval — documentation of a boundary, not dead code.
- **1 lint warning** (`react-hooks/exhaustive-deps`), pre-existing.
- **`/gift/<bad token>`, `/pay/<unknown>`, `/s/<unknown>` answer 200.** These
  render an explicit "not found / expired" state rather than a bare 404, which
  is the better answer for a link someone was handed.

---

## 6. Verification log

| What ran | Result |
|---|---|
| `tsc --noEmit` | clean |
| `next lint` | 0 errors, 1 warning |
| `vitest run` | 13,518 tests passed |
| `next build` | exits 0 |
| `db:audit:queries` | passed |
| `db:audit:migrations` | passed, next version 0291 |
| `i18n:gate` | clean |
| fresh-DB migration replay | 302/302 applied, 0 failed |
| `run-probes.sh` (fresh 306-migration replay, ×3) | 13/13 every run; the five privileged RPCs still service-role-only afterwards |
| 353-route authenticated crawl | 351 ok · 1 gate redirect · 0 failures |
| unknown-slug probe, 16 public routes | all degrade correctly after F-005 |
| API guard sweep | 140/140 guarded or declared public |
| `authenticated.spec.ts` + `concierge.spec.ts` | both pass (needed `E2E_PROVIDER_STUB=1`) |
| all 6 cron routes, live stack | each completes and reports; no run aborts |
| `readAll` vs live PostgREST, 3 tables | 2012 / 3709 / 1420 rows, all distinct; unbounded returns 1000 |
| old paging loop vs a 500-row server cap | returned 500 of 2011, `error=null` — the defect F-011 closes |
| `/sitemap.xml` on the running build | 1,049 blog URLs (was 1,048), 141–226 ms |
| F-012 guard with the fix reverted | 3 of 4 tests fail — not vacuous |
| `/blog`, `/blog/audit-fixture-post` | 200, 363 ms / 200 |
| all 11 cron routes, live stack | each completes and reports; no run aborts |
| 20 changed pages (wallet, marketplace, admin, dashboard) | 200 each |
| `.limit(n > 1000)` scan of `app/` + `lib/` | 0 remaining; guard fails on a planted one |
| PostgREST request-line limit, binary search | 200 at 6,268 bytes · 414 at 9,418 |
| notifications cron ×5 | URI-too-long: 0 · duplicate groups 117 → 117 |
| pristine replay, grants before any probe | five privileged RPCs service-role-only |
| `git check-ignore cookies.json` | ignored (was untracked and committable — F-016) |
| day-key drift, every minute of a day, 9 zones | LA 29.2% · NYC 16.7% · Tokyo 37.5% · Sydney 41.7% |
| meal-plan read at 18:30 Sunday in LA | rendered tomorrow's dinner; now renders tonight's |
| DST week arithmetic, measured across 2026 | 26–31 Oct: +7 fixed days lands a day short |
| F-017 guard with the kitchen fix reverted | fails — not vacuous |
| `sync_job_runs` at 700k rows / 2,000 households | 38,258 buffers · 46 ms → 54 buffers · 0.30 ms |
| 27 further tables checked against `pg_index` | 23 already indexed via UNIQUE/PK; 4 covered by another index |
| A-14 probe, index dropped in a rolled-back txn | the check detects it — not decoration |
| 2 overlapping $8 auths vs a $10 wallet | 1 approved, $8 held — the lock serializes them |
| the same race with `FOR UPDATE` removed | 2 of 2 approved ($16 of $10) — the probe catches it |
| `run-probes.sh`, pristine replay and used DB | 15/15, and 15/15 twice in a row |

---

# Pass C — Write honesty (C-01–C-08)

One question, asked of every write in `app/` and `lib/`: **when this is refused,
does anything notice?**

The answer was no in more places than it should have been, for one reason that
is invisible to every tool the repository runs. A PostgREST call RESOLVES with
`{ data, error }` and rejects only under `.throwOnError()`. The library's own
source does this:

```js
this.shouldThrowOnError = false;                        // default
if (!this.shouldThrowOnError) res = res.catch((fetchError) => { ... });
```

So `await supabase.from(t).insert(row)` with the result discarded cannot fail
visibly — not on an RLS denial, not on a constraint violation, not on a dead
connection. `tsc` has nothing to say either: awaiting a promise and ignoring its
value is legal. A `try/catch` around one of these looks like error handling and
is not; the catch can only ever see a synchronous throw while the query is being
built.

- **Audit head:** `a041b398` (main, after Passes A and B)
- **Method:** a scan for the shape — statement-position `await …from(t).<mutation>` —
  then one question per hit rather than a blanket fix. 55 hits across 37 files;
  most are genuinely fire-and-forget and are untouched.
- **What promotes a hit to a finding:** something downstream *claims* the write
  landed — a success page, a counter in a response, a row that records the
  outcome, or a screen whose whole job is showing what happened.

Two hits were checked and deliberately left, and the reasons are in the code:
`app/api/blog/like` and `blog/save` discard their toggle deletes but then re-read
the real state and return THAT, so a failed delete reports the truth; and
`app/(auth)/actions.ts` was already correct — its brute-force counter reads its
error and every caller refuses the sign-in when the write fails.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| C-01 | `logAudit`'s catch could never run — every caller lost audit rows silently, plus 10 wallet-audit sites written longhand | High | **Fixed** — #531 `3e05006b` |
| C-02 | An emergency escalation recorded `push_sent: true` for a notification that was never written | High | **Fixed** — #531 |
| C-03 | Three more urgent notification writes failed silently — a Guardian screening call, an urgent message, a voicemail | High | **Fixed** — #531 |
| C-04 | "Account disconnected and access revoked" shown when neither had happened | High | **Fixed** — #532 `ed85df8a` |
| C-05 | A family routine could be wedged permanently by one transient write failure | High | **Fixed** — #532 |
| C-06 | Twelve provider-sync writes discarded their errors; both tables are read by surfaces people act on | Medium | **Fixed** — #532 |
| C-07 | An unsubscribe that was never recorded still said "Unsubscribed" | High | **Fixed** — #536 `a041b398` |
| C-08 | Three counters reported work that did not happen — push prune, trust audit, card authorization | Medium | **Fixed** — #536 |

Nothing in Pass C is open. Every fix is on `main` and verified live.

---

## C-01 — `logAudit` could not report a failed audit write *(High, fixed)*

`lib/server/audit.ts` wrapped its insert in `try/catch` and logged from the
catch. Per the mechanism above, that line had never run and could not run, so
every audit-write failure across **all 14 callers it had at the time** was silent
by construction: a child login created, a PIN reset, an admin action, an
onboarding step — none recorded, nobody told. (It has 17 today: the fix also
converted three sites that were writing `audit_logs` longhand and discarding the
error, which the wallet-only sweep could not see.)

The same shape was written out longhand at **ten wallet-audit call sites**,
including the credit and debit paths in `lib/wallet/server.ts`, so a transfer, a
card spend, a card issue or a claimed Pay-ID could complete with no audit row at
all. `app/(app)/money/actions.ts` already did it correctly through a local
helper, which is the shape the rest should have had.

Both now read the error. The wallet helper is shared as `logWalletAudit`, and all
**14** wallet-audit sites go through it — the 10 that discarded their error plus
the four that were already correct, so there is one implementation rather than
two idioms and eight silent copies. It deliberately does **not** fail the caller:
by the time it runs the money has already moved, and refusing a completed
transfer because its log failed would turn a bookkeeping problem into a financial
one.

**Proof:** `tests/audit-write-failures-are-visible.test.ts`, built on a fake
client that RESOLVES with an error the way PostgREST does. Against the original,
the case that matters fails with *"a refused audit write produced no output at
all"*.

## C-02 — An emergency escalation recorded a push that never happened *(High, fixed)*

The sharpest instance in the pass, because it did not merely stay silent — it
wrote down the opposite of what happened. `app/api/guardian/escalate/route.ts`:

```ts
try {
  await supabase.from('notifications').insert({ ... });
  pushSent = true;
} catch { /* non-fatal */ }
```

The insert resolves rather than throwing, so a refused write never reached the
catch and `pushSent = true` ran anyway. That value is not cosmetic: it is written
into the `guardian_escalations` row as `push_sent` and returned to the caller. An
emergency escalation was therefore recorded, permanently, as having alerted the
parents when nothing had been written — and the audit trail of the emergency
asserted it too.

`pushSent` now becomes true only on the no-error branch.

## C-03 — Three more urgent notification writes were silent *(High, fixed)*

The same dead catch on a Guardian screening call, an urgent Contact Center
message and an urgent voicemail. Each wrapped its insert in `try/catch` with a
`console.error` that could not run, so an urgent message reached nobody and left
no trace of having failed. All three now read the error.

**Deliberately not done here:** routing these four through the `notify()` service,
which would also give them dedupe, recipient resolution and an urgent-flagged
quiet-hours bypass. That is the right destination, but it is a larger change on
Guardian emergency paths that could not be exercised end to end from the audit
environment. Making the failure visible is the part that should not wait.

## C-04 — "Account disconnected and access revoked", when neither had happened *(High, fixed)*

Both sync disconnect routes discarded the result of the delete that **is** the
disconnect, then redirected unconditionally:

```ts
await admin.from('sync_accounts').delete().eq('id', account.id);
...
return NextResponse.redirect(new URL(`...?disconnected=1`, ...));
```

`disconnected=1` renders *"Account disconnected and access revoked."* So a
refused delete left the row in place — the account still connected, still syncing
on the next run — and told the member their access was gone. Of every write in
the pass this is the one whose failure may least be reported as success: being
told access was revoked is exactly what stops someone checking again.

The provider-generic route also claimed revocation in three cases where none
happened — no adapter, no refresh token to present, or `revokeToken` throwing
into `.catch(() => {})`. Best effort is a fine design; saying it worked is not.

The delete's error now answers a `danger` banner saying access has **not** been
revoked, and a disconnect that could not withdraw the grant says so and points
the member at the provider.

## C-05 — A routine that fires once and then never again *(High, fixed)*

`app/api/cron/family-routines/route.ts`, at the end of the fire loop, updated
`next_run_at` and discarded the result. That write is the only thing that moves a
rule off the occurrence it just handled. Refused, `next_run_at` keeps a `due_at`
that has already passed — so the next tick selects the same occurrence, collides
`23505` on the reservation, and hands it to `releaseWedgedOccurrence`, which
returns immediately because that guard is for reservations that never became a
request **and this one did**. Nothing else advances the rule.

One transient error and the family's routine is wedged for good, on a tick that
reported `ok: true`. It now reports the rule in `problems`.

`armPendingRoutines` had the same shape with a different cost: `armed += 1` ran
unconditionally after its update, and `armed` exists — its own comment says so —
*"so a quiet tick is distinguishable from a broken one."*

**Proof:** three behavioural cases in `tests/cron-family-routines.test.ts`; the
in-memory harness now lets one specific update resolve with an error, so the
wedge is reproduced rather than asserted about.

## C-06 — Twelve provider-sync writes discarded their errors *(Medium, fixed)*

`sync_audit_logs` and `sync_provider_errors` were written longhand at twelve
sites, every one discarding the result. Neither is telemetry nobody reads:

| table | read by | cost of a lost write |
|---|---|---|
| `sync_audit_logs` | `/dashboard/sync/history` | a gap in the member's account history — and `disconnect` is one of its actions, so the missing row is the one someone goes looking for |
| `sync_provider_errors` | admin sync page, `.eq('is_fatal', true)` | a broken integration looks healthier than it is, on the screen used to decide whether to act |

Both now go through `logSyncAudit` / `logSyncProviderError`. **Two callers
deliberately do not**, because they do something with the failure the helper
cannot express — the cron route counts audit failures into its response, and
onboarding throws, treating a connection it cannot produce a receipt for as
failed. Both are exempt by name with a reason, and the test checks the reason
still holds.

## C-07 — An unsubscribe that was never recorded still said "Unsubscribed" *(High, fixed)*

`app/api/marketing/unsubscribe/route.ts`:

```ts
await supabase.from('marketing_suppressions').upsert({ email: clean, reason: 'unsubscribe' });
return page('Unsubscribed', `${clean} will no longer receive marketing emails…`, true);
```

That upsert **is** the unsubscribe — `lib/marketing/send.ts` drops an address from
a campaign only by finding its row. The result was discarded and the page
promises, unconditionally and with a tick and a 200, that the mail stops. A
refused write sent a person away believing they had opted out, and the next
campaign mailed them anyway.

What makes this a gap rather than the house style is that every other path
touching this table already treats the write as load-bearing:

| path | on failure |
|---|---|
| `lib/marketing/send.ts` | **throws and abandons the whole send** if it cannot even *read* suppressions — it would rather mail nobody than risk mailing someone who opted out |
| `app/api/webhooks/resend/route.ts` | answers **503** so a bounce/complaint write is retried |
| the unsubscribe a person clicks | said "✓ Unsubscribed" |

Both machine-facing paths are rigorous. The one path where a human is told
something was the one that did not check.

The status is not cosmetic either: `POST` here is the **RFC 8058 one-click
endpoint**, and a 2xx is what tells Gmail or Yahoo the opt-out was honoured.
Answering 200 on a failed write spends the provider's only signal on a promise
that was not kept. It now answers 503 and says the mail may still come — the only
wording that gives the reader a reason to try again.

The route had no test at all before this; the existing `marketing-unsubscribe`
spec covered only the token helpers, which is how it survived.

## C-08 — Three counters that counted what did not happen *(Medium, fixed)*

- **`lib/server/push.ts`** incremented `result.pruned` after a delete whose error
  was discarded. A dead endpoint (404/410) that cannot be removed is retried on
  every later notification, spending a send each time and reporting itself
  cleaned up each time. *This is the pass's one duplicate: the same defect was
  found independently on `codex/final-production-audit-20260912`. Both fixes are
  the same; `main`'s also logs which device failed.*
- **`lib/trust/server.ts`** said `// Explainable audit trail — always recorded.`
  above an insert that discarded its result, so it was not always recorded. That
  table is what `dashboard/trust` renders (the last forty decisions, with actor,
  capability, decision and reason) and what `api/privacy/export` cites. A lost row
  is a decision the family **cannot see**, including a denial or one that needed
  their approval. Deliberately still non-fatal: callers act on the returned
  decision, and failing one because its explanation failed to log would take the
  AI layer down, denials included.
- **`lib/stripe/webhook.ts`** recorded a card approve/decline "best-effort" and
  silently. Best-effort is right and must stay — Stripe has already been told, and
  throwing would answer the webhook non-2xx and have Stripe redeliver a decision
  that is already final. Silence is not right, because the admin Stripe page and
  the assistant both answer *"why was this declined"* from those rows.

---

## How Pass C is kept closed

Four guards, **45 cases**, each proved load-bearing by reverting the fix and
watching the matching case fail alone:

| guard | cases | what it holds |
|---|---|---|
| `tests/audit-write-failures-are-visible.test.ts` | 14 | `audit_logs` / `wallet_audit_logs` are never written longhand with the result discarded |
| `tests/sync-write-failures-are-visible.test.ts` | 16 | the two sync tables go through the helper, the disconnect reads its delete, and the page can render "not revoked" |
| `tests/claimed-writes-that-did-not-land.test.ts` | 9 | the prune counter (driven behaviourally), the trust and Stripe rows, and a sweep over four tables |
| `tests/marketing-unsubscribe-route.test.ts` | 6 | the real route: 503 and no claim when the write fails, 200 and the claim when it lands |

Each sweep names the offending **file and line** when a new instance appears, so
the next one fails on the way in rather than being found by a later audit.

---

# Pass D — Server-action authorization (0 findings)

One question, asked of every export of every `'use server'` module: **does this
establish who is calling — and does authenticating them actually constrain what
they can write?**

The surface matters because a server action is not a function call. Every export
of a `'use server'` module is compiled into an HTTP endpoint with its own action
id, and the client can invoke it directly. The component that normally calls it
is not a gate; neither is the page's own access check. Whatever the action does
for a caller who reached it by other means is what it does.

- **Audit head:** `a7ed83c5` (main, after Passes A, B and C)
- **Surface:** 127 `'use server'` modules · 487 exported async actions · 114 of
  them in modules that hold a **service-role** client
- **Why the service-role modules are the ones that matter:** the user client is
  checked by RLS, so a forged id is refused by the database whatever the action
  does. The service client is checked by nothing.
- **Result:** 12 candidates, all 12 cleared against the code. A second, sharper
  sweep for cross-tenant writes returned 2, both correct. **No findings.**

## The false-positive class that nearly produced 33

This is recorded because the intermediate result was wrong in a way that looked
authoritative, and the same mistake is available to anyone who repeats this
audit with the obvious tool.

A text scan finds an action's body by taking the first `{` after its parameter
list. That is not the body when the return type contains an object:

```ts
export async function issueCardAction(input: {
  childWalletId: string; type: 'virtual' | 'physical'; …
}): Promise<Result<{ cardId: string }>> {
  const ctx = await requireUserContext();   // ← the guard, on line 3
```

Brace matching walks the parameters, then takes the next `{` — which opens
`{ cardId: string }`, **inside the return type**. The extracted "body" is a type
literal containing no guard, so the action is reported unguarded while its third
line is `await requireUserContext()`. Every action annotated with an object type
in its return position was flagged this way.

Three formulations of the scan returned **33**, then **48**, then **52**
candidates — the count moving with the regex rather than with the code, which is
the tell. Parsing the modules with the TypeScript compiler instead returned
**12**, and found 15 modules and 50 actions the text scan had missed entirely.
None of the 33 was ever reported as a finding; the correction is here so the
number is not mistaken for a result later.

## The 12 candidates, and why each cleared

| Action | Why it is not a finding |
|---|---|
| `app/(app)/dashboard/inbox/actions.ts:inboxRequestText` | Not an endpoint in the meaningful sense: a pure string composer over its own arguments, exported so a test can pin it without a database. Reads nothing, writes nothing |
| `app/(auth)/actions.ts:stitchIdentityAction` | Authenticates via `supabase.auth.getUser()` and returns early when there is no user — the sweep's guard list did not include the bare property form |
| `app/(auth)/actions.ts:childSignInAction` | A sign-in cannot require a session. Rate-limited by IP and throttled per username via `child_login_throttle`, checked *before* the password path and even for unknown usernames, so it is not a lookup oracle |
| `app/gift/actions.ts:submitGiftPledgeAction` | Public by design; the unguessable link token **is** the authorization. Rate-limited, pledges written `pending` a parent's approval, pending pledges per link capped at 25 |
| `app/reviews/new/actions.ts:submitReviewAction` | Public review form, rate-limited; writes `pending` unless the rating clears the configured auto-approve threshold |
| `app/s/[slug]/actions.ts:submitResponseAction` | Public survey, respondents may be anonymous; the slug must resolve to a live, active, non-deleted survey and the score must sit inside that survey's own scale |
| `app/onboarding/actions.ts:previewCalendarImportAction` | Authenticates, then writes nothing at all — the value-first preview step is computed in memory |
| `app/onboarding/actions.ts:saveFamilyDetailsAction` | Authenticates, then writes through the **user** client. Verified against the policy rather than the comment: `0052_family_onboarding.sql:39` is `FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id))`, so the `WITH CHECK` refuses a forged `familyId` |
| `app/onboarding/actions.ts:resetOnboardingAction` | Authenticates, then every service-role write is keyed on `auth.user.id` — it cannot address another account |
| `app/onboarding/actions.ts:finalizeOnboardingAction` | Authenticates and fails closed on the auth error before any write |
| `app/onboarding/calendar-actions.ts:startCalendarConnectionAction` | `auth.getUser()`, then `verifyOnboardingOwner`, then `assertOnboardingCalendarAccess` — twice, the second time against the family it just prepared |
| `app/onboarding/calendar-actions.ts:previewConnectedCalendarAction` | `auth.getUser()`, then the `sync_accounts` read is scoped `.eq('user_id', auth.data.user.id)`, so another user's `accountId` resolves to nothing |

## The sharper question: authentication is not authorization

"Does it have a guard" is the weaker of the two questions. `requireUserContext()`
answers *who is calling*; it does not answer *which family they may touch*. An
action that authenticates and then hands a **caller-supplied** family id to the
**service** client has no boundary left — RLS is not in the path.

A second sweep looked for exactly that: an exported action that constructs a
service client and keys a read or write on a `family_id` whose value traces back
to its own parameters. Two hits, both in `app/(app)/admin/actions.ts`:

| Action | Verdict |
|---|---|
| `adminCreateUserAction` | `assertSuperAdmin()` with an early return, before anything else. Cross-family is the point of the admin console, and the action is audited via `site_admin` |
| `adminSetFamilyPlanAction` | Same gate, same early return; audited, and the plan is validated against `ASSIGNABLE_PLANS` |

Both are correct. The rest of the 114 either take the family from the
authenticated context or go through the user client.

## How Pass D is kept closed

`tests/server-action-authorization.test.ts` — **8 cases**, the two sweeps above
plus four that prove the detector can see.

| what it holds | how |
|---|---|
| Every action in a service-role module reaches a guard, or is on `PUBLIC_BY_DESIGN` with a written reason | AST walk, resolving guards transitively through same-module helpers |
| A caller-supplied family id reaching the service client is super-admin gated | the parameter-to-`family_id` dataflow sweep, reported with file, line and the parameter it traced to |
| The public allowlist cannot rot | a stale entry fails; so does a reason under 40 characters, because an unexplained exemption is how the next one gets added |
| The detector is not blind | four synthetic modules, including the exact return-type-brace shape that defeated the text scan |

Both sweeps report nothing today, which is the condition under which a guard is
easiest to get wrong — a sweep that cannot see is indistinguishable from a clean
codebase. So each was proved load-bearing against the real code:

- Replacing `requireUserContext()` in `issueCardAction` with a literal made the
  first sweep fail naming `app/(app)/money/actions.ts:109  issueCardAction`, and
  only that.
- **Downgrading** `assertSuperAdmin()` to `requireUserContext()` in
  `adminSetFamilyPlanAction` left the first sweep green — it has a guard — and
  failed the second, naming the three lines where `input.familyId` reaches the
  service client. That is the case the weaker question misses, and it is caught.

Both mutations were reverted; `git status` and `tsc --noEmit` confirm the tree is
unchanged apart from the new test.

---

# Pass E — Read honesty (E-01)

Pass C asked, of every write: *when this is refused, does anything notice?* This
asks the same question of **reads**, and it is the same library fact in the other
direction. A PostgREST read also resolves with `{ data, error }`, so

```ts
const { data } = await supabase.from('trust_policies').select('id')…;
```

cannot fail visibly. `data` comes back `null` — which is exactly what "there is
no such row" looks like. The two are indistinguishable to the code that follows.

- **Audit head:** `2608b556` (the branch, after Passes A–D)
- **Surface:** 210 reads across 101 tables discard their error
- **What promotes a hit to a finding** — narrower than Pass C's, deliberately:
  a rendered empty state is usually a survivable degradation, so a hit counts
  only when the absence is treated as a **fact** and something is decided on it.
  Most of the 210 render; one decides.

Two were checked closely and are correct as they stand. `resolveEntitlement`
(`lib/server/entitlement.ts`) drops the error on its `family_members` read and
falls back to *unlocked, level 0* — and says so in its doc comment. That is the
free tier, the least privilege it can grant, so the failure direction is
conservative. `submitReviewAction` drops the error on `reputation_settings` and
therefore leaves `autoMin` null, which sends the review to **pending**
moderation rather than publishing it. Both fail in the safe direction.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| E-01 | Turning Autopilot off could leave it on, and every retry made it worse | High | **Fixed** — this branch |

---

## E-01 — The autopilot dial could report success without taking effect *(High, fixed)*

`setConciergeAutopilotAction` is the family-facing switch for whether Bubaly acts
on its own: `auto` → `allow`, `ask` → `require_approval`, `off` → `deny`. Its
doc comment says it writes **ONE** system trust policy. It did not enforce that.

```ts
const { data: existing } = await sb
  .from('trust_policies').select('id')
  .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME).maybeSingle();

if (existing?.id) { /* update that row */ } else { /* INSERT a new policy */ }
```

The read's error was discarded, so a refused read returned `data: null` and the
`else` branch ran. Four facts compound from there, each verified rather than
assumed:

1. **Nothing in the schema stops a duplicate.** `0093_trust_engine.sql` gives
   `trust_policies` two indexes, `idx_trust_policies_family` and
   `idx_trust_policies_domain` — both non-unique. There is no unique key on
   `(family_id, name)`.
2. **Two rows change the answer.** The insert hard-codes `priority: 10`, so a
   duplicate ties with the original. `lib/trust/engine.ts:283` filters the
   matching policies, sorts by `b.priority - a.priority`, and takes
   `matching[0]`. `Array.prototype.sort` is stable, so a tie is resolved by
   **list position**.
3. **List position was undefined.** `loadTrustInputs` selected the policies with
   no `ORDER BY`, and a Postgres select without one has no guaranteed row order.
   So which of the two governed could differ between two identical requests.
4. **It ratcheted.** Once two rows exist, `.maybeSingle()` *itself* fails. From
   postgrest-js's own source:

   ```js
   if (this.isMaybeSingle && Array.isArray(data)) {
     if (data.length > 1) {
       error = { code: 'PGRST116', ... };
       data = null;
   ```

   `data` is set to null **and** an error is set. With the error discarded, every
   later save read null again and inserted yet another policy. The dial could
   never take effect again through the UI — and returned `{ ok: true }` each time.

The consequence is the reason this is High rather than Medium. A parent who set
Autopilot to **off** could be left with a stale `allow` still deciding whether
Bubaly executes accepted plans unattended. This is proved rather than asserted:
the guard evaluates the real engine with the two policies in each order and gets
`allow` one way and `deny` the other, from the same two rows.

### The fix, and why it is shaped this way

The read is gone. The update is keyed on the **filter** rather than on an id read
back, and the insert runs only if the update matched nothing:

```ts
const { data: updated, error: updateError } = await sb.from('trust_policies')
  .update({ effect, enabled: true })
  .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME)
  .select('id');
if (updateError) { …log…; return { ok: false, error: updateError.message }; }
if ((updated ?? []).length === 0) { /* insert */ }
```

This is both the fix and the **repair**. It moves every row of that name, so any
duplicates already in a family's database converge to the same effect and the
engine's choice between them stops mattering. That property is required, not
incidental: the production migration ledger is gated (Pass A **F5** / Pass B
**F-001**), so a corrective unique index cannot currently be applied there, and
the fix has to work on unmigrated data.

`loadTrustInputs` now also orders the policies —
`.order('priority', …).order('created_at', { ascending: false })` — so a tie
between any two policies resolves the same way twice, newest first. That closes
the general case behind E-01 rather than only the autopilot instance of it.

A unique index on `(family_id, name)` remains the right belt-and-braces once the
ledger is repaired. It is **not** required for the fix above to hold.

## How Pass E is kept closed

`tests/autopilot-dial-takes-effect.test.ts` — **9 cases**.

| what it holds | how |
|---|---|
| Every policy of that name is moved, not one id read back | asserts the update's filters carry `family_id` + `name` and **no** `id`, with two rows present |
| A refused write reports failure | the decisive case: the dial returned `ok: true` on a write nobody checked |
| A refused read is never read as "no policy yet" | asserts no insert follows a failed update |
| Each dial position maps to the effect the engine obeys | `auto`/`ask`/`off` → `allow`/`require_approval`/`deny` |
| Non-managers are refused before any write | no update, no insert |
| **Why a leftover row mattered** | drives the real `evaluateAction` with both orderings and shows the same two rows give opposite answers — then shows convergence makes order irrelevant |
| The load is ordered | fails if the `.order()` calls are dropped from `lib/trust/server.ts` |

Proved load-bearing by reverting each fix: restoring the original
read-then-branch fails **5 of the 9**, and dropping the `.order()` calls fails
the ordering case alone.

One correction worth recording, because it nearly became a wrong finding. The
first version of the engine fixture returned `deny` for *both* orderings, which
would have read as "deny always wins" — a safe engine and no finding. It was
neither: the fixture used an actor of kind `'ai'`, and `policyApplies` matches a
`subject_kind: 'ai'` policy against an actor of kind **`'ai_agent'`**. Both
policies were being filtered out and the result was the *fallback* deny, which
the decision's `basis: 'fallback'` said plainly. The fixture was wrong, not the
engine. Checking `basis` rather than `effect` is what separated the two.

---

# Pass F — Public API routes (F-a, F-b)

Middleware is the outer session boundary, but a route under a `PUBLIC` prefix is
deliberately *outside* it: the request reaches the handler with no session at
all. So two questions, asked of each one — does it **authenticate itself**, and
does it **only claim what it can support**?

- **Audit head:** `799dd633` (the branch, after Passes A–E)
- **Surface:** 140 `route.ts` files; **98** sit under one of the 24 public `/api`
  prefixes in `middleware.ts`
- **Authentication result:** 94 of 98 have a self-authentication path; the
  remaining 4 were read individually and all 4 are correct. **No finding.**
- **Honesty result:** **2 findings**, both on routes the earlier passes could
  not see — and the reason they could not see them is itself recorded below.

## Authentication: 4 candidates, 4 cleared

| Route | Why it is not a finding |
|---|---|
| `/api/health` | Documented as booleans, latency and missing-var **names** only. Verified against the code rather than the comment: `checkRequiredEnv` returns `{ ok, missing }` where `missing` is `REQUIRED_ENV.filter(…)` — names, never values |
| `/api/build-info` | Returns one build-time literal. No request input, no lookup |
| `/api/exit-intent/resolve` | Public marketing offer; IP rate-limited at 60/min, bounded body, no family data |
| `/api/blog/unsubscribe` | Token-authorized after all — `?token=` is validated as a UUID and matched against `unsubscribe_token`. The sweep's pattern list simply lacked that column name |

The first sweep reported **43** bare routes. That was wrong for one reason worth
keeping: it read each route's own text, and **24 cron routes hold their check in
a shared helper**, `hasCronAuthorization` from `lib/server/cron-auth`. Resolving
imports two levels deep took 43 → 4. This is the same failure as Pass D's
return-type brace: a scan that does not follow the code reports the shape of its
own pattern.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| F-a | The blog unsubscribe confirmed an unsubscribe that was never written, and blamed the reader's link for a failed read | High | **Fixed** — this branch |
| F-b | Activating emergency mode discarded the only record of who activated it | High | **Fixed** — this branch |

---

## F-a — "You've been unsubscribed" over a row that still said subscribed *(High, fixed)*

`/api/blog/unsubscribe` discarded **both** results:

```ts
const { data } = await supabase.from('blog_subscribers')
  .select('id, status').eq('unsubscribe_token', token).maybeSingle();

if (data && data.status !== 'unsubscribed') {
  await supabase.from('blog_subscribers').update({ status: 'unsubscribed', … }).eq('id', data.id);
}
home.searchParams.set('unsubscribed', data ? '1' : 'invalid');
```

Two different lies, from one route:

- **A refused update** still redirected to `unsubscribed=1`, whose banner reads
  *"You've been unsubscribed from blog updates."* The row still said subscribed,
  so the next digest goes out to them. This is C-07 exactly, on a second route.
- **A refused lookup** produced `data: null`, indistinguishable from "no such
  token", and was reported as `invalid` — *"That unsubscribe link doesn't look
  right"*. A real subscriber holding a real link, told the link was wrong.

Both results are now read. A failure redirects to a third state, `error`, and
the blog page renders it — *"we couldn't complete that just now, so you may still
receive blog emails"* — because a route that redirects to a state the page cannot
show has moved the problem rather than fixed it.

## F-b — Emergency mode could be activated with no record of who did it *(High, fixed)*

`activateEmergencyAction` writes the `trust_audit_logs` row that is the **only**
record of who turned emergency mode on and why. Its result was discarded:

```ts
await (await ledgerWriter(supabase)).from('trust_audit_logs').insert({ … });
```

Emergency elevation, by the file's own comment, *"outranks every deny, policy and
risk tier"* — it is the most powerful state the trust engine has. A refused
insert left a family with a live elevation and nothing saying who started it, on
the two surfaces built to answer that question: `dashboard/trust` renders these
rows and `api/privacy/export` cites them.

The fix reads the error and logs the family, the kind and the activating member.
It is deliberately **non-fatal**, for a reason specific to this action: the
`emergency_sessions` insert above has already succeeded, so the elevation *is*
live. Returning an error to a parent mid-emergency invites them to activate it
again, which is worse than a missing log line. It must not fail; it must not be
silent either.

## Why Pass C missed both — a hole in its own guard

Both instances are exactly the class Pass C swept for, on tables Pass C was
watching in one case. They survived because of how its sweep matched:

```js
if (!new RegExp(`^\\s*(?:void\\s+)?await\\s+[\\w.]*\\.from\\('${table}'\\)`).test(line)) return;
```

It required `.from('t')` on the **same line** as the `await`. Both offenders
break the chain across lines — `await supabase` ⏎ `.from('blog_subscribers')`,
and `await (await ledgerWriter(supabase)).from(…)`, which `[\w.]*` cannot match
either way. The sweep reported clean over both.

This was found honestly rather than by inspection: `blog_subscribers` was added
to the watched set, the fix was reverted to check the guard was load-bearing —
**and it still passed**. That vacuous pass is what exposed the hole.

The sweep now joins an eight-line window and cuts at the statement end before
matching. Re-run against the same tree it immediately found **F-b**, which no
pass had seen. A guard that cannot see the common formatting of the thing it
forbids is decoration.

## How Pass F is kept closed

| guard | cases | what it holds |
|---|---|---|
| `tests/public-route-write-honesty.test.ts` | 8 | drives the real route: confirms on a landed write, `error` on a refused write, `error` (not `invalid`) on a refused lookup, `invalid` only for a genuinely unknown token, no DB call for a malformed token, idempotent on an already-unsubscribed row, and the page can render the third state |
| `tests/claimed-writes-that-did-not-land.test.ts` | 10 | the multi-line-aware sweep, now over **five** tables |

Proved load-bearing by reverting: restoring the original route fails the two
cases that matter — the refused write and the refused lookup — and leaves the six
that describe unchanged behaviour passing.

**Noted, not fixed:** `endEmergencyAction` writes no audit row at all. Ending an
elevation is arguably as worth recording as starting one, but that is a missing
feature rather than a discarded result, and inventing scope mid-pass is how an
audit stops being checkable. Recorded here instead.

---

# Pass G — RLS completeness (0 findings)

RLS is the only thing standing between one family's rows and another's, because
the grant layer deliberately does not: hosted Supabase ships
`alter default privileges in schema public grant all on tables to anon,
authenticated, service_role`, and `docs/audit/pg-bootstrap.sh` reproduces exactly
that so the probes test the real posture. **488 of 491 tables grant `anon` full
DML.** That is not a finding — it is the model — but it does mean a single table
with RLS off, or one blanket policy, is the whole boundary gone.

- **Method:** not a text scan. A real replay — Postgres 16.13, `pg-bootstrap.sh`,
  **307 migrations applied, 0 failed** — then `pg_catalog` asked directly.
- **Result:** **491 of 491** public tables have `relrowsecurity` set. Zero
  exceptions. The repo's 15 existing boundary probes pass on that same fresh
  replay, 15/15.

## Why this pass is a replay and not a grep

The first attempt counted `ALTER TABLE … ENABLE ROW LEVEL SECURITY` in the
migrations and reported **129 tables unprotected**. The real answer is **zero**.
Two reasons, both invisible to a pattern:

- `0093_trust_engine.sql` writes `ALTER TABLE public.trust_policies     ENABLE
  ROW LEVEL SECURITY;` — aligned with **multiple spaces**, which a
  single-space pattern does not match.
- Several migrations enable RLS dynamically:
  `execute format('alter table public.%I enable row level security;', t)` over an
  array of names. No static reader can follow that.

CI's own comment already says this, about a different check: *"only a real
catalog is trustworthy … `0261` drops a unique constraint through `execute
format(...)`, which no static reader can follow."* This was the fourth
pattern-based miscount in this audit — after Pass D's 33/48/52, Pass F's 43, and
Pass C's blind sweep — and the one where a wrong number would have been most
alarming. Recorded so the 129 is not mistaken later for something that was ever
true.

## What was newly checked, and what it found

"RLS is on" is not the property anyone cares about: RLS with a policy whose
`USING` or `WITH CHECK` is literally `true` permits everything. The existing
`wallet-write-rls-check.sql` forbids that on the **money** tables. Nothing asked
it of the other ~480.

Asked now, across all 491, **six** policies are unconditional, and all six are
correct:

| policy | verdict |
|---|---|
| `admin_users`, `support_tickets` → `service_role` | `service_role` bypasses RLS anyway; a `true` policy naming only it grants nothing new |
| `badges` → authenticated, read | the badge catalogue — identical for every family |
| `feature_flags` → authenticated, read | flag names and states; no family column |
| `meal_ideas` → PUBLIC, read | the seeded recipe catalogue |
| `service_descriptions` → anon + authenticated, read | public marketing copy, served by the public `/api/services/descriptions` route |

No family-scoped table has one. **No finding.**

## How Pass G is kept closed

`docs/audit/blanket-policy-check.sql` (**A-16**), picked up automatically —
`run-probes.sh` globs `docs/audit/*-check.sql` precisely so a probe added today
runs today without anyone registering it.

| what it holds | how |
|---|---|
| No table outside a named reference-data allowlist carries an unconditional policy | one `pg_temp` function defines the rule, so the invariant and the self-test cannot drift apart |
| The four exemptions stay visible | each is listed with the reason it is exempt, and the probe prints the count — adding a fifth is a decision made in this file, not a side effect of writing a policy elsewhere |
| Service-role-only policies are not false positives | excluded explicitly, because `service_role` bypasses RLS regardless |
| **It can detect what it forbids** | plants a blanket `to authenticated using (true)` policy on `calendar_events`, asserts the rule finds it, rolls back, then asserts the plant is gone |

Probe suite after this addition: **16/16 passed.**

The self-test is the part that matters. Every invariant in this pass currently
reports clean, which is exactly the condition under which a broken check is
indistinguishable from a healthy system — the same reason Pass D's guard carries
four synthetic modules.

---

# Production, read for real (2026-09-13)

F5's first blocker is gone. The owner restored the access token's privileges, and
the **read-only** schema audit — `supabase-schema-audit.yml`, which applies
nothing and is `workflow_dispatch` only — was run against production to check
rather than assume. It had last succeeded on 2026-09-05, before the token broke.

Run [34780188088](https://github.com/NewWorldVenture/Bubaly/actions/runs/34780188088),
step *"Read catalog metadata and migration history"*: **success**. That is the
exact step that previously died at `supabase link`. It returned:

```json
{"migrationVersions":["0001","0002","0003"],"tableCount":440,"policyCount":973,
 "requiresBaselineReview":true,
 "moneyWrites":{"openWrites":[],"unguarded":[],"rlsDisabled":[],"noWritePolicy":[],
                "absent":[],"rlsKnown":true,"exploitable":false}}
```

## The wallet mint boundary is closed in production — verified, not inferred

This document has carried the LB-016 finding with an explicit caveat: a
production metadata audit reported that `wallet_transactions` might still hold a
**permissive INSERT policy** beside the manager-only one — the shape that lets
any family member, a child included, submit a `completed` `credit` and create
spendable funds — and that *"the audit returned policy hashes rather than
expressions, so the exact live condition is still unverified."*

It is now verified. Against live production:

- `exploitable: **false**`
- `openWrites: []` · `unguarded: []` · `rlsDisabled: []` · `noWritePolicy: []`
- all ten money tables — `family_wallets`, `child_wallets`, `wallet_buckets`,
  `wallet_transactions`, `wallet_rules`, `financial_accounts`, `transactions`,
  `budgets`, `bills`, `savings_goals` — return
  **"CLOSED - every write is manager-gated"**
- `rlsKnown: true`, so this is read state rather than an assumption

The highest-severity open question about production money is answered, and the
answer is that the boundary holds.

## What the same read makes newly measurable

Production reports **440 tables and 973 policies**. A clean replay of the repo's
migrations — performed for Pass G on Postgres 16.13, 307 migrations, 0 failures —
produces **491 tables**.

That gap of roughly **50 tables** is the ledger blocker stated as a number rather
than a caveat. `requiresBaselineReview` is still `true` and the recorded history
is still `0001`–`0003`, so the schema has been hand-managed and has drifted
behind the migration set. This document previously said only that *"a missing
ledger entry does not establish that the corresponding schema or feature is
absent"* — which remains true, and is why the direction matters: the count is
what production actually has, so tables the repo defines and production lacks are
features that cannot work there.

**What this does not license.** Nothing here applies a migration or stamps the
ledger; both remain human-owned per `docs/PENDING_PROD_MIGRATIONS.md`, and the
baseline gate is still doing its job by refusing. The remaining F5 work is
unchanged and is step 2 of two: reconcile the ledger against the live catalogue,
verifying each migration's objects before stamping, because a missing entry is
not proof the objects are missing.

## F5 step 2, asked of production rather than guessed (2026-09-13)

With the token working, the repo's own sanctioned path was run in its
**read-only** mode — `supabase-forward-release.yml` with `apply: false`, which
executes `apply-production-forward-release.mjs` with no flags and skips the
verify step entirely. Nothing was applied and nothing was stamped.

It refuses, and names the reason
([run 34781290560](https://github.com/NewWorldVenture/Bubaly/actions/runs/34781290560)):

```
Production forward release is held: repository migrations outside the pinned
0240-0254 release: 00260_display_layouts.sql, … 0294_family_scoped_read_indexes.sql
```

**71 migrations** sit outside the reviewed window. The release manifest was
pinned when `0240`–`0254` was the frontier; `main` is now at `0294`. So the
blocker has moved: it is no longer the access token, and it is no longer only
the baseline gate. The sanctioned apply path is pinned to a release that no
longer describes the repository.

That is the gate working as designed rather than a fault — `assertPreflight`
also refuses on a partially-applied ledger, on a release table that exists
without its migration, and on any boundary drift. But it means **step 2 cannot
be performed by running the existing workflow**. Someone has to re-pin the
manifest, in reviewed tranches, across those 71 migrations. That is a review
decision about what may touch production data, which is precisely the decision
this repository reserves for a human, and it is why nothing here attempted it.

**Worth noticing in that list:** the migrations interleave two numbering
schemes — five-digit names (`00260_display_layouts.sql`,
`01050_calendar_events_rls_repair.sql`) among four-digit ones (`0255`–`0294`).
Lexically `00260` sorts *before* `0255`, so the two families do not order the way
their numbers suggest. Recorded as an observation, not a finding: the five-digit
names appear to be the older scheme and sorting first may well be historically
correct. Anyone re-pinning the manifest should confirm that rather than assume
it, because the apply order is what a replay depends on.

---

# Pass H — Storage object paths (H-01)

Passes A–G asked their questions of **tables**. Nothing asked them of
`storage.objects`, and a family's photos do not live in a table.

Seven buckets exist. Three are private (`documents`, `chore-proof`,
`marketing-assets`); four are public (`avatars`, `marketplace-photos`,
`feedback-attachments`, `family-media`).

`family-media` being public is a **known, owner-tracked decision**, and
`0216_family_media_bucket.sql` states it plainly: consumers resolve attachments
with `getPublicUrl`, existing rows in `family_photos` / `family_messages`
already store public URLs, so flipping the bucket to private would break every
stored link, and hardening reads to signed URLs is tracked separately. That is
not re-litigated here.

What that decision implies, and the migration does not say, is the finding.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| H-01 | Four of six upload sites named objects with a millisecond timestamp, in a bucket where the path is the only access control | High | **Fixed** — this branch |

---

## H-01 — An enumerable name in a public bucket *(High, fixed)*

While the bucket is public, Supabase serves
`/storage/v1/object/public/family-media/<path>` to **anyone** — no session, no
RLS. The family-scoped `SELECT` policy 0216 adds governs the *authenticated*
Storage API; it is not in the path of a public URL. So the object path is the
entire access control.

Six places upload here. They did not agree on what a path is for:

| site | path | |
|---|---|---|
| `photos-module.tsx` | `${familyId}/${folder}/${crypto.randomUUID()}.${ext}` | unguessable |
| `create-memory.tsx` | `${familyId}/photos/${crypto.randomUUID()}.${ext}` | unguessable |
| `closet-module.tsx` | `${familyId}/closet/${Date.now()}.${ext}` | **enumerable** |
| `inventory-module.tsx` | `${familyId}/inventory/${Date.now()}.${ext}` | **enumerable** |
| `messages-module.tsx` | `${familyId}/messages/${Date.now()}.${ext}` | **enumerable** |
| `reminders-module.tsx` | `${familyId}/reminders/${Date.now()}.${ext}` | **enumerable** |

A millisecond timestamp is not a secret. The family id is the only other
component, and it is known to every current **and former** member. A day holds
86.4M timestamps across three or four plausible extensions, and real uploads
cluster into narrow windows, so a bounded scan finds them.

The consequence is about people rather than arithmetic: **removing someone from
a family did not stop them reading its closet, home-inventory, message and
reminder attachments — or discovering new ones as they were added.** Message
attachments are the sharpest of the four. Photos and Create-Memory, the two
sites whose authors clearly thought about this, were already right; the
disagreement between them is what made it visible.

### The fix

`familyMediaPath(familyId, kind, fileName)` in `lib/storage/family-media.ts` —
one place that decides this, which all six sites now call. It keeps the family id
as the first segment, because 0216's INSERT policy is
`is_family_member((storage.foldername(name))[1])` and an upload whose first
segment is not the family is refused.

Deliberately **not** a migration: nothing here changes the bucket, and existing
objects keep their stored paths, so no stored link breaks. That matters because
the production migration ledger is gated (F5) — this had to be fixable without
it, and it is.

**It does not close SEC-001.** Objects uploaded before this remain enumerable,
and the bucket is still public. The real fix is still signed URLs, which is the
owner's tracked work. This removes the part that needed no migration and should
not have waited for one.

## How Pass H is kept closed

`tests/family-media-paths-are-not-guessable.test.ts` — **8 cases**.

| what it holds | how |
|---|---|
| The helper is unguessable | 500 paths, no collision; no epoch-shaped run of digits; at least 32 characters of unique segment |
| The family folder stays first | or 0216's INSERT policy refuses every upload |
| No site builds its own path | a sweep over every file that touches the bucket, failing with the file and line |
| No uploader reaches for `Date.now()` | the specific defect, named separately so the reason survives |
| The sweep can see | a synthetic good and bad line, because a pattern that never matches passes forever |

Proved load-bearing by reverting one site to `${Date.now()}`: two cases fail,
naming `components/modules/closet-module.tsx:415`.

One existing test needed changing rather than satisfying.
`tests/family-media-persistence.test.ts` asserted the literal string
`crypto.randomUUID` inside each component — the right invariant written as an
implementation detail, which a move into a shared helper necessarily breaks. It
now asserts the components call `familyMediaPath()`, the same correction made
once before in this repository when `wallet-money-action-boundaries` pinned a
local helper by name. Its third file, the marketplace uploader, writes to a
different bucket and still rolls its own, so it keeps the original assertion.

---

## Observed and not fixed: a CI check that passes on cache luck

`tests/e2e/marketing-public.spec.ts:11` — *"the mobile menu becomes usable when
its client code is ready"* — failed once on #510's merge head and passed on a
cold re-run. The mechanism is worth recording, because the next person to see it
will otherwise call it a flake and re-run, which is what happened here.

The test intercepts `/_next/static/*.js` to hold hydration back, then asserts it
actually held something:

```ts
await slowPage.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, async (route) => { heldScripts += 1; … });
await slowPage.goto('/', { waitUntil: 'commit' });
await expect.poll(() => heldScripts).toBeGreaterThan(0);   // failed: 0
```

`beforeEach` has already navigated the `page` fixture to `/`, and the test then
opens `context.newPage()`. Both share one `BrowserContext`, so the chunks can be
served from that context's HTTP cache with **no network request** — the route
handler never fires and `heldScripts` stays 0. Playwright's own retry reuses the
same context, which is why `Retry #1` reproduced it rather than clearing it; a
fresh CI container, with a cold cache, passed.

So the assertion measures *whether a request happened*, which depends on cache
state the test does not control. It is not wrong about the behaviour it targets —
a menu that stays inert until its code arrives — it is just not reliably
exercising it. Roughly one run in some number silently tests nothing, and
occasionally fails outright.

**Not fixed here, deliberately.** It is green, it belongs to no finding in this
document, and changing a passing test on someone else's branch to satisfy a
hypothesis is how an audit starts widening into work nobody asked for — the same
reason `endEmergencyAction`'s missing audit row is recorded above rather than
built. The fix, when someone wants it, is one line: open the slow page in a
**fresh context** (`browser.newContext()`) rather than `context.newPage()`, so
the interception is deterministic. That strengthens the test rather than
relaxing it, which is the only acceptable direction.

---

# Pass I — Role boundaries (I-01)

Pass D asked two questions and said plainly that it was not asking a third. It
established *who* is calling (`requireUserContext`) and *which family* they may
write to (the cross-tenant sweep). It did not ask which **role**. For a family
product that is the sharpest version of the question: can a child reach what a
parent decides?

- **Surface:** 487 exported server actions; **311** mutate a table; **213** of
  those reach no role gate at all.
- **Why 213 is not 213 findings:** most are participation, not governance — a
  child adding a grocery item, logging a chore, writing their own
  `user_preferences`. And the app layer is often not where the boundary lives.

## The boundary is in the database, and mostly it is right

Of the 130 distinct tables written without an app-layer role gate, **none** has
a restrictive write policy — the money tables, which do, never appear, because
their actions *are* role-gated. The 172 permissive write policies on the rest
are `is_family_member(family_id)`: any member, a child included.

So the question became which of those tables are governance rather than
participation. Checked individually, the governance ones are gated in the
database, and gated well:

| table | write policy | verdict |
|---|---|---|
| `family_members` | `can_manage_family(family_id)` on insert, update **and** delete | a child cannot change membership or roles |
| `invites` | `can_manage_family`, plus an update clause letting the invited person accept their **own** invite by matching their JWT email | exactly right |
| `parent_approvals` | insert `is_family_member AND status='pending' AND decided_by IS NULL AND decided_at IS NULL`; update/delete `can_manage_family` | a child may **ask** but cannot **decide**, and cannot forge a pre-approved row |
| `subscriptions` | `is_family_admin(family_id)` | plan changes are the parent's |

`parent_approvals` is the one worth singling out: the insert policy does not
merely check membership, it pins the *shape* of the row a member may create. That
is the defense this pass went looking for, implemented one layer lower than the
app.

So the alarming-sounding number is mostly the app layer correctly declining to
duplicate a check the database already enforces.

## Status summary

| # | Finding | Severity | Status |
|---|---|---|---|
| I-01 | A social restriction could be removed by the person it restricted | **Critical** (their rating; mine was Medium — see below) | **Fixed** — `0296`, this branch |

---

## I-01 — The one table whose verbs disagreed *(Medium, fixed)*

`social_access_permissions` is an **override** table. `lib/social/access.ts`
resolves a caller's social role as *"an explicit row wins; otherwise fall back to
a default derived from their household member role"*, and those defaults
(`lib/social/roles.ts`) are:

```
parent -> admin              adult -> marketing_manager
teen   -> content_creator    everyone else -> read_only
```

An override is therefore the mechanism for holding someone **below** their
default. `0034` gated who may create one — and did not gate who may remove one:

```
insert / update : is_family_admin(family_id) OR social_has_permission(family_id,'manage_access')
delete          : is_family_member(family_id)          ← any member
```

Deleting the row restores the higher default. So a member pinned to `read_only`
could lift their own restriction: an adult back to `marketing_manager`, which
carries `publish_posts`, `schedule_posts`, `approve_posts` and `manage_settings`
— back to posting on the family's connected social accounts. A teen pinned to
`read_only` returns to `content_creator`.

**No application code deletes from this table**, which is why it is invisible
from the app — and why it did not matter. Every member holds a JWT and can issue
the delete straight to PostgREST. `access.ts` says as much in its own header:
*"RLS is the backstop."*

`0296_social_access_delete_matches_grant.sql` makes delete carry the same
condition as insert and update. Nothing else changes: members keep `SELECT`, and
an admin can still remove an override.

**Not applied to production.** The migration is authored and replays clean in
sequence, but production's ledger is gated (F5) and applying is the owner's.

## Not found first here — and the other audit was right about the severity

`codex/final-production-audit-20260912` had already found this, and recorded it
in `docs/final-audit/social-access-cycle.md` before this pass ran. Its write-up
is the better one and is worth quoting rather than paraphrasing:

> an active `adult` starts with an explicit `read_only` social role, so
> connect/publish are denied. Their authenticated client directly deletes their
> own `social_access_permissions` row, which the generic family-member DELETE
> policy permits. A subsequent successful required read observes clean absence;
> both the intended default and the repaired JavaScript resolver grant
> `marketing_manager`, which includes `connect_accounts` and `publish_posts`.
> The client does not need service credentials or a failed query.

Three corrections to what this pass wrote above, in their favour:

1. **Severity.** They rate it *"Critical; OPEN database hardening / release
   blocker before enabling live restricted-role publishing"*. This pass rated it
   Medium. Theirs is better reasoned: the escalation restores the right to
   publish on the family's connected accounts to someone a parent deliberately
   stopped, which is a release blocker rather than a permission quirk. The table
   above now carries their rating.
2. **Root cause, stated more precisely than here.** `0034` creates *generic*
   family-member DELETE policies for every table in `social_tables`
   (lines 712–739); the later granular block tightens that table's INSERT and
   UPDATE *only* (lines 765–771). The asymmetry is not an oversight on one
   policy, it is a blanket policy the tightening pass did not revisit.
3. **They also noticed something this pass did not:** *"A parent/admin SQL
   permission matrix also differs from JavaScript on `manage_access`."* Recorded
   here as their observation, unverified by this pass.

What is new here is the repair, not the finding. They were working under a
standing no-new-SQL constraint and wrote, correctly, that *"app-only error
handling cannot repair it"* — so the finding stayed open for want of a
migration. `0296` is that migration, and **A-17** is the behavioural proof, which
their cycle could not produce for the same reason.

This is the second duplicate across the whole document, after C-08's push prune
counter, and it is recorded for the same reason: an audit that quietly claims
another's finding is worth less than one that says who found what.

## How Pass I is kept closed

`docs/audit/social-access-symmetry-check.sql` (**A-17**) — five assertions,
behavioural rather than structural, picked up automatically by the glob in
`run-probes.sh`.

| what it holds | how |
|---|---|
| A restricted member cannot delete their own override | seeds a parent and an adult pinned to `read_only`, acts **as the adult**, and requires the delete to affect 0 rows |
| An admin still can | the positive control — a guard that refuses everyone proves nothing about a boundary |
| The three write verbs agree | compares the policy expressions directly, so a future change to one verb alone fails here |
| **It detects the state it forbids** | restores `0034`'s permissive delete inside a transaction and requires the member's delete to succeed — if the old policy no longer lets them through, the probe says so and fails |
| It leaves no trace | asserts the planted policy is gone after rollback |

Verified on a **fresh** bootstrap rather than the database it was developed
against: **308 migrations applied, 0 failed, 17/17 probes pass.**

---

# Pass J — What the AI may do (0 findings)

Bubaly acts on a family's behalf, so the last surface worth asking about is what
the assistant itself is allowed to do.

The design is sound and worth stating before the question. `lib/ai/tools/registry.ts`
is a **closed set** — `executeTool` looks a name up and denies anything absent,
so a hallucinated `finances.transferMoney` is refused rather than attempted. Every
tool carries a domain, a capability, a risk tier and a schema, and writes go
through `evaluateTrust` with an `approval_requests` row when the household's
policy says so.

- **Surface:** **94 tools — 48 declaring `readOnly: true`, 46 declaring `false`.**
- **The question:** `readOnly` means *"the tool cannot change anything"*, and
  `execute.ts` **skips the write gate** for such a tool — no `evaluateTrust`, no
  approval, and `trailActionFor()` returns `null`, so nothing reaches the
  household trail either. The gate believes what each tool says about itself.
- **Result:** all 48 are honest. **No finding.**

## What was actually checked, and one false positive worth keeping

A first sweep reported `routines.list` — declared `readOnly: true` — as reaching
a mutation through `listRoutines()`. It does not. `listRoutines` is a pure
`.select()`; the `.update(` belonged to **`setRoutineEnabled` beneath it**, and
the sweep had taken a fixed 1,500 characters after the function signature rather
than the function's actual body.

That is the fifth pattern-based miscount in this audit, and the guard below is
written to make it the last of its kind here: bodies come from the TypeScript
parser by brace matching, and one of the five cases pins `routines.list`
specifically as clean, so the false positive cannot come back silently.

## How Pass J is kept closed

`tests/readonly-tools-cannot-write.test.ts` — **5 cases**.

| what it holds | how |
|---|---|
| The registry is actually being read | floors on tools parsed, read-only tools, and write tools — a sweep over an empty registry passes forever |
| No read-only tool reaches a mutation | its handler, plus every function it calls one level into the project's own imports |
| It fires on an inline write | a planted `readOnly` tool that deletes in its own handler |
| **It fires on a write reached through a helper** | the harder half — handlers delegate, so a check that read only the handler would miss a tool whose service call does the writing |
| It does not mistake a pure read for a write | `routines.list` pinned clean, so the character-window false positive is a regression test rather than a memory |

Proved load-bearing against the real registry rather than only against planted
input: flipping `routines.create` to `readOnly: true` fails the sweep with
*"routines.create (lib/ai/tools/routines.ts) writes via createRoutine() in
lib/services/routines/index.ts"*.

**Also re-audited here:** `app/api/blog/search-index/route.ts`, a new **public**
route that landed on `main` after Pass F's sweep had run. Checked against the
same criteria: it sits under the public `/api/blog` prefix, is IP rate-limited at
60/min, and serves only published posts — `getAllPosts()` goes through
`fetchAllPublishedRows` **and** `publicRows`, so the claim in its comment holds
against the code. Its degradation to an empty index is logged, with the comment
citing the stale-sitemap defect (**F-012**) that once hid behind that same catch.
Clean.

---

# Pass K — Tenant scope on the request path (K-01, K-02)

Pass D asked whether a server action knows **who** is calling. This asks the
question one step further along, of the other half of the surface: a route
handler that has authenticated its caller and then takes an **id out of the
request body** — does it check that the id belongs to the household the request
is about?

- **Surface:** **141 `route.ts` files, 149 exported handlers**; 71 of them reach
  a service-role client. **2,809 Supabase query chains** across `app/` and `lib/`.
- **Findings:** **2**, both fixed here. Both in the same class, neither a
  cross-tenant breach.

## The boundary is real, and it is deliberately wider than one household

Every family table carries `family_id` — the replayed catalogue says **0 of 491**
tables are member-keyed without one — and their RLS reads
`is_family_member(family_id)`.

That predicate admits **every family the caller belongs to**, and that is
correct: a parent with a household on each side of a separation is one account
with two families, and both have to work. Nothing is wrong with the policy.

What is wrong is reading a row by `member_id` and calling the result *this
family's* data. The filter is what narrows a membership-wide policy to the one
household the page, the plan check and the feature gate were all decided
against — and if the filter is absent, nothing else supplies it.

## The routes that take an id and check it — the standard the two missed

Three do this properly and are worth naming, because the pattern is established
here and was simply not applied in two places:

| route | what it does |
|---|---|
| `app/api/moving/recalculate/route.ts` | refuses with `context_changed` unless `body.familyId === ctx.active.familyId` **and** `body.memberId === ctx.active.member.id` |
| `app/api/vacations/confirmation-import/route.ts` | eight-way comparison against the resolved context before it will act |
| `app/api/paperwork/link/route.ts` | `expectedFamilyId !== ctx.active.familyId` → 409 |

## Status summary

| id | what it was | severity | state |
|---|---|---|---|
| K-01 | `/api/behavior/insight` read `behavior_logs` with **no family filter at all** | Medium | **fixed** |
| K-02 | `/api/ai/health/coach` read three of its four health tables across households | Medium | **fixed** |

## K-01 — One parenting insight, two households *(Medium, fixed)*

`app/api/behavior/insight/route.ts` built its query as

```ts
let q = supabase.from('behavior_logs').select(…).gte('occurred_at', since).limit(200);
if (body.memberId) q = q.eq('member_id', body.memberId);
```

— `occurred_at`, optionally `member_id`, and nothing else. The comment above it
reads *"family-scoped via the cookie client + RLS"*, which is true of the client
and not true of the scope.

Two consequences, both live:

1. With no `memberId` the route returned the caller's behaviour logs **from every
   household they belong to**, blended into one summary and one set of parenting
   tips. The page is per-family; the answer silently was not.
2. `refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/behavior'])`
   two statements above is checked against the **active** family only, so the
   other household's data passed a gate it had never been held to.

**Also fixed here:** `const { data: logs } = await q` discarded the error, and
the next line answered *"No behavior has been logged yet. Start logging positive
moments and concerns…"*. A refused read was therefore reported to a parent as an
empty log, and they were invited to start logging what they had already logged —
the same shape as **F-a**, on a different surface.

## K-02 — A health answer that crossed households and then got medication wrong *(Medium, fixed)*

`app/api/ai/health/coach/route.ts` grounds its answer in four reads issued
together. Three took `memberId` straight from the request body with no family
filter; the fourth did not:

| read | before |
|---|---|
| `family_members` | `.eq('id', memberId)` |
| `medical_profiles` | `.eq('member_id', memberId)` |
| `symptom_logs` | `.eq('member_id', memberId)` |
| `medications` | `.eq('family_id', familyId).eq('member_id', memberId)` ← **scoped** |

The inconsistency is inside **one `Promise.all`**, and it is what makes this
worse than merely wrong. Name a member of your *other* household and the coach
describes that person — display name, date of birth, blood type, allergies,
conditions, and their last ten symptoms — and then reports **"Active
medications: none on file"**, because the one correctly scoped query returns
nothing for a member of a different family.

A confident wrong answer about medication, on a surface that opens by saying it
is not medical advice, is worse than a refusal. All four reads now name the
family, and a refused read now answers 503 rather than coaching over a medical
record it could not read.

## Proving the premise, rather than asserting it

The premise — that `is_family_member` admits a second household — cannot be read
off the policy text: `is_family_member` is a function, the policies are created
inside `execute format(...)` loops, and the app filter is what actually scopes
the query. So `docs/audit/member-scope-crossing-check.sql` proves it
behaviourally against the replayed database, in a transaction that rolls back:

1. a parent seeded into **two** families reads the second family's `symptom_logs`
   and `behavior_logs` by `member_id` alone — the defect's premise;
2. adding `family_id = <active>` returns **0** — the filter is what scopes it;
3. a user in **neither** family reads **0** both ways — so (1) is a scoping gap
   and not RLS being off, which would be a far larger finding.

Negative control: pointing step 2's "active family" at the household the row is
actually in fails the probe with both table names. It runs in CI — `run-probes.sh`
globs `docs/audit/*-check.sql` — and the suite is **18/18**.

## How Pass K is kept closed

`tests/member-scoped-reads-name-their-family.test.ts` — **21 cases**, parsed with
the TypeScript compiler over **2,809 query chains**.

| what it holds | how |
|---|---|
| It is parsing something | floor of 500 chains — a sweep over nothing passes forever |
| No read is scoped to a person without a household | `member_id`, `family_member_id`, `child_id`, `assigned_to`, `assignee_id` |
| **It sees a filter added to a reassigned builder** | `let q = …; q = q.eq('member_id', …)` folded back into its chain |
| It sees a chain broken across six lines | the chain is one AST node, so line breaks are irrelevant |
| Both routes stay scoped, by name | failing with the route rather than with a number |
| Every exemption states a checkable reason | > 40 characters, and a stale entry fails |
| A `family_members` read never takes its id from the request | the other half of the class — see below |

Each fix proved load-bearing by reverting it: removing the `behavior_logs`
filter fails 2 cases naming the route and line; removing the `symptom_logs`
filter fails 2 more; removing the `family_members` filter fails 2 more.

### The half the first sweep could not see, and the near-miss inside it

`family_members` is keyed by `id`, not `member_id`, so a read of it is not a
member filter at all and the sweep above is blind to it — yet one of K-02's three
crossing reads was exactly that shape. It was found by **reading the route**, not
by the sweep. A class half-covered by a guard reads as covered, so the guard now
covers both halves.

There are **17** such reads in the tree and **all 17 are right**, for two reasons
worth separating rather than listing. Fifteen pass an id that was **derived** —
`cw.member_id` from a `child_wallets` row already resolved, `ctx.active.member.id`
from the session, `memberProfile.member_id` from a signature-authenticated
lookup — so the id could not name a stranger's member in the first place. Two are
super-admin actions, where naming any member is the point. One file
(`child-login-actions.ts`) does take `input.memberId` from the request and is
right anyway, because it reads the row first and refuses unless
`row.family_id === ctx.active.familyId`. That is a rule, not a list, and the guard
encodes the rule.

**And it was wrong on its first run.** The rule tests whether the id's expression
is request-shaped, anchored at the start — which reads

```ts
const memberId = typeof body.memberId === 'string' && body.memberId ? body.memberId : null;
```

as *derived*, because the expression begins with `typeof`. The sweep passed
cleanly over the very defect it had just been written for. It surfaced only
because the fix was reverted to check the guard was load-bearing and **the
general case stayed green** while the named-route case failed — the same vacuous
pass that exposed the hole in Pass C's sweep, caught the same way. The predicate
is now unanchored, and eight of the 21 cases pin it against both shapes so the
mistake is a standing check rather than a memory.

That is the **sixth** pattern-based miscount recorded in this audit, and the
second found by reverting rather than by luck.

## What was checked and found clean

- **Service-role IDOR on the request path.** 149 handlers; the combination that
  would be dangerous — session-authenticated, service-role client, caller-supplied
  tenant id, no ownership check — occurs **0 times**.
- **The `/api/cron` and webhook group.** 25 handlers reach no session guard; each
  authenticates itself instead (`hasCronAuthorization`, a `Bearer ${secret}`
  comparison, `validateTwilioSignature`, `verifyAlexaRequest`, Stripe's
  `constructEvent`). `contact-center/voice/transcription` takes `familyId` from
  the **query string**, which is inside Twilio's signed URL, so the id is
  authenticated by the HMAC rather than trusted.
- **`/api/admin/benchmarks/export`** re-verifies `getUser()` + `isSuperAdmin()` in
  the handler, because a route handler is not protected by the `/admin` layout.
  (It was flagged by a first sweep whose guard vocabulary simply did not contain
  those two names — a detector gap, recorded here so the flag is not mistaken for
  a finding.)
- **`/api/ai/invest`, `/api/ai/schedule`, `/api/ai/trip`.** All three take
  something caller-supplied and all three are right: `childWalletId` is used only
  against `.eq('family_id', familyId)` rows, `memberIds` is a client-side filter
  over rows already family-scoped, and `members` are names in a prompt rather
  than ids.

## Verification

- Full suite: **1,184 files, 13,606 tests, all passing**
- `tsc --noEmit` clean · `eslint` clean on every changed file
- `npm run db:audit:queries` — 491 tables, 77 functions, 141 API routes, all resolve
- Boundary probes **18/18** against a fresh replay of all **308** migrations
- **No migration.** Both fixes are application filters over a policy that is
  already correct, so nothing here is waiting on the gated ledger.

---

# Pass L — What the plans sell versus what the gates serve (L-01, L-02, L-03)

This one did not start as a sweep. The owner reported that
`https://www.bubaly.com/dashboard/assistant` "is not working" — it answered
`/dashboard/billing?upgrade=1&need=1`. That is `requireFeature` doing exactly
what it was told, and what it was told disagreed with what the site sells.

**Four statements of one offer, no two of them the same:**

| where | what it says |
|---|---|
| `lib/constants/plans.ts` — the published Free plan | **"10 AI requests/month"** |
| `components/app/nav-shared.tsx` — the pinned sidebar pill | "always one tap away **regardless of plan**" |
| `app/(app)/dashboard/assistant/page.tsx` | "Free tier includes a metered AI assistant (10 requests/month); **the monthly quota is enforced at the request layer**" |
| `lib/constants/feature-catalog.ts` | `defaultTier: 'basic'` |

So every free family had an "AI Assistant" pill pinned permanently to the top of
their sidebar — pinned on purpose, because `FIXED_SIDEBAR_ROUTES` is chrome and
is never filtered by entitlement — and tapping it produced a billing upsell for
something their plan already included.

## Status summary

| id | what it was | severity | state |
|---|---|---|---|
| L-01 | the assistant page gated at `basic` while Free is sold it | High | **fixed** |
| L-02 | `AI_MONTHLY_ALLOWANCE` unlimited at every level, including Free | High | **fixed** |
| L-03 | `/api/ai` enforced no plan gate at all, and the meter counted the wrong rows | High | **fixed** |

## L-01 — A pinned button that could not work *(High, fixed)*

`ai-assistant`'s `defaultTier` is now `free`. The concierge is untouched and
stays `basic`: Free's copy names *AI requests*, and only Basic's names the
*concierge* ("Unlimited AI assistant & concierge"), so opening one must not open
the other. That required separating them — see L-03.

## L-02 — The meter the plan was sold did not exist *(High, fixed)*

```ts
export const AI_MONTHLY_ALLOWANCE = { 0: null, 1: null, 2: null };
```

with a comment reading *"Numbers land here when the plans define them; the gate,
the count query and the error copy are already wired for that day."*

**The plans had defined them.** `lib/constants/plans.ts` has said "10 AI
requests/month" for Free and "Unlimited AI assistant & concierge" for Basic all
along. The seam was built, documented, and left at `null` — so `null` meant
"unlimited for everyone", the exact opposite of the Free offer, and the count
query, the 429 branch and the error copy below it **had never executed on any
request ever made**.

It is now `{ 0: 10, 1: null, 2: null }`, read straight off the plans. Turning a
number on turns dead code on, so `tests/ai-monthly-allowance.test.ts` drives
every branch of it for the first time: under the allowance, at it, the fail-closed
path when the count cannot be read, the UTC month boundary, and the two levels
that must not pay for a count at all.

## L-03 — The gate was on the screen, and the screen is not what spends money *(High, fixed)*

`/api/ai` is the assistant's transport. It calls the model, and **the Expo app
posts to it directly with a bearer token and never loads the page.** It had no
plan check of any kind — only `rateLimit`/`rateLimitDb` at 20/min, which bounds
a burst and not a month.

So the gate was backwards on both halves at once:

- the **web page** refused a free family a feature their plan includes, and
- the **transport** served any signed-in member unlimited AI on any plan.

That is the failure mode `lib/server/feature-entitlement.ts` documents about
itself — *"the gate was real on the screen and absent in the pipeline behind
it"*, how Family Autopilot ran nightly for every family on the platform. The
same shape, on the most-used AI surface in the product.

`/api/ai` now calls `assertAIAccess` before it prepares a turn, and answers the
denial. An unreadable plan answers **503**, never a refusal: a transient database
failure must not lock out someone who has paid.

**And the meter would not have counted anything.** `assertAIAccess` counted
`ai_requests` rows `.eq('kind', 'concierge')` — but the assistant records its
turns through `withAiRequest`, which leaves `kind` at its default `'feature'`
(`lib/ai/assistant-engine.ts` says so explicitly, because `createRequest`
coerces an unknown kind to `'concierge'` and filing assistant turns under the
concierge planner would be wrong). A limit of ten that counts none of the
requests it is limiting can never be reached. The count is now by family and
calendar month with no kind filter, which is also what the copy says: "10 **AI
requests**/month", not ten of one kind.

`assertAIAccess` also gained a `featureKey`, defaulting to the concierge so that
every existing caller is unchanged, and the assistant asks about `ai-assistant`.

## A correction to F19

**F19 is recorded in this file as *"a pricing decision the owner has to make"*,
and it names `ai`, `ai/chat` — the assistant itself — among the routes
deliberately left ungated, closing with *"The numbers an owner needs are here;
the choice is theirs."***

The owner had already made that choice and published it. It is the first line of
the Free plan on the pricing page. F19 read `AI_MONTHLY_ALLOWANCE` and the route
list and did not read `lib/constants/plans.ts`, so a decision that was already
made and shipped was recorded as outstanding — and the feature stayed broken
behind that framing.

F19 is now **partly closed**: metering for the assistant is decided, wired and
tested, because the plans decided it. The other **35** AI routes are still a
genuine owner decision, and the three options F19 lays out for them still stand.

## How Pass L is kept closed

`tests/plans-and-gates-agree.test.ts` — **7 cases**, cross-referencing the
published offer against the gates that serve it.

| what it holds | how |
|---|---|
| Free is metered at the number Free is sold | the number is **parsed out of the plan copy**, not written down a second time |
| Basic and Plus get the unlimited AI they are sold | asserted against the copy that says so |
| A plan sold AI requests can open the page that spends them | `tierToLevel(ai-assistant) === 0` whenever the Free allowance is non-zero |
| The concierge stays where it is sold | Free's copy names no concierge; Basic's does |
| **Every pinned sidebar route is reachable on the lowest plan** | fixed chrome is never entitlement-filtered, so a gated pin is a permanent dead button |
| The transport asks the gate and answers the denial | checked with the **imports stripped** — see below |
| The meter counts every AI request, not one kind | a `kind` filter would exclude every assistant turn |

`tests/ai-monthly-allowance.test.ts` — **12 cases** over the allowance path
itself. `tests/api-ai-route.test.ts` gains **3**: a family over its allowance is
refused before the engine is touched, the gate is asked about the assistant
rather than the concierge, and an unreadable plan answers 503.

Each of the four changes proved load-bearing by reverting it: `ai-assistant`
back to `basic` fails 2 cases; the allowance back to `null` fails 1 here and 5 in
the allowance suite; the `kind` filter returning fails 1 in each; removing the
route's denial fails 1.

### The seventh miscount, caught the same way as the sixth

The transport case first read:

```ts
expect(route).toContain('accessDeniedResponse');
```

Deleting `return accessDeniedResponse(access)` from the route left the **import**
in place, so the string still matched and **the case passed over a route that
had stopped enforcing anything**. It was caught by the same discipline as Pass
K's: reverting each change to check the guard was load-bearing, and noticing
that this one stayed green. It now strips every `import … from '…'` line before
asserting, and requires the call and the `return` rather than the identifier.

Two vacuous guards in two consecutive passes, both found by reverting rather
than by reading. Reverting the fix is the only check that has caught either.

## Verification

- Full suite: **1,186 files, 13,628 tests, all passing**
- `tsc --noEmit` clean · `eslint` clean on every changed file
- **No migration.** Every change is a constant, a gate call, or a query filter.

## Still open from this report

The owner is on the built-in super-admin allowlist
(`lib/constants/super-admins.ts`), and `requireFeature` returns before any tier
check for a super-admin — so the account that hit this redirect was either a
different one, or one whose session carried no email. Production is at
`fef35f1c`, which is **exactly `main`**, so it is not a stale deploy. Worth
confirming which account was signed in; the defect above is real either way and
affected every free family, super-admin or not.

---

# Pass M — State that outlives its request (M-01)

Every boundary this audit has checked so far is evaluated **during** a request:
RLS runs on the query, `requireFeature` runs on the page, `assertAIAccess` runs
on the call. Pass M asks about the places where a value is produced by one
request and read by another — because in every one of them, the boundary has
already been evaluated and cannot be evaluated again.

Three such places exist. Two are clean.

- **Module-scope mutable state in server modules.** On a warm serverless
  instance, module scope survives between requests and therefore between users.
  **15** bindings across `app/`, `lib/` and `shared/` are mutated inside a
  function rather than only at load. **0 findings.**
- **`unstable_cache`.** A cache key that omits the tenant serves one family's
  data to another, and the second reader never touches the database at all.
  **6** cached functions in 4 modules. **0 findings.**
- **Shared HTTP caches.** A response held by Vercel's edge or any proxy is
  served with no session, no RLS and no token lookup. **3** routes send a
  `public` header with an `s-maxage`. **1 finding.**

## The 15 module bindings, and why none of them holds a family

A count is not a result, so here is what they are. Nine hold configuration or
process facts — `MERGED` (locale catalogues), `partsCache`
(`Intl.DateTimeFormat` per timezone), `REGISTRY`/`LOOKUP` (the AI tool registry,
built at load), `vapidReady`, `warned`, `anchorsBySubject`/`anchorSource`,
`shared` (the scripted stub provider), `chainCache` (Alexa certificate chains,
by URL — public certificates, and it exports `clearAlexaCertCache` so tests
cannot inherit one another's). Three are browser-side — `nowPlaying`,
`touchInFlight`, `conversionInFlight` — where module scope is one tab. One is
the in-memory rate limiter, deliberate and paired with a durable DB counter.

The one worth naming is `SCOPE_CACHE` in `lib/ai/actions.ts`, because it is the
only one that caches **tenant data** and it is the one that is keyed correctly:

```ts
const SCOPE_CACHE = new WeakMap<SupabaseClient<Database>, Map<string, ScopeIdentity>>();
```

The outer key is the **Supabase client instance** — one per request — and the
inner key is `familyId:userId`. So a hit requires the same request and the same
family and the same user, and the entry is collected with the client. Its own
comment explains the second layer and that only successes are cached. That is
what a per-request memo has to look like, and it is what the other fourteen
would have to look like if they ever held a row.

## The 6 cached functions

`getPublishedTestimonials`, `getPublishedCaseStudies`, `getPublicStats`, the
social-links read and the two AEO reads. Every one takes **no argument** except
a locale or a content category, reads `is_published = true` or an aggregate with
a service client, and is invalidated by `revalidateTag` from an admin action. No
request input reaches a key, so there is no tenant to omit from one.

## M-01 — A revoked calendar feed kept being served *(Medium, fixed)*

`/api/sync/feeds/<token>` is a family's calendar — event titles, descriptions,
locations, times — served to anyone holding an unguessable token. That is the
design and it is sound: Apple Calendar, Outlook and Alexa cannot log in, so the
token is the authorization. `lib/sync/feed-token.ts` says so, and states the
control that follows from it: the token is *"revocable (rotate the column to
revoke)"*. The route repeats it: *"Revoke by rotating feed_token or setting
feed_enabled = false."*

It sent `Cache-Control: public, max-age=900, s-maxage=900`.

`s-maxage` is everyone else's cache. For fifteen minutes after a revocation,
Vercel's edge — and any proxy between a subscriber and it — kept serving that
calendar to anyone with the old URL, without the route running at all, so
neither the rotated token nor `feed_enabled = false` was ever consulted. A
family that rotates the token *because the URL leaked* is told the feed is gone
while it is still being handed out.

Nothing crosses tenants here: a shared cache keys on the full path, which is the
token. The defect is that a documented revocation control does not take effect
when it says it does — the same shape as every other finding in this file where
the system claims more than it can support.

**Fixed by separating the two caches rather than removing them.** `max-age`
stays at **900**: that is the subscriber's own calendar client, and they are the
one who held the token. `s-maxage` drops to **60**, which still absorbs a client
polling in a loop — the ICS body itself asks for a 60-**minute** refresh
interval, so nothing legitimate re-fetches inside a minute — while cutting the
revocation window from fifteen minutes to one. The route also holds a 60/min IP
rate limit and a durable DB limiter, which is what actually protects the
database.

## How Pass M is kept closed

`tests/shared-caches-do-not-outlive-revocation.test.ts` — **5 cases**.

| what it holds | how |
|---|---|
| It is reading headers at all | floors on the number found; a sweep matching nothing passes everything |
| No shared cache holds a non-public response longer than 60s | every `public` + `s-maxage` header in `app/api` |
| A route exempted as public content says why | reason > 40 characters, checkable against the handler |
| An exemption for a route that no longer caches fails | stale entries are how an allowlist stops being review |
| The feed keeps its subscriber cache and loses everyone else's | `s-maxage ≤ 60` **and** `max-age === 900`, named |

Load-bearing both ways: restoring `s-maxage=900` fails 2 cases naming the file
and the value; adding a new route with `s-maxage=3600` fails the sweep naming
that route.

**And the sweep found its own hole the way it should.** It first matched only a
`'Cache-Control': '…'` literal at the call site. `app/api/blog/search-index/route.ts`
lifts its header into `const CACHE_CONTROL = '…'`, so the sweep did not see it —
and what surfaced that was the **stale-exemption** case failing, because an
allowlist entry existed for a route the sweep reported as setting no header at
all. A guard whose allowlist is checked against its own findings reports its own
blind spots. The sweep now resolves a same-file constant too.

## Verification

- Full suite: **1,187 files, 13,633 tests, all passing**
- `tsc --noEmit` clean · `eslint` clean on every changed file
- **No migration.**

---

# Pass N — What the browser downloads (0 findings)

`process.env.X` in a module a client bundle can reach is not read at runtime —
it is **inlined as a literal** into JavaScript the browser downloads. So the
question is not whether a module is careful with a key. It is whether the
bundler can see that module from a client component at all.

Next answers part of it. `import 'server-only'` throws at build time when a
client bundle reaches the module, and **196** modules here declare it. What it
does not cover is a module that holds a secret and never declares it.

- **Surface:** **452 client modules**; the bundle reaches **870** modules in
  total through value imports. **8** `NEXT_PUBLIC_*` variables exist.
- **Result:** **0 findings.** One module a client bundle reaches names a
  non-`NEXT_PUBLIC_` variable and it is `NODE_ENV`, which Next inlines by design
  and which names no secret.

## The eight public variables, checked rather than assumed

`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_BUILD_ID`,
`NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
`NEXT_PUBLIC_VAPID_PUBLIC_KEY`. Every one is public by construction — a URL, a
build identifier, the **anon** key, the **publishable** key, the **public**
VAPID half. None is a secret wearing a public prefix, which is the way this
particular defect usually arrives.

## Three edges that are not bundling edges

This is the part worth keeping, because the first run of this sweep reported
**20 leaks** — `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`TWILIO_AUTH_TOKEN`, `CHILD_LOGIN_SECRET`, `RESEND_API_KEY`,
`MICROSOFT_SYNC_CLIENT_SECRET` — and **all twenty were false**.

| edge | why it is not a bundling edge | of the 20 |
|---|---|---|
| **`'use server'`** | an RPC boundary. A client component importing `searchRecordsAction` receives a stub; none of that module's code, and none of its imports' code, reaches the browser | **13** |
| **`import type`** | erased by the compiler. One client module appeared to import a `page.tsx`; it imports `type { InboxRow }` from it | **1** |
| **a directive below a comment block** | the prologue is the first **statement**, and a file may comment above it. `app/(app)/dashboard/search/actions.ts` puts `'use server'` on **line 17**, so a five-line window read it as a plain server module imported by a client component | **2** |

The third is the dangerous one: the other two add noise, but that one
**manufactures exactly the finding being looked for** — a secret-holding module
imported straight into a client component — out of a correct file. Reported
without checking, it would have been the audit's most alarming finding and its
most wrong.

That is the **eighth** pattern-based miscount recorded in this file. It differs
from the previous seven in being caught before anything was written down rather
than after: the chains were read one at a time, and every one ended at a
`'use server'` line.

## How Pass N is kept closed

`tests/the-browser-bundle-holds-no-secret.test.ts` — **9 cases**.

| what it holds | how |
|---|---|
| The traversal is walking the app | floors of 100 client modules and 100 reachable — a traversal that reaches nothing reports no leaks forever |
| Nothing reachable reads a non-public variable | and the failure names the **import chain**, not just the file |
| It sees a client module reading a secret directly | fixture |
| `NEXT_PUBLIC_*` and `NODE_ENV` are not secrets | fixture |
| **It recognises a directive below 16 lines of comments** | fixture, *plus* the assertion that a five-line window does not — the mistake pinned, not just the fix |
| It recognises a directive below a block comment | fixture |
| It drops `import type` and `{ type X }`-only clauses | fixture |
| It keeps a value import that merely mentions a type | the other direction, so the fix cannot be "ignore everything" |
| **`lib/supabase/server.ts` is unreachable from any client bundle** | the one module naming `SUPABASE_SERVICE_ROLE_KEY`; if the sweep can reach it, the rest is decoration |

Proved load-bearing against the **real tree**, not only fixtures: planting
`process.env.SUPABASE_SERVICE_ROLE_KEY` into `components/pwa/register-sw.tsx`
fails with *"reached via itself, a client module"*, and adding a non-`server-only`
lib module holding `STRIPE_SECRET_KEY` and importing it from that same component
fails with *"reached via components/pwa/register-sw.tsx"*.

## Verification

- Full suite: **1,188 files, 13,642 tests, all passing**
- `tsc --noEmit` clean · `eslint` clean
- **No code change.** Nothing was found to fix.

---

# Pass O — Where a secret is stored (O-01, O-02, O-03)

Pass N asked whether the browser is handed a secret from the **environment**.
This asks the same question of the **database**: 27 columns across the schema
hold a token, a key or a password. Which of them is protected by something, and
by what?

Most are fine by construction. `sync_tokens` and `social_account_tokens` store
`access_token_enc` / `refresh_token_enc` — encrypted at rest through
`lib/sync/crypto.ts` under `SYNC_TOKEN_KEY`. `gift_links.token` and
`sync_calendars.feed_token` are capability slugs, unguessable by design and
audited in **M-01**. `stripe_settings.secret_key` is read only by the service
role, and the admin page that shows its status was checked line by line: it
sends `hasSecret: Boolean(stripeCfg?.secret_key)` to the client component, never
the value. `select('*')` there is an over-fetch on the server, not a leak.

One table is not fine.

## Status summary

| id | what it is | severity | state |
|---|---|---|---|
| O-01 | a child could change and delete the family's stored card PIN | **Critical** | **fixed** — `0297`, not applied to production |
| O-02 | a child can still **read** every stored credential | **High** | **open — a product decision, recorded** |
| O-03 | the vault's step-up MFA is a screen control with nothing behind it | **High** | **open — recorded, with the obstacle** |

## What `family_credentials` is

The "Wi-Fi & Passwords" vault. Its category check constraint reads:

```sql
CHECK (category = ANY (ARRAY['wifi','website','app','streaming','email','card','pin','membership','other']))
```

`card` and `pin`. The table is designed to hold bank card numbers and PINs, and
`secret` is plain `text` — not an `_enc` column, in a schema that encrypts
provider tokens at rest two tables over.

All four of its policies were `is_family_member(family_id)`.

## O-01 — Proved, not inferred *(Critical, fixed)*

Against a replay of all 309 migrations, seeding a parent and a **child** in one
family with a card entry, then acting as the child on an `aal1` session
(password only, no second factor):

```
NOTICE:  CHILD, aal1 (no second factor): READ 1 row(s), secret = PIN 9317
NOTICE:  CHILD, aal1: UPDATED 1 row(s)
NOTICE:  CHILD, aal1: DELETED 1 row(s)
```

And nothing in the application stands in the way either.
`components/modules/passwords-module.tsx` has **no role check of any kind** —
not in the UI, not before the write — and it writes with the caller's own client
(`sb.from('family_credentials').insert(...)`), never through a server action. So
RLS is the only boundary this data has ever had.

`0297_family_credentials_write_boundary.sql` makes insert, update and delete
`can_manage_family(family_id)` — the predicate `family_members`, `subscriptions`
and `medical_profiles` already use. It is the same defect as **F20**'s chore
board and the same shape as the money tables' manager-gated writes, on a table
holding card PINs. **Not applied to production**: authored and replaying clean,
but the ledger is gated (**F5**) and applying is the owner's.

## O-02 — Reads are left alone, deliberately *(High, open)*

A child can still **read** every credential, and this pass does not change that,
because narrowing it is a product decision rather than a defect with one answer:

- the page is called **"Wi-Fi & Passwords"** and `wifi` is a category, so some
  entries are plainly meant to be family-wide;
- the table carries a **`member_id` column that no policy consults**, which
  suggests the intended shape was per-person scoping that was never wired;
- guessing wrong breaks a real use case — a child who cannot read the Wi-Fi
  password on the page named after it.

Three options, for the owner:

1. **By category** — `wifi` (and perhaps `streaming`) readable by everyone, the
   rest manager-only. Closest to the page's own name.
2. **By `member_id`** — a credential with a `member_id` is readable by that
   member and managers; one without is family-wide. Uses the column that exists.
3. **Manager-only reads**, and move the Wi-Fi password somewhere else.

The probe below **asserts the read is still open**, so that if this is ever
addressed the probe fails and this section has to be updated. A finding
half-fixed must not come to read as fixed.

## O-03 — The strongest signal in the product, enforced only on the screen *(High, open)*

`app/(app)/dashboard/passwords/page.tsx` calls
`requireAal2(ctx, 'documents', '/dashboard/passwords')` — step-up MFA, the same
treatment money and trust get. The product plainly considers this data sensitive.

**No policy in the schema references `aal`.** Verified against the catalogue:
zero of the policies on 491 tables mention it. So the second factor is a page
guard, and a member's ordinary session reaches the same rows through PostgREST
without it — which is not a hypothetical, because the module itself queries
PostgREST directly.

The obstacle is worth recording, because the naive fix is wrong.
`requireAal2` deliberately does **not** step up a family that never enrolled a
factor — its own comment says so, and `nextLevel` is `aal1` for them. An RLS
policy demanding `auth.jwt()->>'aal' = 'aal2'` would therefore lock every
factor-less family out of their own passwords. The correct mirror is *"aal2, or
this user has no enrolled factor"*, which needs a `security definer` helper over
`auth.mfa_factors`. That is a real piece of design and it belongs to the owner.

## How Pass O is kept closed

`docs/audit/family-credential-write-boundary-check.sql`, in a transaction that
rolls back:

| what it holds | how |
|---|---|
| A child cannot insert, update or delete | the three verbs, each separately |
| A parent still can | the positive control — a guard that refuses everyone is not a boundary |
| **The read half is still open** | asserted as the CURRENT state, so closing O-02 fails this probe and forces the document to be updated |
| The three write policies carry one condition | tightening one and forgetting another is how this started |

Negative control: restoring the pre-`0297` permissive policies fails it with
*"a child INSERTED a credential | a child UPDATED 1 credential row(s) | a child
DELETED 1 credential row(s)"*.

### The negative control found a bug in the probe itself

Running it the first time did not print those three lines. It printed
`ERROR: malformed array literal: "a child INSERTED a credential"`.

`failures := failures || 'some text'` does not append to a `text[]` — Postgres
resolves the untyped literal on the right as an **array literal** and fails to
parse it. Every branch built with `format(...)` was fine, because that yields a
typed `text`; every branch built with a plain string was not.

So the probe would still have failed the build — but naming a type error instead
of the broken boundary, which is most of what a probe is for. **Pass K's
`member-scope-crossing-check.sql` had the same latent bug** in six branches, and
it was invisible there precisely because that probe passes: a failure path that
never runs is a failure path nobody has read. Both now use `array_append`, and
both negative controls were re-run to confirm they name the boundary.

That is the ninth defect this audit found in its own instruments, and the fourth
found by deliberately breaking the thing being guarded rather than by reading it.

## Verification

- Full suite: **1,191 files, 13,677 tests, all passing**
- Fresh replay: **310 migrations applied, 0 failed**; probes **20/20**
- `npm run db:audit:queries` — 491 tables, 78 functions, 141 routes, all resolve
- `tsc --noEmit` clean
