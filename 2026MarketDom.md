# Bubaly — 2026 Market Domination Strategy

**One file, self-contained, for any agent picking up this work.** Claude, Codex,
or a person: you should be able to read this and start on a section without
having seen the conversation any of it came from.

- **Status as of:** 2026-09-07 23:45 UTC. main at `d88978f`; PR #421 merged; PR #424
  (`claude/roadmap-implementation-ld8bon` at `452a297`) carries fourteen further
  sections and is the integration head to branch from until it merges.
- **The per-item evidence** — reachability, persistence, tests, mock risk, gap,
  build plan, file-and-line proof for each of the 60 items — is
  `docs/MARKET_DOMINATION_AUDIT.md`. That file is the authority on *what the
  code actually does today*. This file is the strategy and the coordination.
- **The twenty ready-to-claim work sections**, each sized to one reviewable PR
  with its spec, files, tests and acceptance criteria, are
  `docs/STRATEGY_WORK_QUEUE.md`.

---

## 1. The thesis

Every competitor sells a **shared calendar with features bolted on**. Cozi,
FamilyWall, Skylight, Hearth and Ohai all ask the family to do the coordinating
and give them a nicer surface to do it on.

Bubaly's bet is different: **the household's operating system runs the work, and
the family approves it.** Not a chatbot in front of a calendar — a chief of staff
that reads across every domain the household actually has (school, sports,
money, home, health, travel, moving, inventory, paperwork), proposes a plan,
shows its evidence, and acts only inside the fences a parent set.

That produces the two claims the whole strategy rests on:

1. **Breadth is the moat, not the liability.** A single-domain competitor cannot
   see that the dentist appointment collides with the away game, that the car is
   double-booked, and that the deposit is due the same morning. Cross-domain
   inference needs the whole graph, and the graph is what a family builds by
   *using* the product.
2. **Trust is the product.** An agent that acts on a family's real life is only
   adoptable if every action is previewable, evidenced, reversible and audited.
   Trust is not a compliance page; it is the feature that makes autonomy sellable.

### Competitive position

| Competitor | What they are | Where Bubaly wins |
|---|---|---|
| **Cozi** | Shared calendar + lists, ad-supported | No cross-domain reasoning; no agent that acts; ads vs. a paid trust relationship |
| **FamilyWall** | Calendar, lists, budget, location | Feature-parallel, not integrated — nothing reads across the domains |
| **Skylight** | Hardware display first | The display is a *view*; Bubaly runs Kitchen/Wall Mode on any tablet they already own |
| **Hearth** | Display + routines for kids | Narrow age band, narrow domain |
| **Ohai** | AI assistant for families | Closest competitor. Bubaly's edge is the persisted graph, the evidence ledger and the permission model — an assistant that can *prove* what it did |

### The moats, in the order they compound

1. **The household graph** — entities, obligations, assets, preferences and their
   provenance. Deepens with use; cannot be bought or imported wholesale.
2. **The evidence ledger** — every run, plan, step, tool call and approval,
   persisted. This is what lets Bubaly claim anything at all, and what makes the
   trust surfaces honest rather than decorative.
3. **The permission model** — narrow, explainable, per-tool policies a family
   grants and revokes. Autonomy without this is unsellable.
4. **Switching cost** — zero-setup import, ambient ingestion, entity resolution.
   The graph a family accumulates is the thing they will not re-create elsewhere.
5. **Network effects** — care circles, referrals, privacy-safe benchmarks.

---

## 2. Rules that are not negotiable

These come from the strategy's own "what I would NOT do" list and from defects
this repository has already shipped once. **A PR that breaks one of these is
rejected regardless of how good the feature is.**

1. **Never claim Bubaly did something unless a row says so.** No "called the
   plumber", "sent the form", "booked it" without a persisted provider outcome.
   A test pins the vocabulary on surfaces that have been wrong before.
2. **No opaque actions.** Every action gets a preview, its evidence, and an audit
   entry. If it cannot be previewed, it does not run unattended.
3. **A failed read is not an empty result.** "Nothing needs you today" and "the
   database did not answer" are different facts. Fail closed and say
   *unavailable* — never render a zero the surface cannot stand behind. Use
   `countOrNull` (`lib/metric/count.ts`); never a private `safeCount` returning 0.
