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
