/**
 * Read-only local inventory: node scripts/classify-native-calendar-dates.mjs --input <local-json>
 * Envelope: {version:1, familyId:UUID, declaredRowCount:integer, rows:array}.
 * Required row projection: id, family_id, all_day, starts_at, ends_at,
 * feed_id, external_uid, onboarding_key. Optional source_recurrence is held opaque.
 * Counts describe only the caller-declared input, never database completeness.
 * Canonical representation is not proof of original intent or provenance.
 * Unlike the runtime's millisecond Date parser, nonzero submillisecond native
 * clocks require review; their ordering or DATE boundary cannot be proven here.
 * No original timezone, replacement date or repair is inferred or performed.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_ROWS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = [
  'source_linked_held', 'native_timed', 'native_timed_null_end',
  'canonical_native_date', 'canonical_native_date_null_end', 'review_invalid_clock',
  'review_reversed_interval', 'review_equal_date_boundary', 'review_noncanonical_date_boundary',
  'review_submillisecond_precision',
];
class InventoryError extends Error {}
const refuse = code => { throw new InventoryError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function validDay(day) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day) || day.startsWith('0000')) return false;
  const date = new Date(day + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
// Match search-occurrences.ts strictInstant, including its textual civil prefix.
function instant(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  const result = Date.parse(value);
  return !match || !validDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59
    || match[6] !== undefined && (+match[6] > 23 || +match[7] > 59) || !Number.isFinite(result) ? null : result;
}
function sourceEnvelope(row) {
  if (row.feed_id !== null && !uuid(row.feed_id)) refuse('invalid_source_envelope');
  if (row.external_uid !== null && (typeof row.external_uid !== 'string' || !row.external_uid.trim()
    || Buffer.byteLength(row.external_uid, 'utf8') > 4096)) refuse('invalid_source_envelope');
  if (owns(row, 'source_recurrence') && row.source_recurrence !== null
    && (!object(row.source_recurrence) || row.feed_id === null || row.external_uid === null)) refuse('invalid_source_envelope');
}
function reason(row) {
  // Link presence is a protective hold, not qualification of an imported payload.
  if (row.feed_id !== null || row.external_uid !== null || row.source_recurrence != null) return 'source_linked_held';
  const start = instant(row.starts_at), end = row.ends_at === null ? null : instant(row.ends_at);
  if (start === null || row.ends_at !== null && end === null) return 'review_invalid_clock';
  const submillisecond = value => /[1-9]/.test((/\.(\d+)/.exec(value)?.[1] ?? '').slice(3));
  if (submillisecond(row.starts_at) || row.ends_at !== null && submillisecond(row.ends_at)) return 'review_submillisecond_precision';
  if (end !== null && end < start) return 'review_reversed_interval';
  if (!row.all_day) return end === null ? 'native_timed_null_end' : 'native_timed';
  if (end === start) return 'review_equal_date_boundary';
  if (start !== Date.parse(`${row.starts_at.slice(0, 10)}T00:00:00Z`)
    || end !== null && end !== Date.parse(`${row.ends_at.slice(0, 10)}T00:00:00Z`)) return 'review_noncanonical_date_boundary';
  return end === null ? 'canonical_native_date_null_end' : 'canonical_native_date';
}

/** Representation inventory only. No inferred original timezone, dates or repair. */
export function classifyNativeCalendarDates(jsonText) {
  if (typeof jsonText !== 'string' || Buffer.byteLength(jsonText, 'utf8') > MAX_INPUT_BYTES) refuse('input_size');
  let input;
  try { input = JSON.parse(jsonText); } catch { refuse('invalid_json'); }
  if (!object(input) || Object.keys(input).sort().join(',') !== 'declaredRowCount,familyId,rows,version'
    || input.version !== 1 || !uuid(input.familyId) || !Number.isInteger(input.declaredRowCount)
    || input.declaredRowCount < 0 || input.declaredRowCount > MAX_ROWS || !Array.isArray(input.rows)
    || input.rows.length > MAX_ROWS || input.rows.length !== input.declaredRowCount) refuse('invalid_inventory');
  const seen = new Set();
  // Admit the whole inventory before producing any row classification.
  for (const row of input.rows) {
    if (!object(row) || !['id', 'family_id', 'all_day', 'starts_at', 'ends_at', 'feed_id', 'external_uid', 'onboarding_key'].every(key => owns(row, key))
      || !uuid(row.id) || !uuid(row.family_id) || typeof row.all_day !== 'boolean') refuse('invalid_row_envelope');
    if (row.family_id.toLowerCase() !== input.familyId.toLowerCase()) refuse('family_mismatch');
    if (row.onboarding_key !== null && (typeof row.onboarding_key !== 'string'
      || Buffer.byteLength(row.onboarding_key, 'utf8') > 4096)) refuse('invalid_onboarding_envelope');
    const id = row.id.toLowerCase();
    if (seen.has(id)) refuse('duplicate_id');
    seen.add(id);
    sourceEnvelope(row);
  }
  const counts = Object.fromEntries(REASONS.map(code => [code, 0]));
  const rows = input.rows.map((row, index) => {
    const code = reason(row);
    counts[code]++;
    return { index, reason: code };
  });
  return {
    version: 1, scope: 'caller-declared-inventory-only', provenance: 'not-verified',
    qualification: 'date-representation-only-not-full-calendar-row-admission',
    nullEndPolicy: 'canonical-native-date-null-end-uses-reader-single-day-policy',
    declaredRowCount: input.declaredRowCount, counts, rows,
  };
}

function readLocalJson(file) {
  let fd;
  try {
    if (!file || file.startsWith('\\\\') || file.startsWith('//')
      || /^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) refuse('invalid_input_file');
    if (!lstatSync(file).isFile()) refuse('invalid_input_file');
    // NONBLOCK also prevents a regular-to-FIFO swap from hanging before fstat.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) refuse('input_size');
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let bytes = 0, size;
    while ((size = readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0) {
      bytes += size;
      if (bytes > MAX_INPUT_BYTES) refuse('input_size');
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)); }
    catch { refuse('invalid_utf8'); }
  } finally { if (fd !== undefined) closeSync(fd); }
}
function main(args) {
  try {
    if (args.length !== 2 || args[0] !== '--input') refuse('usage');
    const result = classifyNativeCalendarDates(readLocalJson(args[1]));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof InventoryError ? error.message : 'input_unavailable' }) + '\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));
