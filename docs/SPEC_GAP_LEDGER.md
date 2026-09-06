# Verified spec-gap ledger — `docs/AI_FAMILY_OS_SPEC.md`

A backlog of what is genuinely missing, and — just as important — a record of what
was **claimed** missing and turned out not to be.

Every row was produced the same way: readers swept all 70 spec sections against the
repo and wrote claims with citations, then each claim was handed to independent
reviewers **told to refute it**, defaulting to refutation on the grounds that a false
gap costs a wasted rebuild of something that already works. 32 claims went in;
**21 survived and 11 did not**. Sweep run 2026-09-06 against `main` at `f3f191b`
(42 agents, ~5M tokens).

> Rebuilding something the repo already does is worse than leaving a gap open: it
> burns a cycle, it churns files another agent may be holding, and it usually lands a
> second, subtly different copy of a rule. **Read the refuted list before starting
> anything.**

Each row carries a severity and a rough effort (**S** ≈ hours, **M** ≈ a day,
**L** ≈ several days). The description is deliberately written as what a family
experiences, not as what the code does — when the two disagree about priority, the
family is right.

---

## Open — survived refutation

| § | sev / eff | Section | What a family runs into |
|---|---|---|---|
| **7** | high / L | DOMAIN SERVICE LAYER | A parent on a patchy phone connection taps Save twice on a school concert and gets two identical events on the family calendar - the same double-tap through Bubaly is deduplicated and produces one. A parent typing "Milk" into the grocery list when milk is already on it gets a second Milk line; Bubaly adding milk skips it. And an event a parent adds by hand never reaches the family activity trail that an event Bubaly adds does, so the household's own record of who changed what has holes in it wherever a person did the work instead of the assistant. |
| **21** | high / M | NOTIFICATION ORCHESTRATION | A family is woken at 2am by Bubaly's phone push about a chore or a renewal, and there is nowhere in the app to stop it: the quiet-hours setting the database stores is read by no code, and the push channel would ignore it even if it were. Parents who tried to limit what reaches a child's device get the same silence — child_channels is saved and never consulted. |
| **25** | high / M | ATTACHMENT-TO-ACTION | A parent photographs the season's soccer schedule. Eight events appear on the family calendar with no name on them, so nobody knows they are Maya's; two of them collide with Ethan's swim meets and Bubaly says nothing; and there is no "pack cleats Tuesday night" reminder — the parent still does the whole coordination by hand and only discovers the double-booking on the day. Photograph a birthday invitation or a school permission slip into the same screen and it answers "No events found on that flyer." |
| **26** | high / L | RECEIPT-TO-FAMILY-OS | A parent photographs the Target receipt expecting Bubaly to log the $142 against the household budget, notice the dishwasher on it is now under warranty, tick the milk and eggs off the grocery list, and file the receipt against the appliance. Nothing happens — there is nowhere in the app to give Bubaly a receipt, and even by hand Bubaly cannot record a single transaction. Household spending stays a manual data-entry chore, which is the exact drudgery the family bought the product to end. |
| **30** | high / M | IDEMPOTENCY | A parent types "add soccer practice Saturday at 9" into Bubaly's chat, the phone loses signal mid-answer and the app re-sends — and the family now has two soccer practices on the calendar, the exact duplicate the concierge path is protected against. The same applies to a double-tapped send, a reloaded tab, or Bubaly's own retry of a chat write: nothing can tell an already-succeeded write from a new one, so the family cleans up duplicate chores, duplicate grocery lines and duplicate reminders by hand and stops trusting the assistant with anything that matters. |
| **42** | high / M | REALTIME | Two parents at the supermarket both have the grocery list open; one ticks off milk and the other's screen never changes, because that list subscribes to a table that was never published — the page behaves as if it is live and silently is not, so the milk gets bought twice. A parent who approves a $400 plumber call on their phone leaves their partner staring at the same pending approval card until they manually reload, on the one screen where knowing 'someone already handled this' matters most. And every dashboard page a family opens spins up websocket channels for tables that will never send anything, draining phone battery and consuming Realtime connection slots that the AI run timeline — the one surface that does work — needs. |
| **48** | high / M | WORLD-CLASS SIGNATURE FEATURE — "HANDLE IT" | A parent opens the morning brief, sees "Emma's recital overlaps Jack's game on Saturday" and a sentence saying what would fix it — and there is nothing to press. They have to leave the brief, work out which app section owns the clash, and redo by hand the thinking Bubaly just did. The one screen where the button does exist (/dashboard/readiness) is not where anyone lands, so the interaction the spec calls the signature Bubaly moment is one most families never encounter. |
| **49** | high / M | WORLD-CLASS SIGNATURE FEATURE — DAILY BRIEF | Bubaly reconciled the grocery list, nudged Emma about her uniform and moved the dinner-prep reminder overnight — and the parent who opens the brief at 7am is shown none of it, because the section that says so only appears if they come back in the evening. Worse, the brief only exists for someone who remembers to open /dashboard/briefing. A parent packing lunches never sees today's schedule, the milk, or the permission slip due Friday, so the thing meant to start the family's day is a page they have to go looking for. |
| **57** | high / M | REUSE BEFORE REBUILD | A parent types "add 'call the dentist' to our to-do list" in chat and Bubaly answers "Could not add the task." every time — the row is rejected by the database because it is stamped with the login id instead of the family-member id, while the identical request routed through a plan/run succeeds. The same shadowing means the chat's calendar, chore and grocery writes silently skip the duplicate guard and the family activity feed that the registry path gives them. |
| **3** | medium / M | SUPABASE MUST BE THE SYSTEM OF RECORD | A family in Canada, the UK or the EU sets up Bubaly and every budget, allowance, chore payout and savings goal is printed with a dollar sign and US thousands separators, and Bubaly's own summaries say things like "you are $180 over on groceries" for money that was never dollars. There is no setting anywhere that fixes it, so the numbers are quietly wrong on every finance screen the family opens. |
| **22** | medium / M | FAMILY ACTIVITY FEED | A parent opens the page called Activity and sees Emma's chores and the photos someone posted, but nothing Bubaly did — no "Bubaly planned next week's dinners", no "Bubaly added milk to Grocery List". To find out what the AI changed they have to know to go to a different page (Agents). And when a change was contentious — a rescheduled Saturday, a cancelled practice — no stream anywhere records that Dad approved it, so the family cannot reconstruct who authorised what. |
| **32** | medium / M | FAMILY AI SETTINGS | A family that finds Bubaly too chatty has no way to turn it down — the only levers are switching Bubaly off entirely or dropping whole categories to 'Recommend', which also stops it doing the work they wanted. And 'quiet hours' is a promise nobody can keep: a parent cannot tell Bubaly to stop pinging the house after 9pm, so a reminder or a nudge can land at 2am and wake a child's phone, and the only remedy is muting Bubaly's notifications at the operating system, which also silences the ones they needed. |
| **33** | medium / M | OBSERVABILITY | A family writes in that "Bubaly stopped doing my Sunday meal plan" and nobody can answer them: there is no admin view over runs at all, and for every surface except the concierge planner there is no stored record of which model ran, how long it took, or what error came back — only a console line on a server nobody is reading. The family's own run page is the single diagnostic, and it exists only for concierge runs, so a failure in the chat assistant or the daily brief is invisible after the request ends. |
| **39** | medium / M | PERFORMANCE | A family three months in cannot see what Bubaly did for them last month: the run list stops after eight completed runs and the activity feed after 60 items, with no 'show more' anywhere, so 'did Bubaly ever book that plumber back in June?' is unanswerable from inside the app even though the rows are still in Supabase. At the same time the wallet activity screen downloads up to 2,000 transactions on every visit, which on a phone on cellular data is a slow, expensive screen that gets slower every month the family uses it. |
| **45** | medium / S | TESTING REQUIREMENTS | A family's rows are protected by policies nothing in CI ever tries to break. This repo has already lived the failure once (supabase/migrations/0118 exists because production tables had RLS on with their family policies missing, so pages silently returned zero rows). The next migration that adds a table without a policy, or drops one, ships without a red build — and a household either loses access to its own calendar and money or, worse, another family can read it. |
| **46** | medium / M | END-TO-END TEST PERSONAS | The catch-all question a stressed parent actually types — "what am I forgetting?" — is the one flow nobody has ever watched complete. It reads nine domains and can create a to-do per gap it finds, so when it misfires a parent gets a fabricated chore list or, worse, silence about the permission slip due Friday. And because the other five flows only ever run against a hand-written fake of PostgREST, a real constraint, RLS policy or column default that would reject the write on a live database is not discovered until a family hits it. |
| **50** | medium / M | WORLD-CLASS SIGNATURE FEATURE — WEEKLY FAMILY PLAN | A parent opens the weekly plan on Sunday night and gets soccer, the dentist, five dinners and the shopping list — but not the three bills due Thursday or the car payment that lands mid-week, so they still have to open the finance module separately and the "plan our week" run can never move a purchase or a bill off a tight day. On the Plus Weekly AI Briefing the furnace filter and the overdue gutter clean are invisible too, so the one page sold as the week at a glance quietly leaves out two of the eleven things the family was promised it would cover. |
| **60** | medium / M | DEFINITION OF DONE FOR EVERY AI TOOL | A parent who asks twice in one conversation for milk on the list gets two milks, and the calendar event Bubaly just made from chat never appears in the family activity feed — so the other parent has no record that Bubaly, not a person, put it there. |
| **66** | medium / S | AI SYSTEM PROMPT PRINCIPLE | A parent whose client still hits the older chat endpoint gets a Bubaly operating without the rule that stops it inventing household facts or claiming it did something it never did — and with a school email or an event title someone else wrote pasted in unfenced, that text can instruct it while calendar, chores, grocery and to-do write tools are attached. Separately, when a prompt change makes Bubaly noticeably worse, nobody can tell which conversations ran on the old wording, because chats are never stamped with a prompt version. |
| **70** | medium / M | CONTINUOUS CLOSED LOOP | When the week changes underneath a run — the plumber can't come Tuesday, or three of five dinners fail because the pantry is empty — Bubaly cannot rethink the rest of the plan. It marks those steps failed, reports "partially completed", and stops. A parent has to open the run page and hand-edit a step (or start the whole request again) to get the remaining work re-planned, which is exactly the seven-modules-by-hand work the product exists to remove. |
| **14** | low / S | AI MEMORY | A family that is happy for Bubaly to remember meal preferences and clothing sizes but does not want it keeping notes about, say, their finances, their contacts, or one child's routines has exactly one lever: all memory or none. Turning it off to protect the one area they care about also stops Bubaly remembering that Tom doesn't eat mushrooms and that Saturday mornings are off-limits, so in practice they leave it on and Bubaly keeps learning in the area they wanted left alone. The two categories most families would name first (medical, account) are already protected, so what is lost is the family's ability to draw their own line rather than accept ours. |

