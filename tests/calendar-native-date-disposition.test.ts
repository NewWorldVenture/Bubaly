import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { classifyNativeCalendarDates, MAX_INPUT_BYTES, MAX_ROWS } from '../scripts/classify-native-calendar-dates.mjs';

const FAMILY = '10000000-0000-4000-8000-000000000001';
const script = resolve('scripts/classify-native-calendar-dates.mjs');
const own = mkdtempSync(join(tmpdir(), 'bubaly-native-date-disposition-'));
afterAll(() => rmSync(own, { recursive: true, force: true }));
function row(index = 1, patch: Record<string, unknown> = {}) {
  return {
    id: '20000000-0000-4000-8000-' + index.toString(16).padStart(12, '0'), family_id: FAMILY,
    title: 'PRIVATE-TITLE-SENTINEL', description: 'PRIVATE-DESCRIPTION-SENTINEL', location: null,
    category: 'general', starts_at: '2026-10-08T00:00:00Z', ends_at: '2026-10-09T00:00:00Z', all_day: true,
    recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
    created_by: null, onboarding_key: null, idempotency_key: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...patch,
  };
}
const inventory = (rows: unknown[], patch: Record<string, unknown> = {}) =>
  ({ version: 1, familyId: FAMILY, declaredRowCount: rows.length, rows, ...patch });
const classify = (rows: unknown[], patch: Record<string, unknown> = {}) =>
  classifyNativeCalendarDates(JSON.stringify(inventory(rows, patch)));
