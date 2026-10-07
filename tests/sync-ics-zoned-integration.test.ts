import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPLY_SYNC_FUNCTION, syncFeed } from '@/lib/server/calendar-feeds';
import { appleAdapter, packAppleCredential } from '@/lib/sync/providers/apple';
import { runProviderSync } from '@/lib/sync/engine/generic';
import { syncSdkFixture, ACCOUNT, NEXT, STALE } from './helpers/sync-sdk-fixture';

const mocks = vi.hoisted(() => ({ calendarText: vi.fn(), token: vi.fn() }));
// Exercise the real parser/callers and Supabase SDK. Calendar URL validation has
// its own contract; its network result is synthetic here. Every adapter/SDK HTTP
// request below is intercepted and an unexpected request fails the test.
vi.mock('@/lib/server/public-calendar-fetch', () => ({ fetchPublicCalendarText: mocks.calendarText }));
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: mocks.token }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

type Row = Record<string, unknown>;
type Call = { url: URL; method: string; body: Row | Row[] | null };
const FEED = { id: 'synthetic-feed', family_id: 'synthetic-family', url: 'https://ics-source.invalid/school.ics' };
const PRIOR_STAMP = '2026-09-01T12:00:00.000Z';
const CALENDAR_PATH = '/synthetic/calendars/primary/';
const APPLE_ORIGIN = new URL(process.env.APPLE_CALDAV_BASE_URL || 'https://caldav.icloud.com').origin;
const CREDENTIAL = packAppleCredential('synthetic-owner@example.invalid', 'synthetic-app-password');
const event = (start: string, end?: string, uid = 'zoned-school@synthetic.invalid') => [
  'BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Synthetic school event', start, ...(end ? [end] : []), 'END:VEVENT',
].join('\r\n');
const calendar = (...components: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...components, 'END:VCALENDAR'].join('\r\n');
const firstValid = event('DTSTART:20260701T120000Z', 'DTEND:20260701T123000Z', 'valid-before-invalid@synthetic.invalid');
const suppliedZone = (zone: string) => [
  'BEGIN:VTIMEZONE', `TZID:${zone}`, 'BEGIN:STANDARD', 'DTSTART:19701101T020000',
  'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE',
].join('\r\n');

const zonedCases = [
  {
    name: 'quoted, case-insensitive parameters and an independently zoned DTEND',
    text: calendar(event('DTSTART;tzid="America/New_York";value=date-time:20260701T090000',
      'DTEND;TzId="America/Chicago":20260701T093000')),
    start: '2026-07-01T13:00:00.000Z', end: '2026-07-01T14:30:00.000Z',
  },
  {
    name: 'Lord Howe half-hour gap using the preceding offset',
    text: calendar(event('DTSTART;TZID=Australia/Lord_Howe:20261004T021500', 'DTEND;TZID=Australia/Lord_Howe:20261004T030000')),
    start: '2026-10-03T15:45:00.000Z', end: '2026-10-03T16:00:00.000Z',
  },
  {
    name: 'Apia skipped date using the preceding offset',
    text: calendar(event('DTSTART;TZID=Pacific/Apia:20111230T120000', 'DTEND;TZID=Pacific/Apia:20111231T130000')),
    start: '2011-12-30T22:00:00.000Z', end: '2011-12-30T23:00:00.000Z',
  },
] as const;
const refusals = [
  { name: 'unknown IANA zone', text: calendar(firstValid, event('DTSTART;TZID=America/Not_A_Zone:20260701T090000')) },
  { name: 'custom zone name', text: calendar(firstValid, event('DTSTART;TZID=School/Morning:20260701T090000')) },
  { name: 'empty zone parameter', text: calendar(firstValid, event('DTSTART;TZID=:20260701T090000')) },
  { name: 'UTC value carrying TZID', text: calendar(firstValid, event('DTSTART;TZID=America/New_York:20260701T090000Z')) },
  { name: 'DATE value carrying TZID', text: calendar(firstValid, event('DTSTART;VALUE=DATE;TZID=America/New_York:20260701')) },
  { name: 'referenced supplied VTIMEZONE', text: calendar(suppliedZone('America/New_York'), firstValid,
    event('DTSTART;TZID=America/New_York:20260701T090000')) },
] as const;

