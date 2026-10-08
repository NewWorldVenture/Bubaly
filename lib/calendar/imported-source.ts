/** Durable source data, not an occurrence engine. Validation checks structure;
 * it does not certify raw/typed semantic consistency or expansion capabilities.
 * Compact RFC values, rule spelling/order and timezone definitions stay intact.
 */
export type SourceTime =
  | { kind: 'date'; value: string }
  | { kind: 'utc'; value: string }
  | { kind: 'zoned'; value: string; tzid: string }
  | { kind: 'floating'; value: string };
export type SourceEnd = { kind: 'default' } | { kind: 'dtend'; value: SourceTime } | { kind: 'duration'; value: string };
export type SourceRdate = { kind: 'time'; value: SourceTime } | {
  kind: 'period'; start: SourceTime; end: Exclude<SourceEnd, { kind: 'default' }>;
};
export interface ImportedSourceRevision {
  sequence: number | null;
  dtstamp: string | null;
  lastModified: string | null;
  etag: string | null;
}
export interface ImportedSourceComponent {
  /** Exact original component, or explicit typed-only provenance. Before using
   * raw to materialize/export, reparse and reject conflicts with typed fields. */
  raw: string | null;
  uid: string;
  title: string | null;
  description: string | null;
  location: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  dtstart: SourceTime | null;
  end: SourceEnd | null;
  rrule: string | null;
  rdates: SourceRdate[];
  exdates: SourceTime[];
  revision: ImportedSourceRevision;
}
export interface ImportedSourceOverride extends ImportedSourceComponent {
  recurrenceId: SourceTime;
  range: 'none' | 'THISANDFUTURE';
}
export interface ImportedSourceTimezone { tzid: string; raw: string }
export interface ImportedSourceDocument {
  version: 1;
  uid: string;
  master: ImportedSourceComponent | null;
  overrides: ImportedSourceOverride[];
  timezones: ImportedSourceTimezone[];
  revision: ImportedSourceRevision;
  /** Exact folded calendar-level properties, excluding component boundaries. */
  rawProperties: string[];
}
export interface ImportedSourceProjection {
  externalUid: string;
  title?: string;
  allDay?: boolean;
  startsAt?: string;
  endsAt?: string | null;
}
export const IMPORTED_SOURCE_LIMITS = Object.freeze({ bytes: 1_048_576, overrides: 2000, dates: 5000, timezones: 32, depth: 16, nodes: 50_000 });
export class ImportedSourceValidationError extends Error {
  constructor(message: string) { super(`Invalid imported calendar source: ${message}`); this.name = 'ImportedSourceValidationError'; }
}
function fail(message: string): never { throw new ImportedSourceValidationError(message); }
type Obj = Record<string, unknown>;
function object(value: unknown, keys: readonly string[], label: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const result = value as Obj;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(result, key))) fail(`${label} has missing or unknown fields`);
  return result;
}
function text(value: unknown, label: string, max = 65_536): string {
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be bounded text`);
  return value;
}
function identity(value: unknown, label: string): string {
  const result = text(value, label, 4096);
  if (!result || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(result)) fail(`${label} is empty or contains forbidden controls`);
  return result;
}
function array(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} exceeds its collection bound`);
  return value;
}
function jsonbText(value: string): void {
  // JSON.stringify accepts these strings, but PostgreSQL JSONB cannot store
  // NUL or unpaired UTF-16 surrogates. Preserve valid pairs without rewriting.
  if (/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) fail('document contains text not representable in JSONB');
}
/** Bound input before cloning. Accessors, prototypes and non-JSON values are
 * refused rather than invoked, dropped or silently coerced by JSON.stringify.
 */
