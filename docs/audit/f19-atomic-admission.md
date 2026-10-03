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

- **Streaming `/api/ai`:** the stream goes through `createAssistantStream` in
  `lib/ai/assistant-engine.ts`. A refusal there is reported through the existing
  `AiRequestNotFiled` branch with the "not recorded" text. The model does not run, but
  the event carries no `allowance_exceeded` code. Fixing that needs a change to the
  engine.
- **Chore-proof validation** (`lib/chores/ai.ts`, `chores.validate`) was classified by
  the owner as not charged. On a Free family at 10/10 it is now refused, and the code
  falls back to parent review. Passing `exemptFromAllowance: true` there keeps it
  unrefused.
- **Super-administrators** bypass the allowance in `assertAIAccess`, but
  `withAiRequest` cannot see the caller's email. A super-admin acting in a Free family
  past 10/10 is therefore refused at admission.
- **The concierge intake** (`lib/ai/runs/intake.ts`) calls `createRequest` directly
  after `assertAIAccess`. It does not yet pass `allowance`, so it is still
  check-then-insert.