const requestUrl = (input: RequestInfo | URL) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function feedSdk() {
  const rows: Record<string, Row[]> = {
    calendar_feeds: [{ ...FEED, name: 'School', last_status: 'ok', last_error: null, last_synced_at: PRIOR_STAMP, event_count: 1 }],
    calendar_events: [{ id: 'existing-event', family_id: FEED.family_id, feed_id: FEED.id, external_uid: 'zoned-school@synthetic.invalid',
      title: 'Prior school event', starts_at: '2026-06-01T13:00:00.000Z', ends_at: '2026-06-01T14:00:00.000Z', all_day: false }],
  };
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Row | Row[] : null;
    calls.push({ url, method, body });
    if (url.origin !== 'https://ics-fixture.invalid') throw new Error(`Unexpected synthetic feed request: ${method} ${url.href}`);
    if (method === 'POST' && url.pathname === `/rest/v1/rpc/${APPLY_SYNC_FUNCTION}`) {
      if (!body || Array.isArray(body)) throw new Error('Expected an atomic SDK chunk object');
      expect(body.p_feed_id).toBe(FEED.id);
      expect(body.p_fence).toBe(rows.calendar_feeds[0].updated_at);
      expect(rows.calendar_feeds[0].last_status).toBe('syncing');
      for (const incoming of body.p_upserts as Row[]) {
        const existing = rows.calendar_events.find(row => row.feed_id === incoming.feed_id && row.external_uid === incoming.external_uid);
        if (existing) Object.assign(existing, incoming);
        else rows.calendar_events.push({ id: `event-${rows.calendar_events.length}`, ...incoming });
      }
      return jsonResponse('applied');
    }
    if (method === 'PATCH' && url.pathname === '/rest/v1/calendar_feeds') {
      expect(url.searchParams.get('id')).toBe(`eq.${FEED.id}`);
      if (!body || Array.isArray(body)) throw new Error('Expected an SDK feed status object');
      Object.assign(rows.calendar_feeds[0], body);
      return jsonResponse([{ ...rows.calendar_feeds[0] }]);
    }
    throw new Error(`Unexpected synthetic feed request: ${method} ${url.pathname}`);
  };
  const db = createClient('https://ics-fixture.invalid', 'synthetic-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  vi.stubGlobal('fetch', fetch);
  return { db, rows, calls };
}

const xmlEscape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const multistatus = (properties: string) => `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${properties}</D:multistatus>`;
const response = (href: string, properties: string) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${properties}</D:prop>
  <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
