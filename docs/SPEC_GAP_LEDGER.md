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
| **7** | high / L | DOMAIN SERVICE LAYER | A parent on a patchy phone connection taps Save twice on a school concert and gets two identical events on the family calendar - the same double-tap through Bubaly is deduplicated and produces one. A parent typing "Milk" into the grocery list when milk is already on it gets a second Milk line; Bubaly adding milk skips it. And an event a parent adds by hand never reaches the family activity trail that an event Bubaly adds does, so the household's own record of who changed what has holes in it wherever a person did the work instead of the assistant. (**Calendar tranche landed.** Add Event, Find a time, Edit and Delete now go through `lib/services/calendar` via `app/(app)/dashboard/calendar/actions.ts`, so the module's own Save is deduplicated by the same 0256 index Bubaly's writes use, is validated server-side, and filters `family_id` on update and delete instead of leaving tenancy to RLS. Proofs: `tests/calendar-write-path.test.ts` behaviourally, `tests/calendar-single-write-path.test.ts` structurally; `components/modules/routines-panel.tsx` is the one calendar writer still going to PostgREST from the browser, because it materialises a routine as a BATCH and `createEvent` creates one event. **Groceries tranche landed** (second symptom). The three surfaces a family actually reaches — `shopping-module` (what `/dashboard/grocery` renders), `pantry-module`, `recipes-module` — add through `addItems` via `app/(app)/dashboard/grocery/actions.ts`, so a name already on the list is skipped by `normalizeName` (case, trailing plural 's' and spacing are not differences; checked items are excluded so milk bought last week is addable again). `skipped` is surfaced rather than swallowed: "Milk is already on your list" instead of a silent second line. `components/modules/grocery-module.tsx` is a fourth, UNREACHABLE copy — nothing imports it, no barrel, no dynamic import — and is left alone rather than half-fixed. **Found on the way, now fixed:** `grocery_lists` carries two columns answering "is this archived" — `is_archived` (0002) and `archived_at` (0014) — and NOTHING sets `is_archived`; the only archive writer is the shopping module, which stamps `archived_at`. So a family archived their list, the shopping page hid it, and every `is_archived`-only reader — the service, and therefore Bubaly — kept adding to it. Every open-list lookup now asks both. Consolidating the columns is a migration and a separate decision. `lib/database.types.ts` was also missing all five columns 0014 added to `grocery_lists`, which is why the shopping module carried three `as never` casts; the type now matches the migration and the casts are gone. Proofs: `tests/grocery-write-path.test.ts`, `tests/grocery-single-write-path.test.ts`. **To-dos tranche landed.** `todos-module`'s quick add, edit modal, tick-off and delete go through `app/(app)/dashboard/todos/actions.ts`; `updateTodo` and `deleteTodo` were ADDED to `lib/services/tasks` (it had only `completeTodo`/`assignTodo`, so the edit modal and delete button had nowhere to go and filtered `id` alone). Creates carry a submission id against 0256's index; `created_by` is the `family_members` id, which is the FK the service layer exists to stop getting wrong. The two `todo_lists` inserts are deliberately left: `ensureTodoList` takes no icon or colour, so routing them would change what a new list looks like. Proofs: `tests/todo-write-path.test.ts`, `tests/todo-single-write-path.test.ts`. **Still open: `family_reminders`** (five client insert sites across front-desk, inbox, autopilot and reminders modules — the largest remaining surface), `routines-panel`, and the activity trail. `chore_assignments` and `meal_plans` have no client-side writes at all. **Reminders tranche landed, and it was not just idempotency.** `family_reminders` (0014) constrains `status in ('active','snoozed','completed','dismissed')` and `priority in ('low','medium','high','urgent')`. Four call sites wrote `status: 'pending'` and, off their urgent branch, `priority: 'normal'` — **neither value is in either set, so Postgres rejected the row every time and nothing was ever written**: Front Desk's "turn a call action item into a reminder", the Inbox's one-tap, approving an Autopilot `create_reminder` suggestion, and Paperwork materialising a sign/pay/provide action. Proven against a real Postgres 16, not inferred. All four now go through `createReminder`, which writes a legal status and maps an unrecognised priority onto the column default — the single guard that is why the assistant's reminders always worked while every one-tap button did not. `reminders-module`'s quick-add is converted too. Guard: `tests/reminder-status-constraint.test.ts` reads the allowed values out of the migration rather than restating them. Also `tests/reminder-write-path.test.ts`, `tests/reminder-single-write-path.test.ts`. **`reminders-module`'s editor, recurrence respawn and complete/snooze/delete are NOT converted, and need decisions first:** (a) `CreateReminderInput` cannot express the six columns 0100 added (url, flagged, early_reminder_minutes, image_url, subtasks, list_id), so routing the editor would silently drop what a family typed; (b) the module deliberately retries with those columns stripped when the schema lacks them (`stripNewCols`) and the service has no such tolerance; (c) `completeReminder` rolls a recurring reminder forward IN PLACE while the module spawns a new row and keeps the completed one as history "like iOS" — different data, both defensible, so **today Bubaly completing a recurring reminder loses the history a person completing it creates**. **Third symptom is NOT closed and cannot be closed this way.** `recordActivity` no-ops for `actorKind: 'member'` by design: `agent_activity` is Bubaly's ledger — `/dashboard/agents` renders it as the agent roster's feed and `lib/metric/time-saved-server.ts` counts its `done` rows as time the assistant saved — so writing a parent's own edit there unmarked has Bubaly taking credit for it. A trail carrying both needs a column saying WHICH acted, plus a filter in all six readers; that is a product decision about what the agent feed is, not a call-site change. Pinned by the last case in `tests/calendar-write-path.test.ts` so changing it is a visible diff.) |
| **21** | high / M | NOTIFICATION ORCHESTRATION | A family is woken at 2am by Bubaly's phone push about a chore or a renewal, and there is nowhere in the app to stop it: the quiet-hours setting the database stores is read by no code, and the push channel would ignore it even if it were. Parents who tried to limit what reaches a child's device get the same silence — child_channels is saved and never consulted. (The row is now largely stale: the quiet-hours setting IS read, EVERY site that bypassed it has the window — the batch generator keeps its own insert but takes `deliveryTimeFor` — and `child_channels` IS consulted, at delivery, by both push and email. What remains of this row is the push channel itself and the fact that no UI exists for a parent to set `child_channels` in the first place.) |
| **25** | high / M | ATTACHMENT-TO-ACTION | A parent photographs the season's soccer schedule. Eight events appear on the family calendar with no name on them, so nobody knows they are Maya's; two of them collide with Ethan's swim meets and Bubaly says nothing; and there is no "pack cleats Tuesday night" reminder — the parent still does the whole coordination by hand and only discovers the double-booking on the day. Photograph a birthday invitation or a school permission slip into the same screen and it answers "No events found on that flyer." |
| **26** | high / L | RECEIPT-TO-FAMILY-OS | A parent photographs the Target receipt expecting Bubaly to log the $142 against the household budget, notice the dishwasher on it is now under warranty, tick the milk and eggs off the grocery list, and file the receipt against the appliance. Nothing happens — there is nowhere in the app to give Bubaly a receipt, and even by hand Bubaly cannot record a single transaction. Household spending stays a manual data-entry chore, which is the exact drudgery the family bought the product to end. |
| **30** | high / M | IDEMPOTENCY | A parent types "add soccer practice Saturday at 9" into Bubaly's chat, the phone loses signal mid-answer and the app re-sends — and the family now has two soccer practices on the calendar, the exact duplicate the concierge path is protected against. The same applies to a double-tapped send, a reloaded tab, or Bubaly's own retry of a chat write: nothing can tell an already-succeeded write from a new one, so the family cleans up duplicate chores, duplicate grocery lines and duplicate reminders by hand and stops trusting the assistant with anything that matters. |
| **42** | high / M | REALTIME | Two parents at the supermarket both have the grocery list open; one ticks off milk and the other's screen never changes, because that list subscribes to a table that was never published — the page behaves as if it is live and silently is not, so the milk gets bought twice. A parent who approves a $400 plumber call on their phone leaves their partner staring at the same pending approval card until they manually reload, on the one screen where knowing 'someone already handled this' matters most. And every dashboard page a family opens spins up websocket channels for tables that will never send anything, draining phone battery and consuming Realtime connection slots that the AI run timeline — the one surface that does work — needs. |
| **48** | high / M | WORLD-CLASS SIGNATURE FEATURE — "HANDLE IT" | A parent opens the morning brief, sees "Emma's recital overlaps Jack's game on Saturday" and a sentence saying what would fix it — and there is nothing to press. They have to leave the brief, work out which app section owns the clash, and redo by hand the thinking Bubaly just did. The one screen where the button does exist (/dashboard/readiness) is not where anyone lands, so the interaction the spec calls the signature Bubaly moment is one most families never encounter. |
| **49** | high / M | WORLD-CLASS SIGNATURE FEATURE — DAILY BRIEF | Bubaly reconciled the grocery list, nudged Emma about her uniform and moved the dinner-prep reminder overnight — and the parent who opens the brief at 7am is shown none of it, because the section that says so only appears if they come back in the evening. Worse, the brief only exists for someone who remembers to open /dashboard/briefing. A parent packing lunches never sees today's schedule, the milk, or the permission slip due Friday, so the thing meant to start the family's day is a page they have to go looking for. |
| **57** | high / M | REUSE BEFORE REBUILD | A parent's calendar, chore, to-do and grocery writes through chat silently skip the duplicate guard, the `ai_tool_calls` ledger and the family activity feed that the identical request routed through a plan/run gets, because the chat toolbox shadows the registry tools of the same capability. (Half of this row is already fixed and the sweep's wording is stale: "add 'call the dentist'" failing every time was the `created_by` foreign key, closed in `47f32fd` when `AssistantCtx.memberId` landed. What remains is only the shadowing.) |
| **3** | medium / M | SUPABASE MUST BE THE SYSTEM OF RECORD | A family in Canada, the UK or the EU sets up Bubaly and every budget, allowance, chore payout and savings goal is printed with a dollar sign and US thousands separators, and Bubaly's own summaries say things like "you are $180 over on groceries" for money that was never dollars. There is no setting anywhere that fixes it, so the numbers are quietly wrong on every finance screen the family opens. |
| **22** | medium / M | FAMILY ACTIVITY FEED | A parent opens the page called Activity and sees Emma's chores and the photos someone posted, but nothing Bubaly did — no "Bubaly planned next week's dinners", no "Bubaly added milk to Grocery List". To find out what the AI changed they have to know to go to a different page (Agents). And when a change was contentious — a rescheduled Saturday, a cancelled practice — no stream anywhere records that Dad approved it, so the family cannot reconstruct who authorised what. |
| **32** | medium / M | FAMILY AI SETTINGS | A family that finds Bubaly too chatty has no way to turn it down — the only levers are switching Bubaly off entirely or dropping whole categories to 'Recommend', which also stops it doing the work they wanted. And 'quiet hours' is a promise nobody can keep: a parent cannot tell Bubaly to stop pinging the house after 9pm, so a reminder or a nudge can land at 2am and wake a child's phone, and the only remedy is muting Bubaly's notifications at the operating system, which also silences the ones they needed. |
| **33** | medium / M | OBSERVABILITY | A family writes in that "Bubaly stopped doing my Sunday meal plan" and nobody can answer them: there is no admin view over runs at all, and for every surface except the concierge planner there is no stored record of which model ran, how long it took, or what error came back — only a console line on a server nobody is reading. The family's own run page is the single diagnostic, and it exists only for concierge runs, so a failure in the chat assistant or the daily brief is invisible after the request ends. (Partly closed: the admin view over runs now exists at `/admin/ai-activity`, and `withAiRequest` exists and the two surfaces this row names by name — the chat assistant and the daily brief — now open an `ai_requests` row with model, tokens, latency and error. 17 other model entrypoints are still silent, counted and capped by `tests/ai-observability-coverage.test.ts` (the count was 32 until the scanner stopped counting files that cannot reach a model). The admin view over runs is untouched.) |
| **39** | medium / M | PERFORMANCE | A family three months in cannot see what Bubaly did for them last month: the run list stops after eight completed runs and the activity feed after 60 items, with no 'show more' anywhere, so 'did Bubaly ever book that plumber back in June?' is unanswerable from inside the app even though the rows are still in Supabase. At the same time the wallet activity screen downloads up to 2,000 transactions on every visit, which on a phone on cellular data is a slow, expensive screen that gets slower every month the family uses it. |
| **46** | medium / M | END-TO-END TEST PERSONAS | The catch-all question a stressed parent actually types — "what am I forgetting?" — is the one flow nobody has ever watched complete. It reads nine domains and can create a to-do per gap it finds, so when it misfires a parent gets a fabricated chore list or, worse, silence about the permission slip due Friday. And because the other five flows only ever run against a hand-written fake of PostgREST, a real constraint, RLS policy or column default that would reject the write on a live database is not discovered until a family hits it. |
| **50** | medium / M | WORLD-CLASS SIGNATURE FEATURE — WEEKLY FAMILY PLAN | A parent opens the weekly plan on Sunday night and gets soccer, the dentist, five dinners and the shopping list — but not the three bills due Thursday or the car payment that lands mid-week, so they still have to open the finance module separately and the "plan our week" run can never move a purchase or a bill off a tight day. On the Plus Weekly AI Briefing the furnace filter and the overdue gutter clean are invisible too, so the one page sold as the week at a glance quietly leaves out two of the eleven things the family was promised it would cover. |
| **60** | medium / M | DEFINITION OF DONE FOR EVERY AI TOOL | A parent who asks twice in one conversation for milk on the list gets two milks, and the calendar event Bubaly just made from chat never appears in the family activity feed — so the other parent has no record that Bubaly, not a person, put it there. |
| **66** | medium / S | AI SYSTEM PROMPT PRINCIPLE | A parent whose client still hits the older chat endpoint gets a Bubaly operating without the rule that stops it inventing household facts or claiming it did something it never did — and with a school email or an event title someone else wrote pasted in unfenced, that text can instruct it while calendar, chores, grocery and to-do write tools are attached. Separately, when a prompt change makes Bubaly noticeably worse, nobody can tell which conversations ran on the old wording, because chats are never stamped with a prompt version. |
| **70** | medium / M | CONTINUOUS CLOSED LOOP | When the week changes underneath a run — the plumber can't come Tuesday, or three of five dinners fail because the pantry is empty — Bubaly cannot rethink the rest of the plan. It marks those steps failed, reports "partially completed", and stops. A parent has to open the run page and hand-edit a step (or start the whole request again) to get the remaining work re-planned, which is exactly the seven-modules-by-hand work the product exists to remove. |
| **14** | low / S | AI MEMORY | A family that is happy for Bubaly to remember meal preferences and clothing sizes but does not want it keeping notes about, say, their finances, their contacts, or one child's routines has exactly one lever: all memory or none. Turning it off to protect the one area they care about also stops Bubaly remembering that Tom doesn't eat mushrooms and that Saturday mornings are off-limits, so in practice they leave it on and Bubaly keeps learning in the area they wanted left alone. The two categories most families would name first (medical, account) are already protected, so what is lost is the family's ability to draw their own line rather than accept ours. |

