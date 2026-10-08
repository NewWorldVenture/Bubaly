/** Held integration foundation. No existing calendar reader calls this module.
 * A single server snapshot prevents a legacy-row/archive takeover from being
 * observed halfway through two separate HTTP reads. Imported refs never name a
 * calendar_events row and must not be passed to native mutation adapters. */
import type { CalendarWindowBounds } from '../briefing/calendar-window';
import { allDayBusyInterval } from './event-dates';
import { expandEventsInZone } from './recurrence';
import { parseImportedSource, type ImportedSourceDocument, type ImportedSourceComponent, type ImportedSourceOverride, type SourceTime } from './imported-source';
import { expandSourceOccurrences } from './source-occurrences';
import { exportICSSource } from '../sync/ics-source-export';

type Obj = Record<string, unknown>;
export type CalendarSnapshotReference = { kind: 'native'; eventId: string } | {
  kind: 'source'; feedId: string; uid: string; revisionId: string; original: SourceTime;
};
export interface SnapshotNativeRow {
  id: string; family_id: string; title: string; description: string | null; location: string | null;
  starts_at: string; ends_at: string | null; all_day: boolean; recurrence: string; recurrence_until: string | null;
  feed_id: string | null; external_uid: string | null; assignee_id: string | null; source_recurrence: null;
}
export interface SnapshotSourceGroup {
  feedId: string; uid: string; revisionId: string; materializationState: 'ready'; document: ImportedSourceDocument;
  masterCancellationRevisionId: string | null;
  watermarks: { componentKey: string; versionComponent: ImportedSourceComponent | ImportedSourceOverride;
    versionRevisionId: string; cancelledComponent: ImportedSourceComponent | ImportedSourceOverride | null; cancellationRevisionId: string | null }[];
}
export interface CalendarSourceSnapshot {
  version: 1; familyId: string; nativeRows: SnapshotNativeRow[]; nativeCount: number;
  sourceGroups: SnapshotSourceGroup[]; sourceCount: number; watermarkCount: number;
}
export interface SnapshotOccurrence {
  reference: CalendarSnapshotReference; occurrenceKey: string; readOnly: boolean;
  title: string | null; description: string | null; location: string | null; all_day: boolean;
  /** Display DATEs are UTC civil midnight, never family-zone instants. */
  starts_at: string; ends_at: string | null; startDate: string | null; endDate: string | null;
  actualStartsAt: string; actualEndsAt: string | null;
}
function fail(reason: string): never { throw new Error(`Calendar source snapshot unavailable: ${reason}`); }
function object(value: unknown, keys?: readonly string[]): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
  const row = value as Obj;
  if (keys && (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))) fail('missing or unknown fields');
  return row;
}
function text(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 8192) fail('invalid text identity'); return value; }
function uuid(value: unknown): string { const result = text(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) fail('invalid UUID'); return result.toLowerCase(); }
function nullableText(value: unknown): string | null { if (value === null) return null; if (typeof value !== 'string' || value.length > 65_536) fail('invalid nullable text'); return value; }
function instant(value: unknown): string {
  const token = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(token) || !Number.isFinite(Date.parse(token))) fail('invalid native instant');
  if (+token.slice(0,4) < 1 || +token.slice(11,13) > 23 || +token.slice(14,16) > 59 || +token.slice(17,19) > 59) fail('invalid native clock');
  const at = new Date(token).toISOString();
  // Date.parse normalizes impossible Gregorian days; reject them before the
  // offset conversion, while allowing PostgreSQL's variable precision.
  const day = token.slice(0,10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) !== day) fail('invalid native Gregorian date');
  return at;
}
function count(value: unknown, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail('invalid collection count'); return value as number; }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) fail('collection bound exceeded'); return value; }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Obj)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Refuse accessors, cycles and oversized input before JSON serialization. */
function boundedCopy(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const active = new Set<object>(), encoder = new TextEncoder();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 400_000 || depth > 24) fail('traversal bound exceeded');
    if (typeof item === 'string') {
      if (/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(item)) fail('non-JSONB text');
      bytes += encoder.encode(item).length + 2;
    } else if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) bytes += 24;
    else if (item && typeof item === 'object') {
      const proto: unknown = Object.getPrototypeOf(item);
      if (active.has(item) || (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)) fail('non-JSON object');
      if (Array.isArray(item) && (item.length > 400_000 - nodes || Object.keys(item).length !== item.length || Object.keys(item).some((key,index) => key !== String(index)))) fail('oversized or decorated array');
      active.add(item);
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        if (typeof key !== 'string') fail('symbol key');
        if (/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(key)) fail('non-JSONB key');
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) fail('accessor or hidden field');
        bytes += encoder.encode(key).length + 4; visit(descriptor.value, depth + 1);
      }
      active.delete(item);
    } else fail('non-JSON value');
    if (bytes > 8_388_608) fail('8 MiB snapshot bound exceeded');
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (encoder.encode(json).length > 8_388_608) fail('8 MiB snapshot bound exceeded');
  return JSON.parse(json) as unknown;
}
function componentKey(component: ImportedSourceComponent | ImportedSourceOverride): string {
  return 'recurrenceId' in component ? stable(['override', component.recurrenceId.kind, component.recurrenceId.kind === 'zoned' ? component.recurrenceId.tzid : null, component.recurrenceId.value]) : 'master';
}
function canonicalKey(value: unknown): string {
  const key = text(value);
  if (key === 'master') return key;
  try { const parsed: unknown = JSON.parse(key); if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 'override') fail('invalid component key'); return stable(parsed); }
  catch { return fail('invalid component key'); }
}
function newer(a: ImportedSourceComponent, b: ImportedSourceComponent): boolean {
  for (const field of ['sequence', 'dtstamp', 'lastModified'] as const) {
    const left = a.revision[field], right = b.revision[field];
    if ((left === null) !== (right === null)) return false;
    if (left !== null && right !== null && left !== right) return left > right;
  }
  return false;
}
function historicComponent(value: unknown, doc: ImportedSourceDocument, key: string): ImportedSourceComponent | ImportedSourceOverride {
  const wrapped = parseImportedSource({ ...doc, master: key === 'master' ? value : null, overrides: key === 'master' ? [] : [value] });
  const component = wrapped.master ?? wrapped.overrides[0];
  if (!component || componentKey(component) !== key) fail('watermark identity mismatch');
  return component;
}