function minimal(index: number) {
  const full = row(index);
  return Object.fromEntries(['id', 'family_id', 'starts_at', 'ends_at', 'all_day', 'feed_id', 'external_uid', 'onboarding_key']
    .map(key => [key, full[key as keyof typeof full]]));
}
// Extract actual private admission functions; no runtime export or formatter stand-in.
function actualQualifier() {
  const tree = ts.createSourceFile('search.ts', readFileSync('lib/services/calendar/search-occurrences.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const parts = tree.statements.filter(node =>
    ts.isFunctionDeclaration(node) && ['strictInstant', 'nullableText', 'qualifyNativeRow'].includes(node.name?.text ?? '')
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'CATEGORIES'))
    .map(node => node.getText(tree));
  expect(parts).toHaveLength(4);
  const dates = ts.createSourceFile('date.ts', readFileSync('lib/onboarding/ics-time.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const validDay = dates.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'validDay');
  expect(validDay).toBeDefined();
  parts.unshift(validDay!.getText(dates).replace(/^export /, ''));
  const compiled = ts.transpileModule(parts.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(compiled + '\nqualifyNativeRow;', { Date }) as (value: unknown, family: string) => void;
}
const qualify = actualQualifier();
const cases: [string, Record<string, unknown>, string][] = [
  ['canonical', {}, 'canonical_native_date'],
  ['null end', { ends_at: null }, 'canonical_native_date_null_end'],
  ['multiday', { ends_at: '2026-10-11T00:00:00Z' }, 'canonical_native_date'],
  ['onboarding provenance unresolved', { onboarding_key: 'legacy-copy' }, 'canonical_native_date'],
  ['valid leap', { starts_at: '2028-02-29T00:00:00Z', ends_at: '2028-03-01T00:00:00Z' }, 'canonical_native_date'],
  ['spring DST', { starts_at: '2026-03-08T00:00:00Z', ends_at: '2026-03-09T00:00:00Z' }, 'canonical_native_date'],
  ['fall DST', { starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-11-02T00:00:00Z' }, 'canonical_native_date'],
  ['same-prefix offset', { starts_at: '2026-10-08T09:00:00+09:00', ends_at: '2026-10-09T09:00:00+09:00' }, 'canonical_native_date'],
  ['zero padded DATE precision', { starts_at: '2026-10-08T00:00:00.000000000Z' }, 'canonical_native_date'],
  ['zero padded timed precision', { all_day: false, starts_at: '2026-10-08T00:00:00.123000Z', ends_at: '2026-10-08T00:00:00.124000Z' }, 'native_timed'],
  ['different-prefix midnight', { starts_at: '2026-10-07T19:00:00-05:00', ends_at: '2026-10-08T19:00:00-05:00' }, 'review_noncanonical_date_boundary'],
  ['NY midnight', { starts_at: '2026-10-08T04:00:00Z', ends_at: '2026-10-09T04:00:00Z' }, 'review_noncanonical_date_boundary'],
  ['Tokyo midnight', { starts_at: '2026-10-07T15:00:00Z', ends_at: '2026-10-08T15:00:00Z' }, 'review_noncanonical_date_boundary'],
  ['fractional midnight', { starts_at: '2026-10-08T00:00:00.001Z' }, 'review_noncanonical_date_boundary'],
  ['equal end', { ends_at: '2026-10-08T00:00:00Z' }, 'review_equal_date_boundary'],
  ['reverse end', { ends_at: '2026-10-07T00:00:00Z' }, 'review_reversed_interval'],
  ['invalid leap', { starts_at: '2026-02-29T00:00:00Z' }, 'review_invalid_clock'],
  ['year zero', { starts_at: '0000-10-08T00:00:00Z' }, 'review_invalid_clock'],
  ['hour overflow', { starts_at: '2026-10-08T24:00:00Z' }, 'review_invalid_clock'],
  ['minute overflow', { starts_at: '2026-10-08T00:60:00Z' }, 'review_invalid_clock'],
  ['offset overflow', { starts_at: '2026-10-08T00:00:00+24:00' }, 'review_invalid_clock'],
  ['no zone', { starts_at: '2026-10-08T00:00:00' }, 'review_invalid_clock'],
  ['precision overflow', { starts_at: '2026-10-08T00:00:00.0000000000Z' }, 'review_invalid_clock'],
  ['wrong end type', { ends_at: 0 }, 'review_invalid_clock'],
  ['wrong start type', { starts_at: null }, 'review_invalid_clock'],
  ['timed healthy', { all_day: false, starts_at: '2026-10-08T14:00:00Z', ends_at: '2026-10-08T15:00:00Z' }, 'native_timed'],
  ['timed point', { all_day: false, ends_at: '2026-10-08T00:00:00Z' }, 'native_timed'],
  ['timed null end', { all_day: false, ends_at: null }, 'native_timed_null_end'],
  ['monthly master', { recurrence: 'monthly', starts_at: '2026-10-08T04:00:00Z', ends_at: '2026-10-09T04:00:00Z' }, 'review_noncanonical_date_boundary'],
];
describe('offline native DATE inventory', () => {
  it.each(cases)('%s matches actual private admission and preserves input', (_name, patch, expected) => {
    const value = row(1, patch), before = JSON.stringify(value);
    expect(classify([value]).rows).toEqual([{ index: 0, reason: expected }]);
    if (expected.startsWith('review_')) expect(() => qualify(value, FAMILY)).toThrow();
    else expect(() => qualify(value, FAMILY)).not.toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });
  it('reports counts/indexes only, never private payload or inferred repairs', () => {
    const result = classify([row(), row(2, { starts_at: '2026-10-08T04:00:00Z' }), row(3, { all_day: false })]);
    expect(result.rows).toEqual([{ index: 0, reason: 'canonical_native_date' }, { index: 1, reason: 'review_noncanonical_date_boundary' }, { index: 2, reason: 'native_timed' }]);
    expect(result.declaredRowCount).toBe(3);
    expect(Object.values(result.counts).reduce((sum: number, count) => sum + Number(count), 0)).toBe(3);
    expect(result.scope).toBe('caller-declared-inventory-only');
    expect(result.provenance).toBe('not-verified');
    expect(result.qualification).toBe('date-representation-only-not-full-calendar-row-admission');
    expect(result.nullEndPolicy).toBe('canonical-native-date-null-end-uses-reader-single-day-policy');
    for (const value of [FAMILY, row().id, row().starts_at, row().title, row().description]) expect(JSON.stringify(result)).not.toContain(value!);
  });
  it.each([{ feed_id: FAMILY }, { external_uid: 'owned-UID' }, { feed_id: FAMILY, external_uid: 'owned-UID', source_recurrence: { opaque: 'unqualified' } }])(
    'holds source-linked input without interpreting clocks or payload %j', patch => {
      expect(classify([row(1, { ...patch, starts_at: 'invalid clock' })]).rows).toEqual([{ index: 0, reason: 'source_linked_held' }]);
    });
  it('same instant has two possible original midnight dates, without a proposed date', () => {
    const clock = new Date('2026-10-08T10:00:00Z');
    const local = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(clock);
    expect(local('Pacific/Honolulu')).toMatch(/2026-10-08.*00:00/);
    expect(local('Pacific/Kiritimati')).toMatch(/2026-10-09.*00:00/);
    expect(classify([row(1, { starts_at: clock.toISOString(), ends_at: null })]).rows).toEqual([{ index: 0, reason: 'review_noncanonical_date_boundary' }]);
  });
  it.each([
    { starts_at: '2026-10-08T00:00:00.000001Z', ends_at: null },
    { ends_at: '2026-10-09T00:00:00.000001Z' },
    { all_day: false, starts_at: '2026-10-08T14:00:00.000002Z', ends_at: '2026-10-08T14:00:00.000001Z' },
    { all_day: false, starts_at: '2026-10-08T14:00:00.000001Z', ends_at: '2026-10-08T14:00:00.000002Z' },
  ])('conservatively reviews submillisecond clocks that the actual runtime parser admits %j', patch => {
    const value = row(1, patch), before = JSON.stringify(value);
    expect(() => qualify(value, FAMILY)).not.toThrow();
    expect(classify([value]).rows).toEqual([{ index: 0, reason: 'review_submillisecond_precision' }]);
    expect(JSON.stringify(value)).toBe(before);
  });
  it('does not interpret submillisecond source clocks under the source hold', () => {
    expect(classify([row(1, { feed_id: FAMILY, starts_at: '2026-10-08T00:00:00.000001Z' })]).rows)
      .toEqual([{ index: 0, reason: 'source_linked_held' }]);
  });
  it('admits exact finite ceilings and refuses the next byte/row', () => {
    expect(classify([]).rows).toEqual([]);
    expect(classify(Array.from({ length: MAX_ROWS }, (_, index) => minimal(index + 1))).rows).toHaveLength(MAX_ROWS);
    expect(() => classify(Array.from({ length: MAX_ROWS + 1 }, (_, index) => minimal(index + 1)))).toThrow('invalid_inventory');
    const text = JSON.stringify(inventory([]));
    expect(classifyNativeCalendarDates(text + ' '.repeat(MAX_INPUT_BYTES - Buffer.byteLength(text))).declaredRowCount).toBe(0);
    expect(() => classifyNativeCalendarDates(text + ' '.repeat(MAX_INPUT_BYTES - Buffer.byteLength(text) + 1))).toThrow('input_size');
  });
  it.each([{ declaredRowCount: undefined }, { declaredRowCount: 2 }, { declaredRowCount: -1 }, { declaredRowCount: 1.5 }, { declaredRowCount: MAX_ROWS + 1 }, { version: 2 }, { familyId: 'private-family' }, { endpoint: 'https://private.invalid' }])(
    'refuses invalid declared inventory %j', patch => expect(() => classify([row()], patch)).toThrow());
  it.each([{ id: 'private-id' }, { family_id: 'private-family' }, { family_id: '10000000-0000-4000-8000-000000000002' }, { all_day: null }, { feed_id: undefined }, { feed_id: 'private-feed' }, { external_uid: '' }, { external_uid: 'x'.repeat(4097) }, { onboarding_key: undefined }, { onboarding_key: 1 }, { onboarding_key: 'x'.repeat(4097) }, { source_recurrence: true }, { source_recurrence: [] }, { source_recurrence: {} }, { feed_id: FAMILY, source_recurrence: {} }])(
    'refuses malformed later envelope before classification %j', patch => expect(() => classify([row(), row(2, patch)])).toThrow());
  it('refuses case-insensitive duplicate IDs', () => {
    const id = 'abcdefab-cdef-4000-8000-abcdefabcdef';
    expect(() => classify([row(1, { id }), row(2, { id: id.toUpperCase() })])).toThrow('duplicate_id');
  });
});
function cli(name: string, text: string | Buffer, extras: string[] = []) {
  const file = join(own, name);
  writeFileSync(file, text);
  const before = readFileSync(file);
  const result = spawnSync(process.execPath, [...extras, script, '--input', file], { encoding: 'utf8', env: { NODE_ENV: 'test', SystemRoot: process.env.SystemRoot, TMP: own, TEMP: own }, timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(readFileSync(file).equals(before)).toBe(true);
  return result;
}
describe('actual local read-only CLI', () => {
  it('returns the pure result and leaves input bytes unchanged', () => {
    const text = JSON.stringify(inventory([row()]));
    const result = cli('healthy.json', text);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(classifyNativeCalendarDates(text));
  });
  it.each([
    ['bad-json.json', '{PRIVATE-INPUT-SENTINEL', 'invalid_json'],
    ['later-family.json', JSON.stringify(inventory([row(), row(2, { family_id: '10000000-0000-4000-8000-000000000002' })])), 'family_mismatch'],
    ['later-source.json', JSON.stringify(inventory([row(), row(2, { source_recurrence: { secret: 'PRIVATE-INPUT-SENTINEL' } })])), 'invalid_source_envelope'],
    ['duplicate.json', JSON.stringify(inventory([row(), row()])), 'duplicate_id'],
    ['count.json', JSON.stringify(inventory([row()], { declaredRowCount: 2 })), 'invalid_inventory'],
    ['utf8.json', Buffer.from([0xff]), 'invalid_utf8'],
  ] as const)('refuses %s without path/payload or partial stdout', (name, text, code) => {
    const result = cli(name, text);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: code });
    expect(result.stderr).not.toContain(own);
    expect(result.stderr).not.toContain('PRIVATE');
  });
  it('bounds bytes actually read even when metadata underreports file size', () => {
    const preload = join(own, 'underreported-stat.mjs');
    writeFileSync(preload, "import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.fstatSync; fs.fstatSync=(...args)=>{const stat=original(...args); Object.defineProperty(stat,'size',{value:0}); return stat;}; syncBuiltinESMExports();");
    const result = cli('too-large.json', Buffer.alloc(MAX_INPUT_BYTES + 1, 32), ['--import', pathToFileURL(preload).href]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: 'input_size' });
  });
  it.each(['https://private.invalid/input', 'file:///private.json', '\\\\private-host\\share\\data.json', '//private-host/share/data.json', own])(
    'refuses nonlocal or nonregular input %s', file => {
      const result = spawnSync(process.execPath, [script, '--input', file], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({ error: 'invalid_input_file' });
    });
  it('refuses symlink or junction input', () => {
    const link = join(own, 'link');
    // Directory junctions are unprivileged on Windows and symlinks on POSIX.
    symlinkSync(own, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [script, '--input', link], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: 'invalid_input_file' });
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(own);
  });
  it('refuses missing files without echoing paths', () => {
    const result = spawnSync(process.execPath, [script, '--input', join(own, 'PRIVATE-MISSING.json')], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: 'input_unavailable' });
  });
  it('refuses endpoint options rather than executing them', () => {
    const result = spawnSync(process.execPath, [script, '--endpoint', 'https://private.invalid'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ error: 'usage' });
  });
});
