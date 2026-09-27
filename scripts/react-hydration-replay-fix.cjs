// A build-time backport of the upstream fix for react/react#37584 into the
// React that Next 15.5 bundles (19.2.0-canary-0bdb9206 in 15.5.25 and 15.5.26).
//
// The bug: when a host element (a <div>, an <svg>'s parent) suspends during
// hydration on a time-sliced render — its children include a React Server
// Components chunk that has not arrived yet — React replays that element with
// replaySuspendedUnitOfWork. The first attempt had already claimed the
// element's DOM node and moved the hydration cursor inside it; the replay does
// not move it back, so it tries to claim the element against its own first
// child and throws React #418 ("Hydration failed because the server rendered
// HTML didn't match the client") on a tree that is identical. React then
// discards the server HTML and renders the whole boundary again.
//
// The page audit found it on about 0.7% of signed-in loads under load, a
// different page each time. An instrumented build showed the same shape in 7 of
// 7 hits: React hydrating an element while its cursor pointed at that
// element's own first child (an <svg>, an <h1>, a <nav>).
//
// The fix is the upstream one: before replaying a host fiber that is the
// current hydration parent and has claimed a node, put the cursor back on that
// node and the parent back on its host parent, so the replay claims the same
// node again.
//
// If Next's bundled React changes shape (an upgrade), this loader fails the
// build rather than skipping silently. When that happens, check whether the
// new React already contains the fix for react/react#37584; if it does, remove
// this loader and its rule in next.config.mjs.

const ANCHOR = 'function replaySuspendedUnitOfWork(unitOfWork) {';
const MARKER = '/* bubaly: react/react#37584 replay cursor rewind */';
const REWIND = [
  MARKER,
  '  if (',
  '    isHydrating &&',
  '    hydrationParentFiber === unitOfWork &&',
  '    null !== unitOfWork.stateNode &&',
  '    (5 === unitOfWork.tag || 26 === unitOfWork.tag)',
  '  ) {',
  '    nextHydratableInstance = unitOfWork.stateNode;',
  '    popToNextHostParent(unitOfWork);',
  '  }',
].join('\n');
// Identifiers the rewind uses; each must be declared in the file it is
// injected into (the production and development builds declare them in
// differently shaped var lists, so these match the declaration, not a line).
const REQUIRED = [
  ['hydrationParentFiber', /\bhydrationParentFiber\s*=\s*null\b/],
  ['nextHydratableInstance', /\bnextHydratableInstance\s*=\s*null\b/],
  ['isHydrating', /\bisHydrating\s*=\s*!1\b/],
  ['popToNextHostParent', /function popToNextHostParent\(fiber\)/],
];

function applyReplayFix(source, file = 'react-dom-client') {
  if (source.includes(MARKER)) return source;
  const at = source.indexOf(ANCHOR);
  if (at === -1 || source.indexOf(ANCHOR, at + 1) !== -1) {
    throw new Error(
      `react-hydration-replay-fix: expected exactly one "${ANCHOR}" in ${file}. ` +
      'Next\'s bundled React has changed: check whether it already fixes react/react#37584 ' +
      'and, if so, remove scripts/react-hydration-replay-fix.cjs and its rule in next.config.mjs.',
    );
  }
  const missing = REQUIRED.filter(([, declared]) => !declared.test(source)).map(([name]) => name);
  if (missing.length) {
    throw new Error(`react-hydration-replay-fix: ${file} no longer defines ${missing.join(', ')}; the rewind cannot be applied safely.`);
  }
  const end = at + ANCHOR.length;
  return `${source.slice(0, end)}\n${REWIND}${source.slice(end)}`;
}

module.exports = function reactHydrationReplayFix(source) {
  return applyReplayFix(source, this && this.resourcePath);
};
module.exports.applyReplayFix = applyReplayFix;
module.exports.MARKER = MARKER;