/** Strict admission of the version-1 SQL contract, not a permissive UI decoder. */
export function parseCalendarSourceSnapshot(value: unknown, expectedFamilyId: string): CalendarSourceSnapshot {
  const envelope = object(boundedCopy(value), ['version', 'familyId', 'nativeRows', 'nativeCount', 'sourceGroups', 'sourceCount', 'watermarkCount']);
  const familyId = uuid(envelope.familyId);
  if (envelope.version !== 1 || familyId !== uuid(expectedFamilyId)) fail('version or family mismatch');
  const nativeCount = count(envelope.nativeCount, 20_000), sourceCount = count(envelope.sourceCount, 2000), watermarkCount = count(envelope.watermarkCount, 40_000);
  const nativeIds = new Set<string>(), groupIds = new Set<string>();
  const nativeRows = list(envelope.nativeRows, 20_000).map(value => {
    const row = object(value);
    const required = ['id','family_id','title','description','location','category','starts_at','ends_at','all_day','recurrence','recurrence_until','assignee_id','feed_id','external_uid','created_by','onboarding_key','idempotency_key','created_at','updated_at','source_recurrence'];
    object(row, required);
    const id = uuid(row.id);
    if (nativeIds.has(id) || uuid(row.family_id) !== familyId) fail('duplicate or foreign native row');
    nativeIds.add(id);
    if (row.source_recurrence !== null) fail('unreconciled legacy source projection');
    for (const field of ['starts_at','created_at','updated_at']) row[field] = instant(row[field]);
    for (const field of ['ends_at','recurrence_until']) if (row[field] !== null) row[field] = instant(row[field]);
    for (const field of ['description','location','external_uid','onboarding_key','idempotency_key']) nullableText(row[field]);
    for (const field of ['assignee_id','feed_id','created_by']) if (row[field] !== null) uuid(row[field]);
    if (typeof row.title !== 'string' || row.title.length > 65_536 || typeof row.all_day !== 'boolean' || !['none','daily','weekly','monthly','yearly'].includes(text(row.recurrence)) || !['general','school','sports','appointment','medication','maintenance','birthday','holiday','other'].includes(text(row.category))) fail('invalid native fields');
    if (row.ends_at !== null && Date.parse(row.ends_at as string) < Date.parse(row.starts_at as string)) fail('reversed native interval');
    if (row.all_day && (!(row.starts_at as string).endsWith('T00:00:00.000Z') || row.ends_at !== null && (!(row.ends_at as string).endsWith('T00:00:00.000Z') || row.ends_at === row.starts_at))) fail('native DATE must use positive UTC civil boundaries');
    return { ...row, id, family_id: familyId } as unknown as SnapshotNativeRow;
  });
  if (nativeRows.filter(row => row.recurrence !== 'none').length > 2000) fail('native series count exceeds 2000');
  let totalWatermarks = 0;
  const sourceGroups = list(envelope.sourceGroups, 2000).map(value => {
    const row = object(value, ['feedId','uid','revisionId','materializationState','document','masterCancellationRevisionId','watermarks']);
    const feedId = uuid(row.feedId), uid = text(row.uid), revisionId = uuid(row.revisionId), id = stable([feedId, uid]);
    if (groupIds.has(id) || row.materializationState !== 'ready') fail('duplicate or review-held source group');
    groupIds.add(id);
    const document = parseImportedSource(row.document);
    if (document.uid !== uid) fail('document UID mismatch');
    exportICSSource(document); // Complete raw provenance and typed agreement.
    const components = new Map([...(document.master ? [document.master] : []), ...document.overrides].map(c => [componentKey(c), c]));
    const seen = new Set<string>();
    const watermarks = list(row.watermarks, 20_000).map(value => {
      const watermark = object(value, ['componentKey','versionComponent','versionRevisionId','cancelledComponent','cancellationRevisionId']);
      const key = canonicalKey(watermark.componentKey), current = components.get(key);
      if (seen.has(key) || !current) fail('duplicate or omitted historical component');
      seen.add(key);
      const versionComponent = historicComponent(watermark.versionComponent, document, key);
      if (stable(versionComponent) !== stable(current)) fail('watermark/current component conflict');
      const versionRevisionId = uuid(watermark.versionRevisionId);
      const cancellationRevisionId = watermark.cancellationRevisionId === null ? null : uuid(watermark.cancellationRevisionId);
      const cancelledComponent = watermark.cancelledComponent === null ? null : historicComponent(watermark.cancelledComponent, document, key);
      if ((cancelledComponent === null) !== (cancellationRevisionId === null) || cancelledComponent && (cancelledComponent.status !== 'cancelled' || current.status !== 'cancelled' && !newer(current, cancelledComponent))) fail('unresolved cancellation watermark');
      if (current.status === 'cancelled' && !cancelledComponent) fail('missing cancellation watermark');
      if (current.status === 'cancelled' && (stable(cancelledComponent) !== stable(current) || cancellationRevisionId !== revisionId)) fail('cancelled current component pointer conflict');
      return { componentKey: key, versionComponent, versionRevisionId, cancelledComponent, cancellationRevisionId };
    });
    totalWatermarks += watermarks.length;
    if (seen.size !== components.size) fail('incomplete component watermarks');
    const masterCancellationRevisionId = row.masterCancellationRevisionId === null ? null : uuid(row.masterCancellationRevisionId);
    if (document.master?.status === 'cancelled' && masterCancellationRevisionId !== revisionId) fail('missing current master cancellation pointer');
    if (masterCancellationRevisionId && (document.master?.status !== 'cancelled' || document.overrides.some(c => c.status !== 'cancelled'))) fail('unresolved master cancellation');
    return { feedId, uid, revisionId, document, materializationState: 'ready' as const, masterCancellationRevisionId, watermarks };
  });
  if (nativeRows.length !== nativeCount || sourceGroups.length !== sourceCount || totalWatermarks !== watermarkCount) fail('incomplete snapshot counts');
  for (const native of nativeRows) if (native.feed_id && native.external_uid) {
    const uid = native.external_uid.split('\u001f')[0];
    if (groupIds.has(stable([native.feed_id.toLowerCase(), uid]))) fail('ambiguous native/archive UID overlap');
  }
  return { version: 1, familyId, nativeRows, nativeCount, sourceGroups, sourceCount, watermarkCount };
}

