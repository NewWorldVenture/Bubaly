# Boundary probes

Each `*-check.sql` in this directory asserts a database-level invariant with
`RAISE EXCEPTION`, so under `psql -v ON_ERROR_STOP=1` a broken boundary is a
non-zero exit rather than a paragraph nobody reads.

**These run on every pull request** (`.github/workflows/ci.yml`, the `database`
job): every migration is replayed into a real Postgres 16, then every probe runs
against it. Before that they existed but nothing executed them —
`tests/rls-isolation-sweep.test.ts` reads a probe file and checks it still
contains its assertions, which guards the guard rather than running it.

## Running them by hand

```bash
bash docs/audit/verify-pg.sh up        # throwaway PG16 + shims + all migrations + seed
bash docs/audit/verify-pg.sh probes    # every *-check.sql
bash docs/audit/verify-pg.sh psql      # poke at it
bash docs/audit/verify-pg.sh down
```

`verify-pg.sh` starts a local server and then calls `pg-bootstrap.sh`, which is
the same script CI runs against its service container. One definition on purpose:
a second copy in the workflow would drift, and the drift is invisible — CI would
be proving something nobody can reproduce.

`0237` does `create extension vector`, so a plain Postgres cannot apply the
migrations. Locally: `sudo apt-get install postgresql-16-pgvector`. In CI:
`pgvector/pgvector:pg16`.

## Adding a probe

Name it `<something>-check.sql` and drop it here. `run-probes.sh` globs, so it is
enforced on the next PR with no workflow edit — a hand-kept list is a list
someone forgets to add to.

Two failure modes worth designing against, both of which have already bitten a
probe in this directory:

- **Passing on an empty table.** "User B read 0 rows" proves nothing if nobody
  has rows. `rls-isolation-check.sql` now counts as the owner first and fails if
  a table it names is empty.
- **Only checking one direction.** Every leak probe is satisfied by a *missing*
  policy, because default-deny is what they assert. `0118` exists because
  production had RLS on with its family policies missing and pages silently
  returned zero rows — a leak probe stays green through exactly that.
  `family-self-read-check.sql` covers the other direction.

## What is here

| probe | asserts |
|---|---|
| `rls-isolation-check.sql` | Family B can neither read nor write family A's rows; every family-scoped table has RLS on; definer RPCs reject cross-family and cross-user callers. |
| `family-self-read-check.sql` | Every family-scoped table the anchor family has rows in is readable **by that family** — the other half of the 0118 failure. |
| `money-write-boundary-check.sql` | Ledger writes stay behind the manager boundary. |
| `wallet-write-rls-check.sql` | A child cannot mint money; `wallet_audit_logs` is append-only. |
| `wallet-overspend-check.sql` | Holds are counted and spending cannot exceed the balance. |
| `document-vault-boundary-check.sql` | Vault documents stay inside their boundary. |
| `family-facts-provenance-check.sql` | A memory records where it came from. |
| `ai-surface-role-privacy-check.sql` | A child cannot read or create AI plans, memory or routines; the asking parent still can. |
| `dead-letter-reconcile-check.sql` | A dead-lettered run leaves no step, request or legacy status claiming success. |
| `approval-dedupe-check.sql` | A resent request cannot file a second *pending* approval card; a re-ask after a decision still can. |
| `wallet-side-table-write-check.sql` | The five wallet side-tables whose server actions gate on `isManager` (`babysitter_profiles`, `babysitter_payments`, `gift_links`, `gift_payments`, `compliance_disclosures`) refuse a child's writes and still accept a manager's — 0322. |
| `safety-record-write-check.sql` | Emergency contacts, emergency plans and Guardian suggestions are manager-written, and a child cannot retarget a pending suggestion so that a parent's approval applies the child's value — 0323. |
| `pay-id-and-goal-write-check.sql` | A child cannot repoint, deactivate or release a `pay_handles` row — the one `/pay/<handle>` resolves with the service role to decide whose gift link an outsider lands on — nor author a `wallet_goals` row; the full deputy chain is reproduced, because `wallet_fund_goal` debits the wallet the GOAL names. The service-role resolution and the manager's own funding call are asserted as positive controls — 0324. |
| `dashboard-and-twin-write-check.sql` | `family_digital_twin_profiles` and `family_dashboard_settings` are manager-written (the second holds the very flags `canCustomizeDashboard()` reads), while `dashboard_layouts` is NOT blanket-restricted: a member keeps their own `scope='user'` row and cannot reach the family default or another member's — 0325. |
| `chore-dispute-resolution-check.sql` | A member still raises, withdraws and deletes their own chore dispute; only a manager may resolve one, un-resolve it, or stamp `resolution`/`resolved_by`/`resolved_at` — 0326. |
| `autopilot-suggestion-write-check.sql` | A member still appends to and resolves the Autopilot queue as themselves (the scan and the resolve action are plan-gated, never role-gated); no client role erases a row, nobody records a resolution in someone else's name, and the service role keeps its retention reach — 0327. |
| `wallet-audit-actor-check.sql` | A wallet audit row names the member who actually appended it: a child cannot sign one as the parent or leave it actor-less, a parent cannot sign for the child, and 0224's append-only property still holds — 0328. |
| `a-calendar-event-names-who-made-it-check.sql` | A calendar event names the person who made it, or nobody: a child cannot be born-forged into a parent's name, nor rewrite or erase an author afterwards (by UPDATE or by `ON CONFLICT DO UPDATE`), while unattributed imports, a child's own events, a child's edit of a parent's event, and a **manager naming another member** all still work — that last one asserted POSITIVELY, because it is the approval-replay path and the rejected draft's probe asserted its opposite. Also asserts the column's `ON DELETE SET NULL` still fires, which an unconditional preserve silently reverts — 0339. |
| `an-erasure-actually-erases-check.sql` | 0338's attribution freeze still refuses an application rewrite of `logged_by`/`created_by`, while the columns' own `ON DELETE SET NULL` now fires — so erasing an account clears the name instead of leaving it attached to rows a renderer still draws. Also asserts no trigger issues a nested UPDATE against the four ledgers, which is what would make `pg_trigger_depth() = 1` stop covering every application write. Negative control restores the unconditional preserve and requires the erasure to break — 0340. |