### One correction worth carrying

**§30 is about the ledger, not the gate.** It is easy — I did it — to read "the chat
assistant bypasses the plan path's machinery" as including the trust gate. It does not.
`wrapToolsWithTrust` maps all eleven of the assistant's write tools in `TOOL_DOMAIN`
(`lib/assistant/trust-wrapper.ts`) and routes each through `gateAiAction`, which
resolves the legacy name through the registry and applies the tool's declared risk plus
the family's settings and autonomy dial. So a child's chat write is gated today.

What the chat path really lacks is the `ai_tool_calls` reservation, the
already-succeeded probe and a stable idempotency key — which is exactly why the row
above is titled IDEMPOTENCY and its impact is duplicates, not unauthorised writes.
Fixing it by inventing a second gate helper would add a worse copy of one that already
runs; delegating to `executeTool` is the shape that gets the ledger without a second
gate. Design notes and the objections a review raised against them are in the tranche
design run, and they are substantial: a client-supplied key is guessable across members
unless the acting `memberId` is in it, `legacy-adapter.ts` calls `executeTool` with no
options so ~27 registry write tools would stay undeduplicated, and delegation changes
three visible behaviours (`createTodo` defaults the assignee to the acting member,
`groceries.addItems` skips a duplicate instead of adding it, `reminders.snooze` refuses
a backward move). None of that is a reason not to do it; all of it belongs in the PR
that does.

**And the obvious way to do it loses a family's writes. Do not ship it.** Two
independent designs — delete the shadowing tools, or delegate them in place —
were both rejected on review, for the same reason. Both composed the chat key
from `tool.idempotencyFrom`, and **that key cannot see the assignee**:

| tool | its natural key | what is missing |
|---|---|---|
| `tasks.createChore` | `title:due_at` | assignee |
| `tasks.createTodo` | `title:due_date` | assignee, list, priority |
| `reminders.create` | `title:remind_at` | member, recurrence |
| `calendar.createEvent` | `title:starts_at` | assignee, location, end |
| `messages.createAnnouncement` | `title` | everything else |

So *"give Emma and Jack each a 'take out the bins' chore due Friday"* — one
sentence, two tool calls, identical key — writes **one** chore and reports two
successes. Five of the six delegable tools are assignable, and the swallow is
invisible: `execute.ts`'s duplicate path runs `tool.summarize(input, storedOutput)`
and every `summarize` ignores its input, so the second call is narrated with the
first call's result. That is this repo's own already-rejected `transactions`
fingerprint bug (`lib/services/finances/index.ts`) in five more tables.

Three further findings from the same review, each verified against the code:

- **The dedupe cannot work for a gated call at all.** `executeTool` returns
  `pending_approval` and `denied` at step 3, *before* the ledger reservation at
  step 4. Any PR claiming a resent chat message is deduplicated is false for every
  family that turned approvals on.
- ~~**A resent submission opens two `approval_requests` rows.**~~ **CLOSED by
  0273** — see "one pending approval per request" below. It was exactly as
  described: an unguarded INSERT with no unique index, and approving both cards
  wrote the resource twice.
- **`create_calendar_event` and `add_grocery_item` are in both `AI_TOOLS` and
  `TOOL_DOMAIN`**, and `action-tools.ts` never sets `skipTrust`. Deleting the
  hand-written set without also deleting the `lib/ai/actions.ts` bridge would
  un-shadow them under a name the wrapper gates and create a live double gate.

If the key is composed at all it has to be `[familyId, memberId, conversationId,
submissionId, callIndex, tool, hash(args)]` — the full argument hash and a
per-call ordinal, never the natural key — and the duplicate has to be visible in
the result rather than narrated as a fresh write.

### Closed since the sweep

- **§21, the last writer that could still wake a house at 2am.**
  `generateFamilyNotifications` was the final entry on the write-boundary
  ratchet, carried for tranches with the note "needs its own tranche". It does
  not route through `notify()` — and now, deliberately, it still does not.

  **The exemption is justified rather than owed.** It assembles up to 150 rows
  across events, reminders and medications, each type with its own dedupe read,
  and inserts them in ONE batch. Pushing that through `notify()` would turn one
  insert into 150 round trips on a cron, to re-solve duplicates the function
  already handles. What it was actually missing was never dedupe: it was the
  quiet-hours window.

  So it takes the window and keeps the batch. `deliveryTimeFor` is the decision
  `notify()` already made, lifted out and exported, and the generator resolves it
  ONCE for the whole batch — every row belongs to one family, so a per-row lookup
  would be the same answer fetched 150 times. One definition of "when does this
  land", because two would eventually disagree and the one that drifts is the one
  nobody is testing.

  **"Does not call `notify()`" and "ignores quiet hours" turned out to be
  different claims**, and only the second was ever the problem. The boundary test
  caught this directly: removing the entry from `ALLOWED` made the list assert
  something untrue, because the file IS still a raw-insert site. It stays listed,
  with its reason rewritten from debt to exemption, and its actual behaviour
  asserted in a block of its own.

  **A family that cannot be read is sent to, not held.** When the scope lookup
  fails the zone is unknown, and a notice that arrives is recoverable where one
  held for eight hours against a guessed clock is not.

  Still open in §21: the push channel itself, and the fact that no UI exists for
  a parent to set `child_channels` — a product decision, not a bug.