4. **Do not add modules because a competitor has one.** Breadth is earned by
   cross-domain value, not by a feature checklist.
5. **Never market "AI" as the primary benefit.** The benefit is the outcome — the
   morning that ran itself. AI is how, not what.
6. **No paid bias.** Recommendations rank on the family's interest. Marketplace
   money must never reorder a ranking.
7. **Do not add a migration.** See §6 — the 21 DDL asks are the owner's to
   approve and apply. Agents must not add files under `supabase/migrations`, and
   must not apply anything to production.
8. **Do not touch the global left navigation.** `components/app/app-shell.tsx`
   (SidebarBody), `components/app/free-tier-sidebar.tsx`,
   `components/app/nav-shared.tsx`, and the nav exports in
   `lib/constants/navigation.ts` (`CURATED_*`, `PRIMARY_NAV`, `APP_NAV_GROUPS`,
   `SIDEBAR_FOOTER_NAV`, `NAV_CATALOG_*`, `DEFAULT_SIDEBAR_NAV_KEYS`) are
   off-limits unless the repository owner asks. Per-user presets,
   home/command-center and `MARKETING_NAV` are fine.
9. **Every user-visible string is a catalogue key in seven languages.**
   en-US, de-DE, es-ES, fr-FR, it-IT, nl-NL, pt-PT. German/French/Portuguese
   formal (Sie / vous / formal); Spanish/Italian/Dutch informal (tú / tu / je).
10. **Never skip, disable or quarantine a test to get green.**

---

## 3. How to claim a section and work alongside other bots

**Claiming is atomic and needs no coordination: the branch name is the claim.**

```bash
git fetch origin
git checkout -b claude/strategy-S-07 origin/main
git push -u origin claude/strategy-S-07     # rejected = already taken, pick another
```

The push either succeeds (you own S-07) or fails (someone else does). No lock
file, no registry to update, no race.

Then open your PR against `main`. Keep it to one section — a section is sized so
one PR can carry it and a reviewer can hold it in their head.

### Before you start

1. Read your section's entry in `docs/STRATEGY_WORK_QUEUE.md` — it names the
   spec, the files the section owns, the tests to add, and what a reviewer will
   check.
2. Read the matching item in `docs/MARKET_DOMINATION_AUDIT.md` — it tells you
   what already exists, so you extend rather than rebuild.
3. Check §6 below: if your section's item is on the migration list, build the
   part that needs no DDL and stop at the boundary. Say so in your PR.

### Shared files several sections must each touch

Add your line; do not reformat, reorder or "tidy" the file. These are the
predictable collision points, and a union merge is almost always the right
resolution:

| File | Rule |
|---|---|
| `lib/i18n/messages/*.json` (7 files) | Additive only. Keys sorted. Never delete another section's key. On conflict, union both sides. |
| `lib/ai/tools/registry.ts` | Append your tool group to the spread list. Union on conflict. |
| `lib/ai/planner/templates/` | One file per template + one line in the index. |
| `lib/constants/navigation.ts` | `MARKETING_NAV` only. The app sidebar exports are off-limits (rule 8). |
| `tests/service-layer-forks.test.ts` | If you add a service for a table a component still writes, declare it in `KNOWN_FORKS` with a reason. |

### The `settleAll` hazard — read this before batching reads

`settleAll` (`lib/supabase/settle.ts`) wraps each promise so a **rejection**
becomes `{ data: null, count: null, error }` — the PostgREST shape. That means:

- A **`ServiceResult`** (`{ok:true,data} | {ok:false,error}`) **cannot ride
  inside `settleAll`** — it has `ok`, not `data`. Await it *beside* the batch
  with its own `.catch()`.
- So can't a plain value: `countOrNull` returns `number | null`,
  `loadStrategyMetrics` returns a `StrategyMetrics`. Same rule.
- A promise started **before** a batch and awaited **after** it needs its own
  `.catch()` at creation. If a `.from()` throws while the array literal is still
  being evaluated, the earlier promise is orphaned and its rejection goes
  unhandled. This has bitten this repo twice; both times a test caught it only
  after an unrelated reorder removed the throw that was masking it.

### Definition of done

