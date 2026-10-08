import { ImportedSourceValidationError, parseImportedSource, type ImportedSourceComponent, type ImportedSourceOverride, type SourceEnd, type SourceTime } from './imported-source';
import { createSourceClock } from './source-clock';
import { expandSourceRule, type CivilDateTime } from './source-rule';
import { exportICSSource } from '../sync/ics-source-export';

export interface SourceOccurrenceOptions {
  /** Half-open overlap window, in Unix milliseconds. */
  from: number; to: number;
  floatingTimezone?: string; dateTimezone?: string;
  maxWork?: number; maxOccurrences?: number;
  /** Shared enclosing budget; callback failures propagate without a prefix. */
  consumeWork?: (amount: number) => void;
}
export type SourceTransparency = 'opaque' | 'transparent';
export interface SourceOccurrence {
  /** Derived from the qualified selected VEVENT, not stored version-1 data. */
  transparency: SourceTransparency;
  id: string; uid: string; original: SourceTime; startsAt: string; endsAt: string;
  /** Concrete moved/shifted source start, distinct from stable original identity. */
  sourceStart: SourceTime;
  /** Exclusive Gregorian DATE end before contextual instant projection. */
  sourceEndDate: string | null;
  allDay: boolean; title: string | null; description: string | null; location: string | null;
  status: 'confirmed' | 'tentative';
}
const DAY = 86_400_000;
function fail(message: string): never { throw new ImportedSourceValidationError(`occurrence set: ${message}`); }
function key(time: SourceTime): string { return JSON.stringify([time.kind, time.kind === 'zoned' ? time.tzid : null, time.value]); }
function sameClock(a: SourceTime, b: SourceTime): boolean { return a.kind === b.kind && (a.kind !== 'zoned' || b.kind === 'zoned' && a.tzid === b.tzid); }
function civil(time: SourceTime): CivilDateTime {
  const v = time.value;
  return { year: +v.slice(0, 4), month: +v.slice(4, 6), day: +v.slice(6, 8), hour: +(v.slice(9, 11) || 0), minute: +(v.slice(11, 13) || 0), second: +(v.slice(13, 15) || 0) };
}
function epoch(p: CivilDateTime): number { const d = new Date(0); d.setUTCFullYear(p.year, p.month - 1, p.day); d.setUTCHours(p.hour, p.minute, p.second, 0); return d.getTime(); }
function shifted(time: SourceTime, difference: number): SourceTime {
  const d = new Date(epoch(civil(time)) + difference);
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) fail('civil shift exceeds supported years');
  const pad = (v: number, size = 2) => String(v).padStart(size, '0');
  const value = `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${time.kind === 'date' ? '' : `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${time.kind === 'utc' ? 'Z' : ''}`}`;
  return { ...time, value };
}
function duration(value: string): { days: number; elapsed: number } {
  const m = /^\+?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/i.exec(value);
  if (!m || !m.slice(1).some(v => v !== undefined)) fail('unsupported duration');
  const days = +(m[1] || 0) * 7 + +(m[2] || 0), elapsed = (+(m[3] || 0) * 3600 + +(m[4] || 0) * 60 + +(m[5] || 0)) * 1000;
  if (!Number.isSafeInteger(days * DAY + elapsed)) fail('duration exceeds safe bounds');
  return { days, elapsed };
}
/** Refuse recurrence-affecting extensions rather than silently dropping them.
 * Raw text is still retained in the caller's unchanged source document. */
