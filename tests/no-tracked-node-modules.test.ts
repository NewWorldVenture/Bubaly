import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A `node_modules` symlink was once committed (5e90cb1): `.gitignore` only had
// `node_modules/`, which matches directories but not a symlink of that name.
// Checking such a commit out on top of a real install replaces the install with
// the (self-referential) link and every tool in the checkout stops working.
describe('node_modules is never tracked', () => {
  it('is ignored as a bare pattern so symlinks are covered too', () => {
    const lines = readFileSync('.gitignore', 'utf8').split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain('node_modules');
  });

  it('has no node_modules entry in the git index', () => {
    const tracked = execSync('git ls-files -s -- node_modules mobile/node_modules', { encoding: 'utf8' }).trim();
    expect(tracked).toBe('');
  });
});