- `npx tsc --noEmit` clean, `npm run lint` clean.
- Your tests pass, and the suites your files touch still pass.
- `node scripts/i18n-gate.mjs` clean; keys present in all seven catalogues.
- No file under `supabase/migrations`. No shared-sidebar file.
- Your PR says what you did **not** do and why (a migration boundary, a claim you
  could not honestly make, a test you could not write yet).

---

## 4. The 60 items

Status is **from the audit**, i.e. before PR #421 landed. §5 says what has moved
since. `exists` = reachable, persisted and tested; `partial` = some of it is
real; `missing` = not built; `mock` = a surface exists but does not prove what it
claims.

| # | Item | Audit status |
|---|---|---|
| M1 | Chief of Staff Outcome Engine | exists |
| M2 | Universal Household Inbox | partial |
| M3 | Family Intelligence Graph | partial |
| M4 | Family Daily Brief | partial |
| M5 | Needs Your Decision | partial |
| M6 | Bubaly Handled | partial |
| M7 | Household Autopilot — detect repeated successful workflows, offer narrow explainable policies | partial |
| M8 | Schedule Intelligence | partial |
| M9 | School + Sports Front Desk — schedules, forms, fees, gear, transport, changes | partial |
| M10 | Meal → Pantry → Grocery Loop — calendar-aware, budget, substitutions, purchase handoff | partial |
| M11 | Family CFO — coverage-aware forecast, spending explanation, affordability scenarios | partial |
| M12 | Home Digital Twin — assets, warranties, manuals, maintenance, inventory, projects | partial |
| M13 | Where Is It? — visual inventory with confirmed location and natural-language search | exists |
| M14 | AI Moving OS — move date orchestrates packing, utilities, address changes, school, pets | exists |
| M15 | Family Travel Agent — reservations, packing, home/pet prep, disruption replanning | partial |
| M16 | Extended Family Care — permissioned care circles | partial |
| M17 | Household Purchase Advisor — check what is already owned before recommending | missing |
| M18 | Kitchen / Wall Mode — tablet/browser command center | exists |
| M19 | Voice Everywhere — hands-free Ask Bubaly across phone, tablet, shared display | partial |
| M20 | Family Phone + Email Front Desk | partial |
| M21 | Actionable Notifications — every notification actionable, quiet ones compressed | partial |
| M22 | Household Memory Controls — inspect, correct and delete what Bubaly believes | exists |
| M23 | Permission Model as a Feature | partial |
| M24 | AI Trust Center — evidence, confidence, approvals, policies, sensitive-access history | partial |
| M25 | Outcome Templates — Tournament Day, School Morning, Vacation, Moving, Holiday, Emergency | partial |
| M26 | Marketplace / Service Layer — providers, AI-scoped requests, compare, manage | partial |
| M27 | Bubaly API / Partner Platform — authenticated inbound API with keys and scopes | missing |
| M28 | Family Network Effects | partial |
| M29 | Zero-Setup Import | partial |
| M30 | 30-Minute Wow Onboarding | partial |
| M31 | Time-Saved Ledger | partial (covered by X1) |
| M32 | Savings Ledger — groceries, subscriptions, warranties, avoided duplicate purchases | missing |
| M33 | Best-in-Class Household Search — across documents, items, trips, bills, decisions, with evidence | partial |
| M34 | Life-Event Intelligence — school year, camp, move, new pet, aging parent, renovation | partial |
| M35 | Developer-Grade Reliability | exists |
| M36 | Security as Product Surface — MFA, privacy center, RLS, signed files, sensitive-access audit | partial |
| M37 | Hardware Partnerships — certified display program + in-app device setup | missing |
| M38 | Privacy-Safe Household Benchmarks | partial |
| M39 | Family Referral Flywheel | partial |
| M40 | Outcome-Based Premium Packaging | partial |

### Public-site weaknesses

| # | Weakness | Audit status |
|---|---|---|
| W1 | Breadth: market 5–7 hero outcomes, keep breadth as supporting proof | partial |
| W2 | AI proof: real demos, activity history, Bubaly Handled evidence on the public site | partial |
| W3 | Family+ pricing justified with quantified time saved, savings found, work handled | partial |
| W4 | Trust: customer-facing AI Trust/Privacy Center and independent security evidence | **mock** |
| W5 | Navigation: outcome-first navigation and contextual discovery | partial |
| W6 | Hardware: shared display mode exceptional on tablets they already own, and marketed as such | partial |
| W7 | Social proof: verified outcomes, case studies, referral loops, time-saved metrics | partial |
| W8 | Switching cost: zero-setup imports, ambient ingestion, entity resolution | partial |

