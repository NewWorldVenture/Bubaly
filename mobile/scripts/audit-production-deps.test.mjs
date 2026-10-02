import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED, advisoryId, auditGate, reportProblem, runProblem, unexpectedAdvisories } from './audit-production-deps.mjs';

// Shapes are npm audit --json version 2 (npm 7+): an advisory object in `via`
// under the package it is in, and a plain package name in `via` for "depends on
// it". metadata.vulnerabilities counts the listed packages by severity.
const advisory = (id, severity, title = id) => ({ source: 1, name: 'x', title, url: `https://github.com/advisories/${id}`, severity, range: '<=1.0.0' });
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
function report(entries) {
  const vulnerabilities = Object.fromEntries(entries.map(([pkg, severity, via]) => [pkg, { name: pkg, severity, via }]));
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, entries.filter(([, sev]) => sev === s).length]));
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { ...counts, total: entries.length } } };
}
const RULE = { 'GHSA-aaaa-bbbb-cccc': { until: '2026-11-02', reason: 'test' } };
const run = (body, extra = {}) => ({ status: 1, signal: null, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '', ...extra });

// Today's mobile/ report, reduced: node-forge's high advisory reaches expo via
// @expo/code-signing-certificates and @expo/cli; uuid's moderate one via xcode.
const TODAY = report([
  ['node-forge', 'high', [advisory('GHSA-aaaa-bbbb-cccc', 'high', 'node-forge signature check')]],
  ['@expo/code-signing-certificates', 'high', ['node-forge']],
  ['@expo/cli', 'high', ['@expo/code-signing-certificates']],
  ['expo', 'high', ['@expo/cli']],
  ['uuid', 'moderate', [advisory('GHSA-w5hq-g745-h8pq', 'moderate')]],
  ['xcode', 'moderate', ['uuid']],
]);

test('an allowed advisory passes until its date, inclusive, through the whole gate', () => {
  assert.equal(auditGate(run(TODAY), '2026-10-02', RULE).ok, true);
  assert.equal(auditGate(run(TODAY), '2026-11-02', RULE).ok, true);
  assert.equal(auditGate(run(report([]), { status: 0 }), '2026-10-02', RULE).ok, true);
});

test('an allowed advisory fails again after its date', () => {
  const failing = unexpectedAdvisories(TODAY, '2026-11-03', RULE);
  assert.deepEqual(failing.map((f) => [f.id, f.expired]), [['GHSA-aaaa-bbbb-cccc', '2026-11-02']]);
  assert.equal(auditGate(run(TODAY), '2026-11-03', RULE).ok, false);
});

test('any other high or critical advisory fails, even in the same package', () => {
  const r = report([
    ['forge', 'high', [advisory('GHSA-aaaa-bbbb-cccc', 'high'), advisory('GHSA-dddd-eeee-ffff', 'high')]],
    ['other', 'critical', [advisory('GHSA-gggg-hhhh-iiii', 'critical')]],
  ]);
  assert.deepEqual(unexpectedAdvisories(r, '2026-10-02', RULE).map((f) => f.id), ['GHSA-dddd-eeee-ffff', 'GHSA-gggg-hhhh-iiii']);
  assert.equal(auditGate(run(r), '2026-10-02', RULE).ok, false);
});

test('moderate and low advisories, and "depends on" entries, do not fail the job', () => {
  const r = report([
    ['uuid', 'moderate', [advisory('GHSA-w5hq-g745-h8pq', 'moderate')]],
    ['decode', 'low', [advisory('GHSA-vcc3-ghjq-m6fr', 'low')]],
    ['expo', 'moderate', ['uuid', 'decode']],
  ]);
  assert.equal(auditGate(run(r), '2026-10-02', RULE).ok, true);
});

test('only a GitHub advisory URL identifies an advisory; a title or source never matches an exception', () => {
  assert.equal(advisoryId({ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }), 'GHSA-aaaa-bbbb-cccc');
  for (const via of [
    { title: 'GHSA-aaaa-bbbb-cccc', severity: 'high' },
    { source: 'GHSA-aaaa-bbbb-cccc', severity: 'high' },
    { source: 123, title: 'GHSA-aaaa-bbbb-cccc', severity: 'high' },
    { url: 'https://example.test/GHSA-aaaa-bbbb-cccc', severity: 'high' },
  ]) {
    assert.equal(advisoryId(via), null);
    const r = report([['forge', 'high', [via]]]);
    assert.equal(unexpectedAdvisories(r, '2026-10-02', RULE).length, 1, JSON.stringify(via));
    assert.equal(auditGate(run(r), '2026-10-02', RULE).ok, false, JSON.stringify(via));
  }
});