### Closed since the sweep

- **§21, the push half.** `dispatchPendingPushes` selected on `pushed_at` alone. The
  in-app list (`listUnread`) and the email digest (`deliverNotificationEmails`) both
  filter `send_at <= now`; push did not — and `listUnread`'s own docstring claimed the
  deferral holds *"at read time as well as at push time."* It did not. That bites today
  with no quiet-hours writer anywhere, because the AI's `notifications.notify` tool
  exposes `send_at` as *"Earliest delivery"*: a notice scheduled for 8am tomorrow buzzed
  the phone on the next two-hourly scan, tonight. Fixed by one `.lte('send_at', …)`,
  proved by `tests/push-send-at-boundary.test.ts`. The §21 row above is what remains:
  two stores, one reader, no writer, and `child_channels` unread.

- **§57, the to-do FK and two misattributions.** `lib/assistant/tools.ts` wrote
  `created_by: ctx.userId` into `todo_lists` and `todo_items`, whose FKs point at
  `public.family_members(id)` (`0015_todos.sql`), not `auth.users`. Every chat "add a
  to-do" failed, 100% of the time. The same context had no notion of who was speaking,
  so `ctx.members.find((m) => true)` — `members[0]` written to look like a lookup —
  decided who RSVP'd to an event and who signed an announcement: a teen saying "I'm
  going" was recorded as whoever sorts first in the roster. `AssistantCtx` now carries
  a required `memberId`; `tests/assistant-actor-identity.test.ts` pins all three, plus
  the control case that `calendar_events.created_by` really is an `auth.users` id and
  must stay one. The §57 row above is what remains: the shadowing itself.