### North-star metrics

Every one of these must be **error-aware**: `null` when the read failed, never a
zero. See rule 3.

| # | Metric | Audit status |
|---|---|---|
| X1 | Household admin minutes eliminated / week | partial |
| X2 | % of household obligations auto-captured | missing |
| X3 | % of AI plans completed without rework | partial |
| X4 | Actions handled automatically / household / week | partial |
| X5 | Decision compression ratio | missing |
| X6 | Proactive signal precision | partial |
| X7 | Household graph completeness | partial |
| X8 | Multi-member weekly active households | missing |
| X9 | 90-day household retention | missing |
| X10 | Family+ conversion after demonstrated value | partial |
| X11 | Verified time/savings value vs subscription price | missing |
| X12 | Referral/invite coefficient | partial |

---

## 5. The roadmap, and where it stands

### Phase 1 — Unify
One brain across the domains: chief of staff, household inbox, daily brief,
decisions, the Handled ledger, the family graph, schedule intelligence.

**Landed in #421:** M1 (the replan path was implemented and never called — now
wired, capped per run, ledgered as a new plan version), M4 (the brief leads with
decisions, read from real rows, viewer-role aware so a non-manager's bills and
medication reads are never made at all), M5 (`/dashboard/needs-you`, uncapped,
plus fact suggestions, inbox messages and paperwork), M6/M35 (the ledger says
which tool acted and why, plus a family run history), M8 (prep, leave-by from a
real drive-time estimate, driver and shared-vehicle conflicts, dinner timing,
care gaps), M21 (every notification actionable; the quiet half folds into the
brief's "Also today" so it is said once).

**Landed in #424:** M2/M20 (one household inbox; inbound mail reaches the
planner; a redelivered email files nothing twice; a bill the router declines is
still filed as paperwork; the badge says "Filed with Bubaly", not "Handled"),
M3 (the graph projects events, assets, obligations and preferences — and a
truncated read no longer authorises a prune).

**Landed in #428:** the last fix M21's review asked for — a chore signed off
from a notification reports the status the row recorded (`submitted` for an
ordinary chore, which still waits for a parent), not "marked done".

**Still open:** the `request_id` link the inbox cannot claim without the
migration in §6.

### Phase 2 — Automate
Autopilot, the meals→grocery loop, school and sports front desk, household
search, the trust center.

**Landed in #421:** M7 (a policy is suggested only where the same domain,
capability and tool was approved 3+ times with no rejections and no failed calls;
accepting writes exactly one tag-scoped policy; no suggestion executes anything),
M24 (Trust Center Activity tab — persisted tool calls with run links, the
autonomy dials beside the policies, and per request the *names* of what was read
and what was withheld, never contents), M26 (the call queue stops claiming a
call; `compareQuotes` ranks real `project_quotes` with reasons).

**Landed in #424:** M10 (calendar-aware meals, allergy-aware substitutions,
retailer hand-off, Bought → pantry), M33 (household search across eleven
sources with evidence; the command bar reserves room for record hits).

**Landed after #428 (batch 2b):** M10's review fixes — a nut butter is not
dairy, a proposed swap never keeps the allergen it was meant to remove, and a
bought line is put away and cleared together so a trip that fails half way
leaves the pantry and the list agreeing.

**Landed in batch 3:** M9 — a deterministic classifier reads an inbound
school or sports message as a form, a fee, a gear list, a transport ask or a
schedule change, wired into both the webhooks and the paste-in importer, with
a desk card whose one-tap Propose goes through the approval spine and whose
Handled comes from `ai_handled` and nowhere else.

**Still open:** nothing in this phase without a migration.

### Phase 3 — Deepen
Family CFO, home twin, inventory, travel, moving, care.

