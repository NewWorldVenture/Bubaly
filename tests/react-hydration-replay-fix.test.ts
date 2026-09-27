import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { between } from './helpers/source-order';

// The page audit's last intermittent defect: React #418 on about 0.7% of
// signed-in loads, a different page each time, on a tree that is identical on
// the server and the client. It is react/react#37584 in the React that Next
// 15.5 bundles: a host element that suspended mid-hydration is replayed
// without rewinding the hydration cursor. The build backports React 19.3's fix
// through scripts/react-hydration-replay-fix.cjs. These cases hold that the
// backport applies to the React actually installed, lands where React put the
// fix, leaves a React that already has it alone, and is wired into the build
// for both the production and the development React.

const require = createRequire(import.meta.url);
const { applyReplayFix, MARKER } = require('../scripts/react-hydration-replay-fix.cjs') as {
  applyReplayFix: (source: string, file?: string) => string;
  MARKER: string;
};
const REACT_DOM = (build: string) => require.resolve(`next/dist/compiled/react-dom/cjs/react-dom-client.${build}.js`);

// Next 16.3.6's react-dom-client.production.js (React 19.3.0-canary-cbb046ab),
// the replay's HostComponent case as it ships, with the fix.
const REACT_19_3_REPLAY = `
    case 5:
      resetHooksOnUnwind(next);
      var fiber = next;
      fiber === hydrationParentFiber &&
        (isHydrating
          ? (popToNextHostParent(fiber),
            5 === fiber.tag &&
              null != fiber.stateNode &&
              (nextHydratableInstance = fiber.stateNode))
          : (popToNextHostParent(fiber), (isHydrating = !0)));
    default:
      unwindInterruptedWork(current, next);`;

describe("the React replay-cursor backport (react/react#37584)", () => {
  it.each([
    ['production', 'next'],
    ['development', 'unitOfWork'],
  ])('applies to the installed %s react-dom client, in the replay\'s HostComponent case', (build, fiber) => {
    const file = REACT_DOM(build);
    const source = readFileSync(file, 'utf8');
    expect(source, 'the installed React does not already carry the fix').not.toMatch(/=== hydrationParentFiber &&\s*\(\s*isHydrating/);
    const patched = applyReplayFix(source, file);
    const site = patched.search(new RegExp(`case 5:\\s*resetHooksOnUnwind\\(${fiber}\\);`));
    expect(site, "the replay's HostComponent case").not.toBe(-1);
    const after = patched.slice(site, site + 700);
    // Right after the hooks reset, before the fiber is reset and begun again,
    // exactly as React 19.3 does it.
    expect(between(after, `resetHooksOnUnwind(${fiber});`, MARKER)).toBe(`resetHooksOnUnwind(${fiber});\n`);
    const injected = between(after, MARKER, 'default:');
    expect(injected).toContain(`var replayedHostFiber = ${fiber};`);
    expect(injected).toMatch(/replayedHostFiber === hydrationParentFiber &&\s+\(isHydrating\s+\? \(popToNextHostParent\(replayedHostFiber\),\s+5 === replayedHostFiber\.tag &&\s+null != replayedHostFiber\.stateNode &&\s+\(nextHydratableInstance = replayedHostFiber\.stateNode\)\)\s+: \(popToNextHostParent\(replayedHostFiber\), \(isHydrating = !0\)\)\);/);
    expect(patched.length - source.length).toBeLessThan(500);
    expect(() => new Script(patched, { filename: file }), 'the patched React still parses').not.toThrow();
    expect(applyReplayFix(patched, file)).toBe(patched);
  });

  it('leaves a React that already carries the fix as it is', () => {
    expect(applyReplayFix(REACT_19_3_REPLAY)).toBe(REACT_19_3_REPLAY);
  });

  it('fails the build, not silently, when the React it expects is gone', () => {
    expect(() => applyReplayFix('function somethingElse() {}')).toThrow(/react\/react#37584/);
    expect(() => applyReplayFix('case 5: resetHooksOnUnwind(next);\ncase 5: resetHooksOnUnwind(next);')).toThrow(/exactly one/);
    expect(() => applyReplayFix('case 5: resetHooksOnUnwind(next);\ndefault:')).toThrow(/no longer defines/);
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