---

## Refuted — do not rebuild these

Each was a plausible, well-evidenced claim. Each was checked against the code and
failed. The one-line reason is the load-bearing half.

| § | Claim | Why it is wrong |
|---|---|---|
| **5** | The chore-proof verdict is scraped from model prose and "can auto-approve a real money payout". | It cannot move a cent. `applyCompletionRewards` touches only `kid_progress` and `member_badges`; every wallet credit goes through `creditChildWallet`, whose four call sites are all outside the AI path. And `normalize()` whitelists `status` to five literals, clamps the scores and forces `needs_parent_review` on any safety flag — a lax parse structurally cannot be *more* permissive. `response_format: json_schema` constrains shape, not content, so the proposed remedy closes nothing. |
| **13** | Only 11 of 36 write tools verify; updates and deletes trust their own return value. | The premise is wrong. Every update and delete service returns the **database's** post-write row via `RETURNING`, family-scoped in the write predicate, with zero rows as a hard `notFound`. `verify` is also a slot on any `act` step, and the claim's own named counter-example — `trips.syncToCalendar` — *is* verified, at `templates/prepare-vacation.ts:86`. |
| **20** | "There is no event path at all: nothing reacts to a row being created or changed." | `0134_model_dirty.sql` attaches an AFTER INSERT/UPDATE/DELETE trigger to ten tables including `vacations` and `documents`, with two live consumers, hardened in `0249` after a real production FK failure and pinned by two test files. It delivers §20's "trip created → offer preparation workflow" on the insert itself. §20 opens "Support **future** event-driven AI behavior" and labels the six as "Examples". |
| **23** | Ask Bubaly answers from a bundle omitting home, vendors, money, documents and travel. | The bundle does not determine answerability — the tool catalogue does, and the claim never checked it. `INTENT_TOOL_DOMAINS.answer_question` includes `home_maintenance`, `documents`, `finances` and `travel`, and `toolsForIntent` really does offer `home.lastServiceByTrade`, `documents.listDocuments` and `finances.listTransactions`. Widening the *slices* instead would be a **§27 regression** — §27 forbids carrying passports into prompts that do not need them. |
| **34** | Only concierge requests are metered, and nothing reads the token counters back. | Read back in three places, including the run timeline's "1.2s · 850 tokens" and the month-to-date plan-allowance check. Routine-fired work is metered too. §34's own text frames allowances as **future** support. The real residue is breadth — the feature routes file no `ai_requests` row — which is one argument per route. |
| **52** | Page context is built and validated but only the ⌘K palette ever sends it. | Checked and refuted on the wiring. |
| **59** | Several surfaces show the same empty state when the read FAILED. | Refuted as stated; the surfaces named distinguish the two. |
| **62** | "Never fabricate external success" is broken once telephony env vars are set. | Refuted on the branch actually taken. |
| **65** | `.env.example` omits ~8 shipped variables. | Refuted on the current file. |
| **67** | Step 8's birthday half is missing from plan-week. | Refuted against the template. |
| **68** | Navigation is not oriented around outcomes. | Refuted as a spec over-read. |

The last six were refuted with shorter reasoning than the first five; if you are about
to start one of them, re-read the refutation in the sweep run before trusting this
summary of it.

---

## Working agreement

Two agents are working this repo concurrently. To keep out of each other's way:

- **Claim a row before you start it** by opening a draft PR whose title names the
  section, or by saying so in a comment on an open PR. An unclaimed row is fair game.
- **Small and separable beats large and bundled.** §3 and §14 are each a migration plus
  a setting. §7 and §26 are not; do not start one as a side quest inside another PR.
- **A gap is only closed by a test that fails without the change.** For the boundary
  rows that means a behavioural proof, not a policy listing — `0267` applied cleanly,
  read correctly, and changed nothing, because a `FOR ALL` policy from `0006` was still
  OR'ing itself back in. The proof that caught it ran as a real `authenticated` session.
- **Ordering is a property too.** A test that compares two `indexOf` positions in a
  source file cannot tell "refuses" from "refuses too late". If the property is that
  something happens *before* something else, inject the effects and hold spies.
- **Refuting a row here is a contribution.** If an open row is wrong, move it to the
  refuted table with the citation rather than quietly skipping it.
