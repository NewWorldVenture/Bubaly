import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = resolve(process.cwd(), 'scripts');

// A `for` loop over an empty array runs no assertions and the test passes.
// That is what this did when the filter matched nothing — proved by changing
// `\.mjs$` to an extension nothing uses and watching it stay GREEN while
// examining zero scripts.
//
// `seed-client.mjs` is excluded deliberately: it is the shared client, not a
// seed run, and it has no insert-or-cleanup path to fail closed on. It is
// therefore excluded from the floor too, or the floor would demand that the
// loop examine a file the loop is right to skip.
const SHARED_CLIENT = 'seed-client.mjs';

describe('seed write failure safety', () => {
  it('fails closed instead of continuing after an insert or cleanup error', () => {
    const all = readdirSync(scriptsDir).filter((name) => /^seed.*\.[a-z]+$/i.test(name) && name !== SHARED_CLIENT);
    const examined = readdirSync(scriptsDir)
      .filter((name) => /^seed.*\.mjs$/i.test(name) && name !== SHARED_CLIENT)
      .map((name) => ({ name, source: readFileSync(resolve(scriptsDir, name), 'utf8') }));

    // Non-vacuity floor: something was examined, and nothing that looks like a
    // seed script was skipped by the extension filter.
    expect(examined.length, 'the .mjs filter matched no seed scripts — this contract examined nothing').toBeGreaterThan(0);
    expect(
      examined.map((e) => e.name).sort(),
      `these look like seed scripts but the .mjs filter skipped them, so their error handling was never checked:\n  ${all.filter((a) => !examined.some((e) => e.name === a)).join('\n  ')}`,
    ).toEqual(all.sort());

    for (const { name, source } of examined) {
      expect(source, name).not.toMatch(/if\s*\(\s*error\s*\)[^{\n]*console\.error/);
      expect(source, name).not.toMatch(/if\s*\(\s*error\s*\)\s*\{[^}]{0,240}\b(?:return|break)\b/);
    }
  });
});
