import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The page audit's last intermittent defect: React #418 on about 0.7% of
// signed-in loads, a different page each time, on a tree that is identical on
// the server and the client. It is react/react#37584 in the React that Next
// 15.5 bundles: replaySuspendedUnitOfWork replays a host element that suspended
// mid-hydration without rewinding the hydration cursor. The build backports the
// upstream fix through scripts/react-hydration-replay-fix.cjs. These cases hold
// that the backport applies to the React actually installed, lands where the
// fix belongs, and is wired into the build for both the production and the
// development React.

const require = createRequire(import.meta.url);
const { applyReplayFix, MARKER } = require('../scripts/react-hydration-replay-fix.cjs') as {
  applyReplayFix: (source: string, file?: string) => string;
  MARKER: string;
};
const ANCHOR = 'function replaySuspendedUnitOfWork(unitOfWork) {';
const REACT_DOM = (build: string) => require.resolve(`next/dist/compiled/react-dom/cjs/react-dom-client.${build}.js`);

describe('the React replay-cursor backport (react/react#37584)', () => {
  it.each(['production', 'development'])('applies to the installed %s react-dom client', (build) => {
    const file = REACT_DOM(build);
    const source = readFileSync(file, 'utf8');
    const patched = applyReplayFix(source, file);
    const at = patched.indexOf(ANCHOR);
    // The rewind is the first thing replaySuspendedUnitOfWork does, before the
    // replayed fiber is reset and begun again.
    const head = patched.slice(at, at + ANCHOR.length + MARKER.length + 400);
    expect(head).toContain(MARKER);
    expect(head).toMatch(/isHydrating &&\s+hydrationParentFiber === unitOfWork &&\s+null !== unitOfWork\.stateNode &&\s+\(5 === unitOfWork\.tag \|\| 26 === unitOfWork\.tag\)/);
    expect(head).toMatch(/nextHydratableInstance = unitOfWork\.stateNode;\s+popToNextHostParent\(unitOfWork\);/);
    expect(applyReplayFix(patched, file)).toBe(patched);
  });

  it('fails the build, not silently, when the React it expects is gone', () => {
    expect(() => applyReplayFix('function somethingElse() {}')).toThrow(/react\/react#37584/);
    expect(() => applyReplayFix(`${ANCHOR}}\n${ANCHOR}}`)).toThrow(/exactly one/);
    expect(() => applyReplayFix(`${ANCHOR}}`)).toThrow(/no longer defines/);
  });

  it('is wired into the build for both React builds', async () => {
    const { default: config } = await import('../next.config.mjs');
    expect(config.webpack, 'next.config.mjs defines webpack()').toBeTypeOf('function');
    const webpackConfig = { module: { rules: [] as Array<{ test: RegExp; use: Array<{ loader: string }> }> } };
    const out = config.webpack!(webpackConfig as never, {} as never) as typeof webpackConfig;
    const rule = out.module.rules.find((r) => r.use?.some((u) => u.loader.endsWith('react-hydration-replay-fix.cjs')));
    expect(rule, 'a rule runs the backport').toBeDefined();
    for (const build of ['production', 'development']) expect(rule!.test.test(REACT_DOM(build))).toBe(true);
    expect(rule!.test.test(require.resolve('next/dist/compiled/react-dom/cjs/react-dom.production.js'))).toBe(false);
    expect(existsSync(rule!.use[0].loader)).toBe(true);
  });
});
