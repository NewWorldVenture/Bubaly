# F19: AI requests are admitted atomically

**Status:** implemented and verified against the LOCAL Supabase only. The production
application of `0477` is HELD for the owner's migration process.

## Problem

The Free plan sells 10 AI requests a month. The meter is a count of the family's
`ai_requests` rows since the start of the UTC month (`monthlyAllowance` in
`lib/server/ai-access.ts`: `.eq('family_id', f).gte('created_at', <UTC month start>)`,
every kind and every status). A route reads that count. The row that makes the
request count is filed later, by `withAiRequest` → `createRequest` or by the gift
route's own insert. Two requests at 9 of 10 both read 9, both pass and both file,
which gives 11. N parallel requests overshoot by N−1, and each one is a paid model
call.

## Design

- **`public.admit_ai_request(...)` (migration `0477`)** takes
  `pg_advisory_xact_lock(hashtextextended('ai_requests_admission:' || family_id, 0))`.
  It then counts and inserts in one transaction and returns
  `(request_id, outcome, used)`, where `outcome` is `admitted`, `refused` or `existing`.
  - **Predicate parity:** the count is `family_id = p_family_id and created_at >= date_trunc('month', now(), 'UTC')`.
    This is the same set of rows the TypeScript meter counts. The `ai_requests_select`
    policy is `is_family_member(family_id)` with no row filter, so the member-client
    count and the service-role count see the same rows. The month start is computed
    in SQL from the database clock. That clock also stamps `created_at`
    (`default now()`), so there is no duplicated TypeScript date math, and a row
    cannot disagree with the window it is counted in.
  - **Retry key:** the key is checked before the allowance. A retry of a request that
    was already filed is not a new request, so it answers `existing` with the first
    row's id even at 10/10. That is the answer `createRequest` gives from its 23505
    path. A `unique_violation` raised by a writer that does not take the lock is
    caught and answered the same way. `withAiRequest` therefore still throws
    `AiRequestDuplicate`, unchanged.
  - The function is `security definer` with `set search_path = public, pg_temp`. EXECUTE
    is revoked from `public, anon, authenticated` and granted only to `service_role`.
    A `do` block asserts this, in the same pattern as 0456. The only caller is the
    ledger client (`createServiceClient`).
- **`lib/ai/runs/store.ts`:** `admitRequest(db, row, allowance)` calls the RPC.
  `createRequest` takes `allowance?: number | null`. When it is a number, the row is
  filed through the admission on the ledger client. A refusal returns
  `fail(code: AI_ALLOWANCE_EXCEEDED)`.
- **`lib/ai/observability.ts`:** `withAiRequest` resolves the plan once, before filing.
  - **Capped plans** are admitted. A refusal throws `AiRequestOverAllowance` before
    the body runs. That error subclasses `AiRequestNotFiled`, so every caller that
    already stops on an unfiled request stops on this one too.
  - **Unlimited plans** keep the plain insert.
  - **A plan that cannot be read** is filed plainly, because there is no number to
    admit against, and a failed filing still refuses. That is the previous rule.
  - **`spec.exemptFromAllowance`** files and counts the row but is never refused.
    It is meant for surfaces the owner classified as not charged.
- **Routes:**
  - `/api/ai` (JSON) maps the refusal to `accessDeniedResponse({status:429, code:'allowance_exceeded', limit}, tr)`.
  - `/api/ai/chat` (stream) sends `{type:'error', code:'allowance_exceeded', limit, error:<localized>}`.
  - The gift route admits its own row and answers the same localized 429 when refused.

## Compatibility and deploy order

The change is additive: one new function, and nothing existing is altered.

If the TypeScript ships **before** the migration, the RPC fails with
`PGRST202`/`42883` (the function does not exist). `admitRequest` returns a plain
`fail(db)`, so:
- `withAiRequest` throws `AiRequestNotFiled` on a capped plan. The body does not run.
- The gift route answers 503.
- Capped (Free) families are refused rather than metered loosely. This **fails safe**,
  in the same way as an `AiRequestNotFiled` that is already in place.
- Unlimited plans are unaffected.

**Apply 0477 before or together with the code.**

## Rollback

