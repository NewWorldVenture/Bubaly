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
- **Super-administrators** bypass the allowance in `assertAIAccess`, but
  `withAiRequest` cannot see the caller's email. A super-admin acting in a Free family
  past 10/10 is therefore refused at admission.

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
