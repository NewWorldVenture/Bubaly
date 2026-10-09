import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';
import { parseICSSource } from '@/lib/sync/ics-source';
import { groupCalendarDays, parseCalendarReply } from '../mobile/src/lib/calendar-core';
const h = vi.hoisted(() => ({ enabled: true, context: vi.fn() }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return h.enabled; } }));
vi.mock('@/lib/supabase/bearer', async original => ({ ...await original<typeof import('@/lib/supabase/bearer')>(), getBearerUserContext: h.context }));
import { GET } from '@/app/api/calendar/occurrences/route';
const family = '10000000-0000-4000-8000-000000000001', feed = '20000000-0000-4000-8000-000000000001', revision = '30000000-0000-4000-8000-000000000001';
const owner = { userId: 'synthetic-user', familyId: family, memberId: 'synthetic-member', timezone: 'America/New_York' };
function snapshot(body = 'DTSTART;VALUE=DATE:20261007\r\nDURATION:P3D', uid = 'mobile-source') {
  const doc = parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic source mobile//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];
  return { version: 1, familyId: family, nativeRows: [], nativeCount: 0, sourceCount: 1, watermarkCount: 1, sourceGroups: [{ feedId: feed, uid: doc.uid, revisionId: revision, materializationState: 'ready', document: doc, masterCancellationRevisionId: null, watermarks: [{ componentKey: 'master', versionComponent: structuredClone(doc.master), versionRevisionId: revision, cancelledComponent: null, cancellationRevisionId: null }] }] };
}
let value: ReturnType<typeof snapshot>, status: number, requests: Array<{ url: URL; body: unknown; authorization: string | null }>;
beforeEach(() => {
  value = snapshot(); status = 200; requests = []; h.enabled = true;
  const db = createClient<Database>('https://synthetic-mobile-source.invalid', 'synthetic-anon', { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: 'Bearer synthetic.jwt' }, fetch: async (input, init) => {
    const url = new URL(String(input)); requests.push({ url, body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json(status === 200 ? value : { code: 'PGRST202', message: 'Synthetic private provider detail' }, { status });
  } } });
  h.context.mockReset().mockResolvedValue({ ok: true, supabase: db, ctx: { user: { id: owner.userId }, active: { familyId: family, family: { timezone: owner.timezone } } } });
});
const request = (fromDay = '2026-10-08', days = 3, limit = 100) => new NextRequest(`https://synthetic.invalid/api/calendar/occurrences?fromDay=${fromDay}&days=${days}&limit=${limit}`, { headers: { Authorization: 'Bearer synthetic.jwt', 'X-Bubaly-User-Id': owner.userId, 'X-Bubaly-Family-Id': family } });
describe('actual SDK coherent source snapshot to bearer wire to mobile parser', () => {
  it('retains a complete admitted UID even when its escaped key exceeds one identity limit', async () => {
    const uid = '"'.repeat(4096); value = snapshot(undefined, uid);
    const response = await GET(request()); expect(response.status).toBe(200);
    const reply = parseCalendarReply(await response.json(), owner);
    expect(reply.occurrences[0].occurrenceKey.length).toBeGreaterThan(8192);
    expect(reply.occurrences[0].reference).toMatchObject({ uid });
  });
  it('retains source reference without native IDs and draws only occupied requested DATE days', async () => {
    const response = await GET(request()); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    const reply = parseCalendarReply(await response.json(), owner, { fromDay: '2026-10-08', days: 3 });
    expect(reply.contractVersion).toBe(2); expect(reply.count).toBe(1); const row = reply.occurrences[0];
    expect(row).toMatchObject({ kind: 'source', readOnly: true, category: null, title: null, startDate: '2026-10-07', endDate: '2026-10-10', actualStartsAt: '2026-10-07T04:00:00.000Z', reference: { kind: 'source', feedId: feed, uid: 'mobile-source', original: { kind: 'date', value: '20261007' } } });
    expect(row).not.toHaveProperty('eventId'); expect(row).not.toHaveProperty('id'); expect(row).not.toHaveProperty('document');
    const groups = groupCalendarDays(reply.occurrences, reply.timezone, reply, new Date('2026-10-08T12:00:00Z'));
    expect(groups.map(g => g.key)).toEqual(['2026-10-08', '2026-10-09']); expect(groups.map(g => g.label)).toEqual(['Today', 'Tomorrow']);
    expect(groups.every(g => g.items[0].reference === row.reference && g.items[0].occurrenceKey === row.occurrenceKey)).toBe(true);
    expect(requests).toHaveLength(1); expect(requests[0].url.pathname).toBe('/rest/v1/rpc/calendar_read_occurrence_inputs'); expect(requests[0].body).toEqual({ p_family_id: family }); expect(requests[0].authorization).toBe('Bearer synthetic.jwt');
  });
  it('preserves original identity across revision replacement and clips overnight source times', async () => {
    value = snapshot('DTSTART:20261008T033000Z\r\nDURATION:PT2H');
    const first = parseCalendarReply(await (await GET(request())).json(), owner); const source = first.occurrences[0];
    expect(groupCalendarDays(first.occurrences, first.timezone, first)[0].items[0]).toMatchObject({ segmentStartsAt: '2026-10-08T04:00:00.000Z', segmentEndsAt: '2026-10-08T05:30:00.000Z' });
    value.sourceGroups[0].revisionId = '30000000-0000-4000-8000-000000000002'; value.sourceGroups[0].watermarks[0].versionRevisionId = value.sourceGroups[0].revisionId;
    const second = parseCalendarReply(await (await GET(request())).json(), owner);
    expect(second.occurrences[0].occurrenceKey).toBe(source.occurrenceKey); expect(second.occurrences[0].reference).not.toEqual(source.reference);
  });
  it('admits a mixed native/source snapshot with a native missing-end estimate', async () => {
    const native = { id: '40000000-0000-4000-8000-000000000001', family_id: family, title: 'Native missing end', description: null, location: null, category: 'general', starts_at: '2026-10-08T09:00:00.000Z', ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null, created_by: null, onboarding_key: null, idempotency_key: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', source_recurrence: null };
    Object.assign(value, { nativeRows: [native], nativeCount: 1 });
    const response = await GET(request()); expect(response.status).toBe(200);
    const reply = parseCalendarReply(await response.json(), owner); expect(reply.count).toBe(2);
    const row = reply.occurrences.find(row => row.kind === 'native');
    expect(row).toMatchObject({ eventId: native.id, ends_at: null, actualEndsAt: '2026-10-08T10:00:00.000Z', readOnly: false });
    expect(groupCalendarDays(reply.occurrences, reply.timezone, reply)[0].items.find(item => item.kind === 'native')).toMatchObject({ segmentStartsAt: native.starts_at, segmentEndsAt: '2026-10-08T10:00:00.000Z' });
  });
  it.each(['missing-rpc', 'review', 'count', 'raw-conflict', 'foreign-family'])('refuses whole %s read with no native fallback or partial body', async fault => {
    if (fault === 'missing-rpc') status = 400;
    if (fault === 'review') value.sourceGroups[0].materializationState = 'needs_revision_review';
    if (fault === 'count') value.sourceCount++;
    if (fault === 'raw-conflict') value.sourceGroups[0].document.master!.title = 'Synthetic conflicting title';
    if (fault === 'foreign-family') value.familyId = '10000000-0000-4000-8000-000000000002';
    const response = await GET(request()); expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: 'calendar_unavailable', error: 'calendar_unavailable' }); expect(requests).toHaveLength(1);
  });
  it.each(['native-id', 'editable', 'key', 'original-clock', 'actual-date', 'unknown-version', 'downgrade', 'outside-window'])('mobile refuses malformed source %s contract', async fault => {
    const body = await (await GET(request())).json(), row = body.occurrences[0];
    if (fault === 'native-id') row.eventId = 'invented';
    if (fault === 'editable') row.readOnly = false;
    if (fault === 'key') row.occurrenceKey = 'invented';
    if (fault === 'original-clock') row.reference.original.value = '20260230';
    if (fault === 'actual-date') row.actualStartsAt = row.starts_at;
    if (fault === 'unknown-version') body.contractVersion = 3;
    if (fault === 'downgrade') delete body.contractVersion;
    if (fault === 'outside-window') { body.fromDay = '2026-10-12'; body.toDay = '2026-10-15'; }
    expect(() => parseCalendarReply(body, owner)).toThrow();
  });
});