- **§33 (in part), the two surfaces a family would actually ask about now leave a
  record.** The row says a family writes in that "Bubaly stopped doing my Sunday
  meal plan" and nobody can answer them. The cause was narrower than it looked:
  `ai_requests` has had `model`, `prompt_tokens`, `completion_tokens`,
  `latency_ms` and `error` from the start, and `recordModelCall` has always
  filled them — **but only when handed a `requestId`, and only the concierge
  planner ever opened a row.** Of ~50 model entrypoints, five carried one.

  **It is a wrapper, not a convention, because the provider records nothing
  itself.** `complete()` RETURNS usage and discards it, so adopting observability
  by hand is four separate edits per route — open a row, time the call, record
  the model and usage, close the row. Four steps by hand in forty places is four
  steps done wrong in some of them. `withAiRequest(scope, {feature, text}, body)`
  does all four.

  **The record now says which model ANSWERED.** `AICompletion` carried usage but
  not the model, so a caller could only report the constant it *intended* to use
  — exactly the wrong answer after a fallback or a config change. The provider
  now reports it, because the provider is the only thing that knows.

  **Two surfaces, chosen because the row names them.** The daily brief swallows
  provider errors by design (they can carry family context), so recording had to
  happen *inside* the swallow or it would be erased. The chat assistant never
  throws at all — it catches its own stream errors and falls back — so
  `obs.failed(err, {partial})` is how a surface that handles its own errors still
  leaves the evidence, and a stream that broke halfway settles as
  `partially_completed` rather than as a clean completion.

  **Bookkeeping never fails the family's work**: if the row cannot be opened the
  body still runs with a null request id. Its own test caught this promise being
  broken — the `executing` update had no `.catch()`, so a transient failure there
  would have taken down the brief it was supposed to be observing.

  **Twelve more surfaces followed** — the meal planner, insights, assist, the weekly
  briefing, the health coach, the habit coach, savings, the journal prompt, and the
  four home surfaces (repair diagnosis, find-a-pro, the maintenance forecast and
  utility savings) — each named individually in the coverage test, because "fewer
  silent surfaces" is not a property anyone can check while "the meal planner
  records which model produced this week's plan" is.

  **Four more closed a failure mode nothing was recording: the model answered
  and the surface could not use the answer.** Notes assist, the relationship
  digest, meal nutrition and the chef each ask for a shape — a summary, a
  headline, JSON, a parseable plan — and each has a branch for "we got a reply
  and could not read it". Two answer 502, one 422, and the chef silently keeps
  its deterministic fallback. In every case the tokens were spent and the row,
  had there been one, would have read `completed`.

  They now call `obs.used` and THEN `obs.failed`, in that order, so the spend
  lands on the row even though the turn failed. The coverage test asserts the
  ordering by source position rather than the presence of both calls: a mutant
  that charges the tokens only when the answer was usable — the natural way to
  write it — passes a presence check and fails this one.

  The chef is the sharpest case: `source: 'fallback'` is what a family sees when
  the provider threw, when the reply would not parse, AND when no API key is
  configured. Three causes, one indistinguishable outcome.

  **Utility savings is the third surface that does not fit the pattern.** It
  answers 200 whether or not the model ran: on a provider failure it drops the
  narrative and returns its deterministic findings alone, flagged `aiUsed:
  false`. That flag cannot distinguish "the model errored" from "no API key is
  configured", which is precisely the §33 complaint — so the wrapper has to sit
  INSIDE the try that swallows, and the test asserts the ordering rather than
  just the presence of a call. The first version of that assertion sliced from
  `withAiRequest(` to `obs.used(` and passed against a mutant that wrapped the
  provider call in its own `try { ... } catch { return null }`, because the
  swallow lands AFTER `obs.used`. The slice now runs to the `aiUsed = true` that
  follows the wrapper, and the mutant fails.

  **The ratchet was carrying the exact slack its own comment forbids.** The
  scanner counted any file importing from `lib/ai/provider`. Nine of the 32 could
  not obtain a provider at all: six import only a `ToolSpec` or `AIProviderConfig`
  type (`lib/assistant/tools.ts`, `lib/assistant/trust-wrapper.ts`,
  `lib/ai/action-tools.ts`, `lib/ai/tools/legacy-adapter.ts`, `lib/ai/settings.ts`,
  `lib/ai/provider-stub.ts`), and three import only `describeAIError` /
  `isAIConfigured` (`app/api/ai/route.ts`, `app/api/social/ai/route.ts`,
  `app/(app)/dashboard/concierge/run-actions.ts`). Nine files' worth of room for a
  new silent surface to slip in green.

  It also missed a real one. The obvious forward regex —
  `import\s+(type\s+)?\{[\s\S]*?\}\s+from '…provider'` — starts matching at the
  FIRST `import {` in a file and lazily extends to the provider specifier,
  swallowing every import in between. Any file whose first import happens to be
  `import type {…}` reads as type-only regardless of what it takes from the
  provider. That is how `lib/ai/assistant-engine.ts` — which imports
  `resolveProvider` and calls `provider.runTools` in three places — was classified
  as unable to reach a model. The scanner now finds each provider import by
  scanning BACK from the specifier to the `import` that opens the statement, and
  requires a value import of one of the four exports that actually yield a
  provider (`resolveProvider`, `getProvider`, `providerFromConfig`,
  `OpenAIProvider`).

  Having been wrong in both directions, the scanner now has fixtures of its own:
  nine files asserted absent by name with the reason, three asserted present, and
  six direct unit checks on the classifier including the exact shape the forward
  regex got wrong.

  **The assistant engine — `/api/ai`, both transports — was the largest, and it
  did not take the wrap-the-provider-call shape.** `createAssistantStream`
  returns a `ReadableStream` and `withAiRequest` settles when its body resolves,
  so a wrapper placed around the call would settle every row `completed` before a
  single token existed. It has to live INSIDE `start(controller)`, which is how
  `app/api/ai/chat/route.ts` already does it. A test asserts the ordering by
  source position, and a mutant that hoists the wrapper to wrap the stream
  construction — the realistic mistake — fails it.

  The scope came free: `prepareAssistantTurn` already builds a `ServiceScope`
  with the resolved `family_members.id` from its roster lookup, which the route's
  own context does not reach. Carrying it on `PreparedAssistantTurn` meant no new
  route plumbing. Its `actorKind` is `'ai'` (correct for the tool writes) but
  `createRequest` reads only `familyId`/`userId`/`memberId`, so the row is
  attributed to the person who typed the message.

  The five outcomes are now distinguishable, which they were not:

  | What happened | Family saw | Row |
  |---|---|---|
  | Stream completed | full answer | `completed` |
  | Stream broke before any text, `runTools` fallback succeeded | full answer | `completed`, two `used` calls |
  | Stream broke before any text, fallback also threw | nothing | `failed` |
  | Stream broke mid-answer | partial answer | `partially_completed` |
  | Answered, then `persistAssistantTurn` failed | full answer, **not saved** | `partially_completed` |

  That last row is a gap nothing else had found: **the assistant can answer
  correctly and fail to save the turn**, and the family meets it later as a
  conversation missing its last exchange. The only trace was an SSE `error` event
  (or a `persistenceError` field) the client may never surface.

  One honest limitation: `runToolsStream` yields deltas and actions but no usage
  total — only the JSON transport's `ToolRunResult` carries one — so the
  streaming row records the model and no token counts. A zero would read like a
  free turn.

  Two test changes worth naming. `tests/assistant-stream.test.ts` needed a scope
  on its prepared-turn stub, and its stub `db` has no `insert().select()` chain,
  so the row fails to open and the wrapper carries on with a null request id —
  the "bookkeeping never fails the family's work" promise being exercised rather
  than mocked away. And `tests/ai-prompt-injection.test.ts` asserted that a
  hostile calendar title caused no writes outside `ai_messages`/
  `ai_conversations`; `ai_requests` is the same class of the assistant's own
  bookkeeping, so the set was widened deliberately and the assertion strengthened
  to also name the actual attack (no `calendar_events` write of any kind).

  **The helper/route pairs needed the scope threaded, not the call site
  wrapped.** `lib/chores/ai.ts` and `lib/social/ai.ts` hold the provider; their
  single callers hold the scope. Wrapping at the call site would have observed
  the surface while leaving the helper counted as silent, because the scanner
  counts the file that OBTAINS a provider. So `validateChoreSubmission`,
  `generateChorePlan` and `generate` each take a `ServiceScope` as their first
  argument now and open their own row — one caller each, so a required parameter
  was cleaner than an optional one that could silently no-op.

  **The chore validator is the richest case so far, and the most child-facing.**
  It never throws, and ends at `fallbackValidation` four ways: no API key, a
  photo chore with no photo, a reply that will not parse, and a provider that
  threw. From the child's side those four are ONE thing — *the chore I did was
  not auto-approved and now I wait for a grown-up*. Two of them were silent.

  The sharper half of the fix is which paths open NO row. "No key configured" is
  a setting and "a photo chore with no photo" is a guard that fires before
  anything is asked of a model; a row for either would inflate the failure count
  on `/admin/ai-activity`, which is the first number support reads. Six
  behavioural tests pin all four paths, including that a chore is never
  `rejected` for an AI outage, and that the verdict still arrives when the
  request row cannot be opened at all.

  Three signature changes broke no test, because none of these helpers had one.
  `tests/chores-ai-observed.test.ts` is the first.

  **The ledger is now readable, which is the half the gap row actually names.**
  §33's complaint is not "the rows are missing" — it is *"a family writes in that
  'Bubaly stopped doing my Sunday meal plan' and NOBODY CAN ANSWER THEM."* Until
  `/admin/ai-activity`, no application code selected from `ai_requests` at all
  except `loadRunDetail`, which needs a run. The twelve feature surfaces have no
  run, so four tranches of careful recording were **write-only**: everything
  above this paragraph was invisible to the person answering the ticket.

  The page shows, across all families: surface, status, model, token total,
  latency, error, and the request text — filterable by status, feature and
  family, with a 24-hour strip counting failures and in-flight rows. It is behind
  `app/(app)/admin/layout.tsx`, which redirects a non-super-admin before any
  child renders.

  Three decisions worth recording:

  - **The query is in `lib/ai/activity.ts`, not in the page.** The runner is
    `environment: 'node'` and cannot render a server component, so a page that
    holds its own filtering is a page whose filtering is never tested. Twenty
    tests pin it; the page has five guard assertions on top.
  - **PostgreSQL filters and counts, JavaScript does not.** The neighbouring
    audit-logs page fetches 500 rows and filters in memory. Copied here, "show me
    every failure" would silently mean "every failure inside the last 500 rows",
    on a table that grows by a row per AI call. `count: 'exact'` plus `range`
    instead.
  - **`request_text` is shown, and only here.** Support answering a ticket needs
    the message that failed, and the same text already lives in `ai_messages`.
    Most surfaces store a safe label ("Analyse a note", "Resolve a calendar
    clash"); the chat assistant and the chef store the person's own words. The
    search box deliberately does NOT search that column — it is for diagnosing a
    surface, not for trawling what families typed.

  One real bug came out of writing it: validating the status filter against
  `RUN_STATES` is wrong. That constant is `AiRunLifecycleState[]` and includes
  `paused` — a person pausing a RUN, which no request row ever carries — so
  `?status=paused` would have reached a query that can never match, and the
  console would have shown an empty table reading as "Bubaly did nothing" rather
  than "that is not a status". The compiler caught the unsound type predicate;
  `AI_REQUEST_STATES` is now derived by filtering `paused` out, and a test pins
  both halves.

  **Server actions, not routes — the same wrapper, a different call shape.**
  The reconnect-message drafter, the paperwork reply drafter and the marketplace
  assistant are Server Actions returning result objects rather than HTTP
  responses. They needed nothing new: `ctx` and the client are already in scope,
  and the failure modes are the familiar ones (an empty answer returned as an
  error result; the marketplace one swallowing into its deterministic engine).
  What each does NOT put on the row is the point — not the contact's name, and
  nothing at all from the paperwork itself, which is OCR of a letter somebody
  else wrote and the most literally untrusted text in the product.

  **A second surface that will never adopt, for the same reason as the gift
  route.** `app/(app)/admin/ai/actions.ts` authenticates with `getUser()` +
  `isSuperAdmin()` and never resolves a family: it answers "does the configured
  key work?". There is no `familyId` to build a scope from, and billing a
  connectivity check to whichever family came first would be worse than not
  recording it. Named in the coverage test with that reason, so the floor is now
  2 rather than 1.

  **The subtlest shape: a canned sentence that reads like the real thing.**
  When the parenting coach at `/api/behavior/insight` replies without JSON, the
  route answers 200 with *"Keep logging — patterns will sharpen over time."* — a
  warm, plausible sentence a parent cannot distinguish from coaching. The other
  empty-200 routes at least LOOK empty; this one looks like an answer. Three
  paths reach it (no JSON in the reply, `JSON.parse` throwing on malformed
  braces, the provider throwing) and none recorded anything. The canned line is
  still what the parent sees — the test asserts the failure is recorded BEFORE
  it, by source position, so a mutant that drops `obs.failed` fails.

  `auto.accident` went in the same tranche and is worth naming for a different
  reason: someone has just had a car accident, and a 503 there is the failure on
  this whole list a family is most likely to write in about.

  **A fourth shape of silence: a 200 carrying an empty answer.** After "throws"
  (the common case), "never throws" (the chat assistant) and "answers 200 with a
  flag" (utility savings), `/api/ai/resolve-conflict` splits the model's reply
  into lines and answers `{ ideas: [] }` when none survive — which is exactly
  what a working model with nothing to suggest would produce. A parent sees "no
  suggestions" either way. The response is deliberately unchanged; the row is now
  the only place that difference lives.

  The two Money Coach routes (`wallet.coach`, `wallet.coach.child`) went with it,
  both the familiar unparseable-answer 502. Neither puts the child's name on the
  row: `childId` is already the subject of the `wallet_audit_logs` entry, and the
  request ledger does not need to repeat which kid is being coached about money.

  **The remaining 19 silent surfaces are counted, not ignored.**
  `tests/ai-observability-coverage.test.ts` caps them at exactly 17 — not a round
  number above it, because slack in a ratchet is room for new silent surfaces to
  slip in green, and the ceiling comes down with every adoption (52 → 48 → 44 → 42 → 40 → 36 → 32, then 23 as a correction rather than nine adoptions, then 22, then 19, then 17, then 14, then 11, then 8, then 6) — and
  asserts the scanner finds something, so a broken scanner cannot satisfy the cap
  vacuously. Verified: 22 fails, and adding one new provider-calling route fails it.

  **The floor is 3, and this paragraph used to say 1.** That was wrong twice
  over. `lib/ai/routing.ts` builds an `OpenAIProvider` and hands it back without
  ever calling one — no request to observe, no scope to observe it with. But
  `/api/ai/gift` was documented as deliberately-not-adopted in its own paragraph
  and never counted toward the floor here, despite obtaining a provider and
  sitting in the count from the first day. The floor was 2 the day "the floor is
  1" was written, and `app/(app)/admin/ai/actions.ts` makes it 3. All three are
  now named in one assertion, which is what stops the arithmetic drifting again.

  None is excluded from the count: excluding any means teaching the scanner a
  judgement call, and a scanner that makes judgement calls can be argued into
  excluding a real surface.

  **One surface is deliberately NOT adopted.** `/api/ai/gift` is unauthenticated
  by design — a giver following a gift link is not signed in — so
  `scopeFromUserContext` has nothing to build from. It could be given a system
  scope for the family that owns the link, but that would put a stranger's
  request on the family's own `ai_requests` ledger, and whose AI budget a
  gift-link visitor spends is a product decision rather than a mechanical
  conversion. Recorded in the coverage test with that reason instead of guessed
  at.

  It is one of three surfaces so far that do not fit the pattern, alongside the
  chat assistant which never throws and utility savings which answers 200 on
  failure, and the assistant engine whose stream outlives the call that creates
  it, and the conflict resolver that answers 200 with an empty list. The
  remaining 17 should be expected to contain more of them: "wrap the provider
  call" is the common case, not the whole set.

  **Adopting the wrapper widens what a route reads from its user context.**
  `scopeFromUserContext` needs `ctx.active.role`, `ctx.active.family.timezone`
  and `ctx.active.member.id`; a route that previously touched only `user.id` and
  `active.familyId` now touches all of them. Both are required fields on
  `FamilyMembership`, so production always has them — but a hand-rolled test stub
  need not, and `tests/relationship-ai-gift-history.test.ts` had one that did
  not. It failed seven ways with a `TypeError` on `timezone` swallowed into a
  500. Expect the same in the remaining 32: the stub is thinner than the type.

  Still open in §33: the other 17 surfaces. The admin view over runs is now
  built; what it cannot show is a surface that never opened a row, which is what
  the ceiling counts. Note that `app/api/ai/route.ts` is not among them and is
  not silent either — it holds the scope, the engine holds the provider, and the
  scanner counts the file that obtains one. For a route/helper pair like that,
  adoption in either closes both.

- **§21, "how Bubaly may reach a child directly" was a setting that did
  nothing.** `0257` documents `family_ai_settings.child_channels` as
  `{"push": true, "email": false}` — how Bubaly may reach a child directly. It
  was written by the settings service and read into `AISettings.childChannels`,
  and then consulted by **nothing**: five references in the whole repository, not
  one of them a decision. A family that switched a channel off was told nothing
  and silenced nothing.

  **Enforced at DELIVERY, not in `notify()`.** The setting says how Bubaly may
  REACH a child, not what a child may be told: turning push off should stop the
  phone buzzing, not erase the notice from the in-app list the child opens
  themselves. So `childrenBlockedOn` filters in `dispatchPendingPushes` and in
  `deliverNotificationEmails`.

  **The whole-family fan-out is the case that mattered.** A notification with
  `user_id` null fans out to every active member, so filtering only the addressed
  case would still have reached a child by the widest path — and the one a family
  notices most. The candidate set is built from both shapes before the filter
  runs, and `pushed_at` is still stamped when everyone is filtered out, or the
  notification would be reconsidered on every cron run forever. On the email side
  the block folds into the same skip set as the per-user toggle, so a withheld
  email is resolved into `sent_at` rather than retried.

  **Absent means allowed**, the rule `settingsFromRow` already applies to
  `enabled`: the column defaults to `{}` and only an explicit `false` is a
  decision. Otherwise every family that has never opened the setting would go
  dark. **A failed read delivers** rather than failing closed — this governs
  which channel a notice takes, not whether a child may be told something, and
  quiet hours and the trust gate are the boundaries that fail closed.

  **Scope is the `child` role**, which is what `0257` says. Teens hold their own
  logins and are not what a parent is limiting here; widening it would be a
  product decision rather than a reading of the contract.

  **What is still missing, and is the user's call: there is no UI.** No component
  in the repository reads or writes `childChannels`, so a parent cannot set this
  today — only the settings service can, through an API call. Enforcement makes
  the stored setting truthful and is a prerequisite either way; the control that
  lets a family use it is a product decision about the Settings → Bubaly AI page,
  not something to invent here.

- **§21, the five notifications that could still arrive at half past eleven.**
  `notify()` is where a notification acquires the two things a family relies on —
  the quiet-hours window and the unread-duplicate guard — and
  `tests/notification-write-boundary.test.ts` already enumerated who bypassed it,
  each with a reason. Five carried the same note: *"not urgent, should move"*.
  They have moved.

  **The crons matter more than their names suggest, because cron schedules are
  in UTC and families are not.** `autopilot-scan` runs at 06:30 UTC, which is
  **23:30 for a family on US Pacific time** — so Bubaly's own unprompted
  suggestion was the single thing most likely to light up a phone at half past
  eleven at night, and it wrote its row raw. `close-auctions` at 10:00 UTC is
  late evening in New Zealand. This is the §21 story arrived at from Bubaly's own
  initiative rather than from a chore or a renewal.

  Converted: `lib/autopilot/scan.ts`, `app/gift/actions.ts`,
  `app/(app)/dashboard/locator/actions.ts`,
  `app/api/cron/close-auctions/route.ts`,
  `app/api/cron/return-reminders/route.ts`. Each also gains the duplicate guard,
  which for the crons is the difference between a re-run nudging a family twice
  and not.

  **The locator is marked `urgent`, departing from the note that had it down as
  "not urgent".** Deferring it is the harm: the geofence alerts quiet hours would
  actually hold are the night-time ones, and a child LEAVING the house at 2am is
  precisely the alert a parent must not receive at 7am. Daytime arrivals fall
  outside the window anyway, so marking it urgent costs a family nothing and
  protects the one case that matters. It still gains the duplicate guard, which
  is the real fix for a phone whose GPS jitters across a geofence edge.

  **Both crons build one scope PER FAMILY.** They walk rows belonging to
  different households, and a single scope would apply one family's quiet hours —
  and one family's timezone — to everyone the cron touched. `systemScopeForFamily`
  reads the real zone rather than defaulting, because a window evaluated in the
  wrong zone holds a notice at six in the evening and lets one through at two in
  the morning.

  Two boundary tests went red for the right reason and were fixed rather than
  bent: both pinned the property "a failed notification is counted, and the
  dedupe stamp is not written for a notice nobody got" **by the name of a local
  variable** (`notificationError`). The routes still do both; the tests were
  describing their old shape. They now assert the counting and the stamping.

  Still open in §21: `child_channels` is still saved and never consulted, the
  push channel itself, and `lib/server/notifications.ts` — a batch generator that
  assembles its own rows and is genuinely a different job.

- **§30, one pending approval per request, however many times the phone sends
  it.** The smallest and most concrete piece of the row, and the one that
  actually bites a family today. `openApprovalRequest` was an unguarded INSERT
  and nothing on `approval_requests` stopped a second identical row, so a resend
  — a flaky connection mid-answer, a double-tapped send, a reloaded tab, Bubaly's
  own retry — filed **two pending approvals for one intent**. A parent sees two
  cards that look like the same thing they wanted, approves both, and the
  resource is written twice.

  This is where a gated family's duplicate actually comes from, and it is the one
  the tool ledger structurally cannot catch: `executeTool` returns
  `pending_approval` at step 3, **before** the idempotency reservation at step 4.
  For every family that turned approvals on, the protection §30 describes has
  never been reached.

  `0273` adds `dedupe_key` and a partial unique index. Both halves of the
  predicate are load-bearing:

  * `where status = 'pending'` — a decided request is history. Asking again for
    something already approved is a new request and must be allowed, or a family
    could never repeat anything they had once been granted.
  * `where dedupe_key is not null` — every row that exists today has none, and a
    caller supplying none keeps exactly the old behaviour instead of colliding
    with every other keyless row in the family.

  **The key is the ASK, not the engine's description of it.** Domain, capability,
  who it is for, and the FULL payload — never a natural key, which is the trap
  the earlier design review caught: a natural key cannot see the assignee, so
  "give Emma and Jack each a chore due Friday" collapses two different chores
  into one. Title, summary, reasoning and priority are excluded: they are how the
  engine described the request, and letting them vary would let two identical
  asks through. Payload keys are sorted before hashing, because `JSON.stringify`
  preserves insertion order and two code paths can assemble the same arguments in
  a different sequence.

  **The duplicate is visible rather than narrated as a fresh write**, which the
  design review named as a requirement. The lookup returns `alreadyPending`, and
  chat says *"⏳ Already waiting for a parent's approval"* instead of claiming to
  have sent a second one — telling a parent twice that something was sent is how
  they come to believe two separate things are queued.

  **The application check is a lookup, and a lookup loses a race.** The index is
  what makes it correct: on 23505 the loser re-reads and returns the WINNER's id,
  because a null there would tell a family "Bubaly could not send that for
  approval" about a card already sitting in their inbox. The unit test for that
  path was vacuous at first — the second call's own lookup found the row, so it
  never reached the insert — and now blinds both pre-checks to reproduce the real
  ordering; removing the recovery branch fails it.

  Proven against real Postgres through the harness wired up in §45: 288
  migrations apply, the index refuses a resend, allows a re-ask after approval,
  does not cross families, and leaves keyless rows alone. That proof is now a
  permanent probe (`docs/audit/approval-dedupe-check.sql`) which runs on every PR
  and fails with the index dropped — a fake can tell you the application checks,
  only the database can tell you the index exists and its predicate is right.

  **There were TWO filers, not one.** The original finding named
  `openApprovalRequest`; `lib/ai/tools/execute.ts` opens its own row when the
  RISK TIER tightened an `allow` the engine had already permitted. Left keyless
  it would have kept filing duplicate cards on the registry and concierge paths
  while the chat path was fixed — half a guarantee, and undocumented. It now
  computes the key with the same exported function, because two hashes of "the
  same action" that disagree are worse than one: each path would dedupe against
  itself and neither against the other. Its own test fake had answered a SELECT
  exactly like an INSERT, so the new pre-check always hit and no card was ever
  filed; the fake now models the real table, and a resend that reuses the pending
  card is asserted behaviourally rather than by reading the source.

  Still open in §30: the eight chat writes that shadow registry tools, whose
  delegation the design review rejected on the composed-key grounds recorded
  above.

- **§45, the boundary probes now actually run.** The row said a family's rows are
  protected by policies nothing in CI ever tries to break, and that was exactly
  right — but not because the proofs were missing. `docs/audit/` already held
  eight probes that provision a second tenant, act as a child, and assert under
  `RAISE EXCEPTION` that cross-family reads and writes are refused. **Nothing ran
  them.** `tests/rls-isolation-sweep.test.ts` reads the probe FILE and checks it
  still contains its assertions: a guard on the guard, not a run. They executed
  only when a person remembered to bring up `verify-pg.sh` by hand.

  The blocker turned out to be one apt package. `0237` does `create extension
  vector`, so the replay died there and took `0239` with it (`0239` deletes from
  a table `0237` never created — one failure wearing two hats). With
  `postgresql-16-pgvector` installed, **all 287 migrations apply, fail=0**, and
  the whole bootstrap takes **16 seconds**. In CI that is
  `pgvector/pgvector:pg16` as a service container, not stock `postgres:16`.

  The `database` job replays every migration and then runs every probe. Three
  properties it needed and did not have:

  1. **A replay that fails, not one that reports.** `verify-pg.sh` counted
     failures into `migration_fail=N` and exited 0 — a migration that does not
     apply would have gone green. The bootstrap now exits non-zero and names the
     files.
  2. **One bootstrap, not two.** The shim/migrate/seed logic moved to
     `docs/audit/pg-bootstrap.sh`, which both CI and the by-hand harness call. A
     copy in the workflow would drift, and the drift is invisible: CI proves
     something nobody can reproduce.
  3. **Discovery by glob.** `run-probes.sh` globs `docs/audit/*-check.sql`, so a
     probe added tomorrow is enforced tomorrow. A hand-kept list in the workflow
     is a list someone forgets to add to. It also runs every probe before
     failing, so a red build names all the broken boundaries rather than the
     first.

  **Two things were wrong with the probes themselves, and wiring them up unchanged
  would have shipped a rubber stamp.**

  **The read probe could pass on an empty table.** It asserted user B reads 0 rows
  from ten family-A tables — without ever establishing that family A *has* rows.
  `SEED_ALL` leaves `wallet_transactions` empty for the anchor family, so for the
  highest-risk money table on the list — one `tests/rls-isolation-sweep.test.ts`
  explicitly requires be covered — it read 0 because there was nothing to read.
  It reported isolation it had never tested. Now it counts as the owner first and
  fails outright if a named table is empty, and seeds one `wallet_transactions`
  fixture so the money table has something to fail on.

  **Nothing covered the other half of the 0118 failure.** Every probe looks for a
  LEAK. A missing SELECT policy passes all of them, because default-deny is
  precisely what they assert — drop `calendar_events_select` and the isolation
  probe stays green (verified: exit 0) while the family's calendar goes blank.
  That is the actual 0118 story: RLS on, family policies missing, pages silently
  returning zero rows. `family-self-read-check.sql` asserts the opposite
  direction, swept from the catalog rather than a hand-kept list: for every
  family-scoped table where the owner can see anchor-family rows, that family's
  own parent must see them too. **197 populated tables covered, no exceptions
  needed**, and with `calendar_events_select` dropped it fails and names the
  table.

  Every claim above was checked against a running Postgres, and the guard test
  was mutation-tested. Two of its assertions passed against mutants at first —
  `toContain('pgvector/pgvector:pg16')` and `toContain('docs/audit/*-check.sql')`
  both matched the explanatory COMMENT rather than the `image:` line and the
  `probes=(...)` assignment, so the test was satisfied by its own documentation.
  Now anchored to the code: renaming the job, swapping in stock `postgres:16`, and
  replacing the glob with a hand-kept list each fail.

- **An RSVP is a statement about a person, and only the app was enforcing that.**
  Found while giving `calendar.rsvp` a home: `0047` shipped `event_rsvps` with
  ONE policy for every verb —

  ```sql
  create policy "Members can manage event_rsvps" on public.event_rsvps
    for all to authenticated
    using (public.is_family_member(family_id))
    with check (public.is_family_member(family_id));
  ```

  — no member predicate on either side. Any member of the household could INSERT
  an `accepted` row carrying a **parent's** `member_id`, UPDATE a sibling's reply,
  or DELETE one. And `event_rsvps_once UNIQUE (event_id, member_id)` makes the
  write an upsert, so a second answer did not sit next to the first: it **replaced
  it, silently**. A teen could mark a parent as coming to a thing they had
  declined, and the calendar would show no trace of the earlier answer.

  Nothing in the product does this. The event modal writes only `selfMemberId`,
  and `rsvpToEvent` takes `member_id` from `scope.memberId` and never from a
  caller's arguments — a discipline that exists because this code once used
  `members[0]` as a lookup, so a teen saying "I'm going" answered as whoever
  sorted first in the roster. But that app-level care was the ONLY thing between a
  child and a reply in a parent's name; PostgREST is reachable with the same
  anon key the browser holds. `0272` puts the rule where the next writer cannot
  forget it: four per-verb policies, writes requiring
  `is_self_member(member_id) or can_manage_family(family_id)`.

  **The manager branch is load-bearing, not laxity.** `performApproved` runs under
  the APPROVING parent's client while writing the ASKER's `member_id`
  (`scopeForApprovedWork`), so a self-only rule would have broken the approval
  path this migration exists to protect — and a parent answering for a
  six-year-old with no login is a real thing families do.

  Proven against real Postgres before shipping (PGlite; the migration applied
  verbatim; acting as parent, teen and child under `set role authenticated`), and
  the proof was itself wrong first: the insert cases shared one event with the
  seeded parent reply, so "teen answers for the parent" passed on a duplicate-key
  error rather than on RLS — green against a policy that did nothing. Split onto a
  clean event, the mutant of `0272` that restates the `0047` bug fails two cases,
  and `tests/rsvp-first-person-rls.test.ts` (9) pins the shape that made the real
  outcomes true, including the drop of the `FOR ALL` policy — permissive policies
  are OR'd, so leaving it would have made all four new ones decorative.

  **`notes` and `goals` carry the same `is_family_member`-and-nothing-else shape
  and are deliberately NOT changed.** A shared family notepad being collaboratively
  editable is plausibly the intent; tightening it is a product decision, and
  making one here wearing a security fix's clothes would be the wrong way to get
  it. Recorded so someone can make it deliberately. `event_rsvps` is different in
  kind: the row is a claim about a named person's intent, and the unique index
  turns a second claim into an erasure of the first.

- **An approval now remembers who asked, which closed four things at once.**
  `gateAiAction` passes `actor.kind: 'ai_agent'`, so `openApprovalRequest` left
  `requested_by_member_id` NULL on every AI-filed row: nothing on the row said
  who the request was FOR. And `decideApproval` builds its scope from whoever is
  DECIDING. Between them, an approved action was carried out as the parent who
  released it:

  1. a note the teen asked for was stamped `created_by` = the parent, and
     `activity/page.tsx` renders `created_by` as who "added note" — so it read
     *"Mum added note"*;
  2. an RSVP would have been recorded for the parent and, since
     `event_rsvps_once` makes the write an upsert, **replaced their own reply** —
     which is why `rsvp_to_event` had no registry tool at all and sat in
     `APPROVAL_CANNOT_REPLAY`;
  3. **no approved write reached the family activity feed**, because
     `recordActivity` returns early for `actorKind === 'member'`;
  4. and a parent deciding an approval was only ever told "Bubaly" asked, never
     who for.

  `wrapToolsWithTrust` now takes the acting member and carries it through
  `gateAiAction` to `requested_by_member_id`, and `scopeForApprovedWork` rebuilds
  the replay scope from it: the asker's `memberId`/`userId`, and `actorKind: 'ai'`
  because it IS Bubaly's work — a human released it, they did not type it. The
  approval card reads "Bubaly, for Emma".

  **Confined to `requested_by_kind === 'ai'`**, the same condition that already
  decides `skipTrust`. A member-filed row keeps the decider's scope, because its
  gate IS re-evaluated under the approver's authority and relabelling the actor
  would change that evaluation rather than merely its attribution.

  **The unknown-asker case clears `memberId` rather than falling back.** A row
  filed before this existed has no asker, and inheriting the approver's is
  exactly how an RSVP answers for the wrong person. Cleared, `rsvpToEvent`'s own
  guard fires — *"Bubaly could not tell whose reply this is"* — and the tools
  that do not need a member id are unaffected. Refusing something a parent
  approved is bad; recording it against them is worse.

  Blast radius checked rather than assumed: every reader of `scope.actorKind` was
  inspected. The ledger row, run events, `ai_suggested`, `ai_generated` and the
  finance `source` all become MORE accurate under `'ai'`; the memory
  sensitive-content guard tightens; nothing loosens. And no table the AI writes
  carries a `created_by = auth.uid()` predicate — `0004` applies that only to
  `families` and `user_preferences` — so attributing `created_by` to the asker is
  safe while the approver's session runs the insert.

  With the blocker gone, **`calendar.rsvp` is back** and `APPROVAL_CANNOT_REPLAY`
  is empty. The ratchet forced the decision: the test pinning "the replay runs as
  the approver" went red the moment that stopped being true.


- **§49, the overnight recap was a day stale, not merely evening-only.** The row
  says a parent who opens the brief at 7am is shown nothing of what Bubaly did
  overnight, because the recap only renders on the Evening tab while the tab
  defaults to Morning. Both halves were true, and the second one was worse than
  recorded.

  `briefing/page.tsx` did not use the shared loader. It read
  `family_operating_index` itself — `.order('as_of_date', { ascending: false })`
  with `.limit(2)` — and diffed those two rows, with **no anchor to today at
  all**. That table is written LAZILY, by `loadOperatingIndex`'s own upsert, and
  its only other callers are the Command Center, the Operating Index page and the
  reasoning engine. On a morning when nobody has opened one of those there is no
  row for today, so the card diffed YESTERDAY against THE DAY BEFORE and titled
  itself "Since yesterday". A day out of date, silently, on the one screen meant
  to start the family's day.

  The page now calls `loadOperatingIndex`, which computes today live, anchors the
  prior read with `.lt('as_of_date', today)`, and persists today's row — so
  opening the brief is what makes today's snapshot exist for every other surface,
  instead of the brief being the one reading a stale pair. The page's own
  `toView`/`summarizeChange` block is deleted: it was a second, worse copy of a
  shared function.

  **The two reads now run together.** The page awaited the index read and THEN
  the reasoning context, so it paid both latencies in series. `Promise.allSettled`
  — not `all` — keeps them parallel while keeping the two failures
  distinguishable, because a family told the wrong thing about what broke is a
  different bug.

  **A test had made the staleness look deliberate**, the same way the recurring
  reminder's did: `tests/briefing-read-boundary.test.ts` pinned the page by
  SOURCE STRING, including the literal `const { data: foiSnaps, error: foiError }`
  the fix deletes. The assertions described the shape of the code rather than what
  a family gets, so the code and its test agreed with each other and both were
  wrong. It now asserts delegation, and names the exact discarded shape so
  reintroducing it fails.

  `tests/operating-index-today-anchor.test.ts` is the behavioural half, and it did
  not exist before: **nothing in the suite asserted the `.lt('as_of_date', today)`
  anchor**, though every surface's recap rests on it. I checked it fires by
  removing the anchor.

  Still open in §49: the brief is reachable only from nav, the manifest shortcut
  and a dashboard tile. Nothing surfaces it where a parent packing lunches
  actually lands — that half is a product decision, not a bug, and is left for
  someone to choose deliberately.


- **§30, two of the three writes that had nowhere to land.** `add_note`,
  `add_goal` and `rsvp_to_event` were gated in chat with no registry tool, so a
  parent could grant the approval and read back *"Bubaly has no tool called
  \"add_note\""*. `notes.create` and `goals.create` close two of them.

  **What that does and does not buy, stated exactly.** It does NOT put a ledger
  row under a chat write: `assistant-engine.ts` excludes `notes.create` from the
  chat toolbox the moment `add_note` resolves — that exclusion is the whole
  point — so the hand-written tool still writes raw SQL there. What now reaches
  `executeTool`, with its `ai_tool_calls` row, its gate and its output
  validation, is the APPROVAL REPLAY (which previously just failed) and MAGIC
  IMPORT (`lib/ai/actions.ts`, which previously hand-rolled its own insert). The
  chat path's own ledger gap is the shadowing, and it stays open.

  **The chat toolbox does not change, and that is the load-bearing property.**
  `assistant-engine.ts` excludes a registry tool when `getTool(flatName)`
  resolves, and `mergeToolSets` dedupes on the WIRE name — where the registry's
  is `notes_create`, a different string from `add_note` that it could never see
  as the same tool. So the ALIAS is the entire mechanism. Drop one and the model
  is offered both spellings of one capability: the flat name through
  `wrapToolsWithTrust`, the underscored one skipping the wrapper and gated
  inside `executeTool`, with only the second writing a ledger row.
  `tests/assistant-toolbox-invariance.test.ts` reproduces the engine's own merge
  and fails on exactly that.

  **Risk is `medium` on purpose.** `ai-gate.ts` reads
  `registryTool ? effectiveRisk(settings, tool) : 'medium'`, so these names were
  taking the hard-coded fallback. Declaring `low` — which every other `tasks.*`
  tool declares — would have quietly LOOSENED the chat gate for children.

  **`rsvp_to_event` was designed, written, and then pulled.** An adversarial
  review of the tranche caught what the design missed, and it is worth recording
  because it is a property of the approval system rather than of the tool:
  `decideApproval` builds its scope from the APPROVER (`scopeFromUserContext`),
  and `openApprovalRequest` stores `requested_by_member_id: null` for every
  AI-filed row — `gateAiAction` passes `actor.kind: 'ai_agent'`. **Nothing on the
  row says who asked.** A registry RSVP tool taking `member_id` from
  `scope.memberId` would therefore record the approving PARENT as attending, and
  because `event_rsvps_once UNIQUE (event_id, member_id)` (0047) makes the write
  an upsert, it would silently replace that parent's own earlier answer. Today's
  honest refusal is better than a destroyed reply, so the entry stays in
  `APPROVAL_CANNOT_REPLAY` with that as its reason, and a test pins the two
  facts it depends on so the orphan can be removed the moment they change.

  **The same flaw in a milder form is shipping, and is named rather than
  hidden.** `notes.created_by` and `goals.created_by` also come from the scope,
  so an approved note is attributed to the approver — `activity/page.tsx` renders
  `created_by` as who "added note", and a teen's approved note will read
  "Mum added note". Nothing is destroyed and the family gets the note they asked
  for, which is why this ships where the RSVP does not.

  **The prerequisite for both is one change: record the asker.**
  `wrapToolsWithTrust` does not even receive the acting member id today. Plumbing
  it through to `gateAiAction` and on to `requested_by_member_id`, then binding
  the replay to it, fixes the attribution and unblocks the RSVP. Two things to
  handle in that tranche, both found by the same review: `member_id` would be an
  EDITABLE field on the approval card (`NON_EDITABLE_KEYS` does not list it), so
  a manager could retarget a queued RSVP onto another member; and
  `recordActivity` returns early when `scope.actorKind === 'member'`, so no
  approved write gets an activity line at all — the feed entry these services
  record is written on plan runs and skipped on every approval replay.

  Also deleted: the `add_note`/`add_goal` branches in `lib/ai/actions.ts`,
  unreachable once the tools registered.

  Still open in §30: the eight chat writes that shadow registry tools which DO
  exist, and whose delegation is the one rejected above.

- **§21/§57, a gated chat action tells the truth.** Three separate ways the one
  screen a family talks to lied about what had happened, all of them live and
  all of them found by reviewing a design rather than by running the product.

  **The approval card was never built.** `gateAiAction` hands the wrapper the id
  of the `approval_requests` row it just filed; `wrapToolsWithTrust` threw it
  away and returned camelCase `pendingApproval`, while `approvalIdFromToolResult`
  (`lib/ai/result-cards.ts`) reads snake_case `pending_approval` **plus** an
  `approval_id`. So it returned null every time, `collectOutcomes` built no card,
  and every gated chat write showed "⏳ Sent for parent approval" with nothing a
  parent could act on in the thread. The registry path
  (`lib/ai/tools/legacy-adapter.ts`) has always returned the right shape — the
  wrapper was the only producer that did not.

  **A refusal read as a success.** `finalizeAssistantContent` chose its fallback
  from the action COUNT, so a turn whose every action was denied by the
  household's own policy signed off "Done — I've updated that for you." The
  household's existing test pinned it: a fixture with one success and one
  failure asserted exactly that sentence. The chore was not created and the
  family was told it was. The fallback now reads the outcomes — and a queued
  approval is not "done" either, because nothing is written yet.

  **"Sent for parent approval" could name nothing.** `openApprovalRequest`
  returns null when its insert fails, and the wrapper still reported the action
  as queued. Nothing written, nobody asked, and a child waiting on a decision no
  parent can see. That is now a failure.

  `tests/assistant-approval-replay.test.ts` is the ratchet for a fourth problem
  that is real but not yet fixable: **`add_note`, `add_goal` and `rsvp_to_event`
  are gated and cannot be replayed from their approval.** The gate stores
  `{name, args}` and `approveRequest` replays it through `executeTool`, which
  resolves names against the registry — and nothing outside
  `lib/assistant/tools.ts` writes `notes`, `goals` or `event_rsvps`. A parent
  who approves one today reads *"Approved, but Bubaly could not finish it:
  Bubaly has no tool called \"add_note\""*. Until they have registry tools the
  approval line says so up front, and the test fails in both directions: a newly
  gated tool with no registry equivalent has to be named, and one that gains a
  registry tool has to be removed.


- **§21, the delivery half.** Four surfaces read `notifications` and they did not
  agree on whether a scheduled notice is due. `deliverNotificationEmails` filtered
  `send_at <= now`. `listUnread` filtered it and — as an adversarial review of the
  §21 design pointed out, correcting an earlier claim here — **has no caller at all**
  outside its own tests, so filtering there protected nobody. `dispatchPendingPushes`,
  the notification bell and the notifications list all read without the filter.

  That bites today with no quiet-hours writer anywhere, because `notify()` takes an
  explicit `sendAt` and the AI's `notifications.notify` tool advertises it as
  *"Earliest delivery, ISO 8601"*: a notice scheduled for 8am tomorrow buzzed the
  phone on the next two-hourly scan and lit the badge, tonight. All three are fixed
  with the same `.lte('send_at', …)`, pinned by `tests/push-send-at-boundary.test.ts`
  and `tests/notification-due-surfaces.test.ts` — the second asserts all four surfaces
  agree, so the next one added has to decide deliberately. The §21 row above is what
  remains: two stores, no reader, no settings control, and `child_channels` unread.

- **§48, the button reaches a screen people land on.** `[Let Bubaly handle it]`
  existed in exactly one place — `readiness-module.tsx`, on `/dashboard/readiness`
  — so §48's signature moment was one most families never encountered. The
  Family Operating Index rendered each suggestion as a bare link to the module
  that owns it, which asks the family to go and redo by hand the thinking Bubaly
  had just done.

  Every suggestion `buildSuggestions` can emit is now classified. Seven get a
  request sentence written the way a person would say it, because that sentence
  is what the planner reads — a domain, an object and a verb, not "get us ready".
  **Five deliberately get no button**, and that restraint is the point: two are
  payments (`fix-negative-balances`, `cover-bills`) and Bubaly does not move
  money on its own; `decide-approvals` IS a decision waiting for a person, so
  offering to handle it would have Bubaly approve its own requests; `close-votes`
  and `nudge-goals` are the household making up its mind.

  `tests/handle-it-coverage.test.ts` fails when a new suggestion is neither
  handled nor named, when one is both, and when an entry no longer matches a
  real id — plus a guard that the source parser still finds the list at all, so
  the coverage assertions cannot pass vacuously.

- **§21, the routes that went around it.** Quiet hours landing was only half the
  job: **fifteen call sites wrote `notifications` rows directly**, so they got
  neither the window nor the unread-duplicate guard. The three that woke a house
  most often now go through `notify()` — every screened text, every WhatsApp,
  every voicemail, each firing on *every* inbound message that is not blocked or
  spam. None is marked urgent, deliberately: a text from the dentist can wait
  until morning, and a genuine emergency comes through `/api/guardian/escalate`,
  which is urgent and still lands immediately.

  `systemScopeForFamily` reads the family's real timezone rather than taking
  `scopeForSystem`'s `DEFAULT_TZ`. That fallback would be worse than no check at
  all: a window evaluated against the wrong clock holds a notification at six in
  the evening and lets one through at two in the morning.

  `tests/notification-write-boundary.test.ts` is the ratchet. Every remaining raw
  insert is enumerated **with a reason** — four urgent by nature, six named as
  debt — so what is left is a list someone chose rather than one nobody counted,
  and the sixteenth has to be added deliberately. It also fails on a *stale*
  entry, because an allowlist that stops describing the code is how a ratchet
  quietly becomes decoration.

- **§21, the reader and the control.** Quiet hours were stored in two places and
  honoured from neither. The one `notify()` read —
  `user_preferences.notification_prefs.quietHours` — could never have worked:
  `0004` makes that table own-row-only, so a lookup of the RECIPIENTS' rows returns
  at most the SENDER's. A parent notifying a teen applied the parent's window to
  the teen, or far more often read nothing and deferred nobody. The window now
  comes from `family_ai_settings` (0257), which is family-scoped and readable for
  every recipient on every path including the service-role cron.

  Three decisions the earlier design got wrong, each now the other way:
  a caller-supplied `sendAt` is **never** moved (a reminder asked for at 10:30pm
  is the request, not a courtesy notice to hold till morning); an hour that cannot
  be computed **fails open** rather than deferring for eight hours on a timezone
  read that failed; and a window is bounded to 14 hours, because `{0, 23}` passed
  the old 0–23 check and is a mute switch with no surface that would explain the
  silence.

  §32's **Communication block** ships with it. Until now the columns had a service
  writer and no control, so the setting a family would go looking for was one
  nobody could reach — which made "quiet hours are stored and ignored" true in
  both directions.

  Still open: `child_channels` is stored and read by nothing, and the guardian
  inbound SMS/WhatsApp routes insert family-wide `system` rows directly rather
  than through `notify()`, so they bypass the window entirely. They are the
  likeliest real 2am waker and want their own tranche.

- **§26, the write primitive only.** Not "half of §26" — every §26 bullet is
  predicated on *"Receipt upload could:"*, and this ships no upload, no parser and
  no vision. What it ships is the thing all six bullets need and none of them had:
  `createTransaction`, the first writer `public.transactions` has ever had outside
  the wallet's own UI action. Before it, `lib/services/finances` exported nine
  functions — all reads and analytics — so Bubaly could analyse a household's
  spending six ways and could not record one charge.

  **`fingerprint` stays null, deliberately.** `0256` migrated it with a partial
  unique index, and every key available today can delete a real charge. Family +
  merchant + amount + date — the migration header's own suggestion — collides on
  two coffees at one shop on one day for one price, and a "that's a duplicate"
  handler then discards the second while reporting success. Deriving it from the
  receipt only moves the loss: one photo of a split Costco receipt is two charges
  with one document. A duplicate guard needs the identity of a *charge*, which
  arrives with the intake that reads a receipt into line items. Until then, no key
  is the honest answer — re-recording a charge is visible and correctable, losing
  one is neither.

  Also found on the way, and worth its own row for whoever touches this table:
  **`transactions.idempotency_key` is typed in `lib/database.types.ts` and no
  migration ever adds it.** `0256` gave the column only to its six keyed tables.
  Writing it would be a PGRST204 against real schema that no unit test would catch.

  Still open in §26: the upload route (blocked on `provider.structuredCompletion`
  dropping `AIMessage.images`, plus a trust-gated confirm — `app/api/ai/flyer/route.ts`
  inserts `calendar_events` ungated and repeating that shape would ship the bug
  twice), classification, grocery reconciliation, warranty and inventory linkage.

- **§42, the dead channels.** Ground truth from replaying every migration into
  PGlite and reading `pg_publication_tables`: **51 tables were published** and about
  **170 distinct tables were subscribed** across ~220 sites, so roughly 120 channels
  connected, reported SUBSCRIBED, and could never fire. A dead channel and a quiet
  table are indistinguishable to the client, so those pages looked live and were not.
  (Two counts stated earlier in review — "23 published" and "215 subscribed" — were
  both wrong: the first came from a grep that only saw bare `ALTER PUBLICATION` and
  missed the guarded `DO` blocks in `0112`/`0240`–`0248`/`0250`; the second counted
  every `table:` string literal in the repo, including non-realtime uses. Grep was
  the wrong instrument; a database was the right one.)

  `0269` publishes the ten surfaces where two people plausibly act on the same row
  in the same second, and `lib/realtime/published-tables.ts` stops the client
  opening a socket for anything else. The load-bearing detail is DELETE: under the
  default replica identity a DELETE's old tuple carries only the primary key, so the
  `family_id=eq.` filter every subscription uses can never match — publishing alone
  would have bought live INSERT/UPDATE and a silently stale list. The five tables
  with a client delete path get `REPLICA IDENTITY FULL`; the rest are enumerated as
  knowingly DELETE-blind rather than left unsaid. Proved against a real database:
  61 published after, none missing, `relreplident = 'f'` on exactly those five.

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