function copyJson(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const active = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > IMPORTED_SOURCE_LIMITS.nodes || depth > IMPORTED_SOURCE_LIMITS.depth) fail('document exceeds traversal bounds');
    if (typeof item === 'string') { jsonbText(item); bytes += new TextEncoder().encode(item).length; }
    else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) bytes += 24;
    else if (typeof item === 'object' && item) {
      if (active.has(item)) fail('document is cyclic');
      const proto: unknown = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) fail('document contains a non-JSON object');
      if (Array.isArray(item)) {
        if (proto !== Array.prototype) fail('document contains a non-JSON array prototype');
        // Refuse oversized arrays before enumerating their keys or descriptors.
        if (item.length > IMPORTED_SOURCE_LIMITS.nodes - nodes) fail('document exceeds traversal bounds');
        const keys = Object.keys(item);
        if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) fail('document contains a sparse or decorated array');
      }
      active.add(item);
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        if (typeof key !== 'string') fail('document contains a symbol key');
        jsonbText(key);
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) fail('document contains an accessor or hidden field');
        bytes += new TextEncoder().encode(key).length + 4;
        visit(descriptor.value, depth + 1);
      }
      active.delete(item);
    } else fail('document contains a non-JSON value');
    if (bytes > IMPORTED_SOURCE_LIMITS.bytes) fail('document exceeds byte bound');
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > IMPORTED_SOURCE_LIMITS.bytes) fail('document exceeds byte bound');
  return JSON.parse(serialized) as unknown;
}
function validToken(value: string, kind: SourceTime['kind']): void {
  const match = (kind === 'date' ? /^(\d{4})(\d{2})(\d{2})$/ : kind === 'utc'
    ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
    : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/).exec(value);
  if (!match) fail('temporal value must retain its compact RFC type');
  const [year, month, day] = match.slice(1, 4).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || (kind !== 'date' && (+match[4] > 23 || +match[5] > 59 || +match[6] > 60))) fail('invalid calendar date or clock fields');
}
function time(value: unknown, zones: ReadonlySet<string>): SourceTime {
  const raw = value as Obj | null;
  const zoned = raw?.kind === 'zoned';
  const obj = object(value, zoned ? ['kind', 'value', 'tzid'] : ['kind', 'value'], 'source time');
  if (!['date', 'utc', 'zoned', 'floating'].includes(String(obj.kind))) fail('unknown source time kind');
  const kind = obj.kind as SourceTime['kind'];
  validToken(text(obj.value, 'source time', 32), kind);
  if (zoned) {
    const zone = identity(obj.tzid, 'TZID');
    if (!zones.has(zone)) {
      try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { fail(`TZID ${zone} has no exact retained definition or known IANA zone`); }
    }
  }
  return value as SourceTime;
}
function compatible(left: SourceTime, right: SourceTime, label: string): void {
  if ((left.kind === 'date') !== (right.kind === 'date')) fail(`${label} must match DTSTART DATE/DATE-TIME type`);
}
function duration(value: unknown, dateOnly: boolean): string {
  const result = text(value, 'DURATION', 128);
  const match = /^\+?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/i.exec(result);
  if (!match || /T$/i.test(result) || !match.slice(1).some(part => part !== undefined && +part > 0)
    || match.slice(1).some(part => part !== undefined && !Number.isSafeInteger(+part)) || (dateOnly && /T/i.test(result))) fail('invalid positive DURATION for source type');
  return result;
}
function end(value: unknown, start: SourceTime, zones: ReadonlySet<string>, allowDefault = true): SourceEnd {
  const kind = (value as Obj | null)?.kind;
  const obj = object(value, kind === 'default' ? ['kind'] : ['kind', 'value'], 'source end');
  if (kind === 'default' && allowDefault) return value as SourceEnd;
  if (kind === 'duration') duration(obj.value, start.kind === 'date');
  else if (kind === 'dtend') {
    const finish = time(obj.value, zones);
    compatible(start, finish, 'DTEND');
    if (start.kind === finish.kind && (start.kind !== 'zoned' || (finish.kind === 'zoned' && start.tzid === finish.tzid)) && finish.value <= start.value) fail('DTEND must follow DTSTART');
  } else fail('unknown source end kind');
  return value as SourceEnd;
}
function revision(value: unknown): void {
  const obj = object(value, ['sequence', 'dtstamp', 'lastModified', 'etag'], 'revision');
  if (obj.sequence !== null && (!Number.isSafeInteger(obj.sequence) || (obj.sequence as number) < 0 || (obj.sequence as number) > 2147483647)) fail('invalid SEQUENCE');
  for (const key of ['dtstamp', 'lastModified']) if (obj[key] !== null) validToken(text(obj[key], key, 32), 'utc');
  if (obj.etag !== null) text(obj.etag, 'etag', 4096);
}
/** Validate the base RFC rule grammar against an already validated DTSTART.
 * This preserves the raw string and does not prove iterator support/results.
 */
