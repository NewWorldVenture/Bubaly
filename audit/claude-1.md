# Claude-1 — Coordinator · Architecture · Integration

Owned by Claude-1. No other worker writes findings here.

Severities: CRITICAL, HIGH, MEDIUM, LOW.
Statuses: OPEN, VERIFIED, FIXED, BLOCKED.

Evidence means something reproducible — a command, an output, a probe, a
measurement. An assertion is not evidence, and this file says so because the
largest finding below is precisely a case of an assertion standing in for one
for the entire life of the repository.

---

## Findings

### [CLAUDE-1][CRITICAL][ARCHITECTURE] The documented production-recovery procedure did not work

- **File/path:** `docs/runbooks/LB-016-wallet-permissive-policy-finding.md` §4.1;
  18 files under `supabase/migrations/`; `.github/workflows/ci.yml`
- **Problem:** LB-016 §4 is the procedure an operator follows to unblock
  production. It rests on the claim that every migration is idempotent, so
  `supabase db push` can replay from `0004` over a database that already carries
  the schema. Nothing had ever tested that claim. It cited two things as proof
  and neither showed what it was cited for: `tests/migrations-are-additive.test.ts`
  bans `DROP TABLE`/`COLUMN`/`TRUNCATE`/`TYPE` (additive, not idempotent), and the
  CI replay ran against an **empty** database, where `create policy` has nothing
  to collide with.
- **Evidence:** `docs/audit/rehearse-ledger-repair.sh` reproduces production's
  condition (full schema, ledger holding only `0001`–`0003`) and replays from
  `0004` as `db push` does. Against the history as it stood:

      re-applied cleanly (no-op as claimed): 286
      FAILED:                               18
      stops at 0004_rls.sql :: policy "profiles_insert_self" already exists
      0004 recorded: 0  -> requiresBaselineReview would still be TRUE

- **Impact:** The operator would have spent a maintenance window and come out
  with the ledger no more repaired than when they started, the release still
  blocked, and no indication which of the remaining 17 files would stop them
  next. `create policy` has no `IF NOT EXISTS` form in any Postgres version, so
  there was no way for those files to be safe to re-run.
- **Recommended fix:** applied. Each of the 18 now follows the convention its own
  neighbours already used (`drop policy if exists` first, `create or replace
  trigger`, `create index if not exists`, `create table if not exists`, `add
  column if not exists`, `create or replace function`, a `pg_publication_tables`
  check around publication adds). `0018` needed its drop inside an
  `execute format(...)` loop. `0226` needed its 525 `LoremFlickr (CC)` hero rows
  seeded NULL, because `0238`'s licence trigger — already installed when a
  populated replay reaches `0226` — rejects them.
- **Status:** FIXED — rehearsal reports 0 failures, `0004` records, guard clears
  on its own; from-scratch replay unchanged at 307/0. Landed on main `c6006f58`.

### [CLAUDE-1][HIGH][ARCHITECTURE] Nothing enforced migration idempotency, so it could regress silently

- **File/path:** `.github/workflows/ci.yml`, `docs/audit/rehearse-ledger-repair.sh`
- **Problem:** The finding above was a class, not an incident. The CI replay
  structurally could not observe idempotency, so any future migration could
  reintroduce it and CI would stay green until an operator hit it in a window.
- **Evidence:** Added a deliberately unguarded `create policy` as `0999` and ran
  the two CI steps in order — the existing from-scratch replay passed it without
  complaint, the new step failed by name and exited 1:

      == migrations applied: 308, failed: 0 ==      <- existing replay is happy
      FAILED: 1
        0999_tmp_regression_probe.sql :: policy "tmp_regression_probe" already exists
      REHEARSAL EXIT=1

- **Impact:** Without the gate, production recovery quietly decays again.
- **Recommended fix:** applied. The rehearsal is the last step of the
  `Database (migration replay · RLS boundary probes)` job. It runs last because
  it rewrites the ledger; it is valuable because the job's earlier step already
  applied every migration once, so this applies each a **second** time — a new
  migration is checked on the PR that introduces it. Confirmed live: the
  rehearsal's output appears in #541's CI Database job.
