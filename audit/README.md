# The shared audit workspace

Four workers audit bubaly.com in parallel. This file is the briefing every one
of them reads first. It is written by Claude-1 and is not a findings file.

## Who writes what

| worker | area | writes to |
|---|---|---|
| **Claude-1** | coordinator · architecture · integrations | `audit/claude-1.md` **and** `finalaudit.md` |
| **Claude-2** | frontend · UI/UX · responsive · accessibility | `audit/claude-2.md` only |
| **Claude-3** | backend · API · database · auth · security | `audit/claude-3.md` only |
| **Claude-4** | QA · features · flows · performance · edge cases | `audit/claude-4.md` only |

**`finalaudit.md` is Claude-1's alone.** Nobody else opens it for writing.
Nobody edits another worker's `claude-X.md`. Nobody deletes a finding.

## Finding format

```
### [CLAUDE-X][SEVERITY][AREA] One-line claim
- **File:** path/to/file.ts:123
- **Problem:** what is wrong
- **Evidence:** the command, query or snippet that DEMONSTRATES it
- **Impact:** who is affected and how
- **Fix:** the specific change
- **Status:** OPEN | VERIFIED | FIXED | BLOCKED
```

`SEVERITY` ∈ CRITICAL, HIGH, MEDIUM, LOW, INFO.

## The standard of evidence this audit already holds

Fifteen passes are already recorded in `finalaudit.md`, and they set a bar that
later findings have to clear. It is worth stating plainly, because this codebase
has repeatedly punished sloppy method:

1. **A pattern match is not a finding.** Nine times in this audit a text scan
   produced a count that moved with the regex rather than with the code —
   33/48/52 phantom "unguarded actions" from brace-matching that landed in a
   *return type*; 129 tables "without RLS" that all had it via
   `execute format(...)` loops; **20 leaked secrets** where every chain crossed a
   `'use server'` RPC boundary. Read the actual code before writing a finding.
2. **Prove it, do not infer it.** Where a claim is about the database, prove it
   against a real replay: `bash docs/audit/verify-pg.sh` or `pg-bootstrap.sh`
   into a throwaway Postgres, then act AS the role in question. Where it is
   about a route, drive the route.
3. **A guard that cannot fail is not a guard.** If you propose a test, revert
   the fix and confirm the test goes red. Several tests here passed over the
   exact defect they were written for.
4. **Report zero as loudly as eight.** A pass that finds nothing must show what
   it checked, or "we checked" and "we could not see" read the same.

## What is ALREADY covered — do not re-derive these

`finalaudit.md` Passes A–O. Verify one if verification is genuinely useful, but
do not spend a cycle re-discovering them.

| pass | surface | outcome |
|---|---|---|
| A | public/marketing surface, SEO, robots/sitemap, headers, i18n payload, plan + role entitlement | 21 findings |
| B | Supabase reads/writes, RLS + grants, nightly jobs, build cache, calendar-day, query plans, money concurrency | 19 |
| C | writes whose result is discarded and then claimed | 8 |
| D | every export of every `'use server'` module: authentication + cross-tenant writes | 0 |
| E | reads whose error is discarded and whose absence is then treated as fact | 1 |
| F | every `route.ts` under a PUBLIC middleware prefix | 2 |
| G | RLS enabled + no blanket `true` policy, across all 491 tables in a real catalogue | 0 |
| H | Storage buckets and object paths | 1 |
| I | role boundaries — can a child reach what a parent decides | 1 |
| J | the 94-tool AI registry: does `readOnly: true` tell the truth | 0 |
| K | caller-supplied tenant ids on route handlers | 2 |
| L | published plans vs the gates that serve them | 3 |
| M | state that outlives its request: module scope, `unstable_cache`, shared HTTP caches | 1 |
| N | secrets reachable from the client bundle | 0 |
| O | the 27 columns holding a token, key or password | 3 |

**Still open and owner-owned** (do not "fix" these; they are decisions or need
credentials): F5/F-001 the production migration ledger · F6 · F19's remaining 35
unmetered AI routes · O-02 credential reads · O-03 step-up MFA has no RLS
counterpart · SEC-001 the public `family-media` bucket · migrations `0296` and
`0297` authored but deliberately NOT applied to production.

## Before you change code

1. Read `audit/status.md` and the other workers' files.
2. If another worker lists the file under FILES-TOUCHED, **audit it, do not
   modify it** — write the recommendation instead.
3. Never revert an unrelated change. Never weaken or skip a test.
4. Agents must NOT apply migrations to production (`docs/PENDING_PROD_MIGRATIONS.md`).
5. `lib/constants/navigation.ts` — the global left navigation — must not be
   modified without the user's explicit instruction.

## Useful commands

```bash
npx vitest run                       # 1,191 files / 13,677 tests
npx tsc --noEmit
npm run lint
npm run db:audit:queries             # every table, column, function, route resolves
bash docs/audit/pg-bootstrap.sh      # replay all 310 migrations into a local PG
bash docs/audit/run-probes.sh        # 20 behavioural boundary probes
```
