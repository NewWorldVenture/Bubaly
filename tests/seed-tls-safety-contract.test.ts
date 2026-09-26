import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = resolve(process.cwd(), 'scripts');

// `expect(unsafe).toEqual([])` is satisfied by an empty array, and an empty
// array is what this produced when the filter matched NOTHING. Proved rather
// than reasoned: changing `\.mjs$` to an extension nothing uses left this test
// GREEN while it examined zero seed scripts. A rename to `.mts`, a move into
// `scripts/seed/`, or a new naming convention would each have done the same —
// silently, because a contract that finds no offenders and a contract that
// looks at nothing both report "no offenders".
//
// The floor below compares what was EXAMINED against what LOOKS like a seed
// script by any extension, so the two can never drift apart quietly. A bare
// `length > 0` would not have caught seven of eight files being renamed.
function seedScriptsByAnyExtension(): string[] {
  return readdirSync(scriptsDir).filter((name) => /^seed.*\.[a-z]+$/i.test(name));
}

describe('seed tooling TLS safety', () => {
  it('does not disable certificate verification in seed scripts', () => {
    const examined = readdirSync(scriptsDir).filter((name) => /^seed.*\.mjs$/i.test(name));

    // Non-vacuity floor. This is not a target and it may only change when the
    // seed scripts really change — if it fails, the filter above has gone stale,
    // not the seed tooling.
    const candidates = seedScriptsByAnyExtension();
    expect(examined.length, 'the .mjs filter matched no seed scripts — this contract examined nothing').toBeGreaterThan(0);
    expect(
      examined.sort(),
      `these look like seed scripts but the .mjs filter skipped them, so they were never checked for NODE_TLS_REJECT_UNAUTHORIZED=0:\n  ${candidates.filter((c) => !examined.includes(c)).join('\n  ')}`,
    ).toEqual(candidates.sort());

    const unsafe = examined.filter((name) => /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/.test(
      readFileSync(resolve(scriptsDir, name), 'utf8'),
    ));

    expect(unsafe).toEqual([]);
  });
});
