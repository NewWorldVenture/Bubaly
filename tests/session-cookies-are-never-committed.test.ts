import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// MAIN-F-016. `npm run crawl:login` signs in through the real login form and
// writes the session cookies to cookies.json in the repo root, and that file was
// not ignored: one `git add -A` away from committing a live session.

const ignored = (path: string) => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path]);
    return true;
  } catch {
    return false;
  }
};

describe('a crawl session cookie cannot be committed', () => {
  it('crawl-login still writes cookies.json by default (so the ignore is still needed)', () => {
    expect(readFileSync('scripts/crawl-login.mjs', 'utf8')).toContain("process.argv[2] ?? 'cookies.json'");
  });

  it('git ignores cookies.json at the root', () => {
    expect(ignored('cookies.json')).toBe(true);
  });

  it('and the check can say no (guards the guard)', () => {
    expect(ignored('package.json')).toBe(false);
  });
});