- **Status:** FIXED — verified green in CI, and verified to fail on a planted regression.

### [CLAUDE-1][HIGH][INTEGRATION] Two branches independently claimed migration version 0295

- **File/path:** `supabase/migrations/0295_reward_redemption_decision_guard.sql` (main, #542)
  vs `supabase/migrations/0295_social_access_delete_matches_grant.sql` (#541)
- **Problem:** `supabase_migrations.schema_migrations` has a PRIMARY KEY on
  `version`. Two files sharing `0295` means `db push` dies on the second with
  `duplicate key value violates unique constraint "schema_migrations_pkey"` —
  the exact failure `tests/migration-version-safety.test.ts` exists to prevent,
  which could not see it because the two files were on different branches.
- **Evidence:** `git diff --name-only origin/main...origin/claude/roadmap-implementation-ld8bon
  -- supabase/migrations/` returned the second `0295`. After merging, both sides
  had independently bumped the expected `nextVersion` to `0296` for their own file.
- **Impact:** Would have blocked production migration apply — on the very path
  F-001 is already blocked on.
- **Recommended fix:** applied. #541's file renumbered to `0296` with its
  references moved (`finalaudit.md` I-01, `docs/audit/social-access-symmetry-check.sql`,
  the range sentence in `docs/PENDING_PROD_MIGRATIONS.md`); `nextVersion` now `0297`.
- **Status:** FIXED on #541's branch. `db:audit:migrations` passes at 309 files.

### [CLAUDE-1][HIGH][INTEGRATION] A merge would have reopened the child-self-approval hole

- **File/path:** `components/modules/rewards-module.tsx`
- **Problem:** #510 (`codex/final-production-audit-20260912`) still wrote to
  `reward_redemptions` directly from the browser, choosing `status` and
  `decided_by` client-side. main (#542) had replaced both paths with
  `requestRedemptionAction` / `decideRedemptionAction` precisely because a child
  could approve their own reward. Taking the branch's side on the merge conflict
  would have silently reverted a security fix.
- **Evidence:** the conflict hunk contained
  `status: canManage && forMemberId === selfMember?.id ? 'approved' : 'requested'`
  and `decided_by: ... selfMember?.id` on an unguarded PostgREST insert.
- **Impact:** Reintroduced privilege escalation for any family member with a JWT.
- **Recommended fix:** applied — main's side taken;
  `grep -c "from('reward_redemptions').insert\|.update"` now returns 0.
- **Status:** FIXED on #510's branch.

### [CLAUDE-1][MEDIUM][SECURITY] `/api/contact-center` was public as a prefix, not as exact paths

- **File/path:** `lib/auth/route-access.ts`, `middleware.ts`
- **Problem:** main listed `/api/contact-center` in the PUBLIC prefix list, so
  `matchesPrefix` makes every present and future route under it reachable without
  a session. Only the five inbound webhooks need that.
- **Evidence:** #510's own test asserts it —
  `tests/middleware-public-api-boundary.test.ts:200`,
  `expect(middleware).not.toContain("'/api/contact-center'")` — and it failed on
  the merged tree.
- **Impact:** Today the prefix and the exact set are equivalent (the five routes
  are all that exist). The defect is prospective: a future
  `/api/contact-center/settings` or `/history` would be born public.
- **Recommended fix:** applied — the prefix removed; the five webhooks stay
  reachable through middleware's exact `PUBLIC_CONTACT_CALLBACKS` set, with
  main's reason for making them reachable preserved in the comment.
- **Status:** FIXED on #510's branch; the test that forbids regression passes.

### [CLAUDE-1][MEDIUM][TESTING] A runtime gate fails on this Node and passes on CI's

- **File/path:** `tests/stream-cancellation-runtime.test.ts`
- **Problem:** The test asserts the installed Node carries Node PR62040, which
  fixes an internal error when client cancellation and a late SSR write
  interleave. It fails on Node v22.22.2 and passes on the CI runner's Node 22.x.
- **Evidence:** fails identically on #510's branch **without** my merge (checked
  in a separate worktree), so it is not merge-induced:
  `TypeError: controller[kState].transformAlgorithm is not a function`.
- **Impact:** The suite's result depends on the runner's Node patch version. It
  will turn CI red the moment the runner image moves to a Node without the fix,
  and it currently gives a false "all green" impression to anyone running
  locally on an affected Node.
- **Recommended fix:** pin the Node version in CI and in `package.json` engines,
  or make the test skip with a clear notice on a runtime lacking the fix rather
  than fail — a check that cannot run is not a check that found a problem.
  Not applied: the file belongs to #510's active session.
- **Status:** OPEN — reported, not fixed (worker collision; see rule 9).

### [CLAUDE-1][HIGH][DATABASE] Production schema cannot be reached from any agent

- **File/path:** `docs/PENDING_PROD_MIGRATIONS.md`, `docs/runbooks/LB-016-…md` §4
- **Problem:** Production's ledger records only `0001`–`0003` against a schema
  hundreds of tables ahead, so every release touching `supabase/` halts at
  `scripts/audit-production-migration-state.mjs`.
- **Evidence:** no `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` /
  `SUPABASE_DB_PASSWORD` in the environment or `.env.local`; no `supabase` CLI in
  the sandbox; `NEXT_PUBLIC_SUPABASE_URL` points at `127.0.0.1`.
- **Impact:** Code fixes deploy on merge; schema fixes do not. Any finding whose
  remedy is a migration is only half-live in production.
- **Recommended fix:** operator action, unchanged. What changed this pass is that
  the procedure is now proven to work end to end rather than asserted.
- **Status:** BLOCKED — permanently, for agent workers. Not a defect to fix here.

### [CLAUDE-1][MEDIUM][ARCHITECTURE] The audit record told a future worker to revert a shipped fix

- **File/path:** `finalaudit.md` F13; `lib/auth/route-access.ts`; `middleware.ts`
- **Problem:** F13 recorded "unknown top-level paths redirect to login" and
  closed it *"By design — no change"*, adding that "weakening auth routing is
  off-limits". main #544 then shipped exactly the behaviour F13 said would not
  be changed. The record and the code now said opposite things, and the record
  was the more emphatic of the two.
- **Evidence:** F13's text — "Deliberately **not changed**" — against
  `middleware.ts:74`, `const isProtected = !isPublic && matchesPrefix(path, PROTECTED);`
  which routes an unlisted path to the router (404) rather than `/login`.
- **Impact:** This is the failure mode an audit document is *for* preventing. A
  worker reading F13 would conclude #544 weakened auth routing and could revert
  it. The class is worse than the instance: a stale "closed as unavoidable"
  entry is an instruction, not just a stale note.
- **Recommended fix:** applied. F13 is marked superseded, with why the trade-off
  it described was not actually the choice: #544 added a third state. A path is
  now public, protected, or *neither* — and "neither" is a path with no route,
  which 404s. Fail-closed routing for real app routes is unchanged.
- **Status:** FIXED in `finalaudit.md`. No code changed.

### [CLAUDE-1][OBSERVATION][PROCESS] The recurring defect class in this repository is the vacuous guard

- **File/path:** repository-wide
- **Problem:** Not a defect in itself — a pattern across findings, recorded here
  because it should steer the three passes that have not started.
- **Evidence:** F-004 (a money-boundary probe that could not catch F-003),
  F-011 (the fix for F-008 carrying F-008's own defect), F-015 (a probe granting
  itself privileges and leaving them), F-019 (a concurrency probe that ran two
  statements sequentially), F-020 (a replay that could only ever run against an
  empty database), Pass C's sweep (matching only single-line statements, blind to
  both findings it was meant to catch), and an index test that could not see
  `UNIQUE`/`PRIMARY KEY` declarations.
- **Impact:** A guard that cannot fail is worse than no guard: it converts "we
  did not look" into "we checked", and it is the reason several of these defects
  survived multiple audits.
- **Recommended fix:** for Claude-2/3/4 — for every guard you rely on or add,
  break the thing it protects and confirm it goes red. If it stays green, that is
  the finding. This is already the house standard in Pass C–F's verification
  tables; it should be applied to guards nobody has questioned yet.
- **Status:** VERIFIED — the pattern holds across eight independent findings.
