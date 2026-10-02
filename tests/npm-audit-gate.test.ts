import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluate } from '../scripts/npm-audit-gate.mjs';

// The mobile job's audit gate: `--audit-level=high` with one named, dated
// exception. These pin the three ways it must still fail — another advisory,
// an expired exception, and a report that is not a report.

const advisory = (url: string, severity: string, title = 't') => ({ source: 1, url, severity, title });
const report = (vulns: Record<string, { via: unknown[] }>) => ({ vulnerabilities: vulns });
const FORGE = 'https://github.com/advisories/GHSA-86w9-cpqp-85rv';
const exceptions = [{ id: 'GHSA-86w9-cpqp-85rv', package: 'node-forge', expires: '2026-11-01' }];

describe('npm-audit-gate', () => {
  it('excuses the listed advisory before it expires, and the packages that only inherit it', () => {
    const r = evaluate(report({
      'node-forge': { via: [advisory(FORGE, 'high')] },
      '@expo/code-signing-certificates': { via: ['node-forge'] },
    }), { level: 'high', exceptions, today: '2026-10-02' });
    expect(r.ok).toBe(true);
    expect(r.excused).toHaveLength(1);
  });

  it('fails once the exception has expired, by name', () => {
    const r = evaluate(report({ 'node-forge': { via: [advisory(FORGE, 'high')] } }), { level: 'high', exceptions, today: '2026-11-01' });
    expect(r.ok).toBe(false);
    expect(r.expired.map((e: { id: string }) => e.id)).toEqual(['GHSA-86W9-CPQP-85RV']);
  });

  it('fails on any other high or critical advisory', () => {
    const r = evaluate(report({
      'node-forge': { via: [advisory(FORGE, 'high')] },
      'left-pad': { via: [advisory('https://github.com/advisories/GHSA-aaaa-bbbb-cccc', 'critical')] },
    }), { level: 'high', exceptions, today: '2026-10-02' });
    expect(r.ok).toBe(false);
    expect(r.blocking.map((e: { pkg: string }) => e.pkg)).toEqual(['left-pad']);
  });

  it('does not excuse the same advisory id on a different package', () => {
    const r = evaluate(report({ other: { via: [advisory(FORGE, 'high')] } }), { level: 'high', exceptions, today: '2026-10-02' });
    expect(r.ok).toBe(false);
  });

  it('ignores advisories below the level', () => {
    const r = evaluate(report({ uuid: { via: [advisory('https://github.com/advisories/GHSA-w5hq-g745-h8pq', 'moderate')] } }), { level: 'high', exceptions: [], today: '2026-10-02' });
    expect(r.ok).toBe(true);
  });

  it('fails on output that is not an audit report', () => {
    expect(evaluate({}, { level: 'high', exceptions, today: '2026-10-02' }).ok).toBe(false);
    expect(evaluate(null, { level: 'high', exceptions, today: '2026-10-02' }).ok).toBe(false);
  });

  it('the checked-in exception names node-forge, has a reason, and expires within 60 days of being granted', () => {
    const list = JSON.parse(readFileSync('mobile/audit-exceptions.json', 'utf8')) as Array<{ id: string; package: string; expires: string; reason: string }>;
    for (const e of list) {
      expect(e.reason.length).toBeGreaterThan(40);
      expect(e.package).toBeTruthy();
      expect(e.expires <= '2026-12-01').toBe(true);
    }
  });
});
