import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Next compiles in a separate webpack build worker (next.config.mjs:
// experimental.webpackBuildWorker) and collects pages in jest-worker children.
// A V8 flag on the parent's own command line ("node --max-old-space-size=4096
// next build") never reaches those children: a forked worker takes its heap
// limit from NODE_OPTIONS, or else from V8's default, which is about a quarter
// of the machine's memory. On Vercel's 8 GB build machine that default is about
// 2 GB, and from ae573d879 onward the module graph no longer fit in it: every
// production build died in the worker with "JavaScript heap out of memory"
// about two minutes in, while the same build passed on a 16 GB laptop. The cap
// therefore lives in NODE_OPTIONS, which every child inherits.
describe('the build gives its workers their own heap', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  const build = pkg.scripts.build;

  it('sets the old-space cap through NODE_OPTIONS, where the build worker inherits it', () => {
    expect(build).toMatch(/^NODE_OPTIONS=--max-old-space-size=(\d+) /);
    const cap = Number(/^NODE_OPTIONS=--max-old-space-size=(\d+) /.exec(build)![1]);
    // Below 3 GB the webpack worker runs out of heap on this tree; above 4.5 GB
    // the worker's resident size (about 1.4 GB over its heap) plus the parent
    // would not fit an 8 GB build machine.
    expect(cap).toBeGreaterThanOrEqual(3072);
    expect(cap).toBeLessThanOrEqual(4608);
  });

  it('does not rely on a parent-only command-line heap flag', () => {
    expect(build).not.toMatch(/\bnode --max-old-space-size=/);
  });

  it('still builds with webpack', () => {
    expect(build).toMatch(/next build --webpack$/);
  });
});
