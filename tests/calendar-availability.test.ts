import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import type { ImportedSourceComponent, ImportedSourceOverride } from '@/lib/calendar/imported-source';
import { parseICSSource } from '@/lib/sync/ics-source';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import * as display from '@/lib/calendar/display-occurrences';
import { readCalendarAvailability } from '@/lib/calendar/availability';

const capability = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return capability.enabled; } }));
const FAMILY = '10000000-0000-4000-8000-000000000001', FEED = '20000000-0000-4000-8000-000000000001';
const REVISION = '30000000-0000-4000-8000-000000000001', MEMBER = '50000000-0000-4000-8000-000000000001';
const day = '2026-10-08';
function native(index = 1, patch: Partial<Tables<'calendar_events'>> = {}) {
  return { id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`, family_id: FAMILY, title: `Native ${index}`, description: null, location: null, category: 'general',
    starts_at: `${day}T09:00:00Z`, ends_at: `${day}T10:00:00Z`, all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
    created_by: null, onboarding_key: null, idempotency_key: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', source_recurrence: null, ...patch } as Tables<'calendar_events'> & { source_recurrence: null };
}
function source(events = ['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nSUMMARY:Synthetic source'], uid = 'synthetic-source') {
  return parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic availability//EN\r\n${events.map(body => `BEGIN:VEVENT\r\nUID:${uid}\r\n${body}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`)[0];
}
function group(document = source(), feedId = FEED) {
  const components: (ImportedSourceComponent | ImportedSourceOverride)[] = [...(document.master ? [document.master] : []), ...document.overrides];
  return { feedId, uid: document.uid, revisionId: REVISION, materializationState: 'ready', document,
    masterCancellationRevisionId: document.master?.status === 'cancelled' ? REVISION : null,
    watermarks: components.map(component => ({ componentKey: 'recurrenceId' in component
      ? JSON.stringify(['override', component.recurrenceId.kind, component.recurrenceId.kind === 'zoned' ? component.recurrenceId.tzid : null, component.recurrenceId.value]) : 'master',
    versionComponent: structuredClone(component), versionRevisionId: REVISION, cancelledComponent: component.status === 'cancelled' ? structuredClone(component) : null,
    cancellationRevisionId: component.status === 'cancelled' ? REVISION : null })) };
}
function snapshot(groups = [group()], nativeRows = [native()]) {
  return { version: 1, familyId: FAMILY, nativeRows, nativeCount: nativeRows.length, sourceGroups: groups, sourceCount: groups.length, watermarkCount: groups.reduce((sum, item) => sum + item.watermarks.length, 0) };
}
function sdk({ rows = [native()], value = snapshot(), cap = 2, lateFailure = false, countDrift = false, missingCount = false, rpcStatus = 200 }: {
  rows?: ReturnType<typeof native>[]; value?: unknown; cap?: number; lateFailure?: boolean; countDrift?: boolean; missingCount?: boolean; rpcStatus?: number;
} = {}) {
  const calls: { url: URL; body: unknown }[] = [];
  const db = createClient<Database>('https://availability-sdk.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname.includes('/rpc/')) return Response.json(value, { status: rpcStatus });
    expect(url.pathname).toBe('/rest/v1/calendar_events'); expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
    expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
    const collection = url.searchParams.has('recurrence') ? rows.filter(row => row.recurrence !== 'none') : rows.filter(row => row.recurrence === 'none');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (offset && lateFailure) return Response.json({ code: '42501', message: 'Synthetic later page denied' }, { status: 403 });
    const page = collection.slice(offset, offset + Math.min(cap, Number(url.searchParams.get('limit') ?? cap)));
    const total = collection.length + (offset && countDrift ? 1 : 0);
    return Response.json(page, { headers: missingCount ? {} : { 'content-range': `${offset}-${offset + page.length - 1}/${total}` } });
  } } });
  return { db, calls };
}
const bounds = briefingCalendarBounds(day, 'UTC', 0, 1);
beforeEach(() => { capability.enabled = false; });
afterEach(() => vi.restoreAllMocks());

describe('staged complete calendar availability through actual SDK and projection', () => {
  it('completes capped native pages and preserves native/member/family identities', async () => {
    const probe = sdk({ rows: [native(1, { assignee_id: MEMBER }), native(2), native(3)] });
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.count).toBe(3); expect(result.data?.every(row => row.occupied && row.transparency === 'opaque')).toBe(true);
    expect(result.data?.find(row => row.kind === 'native' && row.event.id === native(1).id)?.attribution).toEqual({ kind: 'member', memberId: MEMBER });
    expect(result.data?.find(row => row.kind === 'native' && row.event.id === native(2).id)?.attribution).toEqual({ kind: 'family', reason: 'native-unassigned' });
    expect(probe.calls.every(call => !call.url.pathname.includes('/rpc/'))).toBe(true);
    expect(probe.calls.filter(call => !call.url.searchParams.has('recurrence')).map(call => call.url.searchParams.get('offset') ?? '0')).toEqual(['0', '2']);
  });
  for (const fault of ['lateFailure', 'countDrift', 'missingCount'] as const) it(`refuses ${fault} rather than declaring a native prefix free`, async () => {
    const probe = sdk({ rows: [native(1), native(2), native(3)], [fault]: true });
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC'); expect(result.data).toBeNull(); expect(result.count).toBeNull(); expect(result.error).not.toBeNull();
  });
  it('reads one coherent source/native snapshot without another native query or fake source ID', async () => {
    capability.enabled = true; const probe = sdk();
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.count).toBe(2); expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].url.pathname).toBe('/rest/v1/rpc/calendar_read_occurrence_inputs'); expect(probe.calls[0].body).toEqual({ p_family_id: FAMILY });
    const imported = result.data?.find(row => row.kind === 'source');
    expect(imported).toMatchObject({ readOnly: true, transparency: 'opaque', occupied: true, estimatedEnd: false, attribution: { kind: 'family', reason: 'source-unmapped' }, reference: { kind: 'source', feedId: FEED, uid: 'synthetic-source', revisionId: REVISION } });
    expect(imported).not.toHaveProperty('id'); expect(imported).not.toHaveProperty('event');
  });
  it('retains transparent records in the complete count without occupying any time', async () => {
    capability.enabled = true; const probe = sdk({ value: snapshot([group(source(['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nTRANSP:TRANSPARENT']))], []) });
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.count).toBe(1); expect(result.data?.[0]).toMatchObject({ transparency: 'transparent', occupied: false, point: false, interval: { start: Date.parse(`${day}T09:00Z`), end: Date.parse(`${day}T10:00Z`) } });
  });
  it('keeps source default points distinct from native null-end estimates', async () => {
    capability.enabled = true; const probe = sdk({ value: snapshot([group(source(['DTSTART:20261008T090000Z']))], [native(1, { ends_at: null }), native(2, { ends_at: `${day}T09:00:00Z` })]) });
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.count).toBe(3);
    expect(result.data?.find(row => row.kind === 'source')).toMatchObject({ point: true, occupied: false, estimatedEnd: false });
    expect(result.data?.find(row => row.kind === 'native' && row.event.id === native(1).id)).toMatchObject({ point: false, occupied: true, estimatedEnd: true });
    expect(result.data?.find(row => row.kind === 'native' && row.event.id === native(2).id)).toMatchObject({ point: true, occupied: false, estimatedEnd: false });
  });
  for (const enabled of [false, true]) for (const zone of [undefined, null, '', '  ', 'Mars/Olympus']) it(`refuses explicit invalid zone ${String(zone)} before transport, gate=${enabled}`, async () => {
    capability.enabled = enabled; const probe = sdk(); const result = await readCalendarAvailability(probe.db, FAMILY, bounds, zone as string);
    expect(result.data).toBeNull(); expect(result.count).toBeNull(); expect(probe.calls).toEqual([]);
  });
  for (const fault of ['family', 'counts', 'held', 'duplicate', 'legacy-overlap', 'permission'] as const) it(`refuses whole enabled snapshot ${fault} without a native fallback`, async () => {
    capability.enabled = true; const value = snapshot();
    if (fault === 'family') value.familyId = '10000000-0000-4000-8000-000000000099';
    if (fault === 'counts') value.sourceCount++;
    if (fault === 'held') value.sourceGroups[0].materializationState = 'review';
    if (fault === 'duplicate') { value.sourceGroups.push(value.sourceGroups[0]); value.sourceCount++; value.watermarkCount *= 2; }
    if (fault === 'legacy-overlap') { value.nativeRows[0].feed_id = FEED; value.nativeRows[0].external_uid = 'synthetic-source'; }
    const probe = sdk({ value, rpcStatus: fault === 'permission' ? 403 : 200 });
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC'); expect(result.data).toBeNull(); expect(result.count).toBeNull(); expect(probe.calls).toHaveLength(1);
  });
  it('keeps equal UIDs in different feeds distinct and never assigns source attendees to a member', async () => {
    capability.enabled = true; const document = source(['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nATTENDEE:mailto:synthetic@example.invalid']);
    const probe = sdk({ value: snapshot([group(document), group(document, '20000000-0000-4000-8000-000000000002')], []) });
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.count).toBe(2); expect(new Set(result.data?.map(row => row.occurrenceKey)).size).toBe(2);
    expect(result.data?.every(row => row.attribution.kind === 'family' && row.assignee_id === null && row.readOnly)).toBe(true);
  });
  it('includes moved-in instances, excludes cancellations, and retains original identity', async () => {
    capability.enabled = true; const document = source(['DTSTART:20261001T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=2', 'RECURRENCE-ID:20261001T090000Z\r\nDTSTART:20261008T110000Z\r\nDURATION:PT2H', 'RECURRENCE-ID:20261002T090000Z\r\nSTATUS:CANCELLED']);
    const probe = sdk({ value: snapshot([group(document)], []) }), result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.count).toBe(1); expect(result.data?.[0]).toMatchObject({ actualStartsAt: `${day}T11:00:00.000Z`, occupied: true, reference: { kind: 'source', original: { kind: 'utc', value: '20261001T090000Z' } } });
  });
  it('clips an overnight source interval only after complete expansion and uses half-open boundaries', async () => {
    capability.enabled = true; const probe = sdk({ value: snapshot([group(source(['DTSTART:20261007T230000Z\r\nDURATION:PT3H']))], []) });
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.data?.[0]).toMatchObject({ actualStartsAt: '2026-10-07T23:00:00.000Z', interval: { start: Date.parse(`${day}T00:00Z`), end: Date.parse(`${day}T02:00Z`) }, occupied: true });
    const touching = sdk({ value: snapshot([group(source(['DTSTART:20261007T230000Z\r\nDURATION:PT1H']))], []) });
    expect((await readCalendarAvailability(touching.db, FAMILY, bounds, 'UTC')).count).toBe(0);
  });
  for (const [date, hours] of [['2026-03-08', 23], ['2026-11-01', 25]] as const) it(`projects civil DATE onto ${hours}-hour LA day without UTC-midnight occupancy`, async () => {
    capability.enabled = true; const compact = date.replaceAll('-', ''), probe = sdk({ value: snapshot([group(source([`DTSTART;VALUE=DATE:${compact}`]))], []) });
    const local = briefingCalendarBounds(date, 'America/Los_Angeles', 0, 1), result = await readCalendarAvailability(probe.db, FAMILY, local, 'America/Los_Angeles');
    expect(result.error).toBeNull(); expect(result.data?.[0]).toMatchObject({ all_day: true, startDate: date, occupied: true, point: false });
    expect(result.data![0].interval.end - result.data![0].interval.start).toBe(hours * 3_600_000);
  });
  it('rejects malformed native scope/clock instead of publishing an occupied or free prefix', async () => {
    for (const patch of [{ family_id: 'other-family' }, { starts_at: '2026-02-30T09:00:00Z' }, { ends_at: `${day}T08:00:00Z` }]) {
      const probe = sdk({ rows: [native(1), native(2, patch)] }); const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC'); expect(result.data).toBeNull(); expect(result.count).toBeNull();
    }
  });
  it('preserves publisher-owned native identity while keeping its read-only restriction', async () => {
    const probe = sdk({ rows: [native(1, { feed_id: FEED, external_uid: 'legacy-source' })] });
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.data?.[0]).toMatchObject({ kind: 'native', readOnly: true, reference: { kind: 'native', eventId: native(1).id }, occupied: true });
  });
  it('expands old native masters across a DST boundary before deriving occupancy and keys', async () => {
    const local = briefingCalendarBounds('2026-03-01', 'America/Los_Angeles', 0, 15);
    const probe = sdk({ rows: [native(1, { starts_at: '2026-03-01T17:00:00Z', ends_at: '2026-03-01T18:00:00Z', recurrence: 'weekly', assignee_id: MEMBER })] });
    const result = await readCalendarAvailability(probe.db, FAMILY, local, 'America/Los_Angeles');
    expect(result.error).toBeNull(); expect(result.count).toBe(3);
    expect(result.data?.map(row => row.actualStartsAt)).toEqual(['2026-03-01T17:00:00.000Z', '2026-03-08T16:00:00.000Z', '2026-03-15T16:00:00.000Z']);
    expect(new Set(result.data?.map(row => row.occurrenceKey)).size).toBe(3); expect(result.data?.every(row => row.occupied && row.attribution.kind === 'member')).toBe(true);
  });
  it('retains a DATE on a skipped Apia day without inventing occupied instants or a point', async () => {
    capability.enabled = true; const local = briefingCalendarBounds('2011-12-30', 'Pacific/Apia', 0, 1);
    const probe = sdk({ value: snapshot([group(source(['DTSTART;VALUE=DATE:20111230']))], []) });
    const result = await readCalendarAvailability(probe.db, FAMILY, local, 'Pacific/Apia');
    expect(result.error).toBeNull(); expect(result.count).toBe(1); expect(result.data?.[0]).toMatchObject({ all_day: true, occupied: false, point: false });
    expect(result.data![0].interval.end).toBe(result.data![0].interval.start);
  });
  it('refuses source occurrence overflow atomically rather than returning a twenty-thousand-row prefix', async () => {
    capability.enabled = true;
    const groups = Array.from({ length: 60 }, (_, index) => group(source(['DTSTART:20260101T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=366'], `bounded-source-${index}`)));
    const probe = sdk({ value: snapshot(groups, []) });
    const result = await readCalendarAvailability(probe.db, FAMILY, briefingCalendarBounds('2026-01-01', 'UTC', 0, 366), 'UTC');
    expect(result.data).toBeNull(); expect(result.count).toBeNull(); expect(probe.calls).toHaveLength(1);
  });
  // These controls deliberately corrupt the projection boundary AFTER a real
  // SDK snapshot read. They qualify the adapter, not hosted transport behavior.
  for (const corruption of ['missing-transparency', 'invalid-transparency', 'duplicate-key', 'partial-count', 'oversized-count', 'source-assignee', 'source-editable', 'source-native-ref', 'source-malformed-original', 'source-malformed-feed', 'invalid-interval', 'invalid-date-clock'] as const) it(`refuses an unqualified projection: ${corruption}`, async () => {
    capability.enabled = true; const probe = sdk({ value: snapshot([group()], []) });
    const projection = await display.readDisplayCalendarOccurrences(probe.db, FAMILY, bounds, 'UTC', { overlap: true });
    if (projection.error) throw new Error('The real baseline projection failed');
    const modified = structuredClone(projection), row = modified.data[0];
    if (corruption === 'missing-transparency') delete row.transparency;
    if (corruption === 'invalid-transparency') Object.assign(row, { transparency: 'unknown' });
    if (corruption === 'duplicate-key') { modified.data.push(row); modified.count++; }
    if (corruption === 'partial-count') modified.count++;
    if (corruption === 'oversized-count') modified.count = 20_001;
    if (corruption === 'source-assignee') row.assignee_id = MEMBER;
    if (corruption === 'source-editable') row.readOnly = false;
    if (corruption === 'source-native-ref') Object.assign(row, { reference: { kind: 'native', eventId: native(1).id } });
    if (corruption === 'source-malformed-original' && row.reference.kind === 'source') row.reference.original.value = '20260230T090000Z';
    if (corruption === 'source-malformed-feed' && row.reference.kind === 'source') row.reference.feedId = 'invented-feed';
    if (corruption === 'invalid-interval') row.actualEndsAt = `${day}T08:00:00Z`;
    if (corruption === 'invalid-date-clock') Object.assign(row, { all_day: true, startDate: day, endDate: '2026-10-09', starts_at: `${day}T00:00:00Z`, ends_at: '2026-10-09T00:00:00Z' });
    const reader = vi.spyOn(display, 'readDisplayCalendarOccurrences').mockResolvedValueOnce(modified);
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.data).toBeNull(); expect(result.count).toBeNull();
    expect(reader).toHaveBeenCalledWith(probe.db, FAMILY, bounds, 'UTC', { overlap: true });
    expect(probe.calls).toHaveLength(1);
  });
});