export interface CalendarSnapshotTransport { rpc(name: 'calendar_read_occurrence_inputs', args: { p_family_id: string }): PromiseLike<{ data: unknown; error: { message: string } | null }> }
export async function readCalendarSourceSnapshot(db: CalendarSnapshotTransport, familyId: string): Promise<CalendarSourceSnapshot> {
  const family = uuid(familyId);
  const result = await db.rpc('calendar_read_occurrence_inputs', { p_family_id: family });
  if (result.error) fail(result.error.message);
  return parseCalendarSourceSnapshot(result.data, family);
}
function civilISO(value: string): string { return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`; }
function dateInstant(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid civil bound');
  const at = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0,10) !== value) fail('invalid civil bound');
  return at;
}
/** Complete family window with a shared work/output bound. Throws atomically;
 * callers must not display a prefix if any UID cannot be qualified. */
export function materializeCalendarSourceSnapshot(value: unknown, options: { familyId: string; bounds: CalendarWindowBounds; timezone: string; maxWork?: number; maxOccurrences?: number }): { occurrences: SnapshotOccurrence[]; count: number } {
  const snapshot = parseCalendarSourceSnapshot(value, options.familyId);
  const maxWork = options.maxWork ?? 2_000_000, maxOccurrences = options.maxOccurrences ?? 20_000;
  if (!Number.isSafeInteger(maxWork) || maxWork < 1 || maxWork > 20_000_000 || !Number.isSafeInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 100_000) fail('invalid family bounds');
  new Intl.DateTimeFormat('en', { timeZone: options.timezone });
  const { bounds } = options, timedFrom = Date.parse(instant(bounds.timedFrom)), timedTo = Date.parse(instant(bounds.timedTo)), dateFrom = dateInstant(bounds.allDayFromDay), dateTo = dateInstant(bounds.allDayToDay);
  if (![timedFrom,timedTo].every(Number.isFinite) || timedTo < timedFrom || dateTo <= dateFrom) fail('invalid window');
  let work = 0;
  const charge = (amount: number) => { work += amount; if (work > maxWork) fail('family work bound exhausted'); };
  const occurrences: SnapshotOccurrence[] = [];
  const add = (row: SnapshotOccurrence) => { charge(1); if (occurrences.length >= maxOccurrences) fail('family occurrence bound exhausted'); occurrences.push(row); };
  for (const row of snapshot.nativeRows) {
    // Reserve the native engine's full bounded search allowance, including
    // candidates discarded by overlap filtering. No copied native engine.
    charge(row.recurrence === 'none' ? 1 : 508);
    const from = row.all_day ? dateFrom : timedFrom, to = row.all_day ? dateTo : timedTo;
    if (from === to) continue;
    const candidates = row.recurrence === 'none' ? [row] : expandEventsInZone([row], new Date(from), new Date(to), row.all_day ? 'UTC' : options.timezone, true, { requireComplete: true });
    for (const candidate of candidates) {
      const start = Date.parse(candidate.starts_at), end = candidate.ends_at ? Date.parse(candidate.ends_at) : start + (row.all_day ? 86_400_000 : 3_600_000);
      if (!(start < to && (end > from || end === start && start >= from))) continue;
      const busy = candidate.all_day ? allDayBusyInterval(candidate, options.timezone) : null;
      add({ reference: { kind: 'native', eventId: row.id }, occurrenceKey: stable(['native',row.id,candidate.starts_at]), readOnly: row.feed_id !== null || row.external_uid !== null,
        title: row.title, description: row.description, location: row.location, all_day: row.all_day, starts_at: candidate.starts_at, ends_at: candidate.ends_at,
        startDate: row.all_day ? candidate.starts_at.slice(0,10) : null, endDate: row.all_day ? new Date((candidate.ends_at ? Date.parse(candidate.ends_at) : start + 86_400_000)).toISOString().slice(0,10) : null,
        actualStartsAt: busy ? new Date(busy.start).toISOString() : candidate.starts_at, actualEndsAt: busy ? new Date(busy.end).toISOString() : new Date(end).toISOString() });
    }
  }
  for (const group of snapshot.sourceGroups) {
    charge(1);
    const common = { floatingTimezone: options.timezone, maxWork: Math.min(maxWork,2_000_000), maxOccurrences, consumeWork: charge };
    const timed = timedFrom === timedTo ? [] : expandSourceOccurrences(group.document, { ...common, from: timedFrom, to: timedTo, dateTimezone: options.timezone }).occurrences.filter(c => !c.allDay);
    const dates = expandSourceOccurrences(group.document, { ...common, from: dateFrom, to: dateTo, dateTimezone: 'UTC' }).occurrences.filter(c => c.allDay);
    for (const occurrence of [...timed,...dates]) {
      const startDate = occurrence.allDay ? civilISO(occurrence.sourceStart.value) : null, endDate = occurrence.sourceEndDate ? civilISO(occurrence.sourceEndDate) : null;
      const starts_at = startDate ? `${startDate}T00:00:00.000Z` : occurrence.startsAt, ends_at = endDate ? `${endDate}T00:00:00.000Z` : occurrence.endsAt;
      const busy = occurrence.allDay ? allDayBusyInterval({ starts_at, ends_at, all_day: true }, options.timezone) : null;
      add({ reference: { kind: 'source', feedId: group.feedId, uid: group.uid, revisionId: group.revisionId, original: occurrence.original }, occurrenceKey: stable(['source',group.feedId,group.uid,occurrence.original]), readOnly: true,
        title: occurrence.title, description: occurrence.description, location: occurrence.location, all_day: occurrence.allDay, starts_at, ends_at, startDate, endDate,
        actualStartsAt: busy ? new Date(busy.start).toISOString() : occurrence.startsAt, actualEndsAt: busy ? new Date(busy.end).toISOString() : occurrence.endsAt });
    }
  }
  occurrences.sort((a,b) => { charge(1); return a.starts_at.localeCompare(b.starts_at) || a.occurrenceKey.localeCompare(b.occurrenceKey); });
  return { occurrences, count: occurrences.length };
}
