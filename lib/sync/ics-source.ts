import {
  IMPORTED_SOURCE_LIMITS, ImportedSourceValidationError, parseImportedSource, validateImportedSourceRule,
  type ImportedSourceComponent, type ImportedSourceDocument, type ImportedSourceOverride,
  type ImportedSourceRevision, type SourceEnd, type SourceRdate, type SourceTime,
} from '@/lib/calendar/imported-source';

/** Source admission only. No recurrence expansion, timezone conversion or application writes. */
export const ICS_SOURCE_LIMITS = Object.freeze({
  bytes: IMPORTED_SOURCE_LIMITS.bytes, lines: 50_000, lineBytes: 65_536,
  components: 4_000, groups: 512, depth: IMPORTED_SOURCE_LIMITS.depth,
});
type Property = { name: string; params: Map<string, string[]>; value: string; raw: string };
type Component = { name: string; properties: Property[]; children: Component[]; raw: string; start: number };
function fail(message: string): never { throw new ImportedSourceValidationError(`ICS ${message}`); }
const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Split only outside quoted parameter values; a colon inside ALTREP is data. */
function splitQuoted(value: string, delimiter: string): string[] {
  const parts: string[] = []; let quote = false, start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '"') quote = !quote;
    else if (!quote && value[index] === delimiter) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  if (quote) fail('unbalanced parameter quote');
  parts.push(value.slice(start)); return parts;
}
function parameterValue(value: string): string {
  const quoted = value.startsWith('"');
  if (quoted ? !value.endsWith('"') || value.length < 2 : /[":;]/.test(value)) fail('malformed parameter value');
  const result = quoted ? value.slice(1, -1) : value;
  if (!result || result.includes('"') || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(result)) fail('invalid parameter value');
  // RFC6868 uses lowercase ^n; unknown pairs (including ^N) stay intact.
  return result.replace(/\^([n^'])/g, (_, char: string) => char === '^' ? '^' : char === "'" ? '"' : '\n');
}
function property(line: string, raw: string): Property {
  let quote = false, colon = -1;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quote = !quote;
    else if (!quote && line[index] === ':') { colon = index; break; }
  }
  if (colon < 1 || quote) fail('content line has no unquoted separator');
  const [name, ...parameters] = splitQuoted(line.slice(0, colon), ';');
  if (!/^[A-Z0-9-]+$/i.test(name)) fail('invalid property name');
  const params = new Map<string, string[]>();
  for (const part of parameters) {
    const equal = part.indexOf('='), key = part.slice(0, equal).toUpperCase();
    if (equal < 1 || !/^[A-Z0-9-]+$/.test(key) || params.has(key)) fail('malformed or duplicate parameter');
    params.set(key, splitQuoted(part.slice(equal + 1), ',').map(parameterValue));
  }
  const upper = name.toUpperCase();
  if ((params.has('RANGE') && upper !== 'RECURRENCE-ID') || (params.has('TZID') && !['DTSTART', 'DTEND', 'RECURRENCE-ID', 'RDATE', 'EXDATE'].includes(upper))) fail('temporal parameter on unsupported property');
  return { name: upper, params, value: line.slice(colon + 1), raw };
}
function parseTree(source: string): Component {
  if (typeof source !== 'string' || !source || bytes(source) > ICS_SOURCE_LIMITS.bytes) fail('input exceeds byte bound or is empty');
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(source)) fail('unpaired UTF-16 source surrogate');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source) || /\r(?!\n)/.test(source)) fail('forbidden control or bare CR');
  const physical = [...source.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)].filter(match => match[0] !== '');
  if (physical.length > ICS_SOURCE_LIMITS.lines) fail('input exceeds line bound');
  const lines: { parts: string[]; length: number; start: number; end: number }[] = [];
  for (const match of physical) {
    const full = match[0], value = full.replace(/\r?\n$/, ''), start = match.index!;
    const size = bytes(value);
    if (size > ICS_SOURCE_LIMITS.lineBytes) fail('physical line exceeds byte bound');
    if (/^[ \t]/.test(value)) {
      const previous = lines.at(-1); if (!previous) fail('orphan folded line');
      previous.parts.push(value.slice(1)); previous.length += size - 1; previous.end = start + full.length;
      if (previous.length > ICS_SOURCE_LIMITS.lineBytes) fail('unfolded line exceeds byte bound');
    } else {
      if (!value) fail('empty content line');
      lines.push({ parts: [value], length: size, start, end: start + full.length });
    }
  }
  const stack: Component[] = []; let root: Component | null = null, count = 0;
  for (const line of lines) {
    const prop = property(line.parts.join(''), source.slice(line.start, line.end));
    if (prop.name === 'BEGIN') {
      if (prop.params.size || !/^[A-Z0-9-]+$/i.test(prop.value)) fail('invalid BEGIN');
      const name = prop.value.toUpperCase(), parent = stack.at(-1);
      if (!parent ? root !== null || name !== 'VCALENDAR' : parent.name === 'VCALENDAR'
        ? !['VEVENT', 'VTIMEZONE'].includes(name) : parent.name === 'VTIMEZONE'
          ? !['STANDARD', 'DAYLIGHT'].includes(name) : parent.name === 'VEVENT' ? name !== 'VALARM' : true) fail('unsupported component nesting');
      if (++count > ICS_SOURCE_LIMITS.components || stack.length >= ICS_SOURCE_LIMITS.depth) fail('component bound exceeded');
      const child: Component = { name, properties: [], children: [], start: line.start, raw: '' };
      if (parent) parent.children.push(child); else root = child;
      stack.push(child);
    } else if (prop.name === 'END') {
      const current = stack.pop();
      if (prop.params.size || !current || current.name !== prop.value.toUpperCase()) fail('unbalanced END');
      current.raw = source.slice(current.start, line.end);
    } else {
      const current = stack.at(-1); if (!current) fail('property outside calendar');
      current.properties.push(prop);
    }
  }
  if (!root || stack.length) fail('unclosed calendar');
  return root;
}
function one(component: Component, name: string): Property | null {
  const found = component.properties.filter(prop => prop.name === name);
  if (found.length > 1) fail(`duplicate ${name}`);
  return found[0] ?? null;
}
function scalar(prop: Property, name: string): string | null {
  const values = prop.params.get(name); if (!values) return null;
  if (values.length !== 1) fail(`ambiguous ${name} parameter`);
  return values[0];
}
function valueType(prop: Property, expected: string): void {
  const declared = scalar(prop, 'VALUE');
  if (declared !== null && declared.toUpperCase() !== expected) fail(`unsupported ${prop.name} VALUE`);
}
function text(prop: Property | null): string | null {
  if (!prop) return null; valueType(prop, 'TEXT');
  let result = '';
  for (let index = 0; index < prop.value.length; index++) {
    const char = prop.value[index];
    if (char === '\\') {
      const escaped = prop.value[++index]; if (!escaped || !/[\\,;nN]/.test(escaped)) fail(`malformed ${prop.name} TEXT escape`);
      result += /[nN]/.test(escaped) ? '\n' : escaped;
    } else { if (char === ',' || char === ';') fail(`unescaped ${prop.name} TEXT delimiter`); result += char; }
  }
  return result;
}
function validClock(value: string): void {
  const year = +value.slice(0, 4), month = +value.slice(4, 6), day = +value.slice(6, 8);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || (value.length > 8 && (+value.slice(9, 11) > 23 || +value.slice(11, 13) > 59 || +value.slice(13, 15) > 60))) fail('invalid date or clock fields');
}
function sourceTime(prop: Property, value = prop.value, forcedType?: string): SourceTime {
  const type = (forcedType ?? scalar(prop, 'VALUE') ?? 'DATE-TIME').toUpperCase(), tzid = scalar(prop, 'TZID');
  if (type === 'DATE') {
    if (tzid !== null || !/^\d{8}$/.test(value)) fail('DATE must have no TZID or clock fields');
    validClock(value);
    return { kind: 'date', value };
  }
  if (type !== 'DATE-TIME' || !/^\d{8}T\d{6}Z?$/.test(value)) fail('invalid DATE-TIME token');
  validClock(value);
  if (value.endsWith('Z')) { if (tzid !== null) fail('UTC time cannot carry TZID'); return { kind: 'utc', value }; }
  return tzid === null ? { kind: 'floating', value } : { kind: 'zoned', value, tzid };
}
function revision(component: Component, etag: string | null): ImportedSourceRevision {
  const sequence = one(component, 'SEQUENCE'), stamp = one(component, 'DTSTAMP'), modified = one(component, 'LAST-MODIFIED');
  if (sequence) { valueType(sequence, 'INTEGER'); if (!/^[+-]?\d+$/.test(sequence.value)) fail('invalid SEQUENCE'); }
  const utc = (prop: Property | null): string | null => {
    if (!prop) return null; if (sourceTime(prop).kind !== 'utc') fail(`${prop.name} must be UTC`); return prop.value;
  };
  return { sequence: sequence ? Number(sequence.value) : null, dtstamp: utc(stamp), lastModified: utc(modified), etag };
}
function component(node: Component, etag: string | null): ImportedSourceComponent | ImportedSourceOverride {
  const uid = text(one(node, 'UID')); if (!uid) fail('VEVENT needs UID');
  const start = one(node, 'DTSTART'), finish = one(node, 'DTEND'), duration = one(node, 'DURATION');
  if (finish && duration) fail('DTEND and DURATION are mutually exclusive');
  if (duration) valueType(duration, 'DURATION');
  const status = one(node, 'STATUS'); if (status) valueType(status, 'TEXT');
  const state = status?.value.toUpperCase() ?? 'CONFIRMED';
  if (!['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(state)) fail('unsupported VEVENT STATUS');
  const rule = one(node, 'RRULE'); if (rule) valueType(rule, 'RECUR');
  // EXRULE is obsolete and cannot be represented by this durable contract.
  if (one(node, 'EXRULE')) fail('unsupported EXRULE; source cannot be admitted without preserving its semantics');
  const rdates: SourceRdate[] = [], exdates: SourceTime[] = [];
  for (const prop of node.properties) {
    if (prop.name === 'RDATE') {
      const period = scalar(prop, 'VALUE')?.toUpperCase() === 'PERIOD';
      for (const token of prop.value.split(',')) {
        if (rdates.length >= IMPORTED_SOURCE_LIMITS.dates) fail('RDATE bound exceeded');
        if (!period) rdates.push({ kind: 'time', value: sourceTime(prop, token) });
        else {
          const parts = token.split('/'); if (parts.length !== 2) fail('invalid RDATE PERIOD');
          const begin = sourceTime(prop, parts[0], 'DATE-TIME');
          const end: Exclude<SourceEnd, { kind: 'default' }> = /^\+?P/.test(parts[1])
            ? { kind: 'duration', value: parts[1] } : { kind: 'dtend', value: sourceTime(prop, parts[1], 'DATE-TIME') };
          rdates.push({ kind: 'period', start: begin, end });
        }
      }
    } else if (prop.name === 'EXDATE') for (const token of prop.value.split(',')) {
      if (exdates.length >= IMPORTED_SOURCE_LIMITS.dates) fail('EXDATE bound exceeded');
      exdates.push(sourceTime(prop, token));
    }
  }
  const result: ImportedSourceComponent = {
    uid, title: text(one(node, 'SUMMARY')), description: text(one(node, 'DESCRIPTION')), location: text(one(node, 'LOCATION')),
    status: state.toLowerCase() as ImportedSourceComponent['status'], dtstart: start ? sourceTime(start) : null,
    end: finish ? { kind: 'dtend', value: sourceTime(finish) } : duration ? { kind: 'duration', value: duration.value } : start ? { kind: 'default' } : null,
    rrule: rule?.value ?? null, rdates, exdates, revision: revision(node, etag), raw: node.raw,
  };
  const original = one(node, 'RECURRENCE-ID');
  if (!original) return result;
  const range = scalar(original, 'RANGE')?.toUpperCase() ?? 'none';
  if (range !== 'none' && range !== 'THISANDFUTURE') fail('unsupported RECURRENCE-ID RANGE');
  return { ...result, recurrenceId: sourceTime(original), range };
}

/** Parse one bounded VCALENDAR into UID groups, retaining original folded
 * component/property source. Unknown raw semantics are preserved, not certified
 * for occurrence generation. Consumers must qualify an engine before projection.
 */
export function parseICSSource(source: string, options: { etag?: string | null } = {}): ImportedSourceDocument[] {
  const tree = parseTree(source), version = one(tree, 'VERSION'), prodid = one(tree, 'PRODID');
  if (version?.value !== '2.0' || !prodid || !text(prodid)) fail('VCALENDAR needs VERSION2.0 and PRODID');
  valueType(version, 'TEXT');
  const scale = one(tree, 'CALSCALE');
  if (scale) valueType(scale, 'TEXT');
  if (scale && scale.value.toUpperCase() !== 'GREGORIAN') fail('unsupported CALSCALE');
  const method = one(tree, 'METHOD');
  if (method) valueType(method, 'TEXT');
  if (method && method.value.toUpperCase() !== 'PUBLISH') fail('scheduling METHOD needs a separately qualified admission path');
  const etag = options.etag ?? null;
  const timezoneIds = new Set<string>();
  const timezones = tree.children.filter(child => child.name === 'VTIMEZONE').map(zone => {
    const tzid = text(one(zone, 'TZID')); if (!tzid) fail('VTIMEZONE needs TZID');
    if (timezoneIds.has(tzid) || timezoneIds.size >= IMPORTED_SOURCE_LIMITS.timezones) fail('duplicate or excessive VTIMEZONE identities');
    timezoneIds.add(tzid);
    if (!zone.children.length) fail('VTIMEZONE needs observance');
    for (const observance of zone.children) {
      const start = one(observance, 'DTSTART'), from = one(observance, 'TZOFFSETFROM'), to = one(observance, 'TZOFFSETTO'), rule = one(observance, 'RRULE');
      if (!start || !from || !to || sourceTime(start).kind !== 'floating') fail('VTIMEZONE needs local DTSTART and both offsets');
      for (const offset of [from, to]) {
        valueType(offset, 'UTC-OFFSET');
        if (!/^[+-]\d{4}(?:\d{2})?$/.test(offset.value) || +offset.value.slice(1, 3) > 23 || +offset.value.slice(3, 5) > 59 || +(offset.value.slice(5) || '0') > 59 || /^-0+$/.test(offset.value)) fail('invalid VTIMEZONE offset');
      }
      if (rule) { valueType(rule, 'RECUR'); validateImportedSourceRule(rule.value, { kind: 'utc', value: `${start.value}Z` }); }
      for (const date of observance.properties.filter(prop => prop.name === 'RDATE')) for (const token of date.value.split(',')) if (sourceTime(date, token).kind !== 'floating') fail('VTIMEZONE RDATE must be local DATE-TIME');
    }
    return { tzid, raw: zone.raw };
  });
  const groups = new Map<string, { master: ImportedSourceComponent | null; overrides: ImportedSourceOverride[] }>();
  for (const node of tree.children.filter(child => child.name === 'VEVENT')) {
    const parsed = component(node, etag); let group = groups.get(parsed.uid);
    if (!group) { if (groups.size >= ICS_SOURCE_LIMITS.groups) fail('UID group bound exceeded'); group = { master: null, overrides: [] }; groups.set(parsed.uid, group); }
    if ('recurrenceId' in parsed) {
      if (group.overrides.length >= IMPORTED_SOURCE_LIMITS.overrides) fail('override bound exceeded');
      group.overrides.push(parsed);
    } else { if (group.master) fail('ambiguous duplicate master UID'); group.master = parsed; }
  }
  const rawProperties = tree.properties.map(prop => prop.raw), documents: ImportedSourceDocument[] = []; let outputBytes = 0;
  if (rawProperties.length > 1000) fail('calendar property bound exceeded');
  for (const [uid, group] of groups) {
    const document = parseImportedSource({ version: 1, uid, ...group, timezones, revision: group.master?.revision ?? { sequence: null, dtstamp: null, lastModified: null, etag }, rawProperties });
    outputBytes += bytes(JSON.stringify(document));
    if (outputBytes > IMPORTED_SOURCE_LIMITS.bytes) fail('grouped output exceeds byte bound');
    documents.push(document);
  }
  return documents;
}