Revert the TypeScript commit, then
`drop function if exists public.admit_ai_request(uuid, integer, text, text, uuid, uuid, uuid, text, text, text, smallint, text, timestamptz);`.
No data is changed.

## Local evidence (disposable local Supabase in Docker, `supabase_db_bubaly`)

```
docker exec -i supabase_db_bubaly psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0477_ai_requests_admission_is_atomic.sql   # applied twice: idempotent
```

The proof uses a disposable family with 9 rows seeded this month. N parallel `psql`
sessions are started with `&` and collected with `wait`.

**Naive pattern:** count, `pg_sleep(0.3)` for the route-to-filing gap, then
`insert if count < 10`.

**Atomic pattern:** `admit_ai_request(fam, 10, ...)` as `service_role`, held open
0.3 s before commit.

| N | naive total | atomic total | admitted / refused |
|---|---|---|---|
| 8 | **17** | **10** | 1 / 7 |
| 16 | **25** | **10** | 1 / 15 |

Other checks:
- A keyed request filed at 10/10 and then retried answers `existing`, and no row is added.
- `set role authenticated; select admit_ai_request(...)` gives `permission denied`.
  `anon` and `authenticated` have no EXECUTE, and `service_role` has it.
- The disposable family was deleted afterwards (cascade). 0 rows remain.

Unit tests:
- `tests/f19-admission-is-atomic.test.ts`
- the race cases in `tests/a-gift-request-counts-against-the-allowance.test.ts`
- the race cases in `tests/a-retried-assistant-turn-counts-once.test.ts`

They emulate the function through `tests/helpers/admit-ai-request.ts`, which also
serves `admit_ai_request` as a built-in of `tests/helpers/in-memory-supabase.ts`.
Against the pre-change code they fail with:
- 8 bodies run instead of 1
- `[200, 200]` instead of `[200, 429]` on the gift and `/api/ai` races

## Known gaps

- **Streaming `/api/ai` (closed in `71b176cb4`):** `createAssistantStream` in
  `lib/ai/assistant-engine.ts` catches `AiRequestOverAllowance` before the generic
  `AiRequestNotFiled` branch. It sends `{type:'error', code:'allowance_exceeded',
  limit}` with the localized `ai.yourFamilyUsedItsMonthlyAllowance` text, and the
  model does not run.
- **Chore-proof validation (closed in `71b176cb4`):** `lib/chores/ai.ts`
  (`chores.validate`) was classified by the owner as not charged. It passes
  `exemptFromAllowance: true`, so a Free family at 10/10 is filed plainly and never
  refused (`tests/chores-ai-observed.test.ts`).
- **Super-administrators (closed):** they bypass the allowance in `assertAIAccess`,
  but `withAiRequest` and the concierge intake only have a scope, with no email, so
  a super-admin in a Free family at 10/10 used to be refused at admission.
  - Only after a refusal, `isSuperAdminCaller` (`lib/server/super-admin-caller.ts`)
    looks the caller up by user id through the ledger client, using the gate's own
    allowlist.
  - A super-admin's row is then filed as it was before 0477: plainly, and counted.
  - A system scope, no user, or a failed lookup keeps the refusal (fail closed).
  - The ordinary path makes no lookup.
  - `tests/f19-super-admin-is-not-refused.test.ts` (7 tests): against the old
    source, 4 fail; the member, failed-lookup and no-lookup controls pass both ways.
  - Whether super-admin work should count at all is still the owner's to decide.
    This only restores the gate's rule.

## Closed: the concierge intake (Ask Bubaly)

`submitRequest` in `lib/ai/runs/intake.ts` is used by `POST /api/ai/requests`, the
concierge form action, the inbox action and inbound contact-center routing. It used
to file its `kind: 'concierge'` row with a plain insert on the member's client after
the caller's `assertAIAccess` count. That was check-then-insert, so two submissions
at 9/10 both filed and both were planned.

- **Plan:** the intake reads the plan once with `resolveFamilyPlanLevel` +
  `monthlyAllowanceFor`, the same read and table as `withAiRequest`. There is no
  TypeScript date math, because the window is the function's own.
