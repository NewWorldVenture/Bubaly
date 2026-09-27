// A build-time backport of React's fix for react/react#37584 into the React
// that Next 15.5 bundles (19.2.0-canary-0bdb9206 in 15.5.25 and 15.5.26).
//
// The bug: when a host element (a <div>, an <svg>'s parent) suspends during
// hydration on a time-sliced render — its children include a React Server
// Components chunk that has not arrived yet — React replays that element. The
// first attempt had already claimed the element's DOM node and moved the
// hydration cursor inside it; the replay does not move it back, so it tries to
// claim the element against its own first child and throws React #418
// ("Hydration failed because the server rendered HTML didn't match the
// client") on a tree that is identical. React then discards the server HTML
// and renders the whole boundary again.
//
// The page audit found it on about 0.7% of signed-in loads under load, a
// different page each time. An instrumented build showed the same shape in 7 of
// 7 hits: React hydrating an element while its cursor pointed at that
// element's own first child (an <svg>, an <h1>, a <nav>).
//
// The fix is React's own, as React 19.3 ships it (and so as Next 16 bundles
// it): when the replayed host fiber is the current hydration parent, put the
// parent back on its host parent and the cursor back on the fiber's node, or,
// if hydration had been suspended for an insertion below it, resume it. It
// goes where React put it, in the replay's HostComponent case, and calls only
// hydration helpers that are identical in 19.2 and 19.3.
//
// A React that already carries the fix (Next 16's) is left as it is. A React
// this does not recognise fails the build rather than being skipped, so an
// upgrade is a prompt to check the fix and remove this loader and its rule in
// next.config.mjs.

const MARKER = '/* bubaly: react/react#37584, as React 19.3 ships it */';
// The replay's HostComponent case: `case 5: resetHooksOnUnwind(<fiber>);`.
// The production build calls the replayed fiber `next`, the development build
// `unitOfWork`.
const SITE = /case 5:\s*resetHooksOnUnwind\((\w+)\);/g;
// What React 19.3 has right after that site.
const ALREADY_FIXED = /^\s*(?:var \w+ = \w+;\s*)?\w+ === hydrationParentFiber &&\s*\(\s*isHydrating\s*\?\s*\(\s*popToNextHostParent\(/;
// Identifiers the fix uses; each must be declared in the file it is injected
// into (the production and development builds declare them in differently
// shaped var lists, so these match the declaration, not a line).
const REQUIRED = [
  ['hydrationParentFiber', /\bhydrationParentFiber\s*=\s*null\b/],
  ['nextHydratableInstance', /\bnextHydratableInstance\s*=\s*null\b/],
  ['isHydrating', /\bisHydrating\s*=\s*!1\b/],
  ['popToNextHostParent', /function popToNextHostParent\(fiber\)/],
];

function fix(fiber) {
  return [
    '',
    MARKER,
    `var replayedHostFiber = ${fiber};`,
    'replayedHostFiber === hydrationParentFiber &&',
    '  (isHydrating',
    '    ? (popToNextHostParent(replayedHostFiber),',
    '      5 === replayedHostFiber.tag &&',
    '        null != replayedHostFiber.stateNode &&',
    '        (nextHydratableInstance = replayedHostFiber.stateNode))',
    '    : (popToNextHostParent(replayedHostFiber), (isHydrating = !0)));',
  ].join('\n');
}

function applyReplayFix(source, file = 'react-dom-client') {
  if (source.includes(MARKER)) return source;
  const sites = [...source.matchAll(SITE)];
  if (sites.length !== 1) {
    throw new Error(
      `react-hydration-replay-fix: expected exactly one "case 5: resetHooksOnUnwind(…);" in ${file}, found ${sites.length}. ` +
      'Next\'s bundled React has changed: check whether it already fixes react/react#37584 ' +
      'and, if so, remove scripts/react-hydration-replay-fix.cjs and its rule in next.config.mjs.',
    );
  }
  const [site] = sites;
  const end = site.index + site[0].length;
  if (ALREADY_FIXED.test(source.slice(end, end + 400))) return source;
  const missing = REQUIRED.filter(([, declared]) => !declared.test(source)).map(([name]) => name);
  if (missing.length) {
    throw new Error(`react-hydration-replay-fix: ${file} no longer defines ${missing.join(', ')}; the fix cannot be applied safely.`);
  }
  return `${source.slice(0, end)}${fix(site[1])}${source.slice(end)}`;
}

module.exports = function reactHydrationReplayFix(source) {
  return applyReplayFix(source, this && this.resourcePath);
};
module.exports.applyReplayFix = applyReplayFix;
module.exports.MARKER = MARKER;