export function validateImportedSourceRule(value: unknown, start: SourceTime): void {
  if (value === null) return;
  const raw = text(value, 'RRULE', 16_384);
  const parts = new Map<string, string>();
  for (const part of raw.split(';')) {
    const match = /^([A-Z]+)=([^;=]+)$/i.exec(part);
    if (!match || parts.has(match[1].toUpperCase())) fail('malformed or duplicate RRULE part');
    parts.set(match[1].toUpperCase(), match[2].toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (!freq || !['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) fail('invalid RRULE frequency');
  if (parts.has('COUNT') && parts.has('UNTIL')) fail('RRULE cannot combine COUNT and UNTIL');
  for (const [key, token] of parts) {
    if (key === 'FREQ') continue;
    if (key === 'COUNT' || key === 'INTERVAL') {
      if (!/^\d+$/.test(token) || +token < 1 || +token > 2147483647) fail(`invalid RRULE ${key}`);
    } else if (key === 'UNTIL') validToken(token, start.kind === 'date' ? 'date' : start.kind === 'floating' ? 'floating' : 'utc');
    else if (key === 'WKST') { if (!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(token)) fail('invalid WKST'); }
    else if (key === 'BYDAY') {
      for (const day of token.split(',')) {
        const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(day);
        if (!match || (match[1] !== undefined && (!['MONTHLY', 'YEARLY'].includes(freq) || +match[1] === 0 || Math.abs(+match[1]) > 53 || parts.has('BYWEEKNO')))) fail('invalid ordinal BYDAY');
      }
    } else {
      const ranges: Record<string, [number, number, boolean]> = { BYSECOND: [0, 60, false], BYMINUTE: [0, 59, false], BYHOUR: [0, 23, false], BYMONTHDAY: [-31, 31, true], BYYEARDAY: [-366, 366, true], BYWEEKNO: [-53, 53, true], BYMONTH: [1, 12, false], BYSETPOS: [-366, 366, true] };
      const bounds = ranges[key];
      const signed = ['BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS'].includes(key);
      const numeric = signed ? (['BYYEARDAY', 'BYSETPOS'].includes(key) ? /^[+-]?\d{1,3}$/ : /^[+-]?\d{1,2}$/) : /^\d{1,2}$/;
      if (!bounds || token.split(',').some(item => !numeric.test(item) || +item < bounds[0] || +item > bounds[1] || (bounds[2] && +item === 0))) fail(`invalid or unknown RRULE ${key}`);
      if ((key === 'BYMONTHDAY' && freq === 'WEEKLY') || (key === 'BYYEARDAY' && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) || (key === 'BYWEEKNO' && freq !== 'YEARLY')) fail(`incompatible RRULE ${key}`);
      if (key === 'BYSETPOS' && ![...parts.keys()].some(other => other.startsWith('BY') && other !== key)) fail('BYSETPOS needs another selector');
      // RFC requires ignoring these selectors on DATE rules. Preserve them;
      // this structural validator must not rewrite the publisher's rule.
    }
  }
}
function component(value: unknown, uid: string, zones: ReadonlySet<string>, override: boolean): ImportedSourceComponent {
  const keys = ['raw', 'uid', 'title', 'description', 'location', 'status', 'dtstart', 'end', 'rrule', 'rdates', 'exdates', 'revision'];
  const obj = object(value, override ? [...keys, 'recurrenceId', 'range'] : keys, 'component');
  if (identity(obj.uid, 'component UID') !== uid) fail('component UID crosses source group');
  if (obj.raw !== null) rawComponent(obj.raw, uid);
  for (const key of ['title', 'description', 'location']) if (obj[key] !== null) text(obj[key], key);
  if (!['confirmed', 'tentative', 'cancelled'].includes(String(obj.status))) fail('invalid component status');
  revision(obj.revision);
  const start = obj.dtstart === null ? null : time(obj.dtstart, zones);
  if (!start && obj.status !== 'cancelled') fail('live component needs DTSTART');
  if (start) {
    if (obj.end === null) fail('component with DTSTART needs explicit end semantics');
    end(obj.end, start, zones);
    validateImportedSourceRule(obj.rrule, start);
  } else if (obj.end !== null || obj.rrule !== null) fail('bare cancellation cannot carry unanchored end or rule');
  for (const item of array(obj.exdates, IMPORTED_SOURCE_LIMITS.dates, 'EXDATE')) {
    const excluded = time(item, zones);
    if (!start) fail('EXDATE needs DTSTART');
    compatible(start, excluded, 'EXDATE');
  }
  for (const item of array(obj.rdates, IMPORTED_SOURCE_LIMITS.dates, 'RDATE')) {
    const period = (item as Obj | null)?.kind === 'period';
    const entry = object(item, period ? ['kind', 'start', 'end'] : ['kind', 'value'], 'RDATE');
    if (!start) fail('RDATE needs DTSTART');
    if (period) {
      const begin = time(entry.start, zones);
      if (begin.kind === 'date' || start.kind === 'date') fail('RDATE PERIOD needs DATE-TIME');
      end(entry.end, begin, zones, false);
    } else {
      if (entry.kind !== 'time') fail('unknown RDATE kind');
      compatible(start, time(entry.value, zones), 'RDATE');
    }
  }
  return value as ImportedSourceComponent;
}
/** These checks frame untrusted raw text; they deliberately do not parse its
 * temporal semantics. A qualified parser/engine must reject raw/typed conflicts.
 */
function contentProperty(line: string): { name: string; value: string } {
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === ':' && !quoted) {
      const name = line.slice(0, index).split(';')[0].toUpperCase();
      if (!/^[A-Z0-9-]+$/.test(name)) fail('invalid raw property name');
      return { name, value: line.slice(index + 1) };
    }
  }
  return fail('invalid raw content line');
}
function unfoldedLines(value: unknown, label: string): string[] {
  const raw = text(value, label, 262_144);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw) || /\r(?!\n)/.test(raw)) fail('invalid controls in raw source');
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
function rawComponent(value: unknown, uid: string): void {
  const lines = unfoldedLines(value, 'raw VEVENT');
  const stack: string[] = [], ids: string[] = [];
  if (lines[0]?.toUpperCase() !== 'BEGIN:VEVENT' || lines.at(-1)?.toUpperCase() !== 'END:VEVENT') fail('raw component must be one VEVENT');
  for (const line of lines) {
    const property = contentProperty(line);
    if (property.name === 'BEGIN') {
      const name = property.value.toUpperCase();
      if (stack.length === 0 ? name !== 'VEVENT' : stack.length !== 1 || name !== 'VALARM') fail('invalid raw VEVENT nesting');
      stack.push(name);
    } else if (property.name === 'END') { if (stack.pop() !== property.value.toUpperCase()) fail('unbalanced raw component'); }
    else if (!stack.length) fail('property outside raw component');
    else if (property.name === 'UID' && stack.length === 1) ids.push(decodedRawText(property.value));
  }
  if (stack.length || ids.length !== 1 || ids[0] !== uid) fail('raw component UID conflicts');
}
function decodedRawText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_match, escaped: string) => /n/i.test(escaped) ? '\n' : escaped);
}
function timezone(value: unknown): string {
  const obj = object(value, ['tzid', 'raw'], 'timezone definition');
  const zone = identity(obj.tzid, 'definition TZID');
  const raw = text(obj.raw, 'VTIMEZONE', 262_144);
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0]?.toUpperCase() !== 'BEGIN:VTIMEZONE' || lines.at(-1)?.toUpperCase() !== 'END:VTIMEZONE') fail('VTIMEZONE must be one exact component');
  const stack: string[] = [], ids: string[] = [];
  let observances = 0;
  let observance = new Map<string, string>();
  let observanceDates: string[] = [];
  for (const line of lines) {
    if (/^BEGIN:/i.test(line)) {
      const name = line.slice(6).toUpperCase();
      if (stack.length === 0 ? name !== 'VTIMEZONE' : stack.length !== 1 || !['STANDARD', 'DAYLIGHT'].includes(name)) fail('invalid VTIMEZONE nesting');
      stack.push(name);
      if (name !== 'VTIMEZONE') { observances++; observance = new Map(); observanceDates = []; }
    } else if (/^END:/i.test(line)) {
      if (stack.length === 2) {
        const start = observance.get('DTSTART');
        if (!start || !observance.has('TZOFFSETFROM') || !observance.has('TZOFFSETTO')) fail('VTIMEZONE observance needs DTSTART and both offsets');
        validToken(start, 'floating');
        // VTIMEZONE observance DTSTART is local, but its UNTIL must be UTC.
        if (observance.has('RRULE')) validateImportedSourceRule(observance.get('RRULE'), { kind: 'utc', value: `${start}Z` });
        for (const token of observanceDates) validToken(token, 'floating');
      }
      if (stack.pop() !== line.slice(4).toUpperCase()) fail('unbalanced VTIMEZONE');
    }
    else if (stack.length === 1 && contentProperty(line).name === 'TZID') ids.push(decodedRawText(contentProperty(line).value));
    else {
      if (!stack.length || !line.includes(':') || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(line)) fail('invalid VTIMEZONE property');
      const parsed = contentProperty(line);
      const key = parsed.name, property = parsed.value;
      if (stack.length === 2 && key === 'RDATE') observanceDates.push(...property.split(','));
      if (stack.length === 2 && ['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'RRULE'].includes(key)) {
        if (observance.has(key)) fail('duplicate VTIMEZONE observance field');
        if (key.startsWith('TZOFFSET') && (!/^[+-]\d{4}(?:\d{2})?$/.test(property) || +property.slice(1, 3) > 23 || +property.slice(3, 5) > 59 || +(property.slice(5) || '0') > 59 || /^-0+$/.test(property))) fail('invalid VTIMEZONE offset');
        observance.set(key, property);
      }
    }
  }
  if (stack.length || !observances || ids.length !== 1 || ids[0] !== zone) fail('VTIMEZONE identity or observance missing');
  return zone;
}
function instant(value: SourceTime): number {
  if (value.kind === 'zoned' || value.kind === 'floating' || value.value.includes('60Z')) fail('instant projection requires a qualified source-clock resolver');
  const token = value.kind === 'date' ? `${value.value}T000000Z` : value.value;
  if (token.slice(13, 15) === '60') fail('leap-second instant projection is unverified');
  return Date.parse(`${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}T${token.slice(9, 11)}:${token.slice(11, 13)}:${token.slice(13, 15)}Z`);
}
function projection(document: ImportedSourceDocument, value: ImportedSourceProjection): void {
  const allowed = ['externalUid', 'title', 'allDay', 'startsAt', 'endsAt'];
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key)) || value.externalUid !== document.uid) fail('projection identity conflicts');
  const master = document.master;
  if (!master || master.status === 'cancelled' || !master.dtstart) fail('projection needs a live master');
  if (value.title !== undefined && value.title !== master.title) fail('projection title conflicts');
  if (value.allDay !== undefined && value.allDay !== (master.dtstart.kind === 'date')) fail('projection all-day type conflicts');
  const sameInstant = (actual: unknown, expected: number): void => {
    if (typeof actual !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(actual)) fail('projection instant conflicts');
    validToken(actual.slice(0, 19).replace(/[-:]/g, '') + 'Z', 'utc');
    if (Date.parse(actual) !== expected) fail('projection instant conflicts');
  };
  if (value.startsAt !== undefined) sameInstant(value.startsAt, instant(master.dtstart));
  if (Object.hasOwn(value, 'endsAt')) {
    if (master.end?.kind === 'dtend') sameInstant(value.endsAt, instant(master.end.value));
    else if (master.end?.kind === 'default' && master.dtstart.kind !== 'date') { if (value.endsAt !== null) fail('projection default end conflicts'); }
    else fail('end projection requires explicit qualified duration/default-date mapping');
  }
}
/** Returns an independent JSON copy; input is never normalized or mutated.
 * Detached groups are retained, but cannot be projected as a master row here.
 */