test('npm that did not run, was killed, or exited other than 0 or 1 fails, even with a clean-looking report', () => {
  for (const [extra, reason] of [
    [{ status: 2 }, /exited 2/],
    [{ status: null, signal: 'SIGTERM' }, /terminated by SIGTERM/],
    [{ status: 1, signal: 'SIGKILL' }, /terminated by SIGKILL/],
    [{ status: null, error: new Error('spawn npm ENOENT') }, /could not be run: spawn npm ENOENT/],
    [{ status: 1, error: new Error('spawnSync npm ETIMEDOUT') }, /could not be run/],
  ]) {
    assert.match(runProblem(run(report([]), extra)) ?? '', reason, JSON.stringify(extra));
    assert.equal(auditGate(run(report([]), extra), '2026-10-02', RULE).ok, false, JSON.stringify(extra));
  }
  assert.equal(runProblem(run(report([]), { status: 0 })), null);
  assert.equal(runProblem(run(TODAY)), null);
});

test('output that is not a complete version-2 report fails', () => {
  const missingTarget = report([['expo', 'high', ['missing-package']]]);
  const unjustified = report([['expo', 'high', ['uuid']], ['uuid', 'moderate', [advisory('GHSA-w5hq-g745-h8pq', 'moderate')]]]);
  const wrongCounts = structuredClone(TODAY);
  wrongCounts.metadata.vulnerabilities.high = 3;
  const zero = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const cases = [
    ['empty object', {}, /auditReportVersion/],
    ['vulnerabilities as an array with a high in metadata', { auditReportVersion: 2, vulnerabilities: [], metadata: { vulnerabilities: { ...zero, high: 1, total: 1 } } }, /not a map/],
    ['vulnerabilities as an empty array with zero counts', { auditReportVersion: 2, vulnerabilities: [], metadata: { vulnerabilities: zero } }, /not a map/],
    ['a dependency the report does not list', missingTarget, /does not list/],
    ['a moderate package whose dependency is not listed', report([['expo', 'moderate', ['missing-package']]]), /depends on missing-package, which the report does not list/],
    ['a high package with no high advisory beneath it', unjustified, /expo is high but reaches no high or critical advisory/],
    ['a high package that depends only on itself', report([['a', 'high', ['a']]]), /a is high but reaches no high or critical advisory/],
    ['a high cycle that reaches no advisory', report([['a', 'high', ['b']], ['b', 'high', ['a']]]), /reaches no high or critical advisory/],
    ['a high package whose only advisory is moderate', report([['a', 'high', [advisory('GHSA-w5hq-g745-h8pq', 'moderate')]]]), /a is high but reaches no high or critical advisory/],
    ['metadata that disagrees with the packages', wrongCounts, /metadata counts 3 high, the report lists 4/],
    ['a metadata total that disagrees', { ...TODAY, metadata: { vulnerabilities: { ...TODAY.metadata.vulnerabilities, total: 99 } } }, /metadata total is 99/],
    ['version 1', { ...TODAY, auditReportVersion: 1 }, /not 2/],
    ['no metadata', { auditReportVersion: 2, vulnerabilities: {} }, /metadata.vulnerabilities is missing/],
    ['an npm error object', { error: { code: 'ENOLOCK', summary: 'no lockfile' } }, /reported an error: no lockfile/],
    ['an advisory that is not an object', report([['expo', 'high', [42]]]), /malformed advisory/],
  ];
  for (const [label, body, reason] of cases) {
    assert.match(reportProblem(body) ?? '', reason, label);
    assert.equal(auditGate(run(body), '2026-10-02', RULE).ok, false, label);
  }
  assert.equal(auditGate(run('npm ERR! something'), '2026-10-02', RULE).ok, false, 'not JSON');
  assert.equal(reportProblem(TODAY), null);
});

test('a dependency cycle is judged by the advisory it reaches, not refused for being a cycle', () => {
  const cycle = (id) => report([['a', 'high', ['b']], ['b', 'high', ['a', 'forge']], ['forge', 'high', [advisory(id, 'high')]]]);
  assert.equal(reportProblem(cycle('GHSA-aaaa-bbbb-cccc')), null);
  assert.equal(auditGate(run(cycle('GHSA-aaaa-bbbb-cccc')), '2026-10-02', RULE).ok, true);
  assert.equal(auditGate(run(cycle('GHSA-dddd-eeee-ffff')), '2026-10-02', RULE).ok, false);
  // The cycle's own members can carry the advisory too.
  const selfAnchored = report([['a', 'high', ['b', advisory('GHSA-aaaa-bbbb-cccc', 'high')]], ['b', 'high', ['a']]]);
  assert.equal(auditGate(run(selfAnchored), '2026-10-02', RULE).ok, true);
});

test('every committed exception names one advisory, a real date and a reason', () => {
  for (const [id, rule] of Object.entries(ALLOWED)) {
    assert.match(id, /^GHSA(-[0-9a-z]{4}){3}$/);
    assert.match(rule.until, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${rule.until}T00:00:00Z`).toISOString().slice(0, 10), rule.until);
    assert.ok(rule.reason.length > 40, `${id} needs a reason`);
  }
});