function appleHttp(ics: string, allowDiscovery = false) {
  const calls: { method: string; path: string; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input), method = init?.method ?? 'GET', body = String(init?.body ?? '');
    if (url.origin !== APPLE_ORIGIN) throw new Error(`Unexpected synthetic Apple origin: ${url.origin}`);
    calls.push({ method, path: url.pathname, body });
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from('synthetic-owner@example.invalid:synthetic-app-password').toString('base64')}`);
    let xml: string;
    if (method === 'REPORT' && url.pathname === CALENDAR_PATH) {
      expect(body).toContain(`<D:sync-token>${STALE}</D:sync-token>`);
      xml = multistatus(`<D:sync-token>${NEXT}</D:sync-token>` + response(`${CALENDAR_PATH}zoned.ics`,
        `<D:getetag>&quot;synthetic-v1&quot;</D:getetag><C:calendar-data>${xmlEscape(ics)}</C:calendar-data>`));
    } else if (allowDiscovery && method === 'PROPFIND' && url.pathname === '/') {
      xml = multistatus(response('/', '<D:current-user-principal><D:href>/synthetic/principal/</D:href></D:current-user-principal>'));
    } else if (allowDiscovery && method === 'PROPFIND' && url.pathname === '/synthetic/principal/') {
      xml = multistatus(response(url.pathname, '<C:calendar-home-set><D:href>/synthetic/calendars/</D:href></C:calendar-home-set>'));
    } else if (allowDiscovery && method === 'PROPFIND' && url.pathname === '/synthetic/calendars/') {
      xml = multistatus(response(CALENDAR_PATH, '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Calendar</D:displayname>'
        + '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>'));
    } else throw new Error(`Unexpected synthetic Apple request: ${method} ${url.pathname}`);
    return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml' } });
  };
  return { fetch, calls };
}

function appleEngineSdk(ics: string) {
  const state = syncSdkFixture([], { direction: 'import' });
  state.rows.sync_accounts[0].provider = 'apple';
  state.rows.sync_calendars[0].provider = 'apple';
  state.rows.sync_calendars[0].external_id = CALENDAR_PATH;
  state.rows.sync_calendar_events[0].provider = 'apple';
  state.rows.sync_external_mappings[0].provider = 'apple';
  const sdkFetch = globalThis.fetch, http = appleHttp(ics, true);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.origin === APPLE_ORIGIN) return http.fetch(input, init);
    if (url.origin === 'https://sync-fixture.invalid') return sdkFetch(input, init);
    throw new Error(`Unexpected synthetic engine request: ${url.href}`);
  });
  return { ...state, http };
}

beforeEach(() => {
  mocks.calendarText.mockReset();
  mocks.token.mockReset().mockResolvedValue(CREDENTIAL);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('real feed caller and SDK zoned DATE-TIME payloads', () => {
  it.each(zonedCases)('upserts $name as the resolved UTC start/end', async ({ text, start, end }) => {
    const { db, rows, calls } = feedSdk();
    mocks.calendarText.mockResolvedValue({ ok: true, url: FEED.url, text });
    expect(await syncFeed(db, FEED)).toEqual({ ok: true, imported: 1 });
    expect(mocks.calendarText).toHaveBeenCalledWith(FEED.url);
    const write = calls.find(call => call.url.pathname === `/rest/v1/rpc/${APPLY_SYNC_FUNCTION}`);
    expect(write?.body).toMatchObject({ p_feed_id: FEED.id, p_fence: expect.any(String), p_upserts: [expect.objectContaining({ family_id: FEED.family_id, feed_id: FEED.id,
      external_uid: 'zoned-school@synthetic.invalid', starts_at: start, ends_at: end, all_day: false })], p_removals: [] });
    expect(rows.calendar_events).toHaveLength(1);
    expect(rows.calendar_events[0]).toMatchObject({ id: 'existing-event', starts_at: start, ends_at: end });
    expect(rows.calendar_feeds[0]).toMatchObject({ last_status: 'ok', last_error: null, event_count: 1 });
    expect(rows.calendar_feeds[0].last_synced_at).not.toBe(PRIOR_STAMP);
  });

  it.each(refusals)('refuses $name before any upsert and retains prior events and successful stamp', async ({ text }) => {
    const { db, rows, calls } = feedSdk(), priorEvents = structuredClone(rows.calendar_events);
    mocks.calendarText.mockResolvedValue({ ok: true, url: FEED.url, text });
    expect(await syncFeed(db, FEED)).toEqual({ ok: false, error: 'Could not parse the calendar' });
    expect(calls.some(call => call.url.pathname === `/rest/v1/rpc/${APPLY_SYNC_FUNCTION}`)).toBe(false);
    expect(rows.calendar_events).toEqual(priorEvents);
    expect(rows.calendar_feeds[0]).toMatchObject({ last_status: 'error', last_error: 'Could not parse the calendar',
      last_synced_at: PRIOR_STAMP, event_count: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toMatchObject({ last_status: 'syncing' });
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { last_status: 'error', last_error: 'Could not parse the calendar' } });
  });

  it('an unreferenced supplied timezone does not alter the existing UTC, DATE or floating compatibility policy', async () => {
    const { db, rows } = feedSdk();
    const text = calendar(suppliedZone('Unused/School'), event('DTSTART:20260701T090000Z', undefined, 'utc'),
      event('DTSTART;VALUE=DATE:20260701', undefined, 'date'), event('DTSTART:20260701T090000', undefined, 'floating'));
    mocks.calendarText.mockResolvedValue({ ok: true, url: FEED.url, text });
    expect(await syncFeed(db, FEED)).toEqual({ ok: true, imported: 3 });
    expect(rows.calendar_events.find(row => row.external_uid === 'utc')).toMatchObject({ starts_at: '2026-07-01T09:00:00.000Z', all_day: false });
    expect(rows.calendar_events.find(row => row.external_uid === 'date')).toMatchObject({ starts_at: '2026-07-01T00:00:00.000Z', all_day: true });
    expect(rows.calendar_events.find(row => row.external_uid === 'floating')).toMatchObject({ starts_at: '2026-07-01T09:00:00.000Z', all_day: false });
  });
});

describe('actual Apple adapter synthetic REPORT boundary', () => {
  it.each(zonedCases)('returns $name only after resolving its dates', async ({ text, start, end }) => {
    const http = appleHttp(text); vi.stubGlobal('fetch', http.fetch);
    const result = await appleAdapter.pullEvents(CREDENTIAL, CALENDAR_PATH, STALE);
    expect(result).toMatchObject({ expired: false, nextCursor: NEXT, events: [expect.objectContaining({
      external_id: `${CALENDAR_PATH}zoned.ics`, uid: 'zoned-school@synthetic.invalid', starts_at: start, ends_at: end, all_day: false,
    })] });
    expect(http.calls).toHaveLength(1);
  });

  it.each(refusals.filter(({ name }) => ['unknown IANA zone', 'custom zone name', 'referenced supplied VTIMEZONE'].includes(name)))
   ('refuses $name before returning a pull result or the supplied next cursor', async ({ text }) => {
      const http = appleHttp(text); vi.stubGlobal('fetch', http.fetch);
      let returned: unknown;
      const pull = appleAdapter.pullEvents(CREDENTIAL, CALENDAR_PATH, STALE).then(result => { returned = result; return result; });
      await expect(pull).rejects.toThrow(/timezone|TZID|zone/i);
      expect(returned).toBeUndefined();
      expect(http.calls).toHaveLength(1);
    });
});

describe('actual Apple adapter through the generic engine and SDK', () => {
  it('passes resolved start/end to the atomic item request, then advances the cursor', async () => {
    const { db, rows, calls, http } = appleEngineSdk(zonedCases[0].text);
    const result = await runProviderSync(db, ACCOUNT, appleAdapter);
    expect(result).toMatchObject({ imported: 1, exported: 0, skipped: 0, conflicts: 0 });
    expect(result.error).toBeUndefined();
    const request = calls.find(call => call.url.pathname === '/rest/v1/rpc/create_sync_pull_item');
    expect(request?.body).toMatchObject({ p_provider: 'apple', p_kind: 'event', p_external: `${CALENDAR_PATH}zoned.ics`,
      p_fields: { starts_at: zonedCases[0].start, ends_at: zonedCases[0].end, all_day: false } });
    expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
    expect(rows.sync_job_runs[0].status).toBe('succeeded');
    expect(http.calls.map(call => call.method)).toEqual(['PROPFIND', 'PROPFIND', 'PROPFIND', 'REPORT']);
  });

  it.each(refusals.filter(({ name }) => ['unknown IANA zone', 'referenced supplied VTIMEZONE'].includes(name)))
   ('retains the prior cursor and rows after $name, and never claims success', async ({ text }) => {
      const { db, rows, calls, http } = appleEngineSdk(text);
      const priorEvents = structuredClone(rows.sync_calendar_events), priorMappings = structuredClone(rows.sync_external_mappings);
      const result = await runProviderSync(db, ACCOUNT, appleAdapter);
      expect(result).toMatchObject({ imported: 0, exported: 0, skipped: 0, conflicts: 0 });
      expect(result.error).toMatch(/timezone|TZID|zone/i);
      expect(rows.sync_calendar_events).toEqual(priorEvents);
      expect(rows.sync_external_mappings).toEqual(priorMappings);
      expect(calls.some(call => call.url.pathname === '/rest/v1/rpc/create_sync_pull_item')).toBe(false);
      expect(calls.some(call => call.method === 'PATCH' && call.url.pathname === '/rest/v1/sync_calendars' && call.body?.sync_token)).toBe(false);
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
      expect(rows.sync_job_runs[0].status).toBe('failed');
      expect(rows.sync_connections[0]).toMatchObject({ health: 'error', sync_status: 'error', last_error: result.error });
      expect(http.calls.map(call => call.method)).toEqual(['PROPFIND', 'PROPFIND', 'PROPFIND', 'REPORT']);
    });
});
