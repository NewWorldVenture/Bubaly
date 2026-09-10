import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAdapter } from '@/lib/sync/providers/google-adapter';
import { microsoftAdapter } from '@/lib/sync/providers/microsoft';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/server/external-fetch', () => ({ fetchExternal: mocks.fetch }));
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const from = '2026-03-08T05:00:00.000Z';
const to = '2026-04-07T04:00:00.000Z';
beforeEach(() => mocks.fetch.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('expanded onboarding calendar windows', () => {
  it('requests Google occurrences in the explicit window and keeps later-page occurrences and dateless tombstones', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ items: [{ id: 'series_occurrence1', summary: 'Lesson', start: { dateTime: '2026-03-10T09:00:00-04:00' } }], nextPageToken: 'later' }))
      .mockResolvedValueOnce(json({ items: [{ id: 'series_occurrence2', start: { date: '2026-03-17' }, end: { date: '2026-03-18' } }, { id: 'series_cancelled', status: 'cancelled' }] }));
    const rows = await googleAdapter.pullCalendarWindow!('private-token', 'primary calendar', from, to);
    const url = new URL(mocks.fetch.mock.calls[0][0]);
    expect(url.pathname).toContain('/calendars/primary%20calendar/events');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ singleEvents: 'true', timeMin: from, timeMax: to, showDeleted: 'true' });
    expect(new URL(mocks.fetch.mock.calls[1][0]).searchParams.get('pageToken')).toBe('later');
    expect(rows).toMatchObject([{ external_id: 'series_occurrence1', starts_at: '2026-03-10T13:00:00.000Z' }, { external_id: 'series_occurrence2', all_day: true, starts_at: '2026-03-17T00:00:00.000Z' }, { external_id: 'series_cancelled', cancelled: true }]);
  });

  it('requests Microsoft calendarView occurrences with UTC response times and follows every page', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/calendars/primary/calendarView?$skiptoken=next';
    mocks.fetch.mockResolvedValueOnce(json({ value: [{ id: 'occurrence1', start: { dateTime: '2026-03-10T13:00:00', timeZone: 'UTC' } }], '@odata.nextLink': next }))
      .mockResolvedValueOnce(json({ value: [{ id: 'occurrence2', start: { dateTime: '2026-03-17T13:00:00', timeZone: 'UTC' } }, { id: 'removed', '@removed': {} }] }));
    const rows = await microsoftAdapter.pullCalendarWindow!('private-token', 'primary', from, to);
    const url = new URL(mocks.fetch.mock.calls[0][0]);
    expect(url.pathname).toContain('/calendarView');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ startDateTime: from, endDateTime: to });
    expect(mocks.fetch.mock.calls[0][1].headers.Prefer).toBe('outlook.timezone="UTC"');
    expect(mocks.fetch.mock.calls[1][0]).toBe(next);
    expect(rows).toMatchObject([{ external_id: 'occurrence1', starts_at: '2026-03-10T13:00:00.000Z' }, { external_id: 'occurrence2' }, { external_id: 'removed', cancelled: true }]);
  });

  it.each([googleAdapter, microsoftAdapter])('rejects missing timing from $provider instead of silently omitting an appointment', async (adapter) => {
    mocks.fetch.mockResolvedValueOnce(json(adapter.provider === 'google' ? { items: [{ id: 'broken' }] } : { value: [{ id: 'broken' }] }));
    await expect(adapter.pullCalendarWindow!('token', 'primary', from, to)).rejects.toThrow('timing unavailable');
  });

  it.each([
    { zone: 'Tokyo Standard Time', viewed: '2026-09-09T15:00:00', start: '2026-09-10', end: '2026-09-11' },
    { zone: 'Pacific Standard Time', viewed: '2026-09-10T07:00:00', start: '2026-09-10', end: '2026-09-11' },
    { zone: 'Eastern Standard Time', viewed: '2026-03-07T05:00:00', start: '2026-03-07', end: '2026-03-10' },
  ])('keeps all-day source dates in $zone, including multi-day DST spans', async ({ zone, viewed, start, end }) => {
    mocks.fetch.mockResolvedValueOnce(json({ value: [{ id: 'all-day', isAllDay: true, start: { dateTime: viewed, timeZone: 'UTC' }, originalStartTimeZone: zone, originalEndTimeZone: zone }] }))
      .mockResolvedValueOnce(json({ id: 'all-day', isAllDay: true, start: { dateTime: `${start}T00:00:00.0000000`, timeZone: zone }, end: { dateTime: `${end}T00:00:00`, timeZone: zone } }));
    const rows = await microsoftAdapter.pullCalendarWindow!('token', 'primary', from, to);
    expect(rows[0]).toMatchObject({ all_day: true, starts_at: `${start}T00:00:00.000Z`, ends_at: `${end}T00:00:00.000Z` });
    expect(mocks.fetch.mock.calls[1][1].headers.Prefer).toBe(`outlook.timezone="${zone}"`);
  });

  it.each(['missing-zone', 'invalid-zone', 'non-midnight', 'wrong-response-zone'] as const)('fails an all-day preview with %s rather than importing a shifted date', async (failure) => {
    const zone = failure === 'missing-zone' ? undefined : failure === 'invalid-zone' ? 'unsafe"zone' : 'Tokyo Standard Time';
    mocks.fetch.mockResolvedValueOnce(json({ value: [{ id: 'all-day', isAllDay: true, originalStartTimeZone: zone, originalEndTimeZone: zone }] }))
      .mockResolvedValueOnce(json({ id: 'all-day', isAllDay: true, start: { dateTime: failure === 'non-midnight' ? '2026-09-10T15:00:00' : '2026-09-10T00:00:00', timeZone: failure === 'wrong-response-zone' ? 'UTC' : zone }, end: { dateTime: '2026-09-11T00:00:00', timeZone: zone } }));
    await expect(microsoftAdapter.pullCalendarWindow!('token', 'primary', from, to)).rejects.toThrow('all-day source');
  });

  it.each([googleAdapter, microsoftAdapter])('rejects $provider when the window cannot be fully paged', async (adapter) => {
    mocks.fetch.mockImplementation(async () => json(adapter.provider === 'google' ? { items: [], nextPageToken: 'more' } : { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/primary/calendarView?$skiptoken=more' }));
    await expect(adapter.pullCalendarWindow!('token', 'primary', from, to)).rejects.toThrow('window exceeded the page limit');
    expect(mocks.fetch).toHaveBeenCalledTimes(50);
  });
});
