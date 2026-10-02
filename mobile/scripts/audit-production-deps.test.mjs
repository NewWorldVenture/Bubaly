import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED, unexpectedAdvisories } from './audit-production-deps.mjs';

// Shapes are npm audit --json (npm 7+): an advisory object in `via` under the
// package it is in, and a plain package name in `via` for "depends on it".
const advisory = (id, severity, title = id) => ({ source: 1, name: 'x', title, url: `https://github.com/advisories/${id}`, severity, range: '<=1.0.0' });
const report = (entries) => ({ vulnerabilities: Object.fromEntries(entries.map(([pkg, via]) => [pkg, { name: pkg, via }])) });
const RULE = { 'GHSA-aaaa-bbbb-cccc': { until: '2026-11-02', reason: 'test' } };

test('an allowed advisory passes until its date, inclusive', () => {
  const r = report([['forge', [advisory('GHSA-aaaa-bbbb-cccc', 'high')]], ['cli', ['forge']]]);
  assert.deepEqual(unexpectedAdvisories(r, '2026-10-02', RULE), []);
  assert.deepEqual(unexpectedAdvisories(r, '2026-11-02', RULE), []);
});

test('an allowed advisory fails again after its date', () => {
  const r = report([['forge', [advisory('GHSA-aaaa-bbbb-cccc', 'high')]]]);
  const failing = unexpectedAdvisories(r, '2026-11-03', RULE);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].id, 'GHSA-aaaa-bbbb-cccc');
  assert.equal(failing[0].expired, '2026-11-02');
});

test('any other high or critical advisory fails, even in the same package', () => {
  const r = report([
    ['forge', [advisory('GHSA-aaaa-bbbb-cccc', 'high'), advisory('GHSA-dddd-eeee-ffff', 'high')]],
    ['other', [advisory('GHSA-gggg-hhhh-iiii', 'critical')]],
  ]);
  assert.deepEqual(unexpectedAdvisories(r, '2026-10-02', RULE).map((f) => f.id), ['GHSA-dddd-eeee-ffff', 'GHSA-gggg-hhhh-iiii']);
});

test('moderate and low advisories, and "depends on" entries, do not fail the job', () => {
  const r = report([
    ['uuid', [advisory('GHSA-w5hq-g745-h8pq', 'moderate')]],
    ['decode', [advisory('GHSA-vcc3-ghjq-m6fr', 'low')]],
    ['expo', ['uuid', 'decode']],
  ]);
  assert.deepEqual(unexpectedAdvisories(r, '2026-10-02', RULE), []);
});

test('an advisory without a GHSA url is never matched by an exception', () => {
  const r = report([['forge', [{ source: 123, title: 'GHSA-aaaa-bbbb-cccc', severity: 'high' }]]]);
  assert.equal(unexpectedAdvisories(r, '2026-10-02', RULE).length, 1);
});

test('every committed exception names one advisory, a real date and a reason', () => {
  for (const [id, rule] of Object.entries(ALLOWED)) {
    assert.match(id, /^GHSA(-[0-9a-z]{4}){3}$/);
    assert.match(rule.until, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${rule.until}T00:00:00Z`).toISOString().slice(0, 10), rule.until);
    assert.ok(rule.reason.length > 40, `${id} needs a reason`);
  }
});
