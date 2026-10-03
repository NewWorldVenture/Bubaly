import { describe, expect, it } from 'vitest';
import { collectAdvisories, evaluateAudit } from '../scripts/audit-npm-advisories.mjs';

// The shape `npm audit --json` gave for mobile/ on 2026-10-02: one high
// advisory on node-forge, three packages high only through it, and moderates.
const forge = { source: 1, name: 'node-forge', dependency: 'node-forge', title: 'RSA PKCS#1 v1.5 signature verification', url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv', severity: 'high', range: '<=1.4.0' };
const uuid = { source: 2, name: 'uuid', dependency: 'uuid', title: 'Missing buffer bounds check', url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq', severity: 'moderate', range: '<11.1.1' };
const report = (extra: Record<string, unknown> = {}) => ({
  vulnerabilities: {
    'node-forge': { name: 'node-forge', severity: 'high', via: [forge] },
    '@expo/code-signing-certificates': { name: '@expo/code-signing-certificates', severity: 'high', via: ['node-forge'] },
    '@expo/cli': { name: '@expo/cli', severity: 'high', via: ['@expo/code-signing-certificates', 'node-forge'] },
    expo: { name: 'expo', severity: 'high', via: ['@expo/cli'] },
    uuid: { name: 'uuid', severity: 'moderate', via: [uuid] },
    ...extra,
  },
});
const ALLOW = { 'GHSA-86w9-cpqp-85rv': { package: 'node-forge', reason: 'no patched release' } };

describe('the mobile dependency audit accepts one advisory by id, nothing more', () => {
  it('counts advisories, not the packages that are high only through them', () => {
    expect(collectAdvisories(report()).map((a) => a.id).sort()).toEqual(['GHSA-86w9-cpqp-85rv', 'GHSA-w5hq-g745-h8pq']);
  });

  it('without the allowlist, the node-forge advisory fails at high', () => {
    expect(evaluateAudit(report(), { level: 'high' }).blocking.map((a) => a.id)).toEqual(['GHSA-86w9-cpqp-85rv']);
  });

  it('with it, the audit passes and still names what it accepted', () => {
    const result = evaluateAudit(report(), { level: 'high', allowlist: ALLOW });
    expect(result.blocking).toEqual([]);
    expect(result.allowed.map((a) => a.id)).toEqual(['GHSA-86w9-cpqp-85rv']);
  });

  it('a new high advisory on the same package still fails', () => {
    const second = { ...forge, source: 3, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'another' };
    const r = report({ 'node-forge': { name: 'node-forge', severity: 'high', via: [forge, second] } });
    expect(evaluateAudit(r, { level: 'high', allowlist: ALLOW }).blocking.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('an allowlisted id reported against a different package is not accepted', () => {
    const r = { vulnerabilities: { other: { name: 'other', severity: 'high', via: [{ ...forge, name: 'other' }] } } };
    expect(evaluateAudit(r, { level: 'high', allowlist: ALLOW }).blocking).toHaveLength(1);
  });

  it('a new high advisory elsewhere fails; moderates stay below the level', () => {
    const tar = { source: 4, name: 'tar', title: 'path traversal', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'critical', range: '<7' };
    const result = evaluateAudit(report({ tar: { name: 'tar', severity: 'critical', via: [tar] } }), { level: 'high', allowlist: ALLOW });
    expect(result.blocking.map((a) => a.package)).toEqual(['tar']);
  });

  it('flags an entry the audit no longer reports, so it gets removed', () => {
    const fixed = { vulnerabilities: { uuid: { name: 'uuid', severity: 'moderate', via: [uuid] } } };
    expect(evaluateAudit(fixed, { level: 'high', allowlist: ALLOW }).stale).toEqual(['GHSA-86w9-cpqp-85rv']);
  });

  it('fails closed when npm returns an error or no report', () => {
    expect(() => evaluateAudit({ error: { code: 'ENOAUDIT', summary: 'registry unreachable' } }, { level: 'high' })).toThrow(/registry unreachable/);
    expect(() => evaluateAudit(undefined, { level: 'high' })).toThrow();
    expect(() => evaluateAudit(report(), { level: 'severe' })).toThrow(/Unknown audit level/);
  });
});