**Landed in #421:** M11 (plan-aware forecast, affordability scenario), M13/M14
(both became assistant tools, with a `plan_move` template and a
confirm-it's-here signal).

**Landed in #424:** M15 (pet-aware trip prep and a disruption re-flow), M16/M23
(a grandparent sees every family they belong to; sharing presets), M17 (before
you buy, grounded in what the household owns), M19 (one mic on every Ask
surface), M22 (one view of what Bubaly believes, with a reset), M25/M34
(launchable outcome templates; life-event detection; the Moving Home handoff
lays out its tasks and never deletes a move it only found), M29/M30 (contacts
import with a review step; onboarding answers remembered).

**Landed in #428:** M13/M14's re-reviewed fixes (the move burn-down counts
the boxes it actually read — it used to say "0/0 boxes unpacked" to every
family — and a move the playbook only *found* keeps its own date, which the
toast now names), M25/M34's fixes (the outcome card says what the server's own
outcome was — working, a question, or an answer — never a blanket "working on
it"; a finished playbook no longer suppresses next year's transition), and a
migrate import that stops part way says what it saved, keyed in seven locales.

**Landed after #428 (batch 2b):** M14's CFO fixes — distinct bills are
counted, a recurring bill paid this month stays in later months, and the
affordability scenario refuses to answer for a month the forecast never
weighed.

**Landed in batch 3:** M12's no-migration half — manuals and warranty
documents on the asset card, and one asset detail view showing warranty,
documents, service history, open maintenance and the related project, each
read failing closed rather than rendering an empty panel.

**Still open:** the replacement lineage, which needs §6 item 9.

### Phase 4 — Expand
Front-desk identity, marketplace, partner API, network effects, hardware.

**Landed in #421:** M36 (TOTP through Supabase Auth with honest error states, an
AAL2 step-up on money/document/trust routes for users who have a factor, and a
Privacy Center that streams a role-scoped export).

**Landed in #424:** M38 (privacy-safe benchmarks, bands translated, the public
page gated on publication), M39 (the referral flywheel: signup capture,
Stripe-confirmed reward, prompts), X3/X5/X10/X12 (error-aware metric tiles).

**Landed in #428:** the metrics core's reviewer fixes (S-15). Four numbers
the admin report presented as measured: the handled count now reads both run
state columns (a manager-approved run stamps only the legacy `status`),
conversion is no longer structurally 0% (it was dated from a row this repo
writes once at family creation), the referral coefficient counts households
only (accepted invites are members, reported beside it), and "terminal" has
one definition, without `blocked`.

**Landed in batch 3:** M37's no-migration half — the certified-devices
catalog and the in-app setup path ship as content and a guided checklist; no
device is described as certified by anyone, and no competitor is priced.

**Still open:** M27 and M32, each needing a migration in §6; M37's kiosk
pairing needs §6 item 13.

### Public site
**Landed in #421 (stage 1):** an outcome-first homepage — the Bubaly-Handled
proof band, the six-outcome rail, and the first-brief, decisions, Kitchen Mode,
switching and social-proof bands, with `MARKETING_NAV` and the footer
reorganised around outcomes. Every illustrative element is badged; aggregate
lines hide rather than render a zero; the social-proof band returns null when
nothing is published.

**Landed after #428 (batch 2b):** W4 — the Trust Center says only what a row
can prove (no bank-level security, no SOC 2, no uptime numbers; the forbidden
vocabulary is pinned by `tests/marketing-claims-contract.test.ts`), with the
same overclaims removed from /ai, /features, /mobile and /faq, and every one of
its 217 strings keyed in seven locales. W3 — the pricing page says what the
price buys: a per-day framing, the outcomes each tier hands back, and a value
block whose three number sources (real aggregate, badged illustrative sample,
published case studies) stay visibly apart; 51 new keys in seven locales.

**Landed in batch 3:** W6 — the display now asks and reports (an Ask tile on
the same request path, and a "handled today" tile counting COMPLETED runs that
renders an error rather than a zero when it cannot read), keeps the tablet
awake, explains its own setup, and has a public /family-display page that is a
compatibility list rather than a partnership claim.

**Still open:** W7's second half, which needs the `public_stats()` change in
§6 item 18. And a translation pass: the six non-English catalogues
are missing 304 keys en-US has (mostly `pricingContent.*`, the older
`security.*`, `visualMocks.*`, `ai.*`, `aiShowcase.*`) — those strings fall
back to English for every other locale. That is a translation job, not code,
and it belongs in its own PR.

### What the adversarial review caught in #421

Worth reading before you write a similar surface — each of these would have
shipped:

