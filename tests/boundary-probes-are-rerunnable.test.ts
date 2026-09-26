import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// The boundary probes under docs/audit/ are the only executable proof this
// audit has that a policy refuses what its migration says it refuses. They run
// in CI's Database job against a container bootstrapped from nothing, and they
// are also what a person runs by hand while iterating on a repair.
//
// Those two are not the same thing, and the difference hid a defect for as long
// as the suite has existed.
//
// ── What happened ───────────────────────────────────────────────────────────
//
// 36 of the 60 probes carry NO transaction around their seed, so every family,
// member and user they create is COMMITTED. Two of them used the same fixed
// family id — `…0000000000c1` was "Login House" in
// child-login-mapping-is-managers-only-check.sql and "Symmetry House" in
// social-access-symmetry-check.sql — and both seed with
// `on conflict do nothing`. Alphabetically the login probe runs first, so on a
// FRESH database it seeds, passes, and then the symmetry probe commits its own
// rows under the same id.
//
// On the SECOND run against that database the login probe's inserts are
// silently skipped (the conflict target is already taken, by another probe's
// family), and the foreign key that follows fails:
//
//   FAIL  child-login-mapping-is-managers-only-check.sql
//         ERROR: insert or update on table "child_logins" violates foreign key
//                constraint "child_logins_member_id_fkey"
//
// That is not a broken boundary. It is the suite failing to be re-runnable,
// reported in exactly the voice of a real breach — the worst shape a red build
// can take, because it teaches the next reader to discount the colour.
//
// CI never saw it, and the reason is the point: the Database job bootstraps a
// fresh container every time, so the suite had only ever been run ONCE per
// database. The person iterating locally is the one who meets it.
//
// ── Why this test and not a `begin`/`rollback` wrapper in run-probes.sh ──────
//
// That was tried first and it is the wrong fix, for two measured reasons.
// `perform set_config('role', 'authenticated', true)` is TRANSACTION-local, so
// probes written without a transaction rely on the role resetting between
// statements; an outer transaction makes it persist and
// invite-role-escalation-check.sql fails with "permission denied for table
// users". And wallet-concurrency-check.sql opens a SECOND session over dblink
// and therefore REQUIRES its seed rows to be committed — its own header says
// so. A wrapper broke three probes; converting the other 35 file by file is a
// deliberate pass, not a one-liner.
//
// So this pins the property that actually matters, which is narrower and
// exactly sufficient: A PROBE THAT COMMITS ITS SEED MUST NOT SHARE A FIXED ID
// WITH ANY OTHER PROBE. Two transactional probes may share one — neither
// leaves it behind. The anchor account that pg-bootstrap.sh creates is shared
// on purpose by six probes and is excluded by name.

const DIR = 'docs/audit';

/** Every UUID literal a probe hard-codes. */
const FIXED_ID = /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g;

/** The first row a probe writes, in either schema. */
const FIRST_SEED = /^\s*insert\s+into\s+(?:public|auth)\./im;

/** The ids pg-bootstrap.sh itself creates. Shared deliberately. */
function anchorIds(): Set<string> {
  const boot = readFileSync(join(DIR, 'pg-bootstrap.sh'), 'utf8');
  const ids = new Set<string>();
  for (const m of boot.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) ids.add(m[0]);
  return ids;
}

function probes(): string[] {
  return execFileSync('git', ['ls-files', '--', `${DIR}/*-check.sql`], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
}

/**
 * Does this probe's seed survive the run?
 *
 * A `begin;` before the first insert means the rows are inside a transaction
 * the file rolls back at the end. Anything else — no transaction at all, or one
 * opened later for a negative control only, which is what
 * social-access-symmetry-check.sql does — commits.
 */
function commitsItsSeed(source: string): boolean {
  const seed = source.search(FIRST_SEED);
  if (seed < 0) return false; // writes nothing; nothing to leave behind
  return !/^\s*begin\s*;/im.test(source.slice(0, seed));
}

describe('the boundary probes can be run twice against one database', () => {
  const files = probes();
  const anchors = anchorIds();

  it('reads the suite and the bootstrap it shares ids with', () => {
    // A scan that sees nothing must not pass — the defect this whole file is
    // about is an instrument reporting clean because it looked at nothing.
    expect(files.length, 'no boundary probes were found').toBeGreaterThan(50);
    expect(anchors.size, 'pg-bootstrap.sh yielded no anchor ids').toBeGreaterThan(0);
  });

  it('leaves no committing probe sharing a fixed id with another', () => {
    const owners = new Map<string, string[]>();
    const commits = new Set<string>();
    let seen = 0;

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const name = basename(file);
      if (commitsItsSeed(source)) commits.add(name);
      for (const m of source.matchAll(FIXED_ID)) {
        if (anchors.has(m[1])) continue;
        seen += 1;
        const list = owners.get(m[1]) ?? [];
        if (!list.includes(name)) list.push(name);
        owners.set(m[1], list);
      }
    }
    expect(seen, 'no fixed ids were extracted').toBeGreaterThan(100);
    expect(commits.size, 'no probe was classified as committing, which cannot be right')
      .toBeGreaterThan(10);

    const clashes: string[] = [];
    for (const [id, names] of owners) {
      if (names.length < 2) continue;
      const committing = names.filter((n) => commits.has(n));
      if (committing.length === 0) continue; // all transactional; nothing survives
      clashes.push(`${id}  shared by ${names.join(', ')}  (committing: ${committing.join(', ')})`);
    }

    expect(clashes, 'these probes commit rows under an id another probe also seeds, so the '
      + 'second run of the suite fails on a conflict that is not a boundary. Give the '
      + 'committing probe its own ids, or wrap its seed in begin/rollback').toEqual([]);
  });
});
