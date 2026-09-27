import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Audit C3-S5-04.
 *
 * The old module exported a fifteen-line helper that
 * add an AbortSignal deadline and perform no URL validation, no scheme check,
 * no DNS resolution and no redirect policy — sitting in a directory whose other
 * members are real SSRF guards. No caller passed a non-constant URL, so there
 * was no live hole; the finding is that the next person who needs to fetch a
 * URL from a database row picks the function whose name promises safety, from
 * the directory full of guards, and gets a timeout.
 *
 * The limit of this guard, stated: it keeps the misleading NAME from coming
 * back. It cannot tell whether a given call site's URL is constant.
 */
const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
  }
};
['app', 'lib', 'components', 'tests', 'scripts'].forEach(walk);

describe('the timeout wrapper is not named like a safety boundary', () => {
  it('nothing exports or calls the old misleading name any more', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      // Spelled in halves so this file does not match its own rule — an
      // exemption for the guard's own path would be the weaker answer.
      const banned = new RegExp(`\\b${'fetch' + 'External'}\\b|server/${'external' + '-fetch'}`);
      return banned.test(src);
    });
    expect(offenders, 'it is a deadline, not a guard — use fetchWithDeadline').toEqual([]);
  });

  it('it says what it is, and names the guard to use instead', () => {
    const src = readFileSync('lib/server/fetch-with-deadline.ts', 'utf8');
    expect(src).toContain('performs no URL validation');
    expect(src).toContain('lib/server/public-document-fetch.ts');
    // Still small enough that the docstring is most of it: if this file ever
    // grows URL handling, it stops being a deadline and this should be read.
    expect(statSync('lib/server/fetch-with-deadline.ts').size).toBeLessThan(2_000);
  });
});
