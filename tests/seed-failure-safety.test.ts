import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// This file was named "fails closed" and asserted only that two BAD shapes were
// absent (F-F06):
//
//   expect(source).not.toMatch(/if \(error\)[^{\n]*console\.error/);
//   expect(source).not.toMatch(/if \(error\) \{[^}]{0,240}\b(return|break)\b/);
//
// Deleting a script's error check entirely made it GREENER — a seed that never
// looks at `error` matches neither pattern. So the test was satisfied by the
// one thing it existed to prevent, and a script could stop checking without a
// single case going red.
//
// What it asserts now is the shape being claimed: every seed script checks the
// error, and every check it makes ends in a throw. The absence cases are kept
// behind that as a cheap second net, not as the argument.
const scriptsDir = resolve(process.cwd(), 'scripts');

/** Seed scripts, excluding the shared client they all import. */
function seedScripts(): { name: string; source: string }[] {
  return readdirSync(scriptsDir)
    .filter((name) => /^seed.*\.mjs$/i.test(name) && name !== 'seed-client.mjs')
    .map((name) => ({ name, source: readFileSync(resolve(scriptsDir, name), 'utf8') }));
}

// Two constants, not one with `.test()` called on it. A /g/ regex carries
// `lastIndex` between calls, so a single shared instance reports every other
// script as having no error check at all — which this file caught on its own
// first run, and which is precisely the kind of false negative it exists to
// stop being possible.
/** `if (error)` — with or without the whitespace a minified script omits. */
const ERROR_CHECK = /if\s*\(\s*error\b/;
const ERROR_CHECKS = /if\s*\(\s*error\b/g;

describe('seed write failure safety', () => {
  const scripts = seedScripts();

  it('finds the seed scripts (non-vacuity)', () => {
    // The walk is the first thing that can silently stop working: a rename
    // convention would empty this list and pass every case below.
    expect(scripts.length).toBeGreaterThanOrEqual(6);
    expect(scripts.map((s) => s.name)).toContain('seed.mjs');
  });

  it('every seed script looks at the error at all', () => {
    // The hole in the old version. A script that never reads `error` inserts
    // into a table that refused it and reports a tick.
    const blind = scripts.filter((s) => !ERROR_CHECK.test(s.source)).map((s) => s.name);
    expect(
      blind,
      'these never check a write result — a refused insert would be reported as a seeded row:\n' + blind.join('\n'),
    ).toEqual([]);
  });

  it('every error check ends in a throw', () => {
    const offenders: string[] = [];
    for (const { name, source } of scripts) {
      for (const match of source.matchAll(ERROR_CHECKS)) {
        // The check and what it does about it: to the end of the statement or
        // the block it opens, whichever comes first.
        const after = source.slice(match.index!, match.index! + 260);
        if (/\bthrow\b/.test(after)) continue;
        const line = source.slice(0, match.index!).split('\n').length;
        offenders.push(`${name}:${line}`);
      }
    }
    expect(
      offenders,
      'a seed error that does not throw leaves a half-seeded database reported as a full one:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('does not log-and-continue, or swallow with a bare return', () => {
    // The original two assertions, kept as a second net. On their own they were
    // satisfied by removing the check; behind the two cases above they are not.
    for (const { name, source } of scripts) {
      expect(source, name).not.toMatch(/if\s*\(\s*error\s*\)[^{\n]*console\.error/);
      expect(source, name).not.toMatch(/if\s*\(\s*error\s*\)\s*\{[^}]{0,240}\b(?:return|break)\b/);
    }
  });

  it('the one tolerated error says why, in the code', () => {
    // seed-medical tolerates a cleanup against a table that does not exist —
    // production's migration ledger stops short, so an absent table there is
    // the normal case. That is a decision, and it is narrow: it still throws on
    // anything else. Asserted so it cannot widen into "cleanup errors are fine".
    const medical = scripts.find((s) => s.name === 'seed-medical.mjs');
    if (!medical) return;
    expect(medical.source).toMatch(/if\s*\(error\s*&&\s*!\/does not exist\/i\.test\(error\.message\)\)/);
    expect(medical.source).toMatch(/throw new Error\(`Seed cleanup failed/);
  });
});