export function parseImportedSource(value: unknown, expected?: ImportedSourceProjection): ImportedSourceDocument {
  const copy = copyJson(value);
  const obj = object(copy, ['version', 'uid', 'master', 'overrides', 'timezones', 'revision', 'rawProperties'], 'document');
  if (obj.version !== 1) fail('unknown document version');
  const uid = identity(obj.uid, 'document UID');
  revision(obj.revision);
  for (const property of array(obj.rawProperties, 1000, 'raw calendar properties')) {
    const lines = unfoldedLines(property, 'raw calendar property');
    if (lines.length !== 1 || ['BEGIN', 'END'].includes(contentProperty(lines[0]).name)) fail('raw calendar property must be one folded property');
  }
  const zones = new Set<string>();
  for (const item of array(obj.timezones, IMPORTED_SOURCE_LIMITS.timezones, 'timezones')) {
    const zone = timezone(item);
    if (zones.has(zone)) fail('duplicate timezone identity');
    zones.add(zone);
  }
  const master = obj.master === null ? null : component(obj.master, uid, zones, false);
  const seen = new Set<string>();
  let originalClock: SourceTime | null = master?.dtstart ?? null;
  const overrides = array(obj.overrides, IMPORTED_SOURCE_LIMITS.overrides, 'overrides');
  if (!master && !overrides.length) fail('source group has no components');
  for (const item of overrides) {
    component(item, uid, zones, true);
    const entry = item as ImportedSourceOverride;
    const original = time(entry.recurrenceId, zones);
    if (!['none', 'THISANDFUTURE'].includes(entry.range)) fail('unknown override RANGE');
    if (entry.dtstart) compatible(original, entry.dtstart, 'override DTSTART');
    if (originalClock) {
      compatible(originalClock, original, 'RECURRENCE-ID');
      if (originalClock.kind !== original.kind || (originalClock.kind === 'zoned' && original.kind === 'zoned' && originalClock.tzid !== original.tzid)) fail('RECURRENCE-ID must retain original source clock');
    }
    originalClock ??= original;
    const key = JSON.stringify([original.kind, original.kind === 'zoned' ? original.tzid : null, original.value]);
    if (seen.has(key)) fail('duplicate override identity');
    seen.add(key);
  }
  const document = copy as ImportedSourceDocument;
  if (expected !== undefined) projection(document, expected);
  return document;
}
export function validateImportedSource(value: unknown, expected?: ImportedSourceProjection):
  { ok: true; value: ImportedSourceDocument } | { ok: false; error: ImportedSourceValidationError } {
  try { return { ok: true, value: parseImportedSource(value, expected) }; }
  catch (error) { if (error instanceof ImportedSourceValidationError) return { ok: false, error }; throw error; }
}