- Run history derived "Started by a routine" from `request_id === null`, which is
  **inverted on both sides**: a plan a person accepts is written with no request,
  and a cron routine creates one and carries its id. It reads `run_type` now.
- The homepage proof band linked to a live demo #414 had removed — a dead CTA on
  the one band whose subject is honest evidence.
- A recommendation whose `cta_href` was off-app took the **whole** Daily Brief
  down, because that column is free text any member can write.
- Merging `settleAll` exposed an orphaned promise in `lib/briefing/decisions.ts`
  (see the hazard note in §3).

And what the reviews of #424's sections caught, landed in #428 and batch 2b:

- `getMove` passed an **empty list** where `moveSummary` expects the boxes, so
  "4 days in · 0/0 boxes unpacked" was invented for every family mid-move.
- Conversion was **structurally 0%**: `subscriptions.created_at` is the
  family's creation instant in this repo, always earlier than any activation.
- The outcome card said "working on it" for requests the server had answered
  inline or parked on a question — a claim of work with no run behind it.
- One household inviting a spouse, two grandparents and a sitter read a viral
  coefficient of **4.00** with zero new households behind it.

---

## 6. The 21 migration asks — owner approval required

**No agent may add any of these.** They are listed so the work that depends on
them is visible, and so you can build up to the boundary and stop. If your
section needs one, implement everything that does not, and say in your PR
exactly which DDL is missing and what is therefore not claimed.

1. **M2 + M20 + M9** (one migration): `family_inbox_messages` add `request_id`
   uuid → `ai_requests`, `handled_at`, `paperwork_item_id`, `member_id`,
   `linked_type`, `linked_id`, `sub_intent`; extend the channel CHECK with
   `share`, `scan`, `paste`, `form`. RLS unchanged.
2. **M3**: `graph_entities`/`graph_edges` add `source` (default `projection`),
   `confidence`, `observed_at`; extend the kind CHECK with `asset`, `obligation`,
   `preference`, `provider`; add `calendar_events`, `bills`, `paperwork_items`,
   `family_facts` to the 0134 `mark_model_dirty` trigger list.
3. **M6**: `ai_plan_steps` add `undone_at`, `undone_by`; `ai_run_events` add
   `undone`; `ai_tool_calls.created_refs` jsonb for multi-row writes only.
4. **M35**: `CREATE OR REPLACE claim_ai_runs` so a dead-lettered run marks its
   orphaned `ai_tool_calls` rows `unknown`. No schema or RLS change.
5. **M10**: `grocery_lists.budget_cents`, `grocery_items.estimated_price_cents`.
   Calendar-awareness, substitutions and handoff can ship without it.
6. **M21**: `notifications.priority` (`now`/`digest`) + index.
7. **M24**: new `ai_context_access_log`. The Activity tab shipped without it.
8. **M36**: new `account_deletion_requests`; plus enabling MFA/TOTP in the
   Supabase project settings (no schema).
9. **M12**: `home_assets.replaced_by_asset_id`, `retired_on`; optionally
   `inventory_items.asset_id`.
10. **M15** (confirmed required — 0070 has no status column):
    `vacation_flights`/`vacation_lodging` add `disruption_status`, `delay_minutes`.
11. **M16**: `care_circles`, `care_circle_members`, `care_handoffs` +
    `is_circle_member()` + scoped SELECT policies.
12. **M32**: new `savings_ledger` + RLS + index; add to the 0275 money sweep.
13. **M18(c)** optional: `display_devices` + redeem RPC. The Ask/handled tiles
    and `/display/setup` need no migration.
14. **M26**: `service_providers`, `service_requests`, `service_quotes`.
15. **M27**: `partner_api_keys`, `partner_events` with
    `unique(family_id, idempotency_key)`.
16. **M23**: RLS on `documents`/`notes`/`journal_entries` honouring `member_id` +
    `has_active_delegation()`.
17. **M33**: `search_household()` (SECURITY INVOKER, pinned `search_path`)
    UNIONing pg_trgm similarity across eleven sources + GIN trigram indexes.
18. **W2 + W7 + W3** (one migration): `CREATE OR REPLACE public.public_stats()`
    adding `ai_handled_30d` and `avg_first_brief_minutes`.