- **Capped plan:** the row goes through `createRequest(..., { allowance })`, which
  calls `admitRequest` on the intake's ledger client (`admit_ai_request` is
  service-role only). The requester comes from `scope.userId`/`scope.memberId`, as
  before. 0477 already takes everything the intake writes at filing: `kind`
  'concierge', `conversation_id`, `request_text`, `client_request_id`, a null
  `feature`, `status` 'queued' and priority 0. The intent is written after filing,
  as before.
- **Refusal:** a refused admission returns `IntakeAllowanceRefusal`. This has the
  same shape as `assertAIAccess`'s denial: status 429, `code: 'allowance_exceeded'`,
  `limit`, and the same English source text. Nothing is classified or planned.
  `/api/ai/requests` answers it with `accessDeniedResponse(refusal, t)`, so the
  response is localized (`ai.yourFamilyUsedItsMonthlyAllowance`). The server actions
  pass `error`/`code` through exactly as they do for the gate's denial.
- **Keyed retry:** the function answers `existing` before checking the allowance, so
  the intake's replay path runs even at 10/10.
- **Unlimited plan:** the row is a plain insert on the member's client, as before
  (RLS proves the requester). There is no rpc call.
- **Plan unreadable:** the row is filed plainly (`withAiRequest`'s rule). A failed
  filing returns before anything is planned.
- **0477 missing:** the admission fails, the intake returns that failure, and nothing
  is filed or planned. The call is refused, never filed unmetered.
- **System scope (inbound contact-center routing):** never admitted. The row is a
  plain insert, as before, and is never refused at the cap. Only what a person asked
  for is metered (owner decision on #771). A member scope on the same plan at 10/10
  is still refused.

- **Keyed retry of the 10th request through a gate (closed):** `/api/ai/requests`,
  the concierge form action and the inbox action run `assertAIAccess` before the
  intake. At 10/10 the gate used to answer 429 before the intake could replay a
  keyed retry of the request that made it 10. Now `isRetryPastAllowance` passes
  over an `allowance_exceeded` denial, and only that code. It does so only when the
  key already names a `kind: 'concierge'` row filed by the same requester; the
  intake then replays that row (200, the same request, no new row, no planning).
  - Still refused: `feature_off`, `plan_required`, `unavailable`, a new key, an
    unkeyed submission, another member's key, or a key on an assistant-turn row.
  - A new key at the cap is refused by the gate and again, atomically, by 0477.
  - A failed lookup keeps the gate's refusal.

**Evidence.** `tests/f19-intake-admission-is-atomic.test.ts` (15 tests) drives the real
intake, store and route over one in-memory database. The member and ledger clients
are two views of that database, and `admit_ai_request` is emulated by
`tests/helpers/admit-ai-request.ts`. A barrier holds route racers after the gate's
count, which makes the race deterministic.

Against the pre-change intake and route, 6 of the 8 tests fail:
- Two direct submissions at 9/10 leave 11 rows instead of 10.
- Two POSTs give `[202, 202]` instead of `[202, 429]`.
- Eight POSTs give eight 202s instead of one.
- The "0477 missing" case is filed anyway.
- No admission is made, so the requester and column checks find no rpc call.

After the change, all 8 pass. Two later tests pin the system-scope rule: a system
scope at 10/10 files plainly, and as a negative control a member scope at 10/10 is
refused. Without the `actorKind === 'system'` guard, the system-scope test fails.
Five more tests pin the retry-past-the-gate rule, through the route and the form
action. Without `isRetryPastAllowance` the two replay tests fail (429). Without its
requester check, the other-member test fails. Without its kind check, the
assistant-turn test fails.

Local SQL, on a disposable family seeded with 9 rows: 8 concurrent
`admit_ai_request(..., 'concierge', ...)` calls were made as `service_role`, each
held 0.3 s before commit.
- Result: 1 `admitted:10` and 7 `refused:10`, for exactly 10 rows, all concierge.
- A retry under the admitted key at 10/10 answered `existing`.
- A new key at 10/10 answered `refused:10`.
- The family was deleted afterwards. 0 rows remain.

## Closed: every access refusal in the reader's language

`assertAIAccess` writes its refusals in English. API routes translated only the
allowance one, through `accessDeniedResponse(denial, t)`. Server actions (the
concierge form, run answer and control, the inbox "Ask Bubaly", the mission draft)
and the concierge run pages showed `denial.error` as it was. A German family read
"Ask Bubaly is part of Family Basic…" in English.

`denialMessage(denial, t)` in `lib/server/ai-access.ts` translates every code:
- `allowance_exceeded`, with `limit`;
- `plan_required`, with `feature` and `needLevel`;
- `unavailable`, with `unreadable` set to `plan` or `usage`;
- `feature_off`: a bare "Not found." in API responses; actions name the feature,
  because the member is already on its page.

`accessDeniedResponse`, every action and both pages use it. The intake's own
allowance refusal goes through it too. `error` stays the English source text.

Six keys were added to all 7 base catalogues.
`tests/ai-access-refusals-are-localized-off-the-api.test.ts` has 13 tests and drives
the real gate, actions, translator and catalogues in German. Against the old
source, 10 of the 13 fail. The three that still pass are the positive control, the
English control and the catalogue check.

## Closed: exempt work no longer uses up the allowance

Independent review on #892 (comment 5970498462) found that both meters counted
every `ai_requests` row of the month: 0477's admission and `assertAIAccess`. That
included rows the owner said must not be charged ("not approval to silently
charge background work", #771 review 5391362628):
- chore-proof validation (`exemptFromAllowance`);
- system-scope concierge intake (inbound contact center);
- system-scope `kind: 'routine'` requests from the family-routines cron.

At 9/10 a chore proof made the family 10/10, and its next real request was
refused. At 10/10 exempt rows went past the cap without the lock.

**Fix.**
- 0477 adds `ai_requests.metered boolean not null default true`. Existing rows and
  every writer that says nothing stay metered.
- Both meters count `metered` rows only: 0477's `admit_ai_request` (`and
  r.metered`) and `monthlyAllowance` (`.eq('metered', true)`).
- `createRequest` writes `metered = false` when the request is exempt or its scope
  is a system scope, and never admits such a row.
- `withAiRequest` treats a system scope as exempt. An exempt filing that fails no
  longer refuses on a capped plan: it is a record, not the meter.
- `metered` is sent only when false, so metered inserts look exactly as they did.
  If the column is missing (code deployed before 0477), an exempt request is not
  filed: 0477's default would make such a row metered, and nothing could
  distinguish it afterwards (#892 review 5971047090).
  - Exempt work behind `withAiRequest` still runs, unrecorded.
  - System intake and routines report failure until the migration lands.
  - Regression: `tests/f19-exempt-work-is-not-metered.test.ts` runs a chore proof
    and a system intake in that window, then applies 0477 and asserts that the
    family still has its 10th paid request.

**Who can unmeter a row.** Only server code. Members have no UPDATE or DELETE
policy on `ai_requests`. A concierge row a member inserts directly (0255) with
`metered = false` is never planned, because nothing sweeps queued rows, so it buys
no AI work.

**Owner-visible consequence.** Routine runs, scheduled by a member and run by cron,
are now unmetered. That follows the ruling above. If routines should be metered,
it is a one-line change in `createRequest`.

**Evidence.**
- `tests/f19-exempt-work-is-not-metered.test.ts` has 8 tests. It drives the real
  `withAiRequest`, `createRequest`, `submitRequest` and `assertAIAccess` over one
  in-memory database with `admit_ai_request` emulated from the same table.
  - Sequential: a chore proof at 9/10, then the 10th paid request is admitted and
    the 11th refused. A chore proof at 10/10 runs and stays out of the count. A
    system intake at 9/10 leaves the member's 10th request. A routine is
    unmetered.
  - Concurrent: 8 proofs and 8 paid requests at 9/10 give 8 proofs, 1 paid
    admitted, 7 refused, 10 metered of 18, and 9 model calls. A second race uses 4
    system intakes and 4 member submissions.
  - Controls: a member's ordinary request is metered, and a pre-0477 schema falls
    back to the metered insert.
  - Against the old source, 6 of the 8 fail; the 2 controls pass.
- Local SQL (`scratchpad` script, a disposable family, real Postgres):
  - sequential, at 9 paid: 1 exempt row leaves metered at 9; paid #10 is
    admitted; an exempt row at 10/10 is filed with metered still 10; paid #11 is
    refused;
  - concurrent, 8 exempt and 8 paid at 9, each transaction held 0.3 s: 1 admitted,
    7 refused, 10 metered, 8 unmetered, 18 rows;
  - control, with the old behaviour (exempt rows metered): 8 exempt rows at 9 take
    the meter to 17.

## Closed: paperwork transcription was a paid model call nobody recorded

Filing a document reads it with a vision model. `extractDocumentText` sends the
image or PDF to a multimodal `structuredCompletion` of up to 8,192 tokens. Three
paths do this:
- an upload (`/api/paperwork/capture`, member scope);
- a link (`/api/paperwork/link`, member scope);
- an emailed attachment (the inbound email webhook, system scope).

None of them opened an `ai_requests` row. Paperwork has no feature-tier gate, so a
Free family could transcribe without limit, unrecorded and uncounted. The §33
coverage scanner never saw these paths: it counted only `@/lib/ai/provider`
producers, and these obtained their model through `resolveProviderForTask`.

**Fix.**
- **Scanner:** it now treats `resolveProviderForTask` as reaching a model. With
  only that change, the three paths appear and the ceiling fails.
- **Helper:** `transcribeDocument` (`lib/ai/observed-document-text.ts`) wraps each
  transcription that reaches a model in `withAiRequest`. The feature is
  `paperwork.transcribe.{upload|link|email}` and the text is fixed.
  - The row is `exemptFromAllowance`: `metered = false`, never refused.
  - A plain-text, empty, oversized or unsupported file opens no row.
  - A transcription that fails settles its row `failed`.
- **Ceiling:** the silent ceiling is now the exact count, 5.

**Owner decision:** whether a member's upload or link should count against Free's
10 requests. If yes, it is one flag; emailed attachments stay unmetered as
background work.

**Evidence.**
- `tests/paperwork-transcription-is-recorded.test.ts`: 6 tests, including 10/10 on
  Free, a failure, the system scope, and plain-text and unsupported controls.
- Coverage test: with the old services it fails 2 cases ("does not grow", and the
  new paperwork assertion); with the new ones it passes.

## Closed: the contact-center concierge records its model call

`runConcierge` answers every inbound SMS, email and voicemail transcript with
`provider.complete`, and its summary is delivered to the family's phone. It opened
no `ai_requests` row, so a line that answered badly, or fell back every time, left
nothing to diagnose.

**Fix.**
- The three inbound routes pass `record: { db, familyId }`. The model call then
  runs inside `withAiRequest` on a system scope (`contact-center.{sms|email|voice}`,
  fixed text).
- The row is unmetered and never refused: this is inbound work nobody in the
  family asked for.
- `runConcierge` still never throws. A model error, an unparseable answer or an
  abort after the row opened settles the row `failed`, and the deterministic
  fallback answers the line.
- No row is opened when AI is not configured or the call is already aborted.
- The §33 silent ceiling goes from 5 to 4.

**Evidence.** `tests/contact-center-concierge-is-recorded.test.ts` has 6 tests.
Against the old source 5 fail: the 4 recording cases plus the coverage ceiling.
The controls (no `record`; not configured or aborted) pass either way.

## Hosted proof: the boundary probe

`docs/audit/an-ai-request-is-admitted-under-the-allowance-check.sql` runs 0477's
real function in CI's Database job. That job replays every migration into a real
Postgres and runs every `*-check.sql` probe under `ON_ERROR_STOP`. The probe
asserts eight things in one transaction that rolls back:
- at 9 of 10 the request is admitted, reporting 10 used;
- at 10 of 10, keyed or not, it is refused and nothing is filed;
- 5 unmetered rows are not counted. The negative control flips those same rows to
  metered and requires a refusal;
- rows from last month fall outside the window;
- a retry key at the cap answers `existing` with the first row's id;
- an insert that says nothing about `metered` is metered;
- `anon` and `authenticated` cannot execute the function, and `service_role` can.

Locally, against a mutant of the function without `and r.metered`, the probe
fails four assertions by name. Against the real function it passes. Concurrency
needs several sessions, so it stays with the local multi-session script above;
the probe proves the decision each session makes.
