import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { collectAdvisories, evaluateAudit, reportProblem, runProblem } from '../scripts/audit-npm-advisories.mjs';

// The shape `npm audit --json` gave for mobile/ on 2026-10-02: one high
// advisory on node-forge, three packages high only through it, and moderates.
const forge = { source: 1, name: 'node-forge', dependency: 'node-forge', title: 'RSA PKCS#1 v1.5 signature verification', url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv', severity: 'high', range: '<=1.4.0' };
const uuid = { source: 2, name: 'uuid', dependency: 'uuid', title: 'Missing buffer bounds check', url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq', severity: 'moderate', range: '<11.1.1' };
type Entry = { name: string; severity: string; via: unknown[] };
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const completeReport = (vulnerabilities: Record<string, Entry>) => ({
  auditReportVersion: 2,
  vulnerabilities,
  metadata: { vulnerabilities: {
    ...Object.fromEntries(severities.map((severity) => [severity, Object.values(vulnerabilities).filter((entry) => entry.severity === severity).length])),
    total: Object.keys(vulnerabilities).length,
  } },
});

const report = (extra: Record<string, Entry> = {}) => completeReport({
    'node-forge': { name: 'node-forge', severity: 'high', via: [forge] },
    '@expo/code-signing-certificates': { name: '@expo/code-signing-certificates', severity: 'high', via: ['node-forge'] },
    '@expo/cli': { name: '@expo/cli', severity: 'high', via: ['@expo/code-signing-certificates', 'node-forge'] },
    expo: { name: 'expo', severity: 'high', via: ['@expo/cli'] },
    uuid: { name: 'uuid', severity: 'moderate', via: [uuid] },
    ...extra,
});
const ALLOW = { 'GHSA-86w9-cpqp-85rv': { package: 'node-forge', reason: 'no patched release' } };

const one = (name: string, severity: string, via: unknown[]) => completeReport({ [name]: { name, severity, via } });
const empty = () => completeReport({});
const malformed = [
  ['empty unversioned map', { vulnerabilities: {} }, /auditReportVersion/],
  ['high package without advisory details', one('x', 'high', []), /no via list/],
  ['unanchored self cycle', one('x', 'high', ['x']), /reaches no advisory/],
  ['unanchored two-package cycle', completeReport({ x: { name: 'x', severity: 'high', via: ['y'] }, y: { name: 'y', severity: 'high', via: ['x'] } }), /reaches no advisory/],
  ['missing dependency target', one('x', 'high', ['missing']), /does not list/],
  ['array vulnerability map', { ...empty(), vulnerabilities: [] }, /not a map/],
  ['metadata total mismatch', { ...empty(), metadata: { vulnerabilities: { ...empty().metadata.vulnerabilities, total: 1 } } }, /metadata total/],
  ['wrong report version', { ...empty(), auditReportVersion: 1 }, /not 2/],
  ['missing metadata', { auditReportVersion: 2, vulnerabilities: {} }, /metadata.vulnerabilities/],
  ['numeric advisory', one('x', 'high', [42]), /malformed advisory/],
  ['unknown advisory severity', one('x', 'high', [{ ...forge, severity: 'unknown' }]), /malformed advisory/],
  ['missing advisory package', one('x', 'high', [{ ...forge, name: undefined }]), /malformed advisory/],
  ['unknown package severity', one('x', 'unknown', [forge]), /known severity/],
  ['high package anchored only to a moderate advisory', one('x', 'high', [uuid]), /reaches no advisory/],
  ['severity count mismatch', { ...empty(), metadata: { vulnerabilities: { ...empty().metadata.vulnerabilities, high: 1 } } }, /metadata counts/],
  ['conflicting package details for one GHSA', one('x', 'high', [forge, { ...forge, name: 'other' }]), /inconsistent package or severity/],
  ['conflicting severity details for one GHSA', one('x', 'high', [{ ...forge, severity: 'moderate' }, forge]), /inconsistent package or severity/],
  ['npm report error', { error: { code: 'SYNTHETIC', summary: 'Synthetic report refused' } }, /Synthetic report refused/],
] as const;

describe('only complete reports can authorize the dependency audit', () => {
  it.each(malformed)('refuses %s', (_label, body, reason) => {
    expect(reportProblem(body, { level: 'high' })).toMatch(reason);
    expect(() => evaluateAudit(body, { level: 'high', allowlist: ALLOW })).toThrow(reason);
  });

  it.each(['moderate', 'high', 'critical'])('requires a real advisory anchor at the selected %s threshold', (level) => {
    expect(() => evaluateAudit(one('x', level, ['x']), { level, allowlist: ALLOW })).toThrow(/reaches no advisory/);
    const severity = level === 'critical' ? 'high' : 'low';
    expect(() => evaluateAudit(one('x', level, [{ ...forge, severity }]), { level, allowlist: ALLOW })).toThrow(/reaches no advisory/);
    expect(evaluateAudit(one('x', level, [{ ...forge, severity: level }]), { level, allowlist: ALLOW }).allowed).toHaveLength(1);
  });

  it('propagates through a reverse-ordered multi-hop chain to a fixed point', () => {
    const body = completeReport({
      a: { name: 'a', severity: 'high', via: ['b'] },
      b: { name: 'b', severity: 'high', via: ['c'] },
      c: { name: 'c', severity: 'high', via: ['node-forge'] },
      'node-forge': { name: 'node-forge', severity: 'high', via: [forge] },
    });
    expect(reportProblem(body, { level: 'high' })).toBeNull();
    expect(evaluateAudit(body, { level: 'high', allowlist: ALLOW }).blocking).toEqual([]);
  });

  it('judges anchored cycles by their advisory and preserves valid repeated receipts', () => {
    const body = completeReport({
      a: { name: 'a', severity: 'high', via: ['b', forge] },
      b: { name: 'b', severity: 'high', via: ['a', forge] },
    });
    expect(evaluateAudit(body, { level: 'high', allowlist: ALLOW }).allowed).toHaveLength(1);
    expect(evaluateAudit(body, { level: 'high' }).blocking).toHaveLength(1);
  });

  it('keeps low and moderate advisories below high and accepts a complete empty report', () => {
    expect(evaluateAudit(one('uuid', 'moderate', [uuid]), { level: 'high' }).blocking).toEqual([]);
    expect(evaluateAudit(one('uuid', 'low', [{ ...uuid, severity: 'low' }]), { level: 'high' }).blocking).toEqual([]);
    expect(evaluateAudit(empty(), { level: 'high' })).toEqual({ blocking: [], allowed: [], stale: [] });
  });
});

describe('only a canonical advisory URL can match a package-bound exception', () => {
  it.each([
    ['foreign URL', { ...forge, url: 'https://synthetic.invalid/GHSA-86w9-cpqp-85rv' }],
    ['source field without a URL', { ...forge, url: undefined, source: 'GHSA-86w9-cpqp-85rv' }],
    ['bare GHSA instead of a URL', { ...forge, url: 'GHSA-86w9-cpqp-85rv' }],
  ])('refuses a matching id supplied by %s', (_label, via) => {
    const result = evaluateAudit(one('node-forge', 'high', [via]), { level: 'high', allowlist: ALLOW });
    expect(result.blocking).toHaveLength(1);
    expect(result.allowed).toEqual([]);
    expect(result.stale).toEqual(['GHSA-86w9-cpqp-85rv']);
  });

  it('does not deduplicate an unidentified advisory behind an allowed one', () => {
    const result = evaluateAudit(one('node-forge', 'high', [forge, { ...forge, url: undefined, source: 'GHSA-86w9-cpqp-85rv' }]), { level: 'high', allowlist: ALLOW });
    expect(result.allowed).toHaveLength(1);
    expect(result.blocking).toHaveLength(1);
  });
});

type SyntheticRun = { status: number | null; signal: string | null; stdout: string; stderr: string; error?: { message: string } };
const goodRun = (): SyntheticRun => ({ status: 0, signal: null, stdout: JSON.stringify(empty()), stderr: '' });
const processErrors = [
  ['exit 2', { status: 2 }, /exited 2/],
  ['terminated command', { status: null, signal: 'SIGTERM' }, /terminated by SIGTERM/],
  ['launch error', { status: null, error: { message: 'Synthetic ENOENT' } }, /could not be run/],
  ['command error despite exit 1', { status: 1, error: { message: 'Synthetic timeout' } }, /could not be run/],
  ['missing process status', { status: null }, /exited null/],
] as const;

describe('the command result is checked before its clean-looking JSON', () => {
  it.each(processErrors)('refuses %s', (_label, extra, reason) => {
    expect(runProblem({ ...goodRun(), ...extra })).toMatch(reason);
  });

  const cases: { name: string; run: SyntheticRun; pass: boolean }[] = [
    { name: 'ordinary exit 0', run: goodRun(), pass: true },
    { name: 'ordinary exit 1 with an allowed advisory', run: { ...goodRun(), status: 1, stdout: JSON.stringify(report()) }, pass: true },
    { name: 'unrelated high advisory', run: { ...goodRun(), status: 1, stdout: JSON.stringify(one('other', 'high', [{ ...forge, name: 'other', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }])) }, pass: false },
    ...processErrors.map(([name, extra]) => ({ name, run: { ...goodRun(), ...extra }, pass: false })),
    { name: 'unreadable JSON', run: { ...goodRun(), status: 1, stdout: 'not JSON' }, pass: false },
    { name: 'npm report error', run: { ...goodRun(), status: 1, stdout: JSON.stringify({ error: { code: 'SYNTHETIC', summary: 'Synthetic report refused' } }) }, pass: false },
    { name: 'unversioned empty map', run: { ...goodRun(), status: 1, stdout: JSON.stringify({ vulnerabilities: {} }) }, pass: false },
    { name: 'unanchored self cycle', run: { ...goodRun(), status: 1, stdout: JSON.stringify(one('x', 'high', ['x'])) }, pass: false },
    { name: 'high package without an advisory', run: { ...goodRun(), status: 1, stdout: JSON.stringify(one('x', 'high', [])) }, pass: false },
    { name: 'false URL identity', run: { ...goodRun(), status: 1, stdout: JSON.stringify(one('node-forge', 'high', [{ ...forge, url: 'https://synthetic.invalid/GHSA-86w9-cpqp-85rv' }])) }, pass: false },
  ];

  it.each(cases)('actual CLI: $name uses exactly one inert npm boundary', ({ run, pass }) => {
    const directory = mkdtempSync(join(tmpdir(), 'bubaly-audit-gate-'));
    try {
      const fixture = join(directory, 'run.json');
      const receipt = join(directory, 'receipt.json');
      const rules = join(directory, 'allowlist.json');
      const preload = join(directory, 'npm.cjs');
      writeFileSync(fixture, JSON.stringify(run));
      writeFileSync(rules, JSON.stringify({ advisories: ALLOW }));
      writeFileSync(preload, `
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const data = JSON.parse(fs.readFileSync(process.env.SYNTHETIC_AUDIT_CASE, 'utf8'));
let calls = 0;
const denied = () => { throw new Error('Synthetic audit forbids other process or network'); };
cp.spawnSync = (command, args) => {
  if (command !== 'npm' || args[0] !== 'audit' || !args.includes('--json') || ++calls !== 1) denied();
  const result = { ...data };
  if (result.error) result.error = new Error(result.error.message);
  return result;
};
for (const name of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = denied;
globalThis.fetch = denied;
for (const name of ['node:http', 'node:https']) { const mod = require(name); mod.request = denied; mod.get = denied; }
syncBuiltinESMExports();
process.on('exit', () => { fs.writeFileSync(process.env.SYNTHETIC_AUDIT_RECEIPT, JSON.stringify({ calls, inert: true })); if (calls !== 1) process.exitCode = 97; });
`);
      const safeNames = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'comspec']);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => safeNames.has(key.toLowerCase())));
      const result = spawnSync(process.execPath, ['--require', preload, resolve('scripts/audit-npm-advisories.mjs'), '--omit=dev', '--audit-level=high', `--allowlist=${rules}`], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...env, NODE_ENV: 'test', TZ: 'UTC', SYNTHETIC_AUDIT_CASE: fixture, SYNTHETIC_AUDIT_RECEIPT: receipt },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ calls: 1, inert: true });
      expect(result.status, result.stderr).toBe(pass ? 0 : 1);
      if (pass) expect(result.stdout).toContain('Dependency audit passed');
      else expect(result.stdout).not.toContain('Dependency audit passed');
    } finally {
      const target = resolve(directory);
      expect(target.startsWith(resolve(tmpdir()) + sep)).toBe(true);
      expect(basename(target).startsWith('bubaly-audit-gate-')).toBe(true);
      rmSync(target, { recursive: true, force: true });
    }
  });
});

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
    const r = completeReport({ other: { name: 'other', severity: 'high', via: [{ ...forge, name: 'other' }] } });
    expect(evaluateAudit(r, { level: 'high', allowlist: ALLOW }).blocking).toHaveLength(1);
  });

  it('a new high advisory elsewhere fails; moderates stay below the level', () => {
    const tar = { source: 4, name: 'tar', title: 'path traversal', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'critical', range: '<7' };
    const result = evaluateAudit(report({ tar: { name: 'tar', severity: 'critical', via: [tar] } }), { level: 'high', allowlist: ALLOW });
    expect(result.blocking.map((a) => a.package)).toEqual(['tar']);
  });

  it('flags an entry the audit no longer reports, so it gets removed', () => {
    const fixed = completeReport({ uuid: { name: 'uuid', severity: 'moderate', via: [uuid] } });
    expect(evaluateAudit(fixed, { level: 'high', allowlist: ALLOW }).stale).toEqual(['GHSA-86w9-cpqp-85rv']);
  });

  it('fails closed when npm returns an error or no report', () => {
    expect(() => evaluateAudit({ error: { code: 'ENOAUDIT', summary: 'registry unreachable' } }, { level: 'high' })).toThrow(/registry unreachable/);
    expect(() => evaluateAudit(undefined, { level: 'high' })).toThrow();
    expect(() => evaluateAudit(report(), { level: 'severe' })).toThrow(/Unknown audit level/);
  });
});
