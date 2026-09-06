# Verified spec-gap ledger — `docs/AI_FAMILY_OS_SPEC.md`

A backlog of what is genuinely missing, and — just as important — a record of what
was **claimed** missing and turned out not to be.

Every row below was produced the same way: one reader swept a slice of the spec against
the repo and wrote a claim with citations, then **two independent reviewers were asked to
refute it**, defaulting to refutation on the grounds that a false gap costs a wasted
rebuild of something that already works. Only claims that survived that pass are listed
as open. Sweep run 2026-09-06 against `main` at `f3f191b`.

> Rebuilding something the repo already does is worse than leaving a gap open: it burns
> a cycle, it churns files another agent may be holding, and it usually lands a second,
> subtly different copy of a rule. **Read the refuted list before starting anything.**

---

## Open — survived refutation

Ordered by user harm, not by section number. The first two are live defects: a setting
the UI already offers that does nothing, and a safety mechanism the most-used AI surface
skips. The rest are unbuilt capability.

| § | Gap | Why it bites | Claimed by |
|---|---|---|---|
| **30** | On `/api/ai` the model is handed direct-write tools (`lib/assistant/tools.ts`) that insert straight into `calendar_events`, `chores`, `grocery_items`, `todo_items`, `family_reminders` and more with **no `ai_tool_calls` reservation, no `idempotency_key`, no replay probe and no trust-gate decision** — every one of which `lib/ai/tools/execute.ts` applies on the plan path. | Children have real sessions (`/kid-login` is whitelisted in `middleware.ts`) and reach this route. A retried or re-streamed turn duplicates the write; nothing in the ledger records that the AI did it. | tranche K |
| **21** | Quiet hours are stored in **two** places and honoured from neither. `family_ai_settings.quiet_hours_start/end` (0257) is written by `lib/services/ai-settings/index.ts:96-98` and mapped into `AISettings.quietHours`, and no consumer reads it. `notify()` reads a *different* store, `user_preferences.notification_prefs.quietHours` — a documented seam (`lib/services/notifications/index.ts:17-26`) with correct wrapping-window and timezone maths already in place, waiting on a writer that never arrived. So the deferral machinery is built and inert. | A family that sets quiet hours in Settings still gets pushed at 2am, because the column it wrote is not the one delivery reads. One of the two stores has to win. | tranche L |
| **33** | Model/latency/token observability is wired to `structured()` only, so the assistant and every `/api/ai/*` feature route record nothing about the model call. §33's explicit "admin diagnostics should make it possible to understand why workflows fail" has no surface. | You cannot answer "why was that run slow / why did it fail" from inside the product. | — |
| **26** | No receipt intake anywhere, and no way for Bubaly to record a transaction at all. The anti-duplicate columns are migrated and unused: `transactions.fingerprint`, `transactions.receipt_document_id` and `uq_transactions_fingerprint` all landed in `0256` and **nothing ever writes them**. | §26 is a named signature capability. The schema is already paid for. | — |
| **25** | Of §25's six named attachment behaviours only date extraction and event type are honoured. `app/api/ai/flyer/route.ts` never identifies the child or team (`ProposedEvent` has no member field; the confirm insert omits `assignee_id` though `calendar_events` has the FK), never checks conflicts, never creates preparation reminders — and the attachment path **bypasses the trust gate the pasted-text path uses**. | Same class as §30: one intake path gated, its sibling not. | — |
| **22** | Two feeds exist, neither is §22's single interleaved stream. `/dashboard/activity` is human-only (`lib/activity/feed.ts:5` declares six kinds, none AI/run/approval; the row actor resolves only from `memberById`/`memberByUser`). `lib/services/activity/index.ts:51` returns early for `actorKind: 'member'`, so the AI feed is the mirror image. A human approval is written to neither. | "Dad approved Saturday's schedule" — §22's own example — is unrepresentable. | — |
| **32** | Two of §32's five named Settings → Bubaly AI blocks do not exist: no **Proactive assistance** dial (Off / Important only / Standard / Highly proactive) anywhere in `lib`, `app`, `components`, `supabase` or `mobile`, and no **Communication** block — quiet hours has a column and no control, preferred channels and summary frequency have neither. | Overlaps §21: the same missing block is both a settings gap and a behavioural one. Do them together. | tranche L |
| **14** | "Prevent certain categories from being remembered" is not family-configurable. `AISettings` carries exactly one memory field, `memoryEnabled`; `family_ai_settings` (0257) has `memory_enabled` and no category-scoped column. What exists is a global on/off plus a hardcoded refusal of medical and account facts. (`category_behavior` is autonomy per trust domain — a different axis.) | A family cannot say "never remember anything about money" without turning memory off entirely. | — |
| **7** | The services exist and the AI uses them exclusively; the UI does not. Every `lib/services/**` module is `import 'server-only'`, so the only legal UI route is a server action — and the module screens still write the same tables directly through the browser anon client. | §7's stated purpose is that UI and AI run the same business logic. Today they run two copies, and they have already drifted (see the vault upload path fixed in `0266`). | — |
| **3** | `public.families` has no `locale` and no `default_currency`. `grep -rn "locale" supabase/migrations/*.sql` is empty across all 284 migrations and `git log --all -S"default_currency" -- supabase/` returns nothing, so no branch holds it either. Every money figure in the app and in Bubaly's own prompts is hardcoded to en-US / USD. | Cheap to add, and it gets more expensive with every hardcoded `$` that ships. | — |

