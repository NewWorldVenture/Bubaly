import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// §45: "a family's rows are protected by policies nothing in CI ever tries to
// break." The probes in docs/audit/ have existed for a while and NOTHING ran
// them — tests/rls-isolation-sweep.test.ts reads the probe file and checks it
// still contains its assertions, which is a guard on the guard, not a run.
//
// The `database` job replays every migration into a real Postgres and runs every
// probe against it. This file guards the wiring: the job, the fail-fast, and the
// glob. It cannot check that Postgres agreed — that is the job's own business —
// but it can check that nothing quietly stops asking.
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const bootstrap = readFileSync('docs/audit/pg-bootstrap.sh', 'utf8');
const runner = readFileSync('docs/audit/run-probes.sh', 'utf8');

describe('the database boundary is actually exercised in CI', () => {
  it('runs the migration replay and the probes on every PR', () => {
    expect(ci).toContain('  database:');
    expect(ci).toContain('bash docs/audit/pg-bootstrap.sh');
    expect(ci).toContain('bash docs/audit/run-probes.sh');
    // pull_request with no branch filter — the job has to gate PRs, not just main.
    expect(ci).toMatch(/on:\s*\n\s*pull_request:/);
  });

  it('uses an image that can actually apply the migrations', () => {
    // 0237 does `create extension vector`. On stock postgres:16 that migration
    // fails, and a replay that cannot finish proves nothing about what follows it.
    // Match the `image:` line itself. The comment above it names both images to
    // explain the choice, so a bare toContain passes on a workflow that actually
    // runs stock postgres — the test would be satisfied by its own documentation.
    expect(ci).toMatch(/^\s*image:\s*pgvector\/pgvector:pg16\s*$/m);
    expect(ci).not.toMatch(/^\s*image:\s*postgres:16\s*$/m);
  });

  it('fails the build when a migration does not apply, rather than counting', () => {
    // The harness used to print `migration_fail=N` and exit 0. A replay that
    // reports instead of failing is how the next 0118 ships green.
    expect(bootstrap).toContain('FAILED MIGRATIONS');
    expect(bootstrap).toMatch(/if \[ \$\{#failed\[@\]\} -ne 0 \]; then[\s\S]{0,200}exit 1/);
  });

  it('discovers probes by glob, so a new one is enforced without editing CI', () => {
    // A hand-kept list in the workflow is a list someone forgets to add to.
    // The assignment, not the usage comment above it.
    expect(runner).toMatch(/^probes=\(.*docs\/audit\/\*-check\.sql\)/m);
    expect(runner).toContain('ON_ERROR_STOP=1');
    // An empty docs/audit must be a failure, not a vacuous pass.
    expect(runner).toMatch(/\$\{#probes\[@\]\} -eq 0[\s\S]{0,200}exit 1/);
  });

  it('runs every probe before failing, so a red build names all of them', () => {
    expect(runner).not.toMatch(/exit 1\s*\n\s*fi\s*\n\s*done/);
    expect(runner).toContain('FAILED PROBES');
  });

  it('shares one bootstrap with the harness a person runs by hand', () => {
    // Two copies of the shim + migrate + seed logic drift, and the drift is
    // invisible: CI proves something nobody can reproduce.
    const harness = readFileSync('docs/audit/verify-pg.sh', 'utf8');
    expect(harness).toContain('docs/audit/pg-bootstrap.sh');
    expect(harness).not.toContain('create table if not exists auth.users');
  });

  it('covers both directions of the 0118 failure', () => {
    const probes = readdirSync('docs/audit').filter((f) => f.endsWith('-check.sql'));
    // A leak: another family reading your rows.
    expect(probes).toContain('rls-isolation-check.sql');
    // The other half: your own family losing access to its rows. A missing
    // SELECT policy passes every leak probe, because default-deny is exactly
    // what they assert — drop calendar_events_select and the isolation probe
    // stays green while the family's calendar goes blank.
    expect(probes).toContain('family-self-read-check.sql');
    const selfRead = readFileSync('docs/audit/family-self-read-check.sql', 'utf8');
    expect(selfRead).toContain('SELF-READ FAIL');
    // Swept from the catalog, not from a hand-kept list of tables.
    expect(selfRead).toContain("col.column_name = 'family_id'");
  });
});