function admitRaw(raw: string): SourceTransparency {
  let transparency: SourceTransparency = 'opaque', seenTransparency = false;
  const allowed = new Set('UID SUMMARY DESCRIPTION LOCATION STATUS DTSTART DTEND DURATION RRULE RDATE EXDATE RECURRENCE-ID SEQUENCE DTSTAMP LAST-MODIFIED CREATED TRANSP CLASS CATEGORIES URL GEO ORGANIZER ATTENDEE CONTACT COMMENT RELATED-TO RESOURCES PRIORITY ATTACH'.split(' '));
  const temporal = new Set(['DTSTART', 'DTEND', 'RDATE', 'EXDATE', 'RECURRENCE-ID', 'RRULE', 'DURATION']);
  let depth = 0;
  for (const line of raw.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter(Boolean)) {
    let quoted = false, colon = -1;
    for (let i = 0; i < line.length; i++) { if (line[i] === '"') quoted = !quoted; else if (line[i] === ':' && !quoted) { colon = i; break; } }
    if (colon < 1) fail('malformed raw content');
    const head = line.slice(0, colon), parts: string[] = [];
    let partStart = 0; quoted = false;
    for (let i = 0; i < head.length; i++) { if (head[i] === '"') quoted = !quoted; else if (head[i] === ';' && !quoted) { parts.push(head.slice(partStart, i)); partStart = i + 1; } }
    parts.push(head.slice(partStart));
    const name = parts[0].toUpperCase(), value = line.slice(colon + 1);
    if (name === 'BEGIN') { depth++; continue; }
    if (name === 'END') { depth--; continue; }
    if (depth !== 1) continue; // VALARM does not define occurrence membership.
    if (!allowed.has(name)) fail(`unqualified raw property ${name}`);
    if (temporal.has(name)) for (const part of parts.slice(1)) {
      const parameter = part.split('=')[0].toUpperCase();
      const supported = ['VALUE', ...(['DTSTART', 'DTEND', 'RDATE', 'EXDATE', 'RECURRENCE-ID'].includes(name) ? ['TZID'] : []), ...(name === 'RECURRENCE-ID' ? ['RANGE'] : [])];
      if (!supported.includes(parameter)) fail(`unqualified ${name} parameter ${parameter}`);
    }
    if (name === 'STATUS' && !['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(value.toUpperCase())) fail('unqualified status');
    if (name === 'TRANSP') {
      // RFC 5545 3.8.2.7: singleton enumerated TEXT, default OPAQUE.
      // Extension parameters remain unqualified rather than silently ignored.
      if (seenTransparency || parts.length !== 1 || !['OPAQUE', 'TRANSPARENT'].includes(value.toUpperCase())) fail('unqualified transparency');
      seenTransparency = true;
      transparency = value.toUpperCase() === 'TRANSPARENT' ? 'transparent' : 'opaque';
    }
  }
  return transparency;
}

/** Complete bounded materialization for one UID. Unsupported semantics throw;
 * this API never returns a truncated prefix and never changes source data.
 * RANGE is qualified only for civil shifts within the same original clock.
 * IANA clock results use host ICU; they are not pinned-TZDB certification. */
export function expandSourceOccurrences(value: unknown, options: SourceOccurrenceOptions): { occurrences: SourceOccurrence[]; count: number } {
  const doc = parseImportedSource(value);
  const { from, to } = options;
  const maxOccurrences = options.maxOccurrences ?? 20_000;
  const maxWork = options.maxWork ?? 200_000;
  let work = 0;
  const charge = (amount = 1) => { work += amount; if (work > maxWork) fail('aggregate work bound exhausted'); options.consumeWork?.(amount); };
  if (![from, to].every(Number.isFinite) || from >= to || Math.abs(from) > 8.64e15 || Math.abs(to) > 8.64e15) fail('invalid bounded window');
  if (!Number.isInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 100_000) fail('invalid occurrence bound');
  if (!Number.isInteger(maxWork) || maxWork < 1 || maxWork > 2_000_000) fail('invalid aggregate work bound');
  const components = [...(doc.master ? [doc.master] : []), ...doc.overrides];
  if (components.some(c => c.raw === null)) fail('raw provenance is required to qualify transparency');
  exportICSSource(doc); // Reparses raw and proves agreement before projection.
  const transparencies = new Map(components.map(component => [component, admitRaw(component.raw!)]));
  for (const raw of doc.rawProperties) {
    const line = raw.replace(/\r?\n[ \t]/g, '');
    if (/^METHOD[;:]/i.test(line) && !/^METHOD:PUBLISH\r?\n?$/i.test(line)) fail('scheduling METHOD requires a separate revision/cancellation contract');
  }
  for (const override of doc.overrides) if (override.rrule || override.rdates.length || override.exdates.length) fail('nested recurrence on an override is unqualified');
  const ranges = doc.overrides.filter(c => c.range === 'THISANDFUTURE');
  if (!doc.master && ranges.length) fail('detached RANGE has no original series clock');
  // RFC 5545 explicitly propagates RANGE timing/duration, not TRANSP changes.
  // Qualify unchanged free/busy semantics; do not invent an inheritance rule.
  for (const range of ranges) if (range.status !== 'cancelled' && transparencies.get(range) !== transparencies.get(doc.master!)) fail('RANGE transparency change is unqualified');
  if (doc.master?.status === 'cancelled') {
    if (doc.overrides.some(c => c.status !== 'cancelled')) fail('live exception under cancelled master needs revision reconciliation');
    return { occurrences: [], count: 0 };
  }
  let largestShift = 0, largestEndSpan = DAY, horizon = to, ruleHorizon = to;
  const admitEndSpan = (start: SourceTime | null, end: SourceEnd | null) => {
    charge();
    if (!start || !end) return;
    if (end.kind === 'duration') { const d = duration(end.value); largestEndSpan = Math.max(largestEndSpan, d.days * DAY + d.elapsed); }
    else if (end.kind === 'dtend') largestEndSpan = Math.max(largestEndSpan, Math.abs(epoch(civil(end.value)) - epoch(civil(start))) + 4 * DAY);
  };
  for (const component of components) {
    charge();
    admitEndSpan(component.dtstart, component.end);
    for (const rdate of component.rdates) if (rdate.kind === 'period') admitEndSpan(rdate.start, rdate.end);
    for (const time of [component.dtstart, 'recurrenceId' in component ? component.recurrenceId as SourceTime : null, component.end?.kind === 'dtend' ? component.end.value : null,
      ...component.exdates, ...component.rdates.flatMap(date => date.kind === 'time' ? [date.value] : [date.start, ...(date.end.kind === 'dtend' ? [date.end.value] : [])])]) {
      charge();
      if (time) horizon = Math.max(horizon, epoch(civil(time)) + 2 * DAY);
    }
    if ('recurrenceId' in component) ruleHorizon = Math.max(ruleHorizon, epoch(civil(component.recurrenceId as SourceTime)) + 2 * DAY);
  }
  for (const range of ranges) {
    if (!doc.master?.dtstart || !sameClock(doc.master.dtstart, range.recurrenceId)) fail('RANGE original clock differs from master');
    if (range.status !== 'cancelled') {
      if (!range.dtstart || !sameClock(range.dtstart, range.recurrenceId)) fail('cross-clock RANGE is unqualified');
      largestShift = Math.max(largestShift, Math.abs(epoch(civil(range.dtstart)) - epoch(civil(range.recurrenceId))));
    }
  }
  horizon += largestShift + largestEndSpan + 4 * DAY;
  ruleHorizon += largestShift + 2 * DAY;
  const clock = createSourceClock({ timezones: doc.timezones, floatingTimezone: options.floatingTimezone, dateTimezone: options.dateTimezone, through: horizon, maxWork, consumeWork: charge });
  const instant = (time: SourceTime) => { const result = clock.resolve(time, 'explicit'); if (result === null) fail('explicit source time unresolved'); return result; };
  const dateEndFor = (start: SourceTime, end: SourceEnd, reference: SourceTime): SourceTime | null => {
    if (start.kind !== 'date') return null;
    if (end.kind === 'default') return shifted(start, DAY);
    if (end.kind === 'duration') return shifted(start, duration(end.value).days * DAY);
    if (end.value.kind !== 'date' || reference.kind !== 'date') fail('DATE end requires Gregorian DATE reference');
    return shifted(start, epoch(civil(end.value)) - epoch(civil(reference)));
  };
  const endFor = (start: SourceTime, end: SourceEnd, reference: SourceTime): number => {
    charge();
    const at = instant(start);
    const dateEnd = dateEndFor(start, end, reference);
    if (dateEnd) return instant(dateEnd);
    if (end.kind === 'default') return at;
    if (end.kind === 'dtend') {
      return at + instant(end.value) - instant(reference);
    }
    const delta = duration(end.value);
    return instant(shifted(start, delta.days * DAY)) + delta.elapsed;
  };
  const slots = new Map<string, { original: SourceTime; end: SourceEnd | null }>();
  const add = (time: SourceTime, end: SourceEnd | null = null) => {
    charge();
    const previous = slots.get(key(time));
    if (previous?.end && end && JSON.stringify(previous.end) !== JSON.stringify(end)) fail('conflicting duplicate PERIOD ends');
    slots.set(key(time), { original: time, end: end ?? previous?.end ?? null });
    if (slots.size > maxOccurrences) fail('occurrence bound exhausted');
  };
  const master = doc.master;
  if (master?.dtstart) {
    add(master.dtstart);
    if (master.rrule) for (const item of expandSourceRule({ start: master.dtstart, rule: master.rrule, through: ruleHorizon, maxWork, maxOccurrences, consumeWork: () => charge(),
      resolve: p => clock.resolve(shifted(master.dtstart!, epoch(p) - epoch(civil(master.dtstart!))), master.dtstart!.kind === 'date' ? 'explicit' : 'generated'),
      resolveStart: p => clock.resolve(shifted(master.dtstart!, epoch(p) - epoch(civil(master.dtstart!))), 'explicit') })) add(item.original);
    for (const rdate of master.rdates) add(rdate.kind === 'time' ? rdate.value : rdate.start, rdate.kind === 'period' ? rdate.end : null);
  } else for (const override of doc.overrides) add(override.recurrenceId);
  // Different typed clocks at an identical instant have no unambiguous original
  // identity for later RANGE/exception matching. Require explicit normalization.
  const instants = new Map<number, SourceTime>();
  for (const slot of slots.values()) { const at = instant(slot.original), prior = instants.get(at); if (prior && !sameClock(prior, slot.original)) fail('cross-clock duplicate recurrence identity is unqualified'); instants.set(at, slot.original); }
  const overrides = new Map<string, ImportedSourceOverride>();
  for (const override of doc.overrides) {
    charge();
    if (!slots.has(key(override.recurrenceId))) fail('override does not identify an original recurrence instance');
    overrides.set(key(override.recurrenceId), override);
  }
  const orderedRanges = [...ranges].sort((a, b) => { charge(); return epoch(civil(a.recurrenceId)) - epoch(civil(b.recurrenceId)); });
  let cancelledRange = false;
  for (const range of orderedRanges) { charge(); if (cancelledRange && range.status !== 'cancelled') fail('RANGE reactivation after cancellation requires revision reconciliation'); cancelledRange ||= range.status === 'cancelled'; }
  const rangeFor = (original: SourceTime): ImportedSourceOverride | undefined => {
    let low = 0, high = orderedRanges.length;
    const at = epoch(civil(original));
    while (low < high) { charge(); const mid = Math.floor((low + high) / 2); if (epoch(civil(orderedRanges[mid].recurrenceId)) <= at) low = mid + 1; else high = mid; }
    return low ? orderedRanges[low - 1] : undefined;
  };
  if (orderedRanges.length && [...slots.values()].some(slot => !sameClock(slot.original, master!.dtstart!))) fail('RANGE over cross-clock RDATE is unqualified');
  const excludedKeys = new Set(master?.exdates.map(key) ?? []);
  const excludedInstants = new Set(master?.exdates.filter(time => time.kind !== 'date').map(instant) ?? []);
  const occurrences: SourceOccurrence[] = [];
  for (const slot of slots.values()) {
    charge();
    const original = slot.original;
    if (excludedKeys.has(key(original)) || original.kind !== 'date' && excludedInstants.has(instant(original))) continue; // EXDATE never replenishes COUNT; DATE stays a civil identity.
    const exact = overrides.get(key(original));
    const range = rangeFor(original);
    const component: ImportedSourceComponent | undefined = exact ?? range ?? master ?? undefined;
    if (!component || component.status === 'cancelled') continue;
    let start = original, end = slot.end ?? component.end;
    if (exact) { if (!exact.dtstart) fail('live exception has no DTSTART'); start = exact.dtstart; end = exact.end; }
    else if (range) { start = shifted(original, epoch(civil(range.dtstart!)) - epoch(civil(range.recurrenceId))); end = range.end; }
    if (!end) fail('live occurrence has no end semantics');
    const reference = exact?.dtstart ?? range?.dtstart ?? (slot.end ? original : master?.dtstart) ?? original;
    const begins = instant(start), ends = endFor(start, end, reference);
    if (!Number.isFinite(ends) || ends < begins) fail('invalid occurrence end');
    if (!(begins < to && (ends > from || ends === begins && begins >= from))) continue;
    occurrences.push({ id: JSON.stringify([doc.uid, original.kind, original.kind === 'zoned' ? original.tzid : null, original.value]), uid: doc.uid, original,
      startsAt: new Date(begins).toISOString(), endsAt: new Date(ends).toISOString(), sourceStart: start, sourceEndDate: dateEndFor(start, end, reference)?.value ?? null,
      transparency: transparencies.get(component)!, allDay: start.kind === 'date', title: component.title, description: component.description, location: component.location, status: component.status });
  }
  occurrences.sort((a, b) => { charge(); return a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id); });
  return { occurrences, count: occurrences.length };
}