19. **X1 + X2 + X4 + X6 + X9 + X11** (one migration): new `family_metric_weeks`,
    unique `(family_id, week_start)`, family-scoped SELECT, service-role writes
    from the weekly-digest cron.
20. **X8 + X9**: `family_members.last_active_at` + index; throttled service-role
    updates from `requireUserContext`.
21. **X2** optional follow-up: `created_via` on `calendar_events`, `todo_items`,
    `bills`, `family_reminders` so a manual capture is stamped explicitly.

---

## 7. Where the remaining work physically is

**Landed and needing no further work from anyone:**

- **PR #424** — fourteen sections: M2/M20, M3, M10, M15, M16/M23, M17, M19,
  M22, M25/M34, M29/M30, M33, M38, M39, and the X3/X5/X10/X12 metric tiles.
- **PR #428** — the review fixes those sections still lacked: dd9-13 (M13/M14),
  323-13 (M21), de4-12 (S-15 metrics core), dd9-16 (M25/M34), and the migrate
  import's part-way failure copy.
- **PR #429** — S-19 (W4 Trust Center), S-20 (W3 pricing value), the M10
  meals-loop review fixes, and the M14 Family CFO review fixes.
- **Batch 3** — S-06 (M9), S-04 (M12's no-migration half), S-07 (M18 + M37 +
  W6), plus a clock fix for two suites whose result depended on the day they
  ran.

Do not re-land any of them; the audit in `docs/MARKET_DOMINATION_AUDIT.md`
predates them and still says `partial` for several.

**Superseded — do not merge, even though the branches still exist in the
integrator's container:** `dd9-4`, `ba1-1`, `ba1-2`, `6f2-5`, `de4-11`,
`6b2-3`, `543-1`, `68a-1`, `323-4`, `323-5`, `323-6`, `323-14`, `358-4`,
`2e4-1`, `4b7-1` (≥97% of each branch's own delta is already on main through
the reviewed sibling that landed), and `358-11` (a *parallel implementation* of
S-14 whose three review fixes main already had or does not need — its one
missing finding, the migrate copy, landed in #428).

**What is genuinely left, and it is short:**

1. **The translation pass.** 291 keys en-US has that the six other locales
   lack — `pricingContent` (113), `security` (85), `visualMocks` (37), `ai`
   (20), `aiShowcase` (15), `blog` (10). Roughly two thirds look like orphans
   from copy that has since been retired: 106 of 115 `pricingContent.*` and
   179 of 236 `security.*` keys have no literal `t('…')` reference. But this
   repository does use dynamic `t(\`prefix.${x}\`)`, so prune by searching for
   the key SEGMENT, never by literal match alone — deleting a key a template
   builds at runtime renders the raw key to a family. Prune first, then
   translate what survives.
2. **Everything in §6.** Every remaining item — M12's lineage, M27, M32,
   W7's second half, the twelve metric weeks — is blocked on DDL that only the
   owner may apply.

**Three lessons the integrator paid for, so you do not have to.** First: when a
review returns fixes, they are usually on a *different* branch than the one
first merged — the harness placed reviewing agents in fresh worktrees, and the
labels in a workflow journal are ordered by completion, not by section. Read
the report's own `branch` and `sha` fields. Second: a branch that touches the
same files as a landed section is not necessarily a fix stack on it. Measure
how much of the branch's *own delta* already lives on main before merging:
≥97% means superseded; ~85% with a few hundred lines missing means a fix stack
worth porting; ~10% on files main also rewrote means a parallel implementation,
and merging it would land the section twice. Third: run the FULL suite, not the
changed files. Two suites here built plans against a frozen `NOW` but let the
executor judge them against `Date.now()`; they passed for as long as wall time
stayed behind the fixture date and then turned main red with no commit behind
it. A test whose result depends on the day it runs is not a flake, and
re-running it never clears it.

---

## 8. Definition of "done" for the strategy

Not "all 60 items say exists". The bar is:

- **Every claim the product makes is backed by a row.** No surface says Bubaly
  did something the database cannot confirm.
- **Every metric is error-aware.** No zero standing in for a failed read.
- **Every autonomous action is inside a policy a family granted**, previewable
  and audited.
- **The public site markets outcomes**, and every illustrative element is badged
  as illustrative.
- **W4 stops being `mock`.** The Trust Center is the one surface where a gap
  between claim and proof is not a missing feature but a broken promise.
