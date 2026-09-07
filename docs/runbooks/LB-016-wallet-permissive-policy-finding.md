# LB-016 — "wallet_transactions still has a permissive INSERT policy"

**Status:** closed on production, verified by the audit (§0). Code side closed by
migration `0275_money_permissive_write_sweep.sql`. One operator action remains,
and it is about the migration ledger rather than about money (§4).

This page exists because the same finding has stopped three separate release
attempts, and each reviewer had to re-derive the same answer from scratch. If an
automated audit has just halted you with wording like:

> `wallet_transactions` still has a permissive INSERT policy alongside the
> intended manager-only policy … allowing any family member, potentially
> including a child account, to submit a completed credit and create spendable
> wallet funds.

read §2 and §3, then continue. **Halting again adds nothing.**

---

## 0. What production reports now (2026-09-07, after `0275` was applied by hand)

The operator ran `0275` in the SQL editor. The next release attempt's audit read
the result back out of the production catalog, and this is the whole verdict:

```json
{"migrationVersions":["0001","0002","0003"],"tableCount":441,"policyCount":978,
 "requiresBaselineReview":true,
 "moneyWrites":{"openWrites":[],"unguarded":[],"exploitable":false}}
```

Source: `Supabase production migrations` run #29, on `main` at `bda1c30`,
2026-09-07 14:39 UTC. Produced by `moneyWriteVerdict` in
`scripts/audit-production-migration-state.mjs` (#409), with the hardened
counting rules from #410 — resolved through `to_regclass`, gated on
`relrowsecurity`, matched on the policy expression, and requiring three
*distinct* commands.

Read it as three separate claims:

- `openWrites: []` — **no permissive write policy on any of the ten money tables
  lacks `can_manage_family`.** The stray that stopped three releases is gone, and
  so is the `is_family_member` shape on the finance tables in §5.
- `unguarded: []` — **every one of the ten carries a restrictive write guard**,
  including the five (`bills`, `budgets`, `financial_accounts`, `savings_goals`,
  `transactions`) that had never had one.
- `exploitable: false` — the conjunction. Nothing to escalate.

This is the proof #410 said was missing. The earlier all-clear was reported as
proven when it was only counted; this one was measured by the hardened check
against the real database, and both directions now agree.

`requiresBaselineReview: true` is the *separate* problem, and the one that is
still open: §4. It is why that workflow run is red. A red
`Supabase production migrations` check does **not** mean the money finding is
back — check `moneyWrites` in the run's log before assuming it does.

---

## 1. Why the finding is real

It is a true statement about database metadata. `pg_policy` really does carry a
permissive write policy on a money table, and it is not one of the intended
manager-only ones.

Every migration that has touched this boundary — `0217`, `0254`, `0267` — drops
policies **by hardcoded name**. A permissive policy whose name nobody listed
survives all three. So each audit correctly reports it, and will keep reporting
it until the policy is actually gone.

## 2. Why it is not exploitable

Permissive policies OR together, so on its own that finding is exactly as bad as
it sounds. What closes it is `0254`, which added **RESTRICTIVE** manager guards:

> A restrictive policy ANDs with the union of the permissive ones, so no
> permissive policy — whatever it is called, whoever it is granted to — can
> grant past it.

That is a claim about Postgres semantics, and a claim about money deserves a
test rather than a reading. `docs/audit/wallet-write-rls-check.sql` **invariant
5** injects the drifted policy in two shapes and asserts a child session still
cannot mint:

- `to authenticated with check (is_family_member(family_id))` — the exact shape
  the audit describes.
- `to public with check (true)` — no role limit, no condition at all.

**Invariant 6** covers the one path restrictive guards do not: the guards are
`to authenticated`, so a policy `to public` would not AND with them for an
anonymous request. `anon` holds no INSERT privilege, so the question never
reaches RLS. Asserted, not assumed.

These run in CI on every PR (`Database (migration replay · RLS boundary
probes)`), against a real Postgres, after replaying every migration.

## 3. What actually closes the finding

`supabase/migrations/0275_money_permissive_write_sweep.sql` enumerates
`pg_policy` **at apply time** and drops every permissive `INSERT/UPDATE/DELETE/ALL`
policy on the money tables that is not one of the intended ones. It cannot miss
a name it was never told about — that is the whole point, since the previous
three attempts each fixed the instance and left the class open.

It also gives the household finance tables (`0267`'s group) the same restrictive
backstop the wallet tables have had since `0254`, so the identical drift cannot
reopen the household's money the identical way.

Scope guardrails, all asserted in `tests/0275-money-permissive-write-sweep.test.ts`:

- **Writes only.** `select` is untouched on both groups — narrowing reads would
  empty "My Wallet" for every non-manager, which is a product change, not a leak
  (see `0267`'s header).
- The intended `select` policy is re-asserted **before** anything is dropped, so
  a `FOR ALL` policy can be swept without leaving reads uncovered mid-transaction.
- The sweep filters on `polpermissive`, so it can never remove the restrictive
  guards that are holding the line.
- It asserts its own end state and raises if a stray survived — a sweep that
  matched nothing looks identical to one that worked.
- No money row, balance, bucket or external payment is read or changed.

`docs/audit/wallet-write-rls-check.sql` **invariant 7** then asserts that no
stray permissive write policy remains, so this cannot quietly regress.

## 4. The one thing still open — and it is an operator action

`scripts/audit-production-migration-state.mjs` refuses historical replay when
production carries the `profiles_insert_self` policy but has **no migration
`0004` recorded** (`hasUnrecordedBaseline`). Production's ledger holds only
`0001`–`0003` while the schema is hundreds of tables ahead, so every release
that touches `supabase/` stops here.

That check is correct and must not be bypassed.

**Do not:**
- disable or weaken `hasUnrecordedBaseline`;
- pass `--enforce-history` off to "get past" it;
- hand-apply anything that touches **data or schema** out of band — that is what
  the ledger exists to keep honest.

### 4.1 What the repair actually is

Not a stamping exercise. Every migration in this repository is **additive and
idempotent** — `tests/migrations-are-additive.test.ts` holds the whole history
to zero `DROP TABLE` / `DROP COLUMN` / `TRUNCATE` / `DROP TYPE`, and CI replays
all 291 of them against a real Postgres on every PR (`Database (migration
replay · RLS boundary probes)`). So the ledger does not need to be *told* what
is applied; it repairs itself by letting `supabase db push` run from `0004`,
where the already-applied migrations no-op and the genuinely missing ones land.

Writing rows into `supabase_migrations.schema_migrations` by hand is the option
NOT to take: it asserts that work was done without doing it, and a migration
wrongly marked applied is skipped forever.

### 4.2 Prerequisite, now satisfied

`schema_migrations` has a **PRIMARY KEY on `version`**. The repository used to
carry 17 duplicate version numbers (`0010`, `0026`, `0042`, …), so a replay died
at the second `0010` with

```
ERROR: duplicate key value violates unique constraint "schema_migrations_pkey"
```

Every group has since been renamed to a unique version preserving apply order
(`0010_blog_posts` → `00100_blog_posts`, `0010_support_tickets_admin_users` →
`00101_support_tickets_admin_users`). `KNOWN_DUPLICATE_MIGRATIONS` is now empty
and `tests/migration-version-safety.test.ts` fails if a duplicate returns.

### 4.3 The procedure

1. **Pre-flight.** Run `docs/audit/migration-ledger-state.sql` — read-only. It
   reports what the ledger holds, how far ahead the schema is, and whether the
   three hand-applied migrations (`0249`, `0254`, `0275`) show as
   *present / unrecorded*. Expect exactly that for all three.
2. **Take a restore point.** A PITR checkpoint or a backup, not a mental note.
   This is the step that makes everything after it reversible.
3. **Pick a maintenance window** — see the warning in 4.4.
4. **Replay**, outside the workflow, with the ledger guard intact:
   `supabase db push` against the production project.
5. **Verify.** Re-run the pre-flight; the ledger high-water mark should now be
   the newest migration. Then run `node scripts/audit-production-migration-state.mjs`
   and confirm `requiresBaselineReview: false` and `moneyWrites.exploitable: false`.
6. **Re-run the release workflow.** With `0004` recorded, the guard passes on
   its own — nothing in the code needs changing to make that happen.

### 4.4 The window nobody has flagged before

A replay runs the history **in order**, and the history contains a period where
the money boundary is open:

- `0006` creates the household finance policies gated on `is_family_member`
  (membership, not role);
- `0267` narrows them to `can_manage_family`;
- `0275` sweeps whatever survived and adds the restrictive guards.

Between `0006` and `0267` executing, production briefly carries the exact
permissive policies §5 describes. The end state is correct — that is the whole
point of running them in order — but the intermediate state is not. Replay in a
maintenance window with the app unavailable, not against live traffic.

That risk is a consequence of repairing the ledger late. It gets no smaller by
waiting, and every migration hand-applied in the meantime adds one more row the
replay has to no-op through.

## 5. Running this by hand in the Supabase SQL editor

`0254` has been applied to production by hand. That is what puts the restrictive
guards in place, so **the money is locked** (§2). It does **not** necessarily
clear the finding: `0254` drops policies by name, so a stray called anything
other than `wallet_transactions_insert` / `_update` / `_delete` or
`"Members manage wallet_transactions"` survives it.

### Step 1 — find out (read-only, changes nothing)

```sql
select c.relname                                as table_name,
       p.polname                                as policy_name,
       case p.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                     when 'd' then 'DELETE' when '*' then 'ALL'
                     when 'r' then 'SELECT' end as command,
       case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end as kind,
       pg_get_expr(p.polqual,      p.polrelid)  as using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid)  as with_check_expr
from pg_policy p
join pg_class c     on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = any (array[
    'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
    'financial_accounts','transactions','budgets','bills','savings_goals'])
order by c.relname, p.polpermissive desc, p.polcmd, p.polname;
```

Read the result like this:

- A **RESTRICTIVE** row on a write command is a guard. You want these. There
  should be three per wallet table (`_manager_insert_guard` and siblings).
- A **PERMISSIVE** row on `INSERT`/`UPDATE`/`DELETE`/`ALL` whose name is not
  `<table>_mng_insert` / `_mng_update` / `_mng_delete` (wallet tables) or
  `<table>_insert` / `_update` / `_delete` (finance tables) **is the stray the
  audit keeps reporting.** Note its name.
- `SELECT` rows are out of scope — leave them alone (§3).

### What the query returned on production BEFORE `0275` was applied

**This is a historical record, not the current state — see §0, which is the same
database after the fix.** It is kept because it is worse than the finding that
prompted this page, and because it was found only by running the query rather
than reasoning about the migrations.

The **wallet** tables are correct — `0254` did its job:

```
child_wallets  child_wallets_mng_insert  INSERT  PERMISSIVE  can_manage_family(family_id)
child_wallets  child_wallets_mng_update  UPDATE  PERMISSIVE  can_manage_family(family_id)
child_wallets  child_wallets_mng_delete  DELETE  PERMISSIVE  can_manage_family(family_id)
child_wallets  child_wallets_select      SELECT  PERMISSIVE  is_family_member(family_id)
```

The **finance** tables are not. `0267` has never been applied to production:

```
bills    "Members can manage bills"  ALL     PERMISSIVE  is_family_member(family_id)
bills    bills_insert                INSERT  PERMISSIVE  is_family_member(family_id)
bills    bills_update                UPDATE  PERMISSIVE  is_family_member(family_id)
bills    bills_delete                DELETE  PERMISSIVE  is_family_member(family_id)
budgets  ... identical shape
```

`is_family_member`, not `can_manage_family` — **membership, not role.** A child
has a real session (`/kid-login` is whitelisted in `middleware.ts`). So at that
moment a minor could turn off autopay on the mortgage, delete the Groceries
budget, or remove a financial account. That is exactly the hole `0267` was
written to close, and `0267` had never reached production. There were no
restrictive guards on these tables either — `0267` never added any, which is why
`0275` does. **Closed the same day** by running `0275`; §0 is the read-back.

**The trap this sprang:** `bills_insert` has the *correct name* and the *wrong
rule*. Every check that works by policy name — including the first version of
the step 1 query on this page — reports it as intended. Diagnose by rule, not by
name:

```sql
  and p.polpermissive
  and p.polcmd in ('a','w','d','*')
  and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
      coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') not like '%can_manage_family%'
```

Every row that returns is a write a child can currently make.

### Step 2 — remove it

Paste the whole of `supabase/migrations/0275_money_permissive_write_sweep.sql`
into the SQL editor and run it. It closes the finance hole above as well as the
wallet finding: it drops the `FOR ALL` policy and recreates
`<table>_insert/_update/_delete` against `can_manage_family`, then adds the
restrictive guards.

**This one is a behaviour change, not metadata tidying.** Any non-manager who can
currently edit bills, budgets, financial accounts or savings goals stops being
able to. That is what `0267` intended and what the TypeScript already enforces in
three independent places; the database was the one disagreeing. Reads are
untouched, so nothing disappears from anyone's screen. It removes strays by shape rather than by name,
so you do not have to tell it what the policy from step 1 is called. It is
idempotent, it re-asserts the intended policies and the guards, it touches no
money rows, and it raises an exception rather than reporting success if a stray
survives. Re-run step 1 afterwards: every remaining permissive write row should
be an intended one.

### A caveat about doing this by hand

Applying migrations through the SQL editor does **not** record them in
`supabase_migrations.schema_migrations`. That divergence is exactly what §4
describes — production's ledger holds only `0001`–`0003` while the schema is far
ahead. Hand-applying `0254` and `0275` is low risk in itself (policies only,
idempotent, no data touched), but it widens that gap. The ledger still needs the
operator action in §4 before the normal forward release can work again.

## 6. If you are an agent that just got stopped by this

1. Confirm the finding is the one described above (permissive **write** policy on
   a money table).
2. **Check `moneyWrites` in the latest `Supabase production migrations` run
   before anything else.** That field is the answer to the question you were
   stopped on, read straight out of production. If `exploitable` is `false` with
   `openWrites: []` and `unguarded: []`, the boundary is closed on the live
   database — say so, cite the run, and carry on. §0 is the last reading.
3. Confirm `supabase/migrations/0275_money_permissive_write_sweep.sql` is present
   on your branch. If it is, the code side is done — **say so and carry on.**
4. If the blocker is the migration ledger, that is §4: an operator action, not a
   code change. It is also why that workflow is red, which is **not** a money
   finding. Report it and continue with the rest of your task.
5. Do not open a fourth migration that drops these policies by name. That is the
   pattern that produced this page.