### Closed during the sweep

**§21, the push half.** `dispatchPendingPushes` (`lib/server/push.ts`) selected on `pushed_at`
alone. The in-app list (`listUnread`) and the email digest (`deliverNotificationEmails`) both
filter `send_at <= now`; push did not — and `listUnread`'s own docstring claimed the deferral
holds *"at read time as well as at push time"*. It did not hold at push time.

That is live today without any quiet-hours writer, because `notify()` takes an explicit
`sendAt` and the AI's `notifications.notify` tool exposes it as *"Earliest delivery, ISO
8601"*. A plan step that scheduled a notice for 8am tomorrow buzzed the phone on the next
two-hourly scan — tonight. Fixed by one `.lte('send_at', …)`, proved by
`tests/push-send-at-boundary.test.ts` (three assertions, all failing before the change).
The row above is what remains: the two stores, and the settings surface.

---

## Refuted — do not rebuild these

Each was a plausible, well-evidenced claim. Each was checked against the code and failed.
The one-line reason is the load-bearing half; the full refutations are in the sweep run.

| § | Claim | Why it is wrong |
|---|---|---|
| **5** | The chore-proof verdict is scraped from model prose and "can auto-approve a real money payout". | It cannot move a cent. `finalizeApproval` flips a status and calls `applyCompletionRewards`, which touches only `kid_progress` and `member_badges`; every wallet credit goes through `creditChildWallet`, whose four call sites are all outside the AI path. And the parse is not free-form: `normalize()` (`lib/chores/ai.ts:176-198`) whitelists `status` to five literals, clamps the scores, and forces `needs_parent_review` on any safety flag — a lax parser structurally cannot produce a *more* permissive verdict. `response_format: json_schema` constrains shape, not content, so the proposed remedy would not close the hole described. |
| **13** | Only 11 of 36 write tools verify; updates and deletes report success on their own return value. | The premise is wrong. Every update and delete service returns the **database's** post-write row via PostgREST `RETURNING`, family-scoped in the write predicate, with a zero-row result as a hard `notFound`. The tool outputs read fields off that stored row. `verify` is also a slot on any `act` step (`lib/ai/planner/schema.ts:60`), and the claim's own named counter-example — `trips.syncToCalendar` — *is* verified, at `templates/prepare-vacation.ts:86`. |
| **20** | "There is no event path at all: nothing reacts to a row being created or changed." | `0134_model_dirty.sql` attaches an AFTER INSERT/UPDATE/DELETE trigger to ten tables including `vacations` and `documents`, with two live consumers (`scheduleGraphAutoRefresh`, `/api/cron/model-refresh`), hardened in `0249` after a real production FK failure and pinned by two test files. It delivers §20's "trip created → offer preparation workflow" on the insert itself via `runPrepGeneration`. §20 itself opens "Support **future** event-driven AI behavior" and labels the six as "Examples". The accurate residue is only that `kind='trigger'` has no writer. |
| **23** | Ask Bubaly answers from a context bundle omitting home, vendors, money, documents and travel. | The bundle is not what determines answerability — the tool catalogue is, and it was never checked. `INTENT_TOOL_DOMAINS.answer_question` (`lib/ai/planner/prompts.ts:45`) includes `home_maintenance`, `documents`, `finances` and `travel`; `toolsForIntent` really does offer `home.lastServiceByTrade`, `home.listContractors`, `documents.listDocuments`, `finances.listTransactions` and `trips.getTrip`. Widening the *slices* instead would be a **§27 regression** — §27 explicitly forbids carrying passports and home insurance into prompts that do not need them. |
| **34** | Only concierge requests are metered, and nothing reads the token counters back. | Read back in three places: `lib/ai/runs/detail.ts:169-177` renders "1.2s · 850 tokens" into the run timeline, `lib/server/ai-access.ts:114-132` compares month-to-date `ai_requests` against the plan allowance, and `social_ai_generations`/`social_usage_events` are rolled up in the admin usage page. Routine-fired work is metered too. §34's own text frames allowances and limits as **future** support. The real residue is breadth — the feature routes file no `ai_requests` row — which is one argument per route, not a missing §34. |

---

## Working agreement

Two agents are working this repo concurrently. To keep out of each other's way:

- **Claim a row before you start it** by opening a draft PR whose title names the section, or by saying so in a comment on an open PR. An unclaimed row is fair game.
- **Small and separable beats large and bundled.** §3 and §14 are each a migration plus a
  setting. §7 and §26 are not; do not start one as a side quest inside another PR.
- **A gap is only closed by a test that fails without the change.** For the boundary rows
  (§30, §25) that means a behavioural proof, not a policy listing — `0267` applied cleanly,
  read correctly, and changed nothing, because a `FOR ALL` policy from `0006` was still
  OR'ing itself back in. The proof that caught it ran as a real `authenticated` session.
- **Refuting a row here is a contribution.** If you find one of the open rows is wrong, move
  it to the refuted table with the citation rather than quietly skipping it.
