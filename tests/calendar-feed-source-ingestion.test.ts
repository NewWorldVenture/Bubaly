import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { parseICSSource } from '@/lib/sync/ics-source';

const h = vi.hoisted(() => ({ enabled: true, fetch: vi.fn() }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return h.enabled; } }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({ fetchPublicCalendarText: h.fetch }));
import { syncFeed } from '@/lib/server/calendar-feeds';

const feed = { id: '11111111-1111-4111-8111-111111111111', family_id: '22222222-2222-4222-8222-222222222222', url: 'https://synthetic.invalid/feed.ics' };
const fence = '2026-10-08T12:00:00.123456+00:00';
const revision = '33333333-3333-4333-8333-333333333333';
const calendar = (...events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic//Test//EN', ...events.flatMap(event => ['BEGIN:VEVENT', ...event, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const master = ['UID:series', 'SUMMARY:Class', 'DTSTART:20261008T090000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'SEQUENCE:5', 'DTSTAMP:20261008T080000Z'];
const moved = ['UID:series', 'RECURRENCE-ID:20261009T090000Z', 'DTSTART:20261009T110000Z', 'SUMMARY:Moved', 'SEQUENCE:6', 'DTSTAMP:20261008T080000Z'];

function sdk(reply?: unknown, error?: { code: string; message: string }) {
  const requests: { url: URL; method: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}'));
    requests.push({ url, method: init?.method ?? 'GET', body });
    if (url.pathname.endsWith('/calendar_feeds') && init?.method === 'PATCH') {
      return new Response(JSON.stringify([{ id: feed.id, updated_at: fence }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/rpc/calendar_feed_archive_sources')) {
      const response = error ?? reply ?? { outcome: 'applied', groups: (body.p_documents as { uid: string }[]).map(document => ({ uid: document.uid, revision_id: revision, state: 'ready', reused: false })) };
      return new Response(JSON.stringify(response), { status: error ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/rpc/calendar_feed_apply_sync')) return new Response(JSON.stringify('applied'), { headers: { 'Content-Type': 'application/json' } });
    throw new Error(`Unexpected synthetic SDK request ${url.pathname}`);
  };
  return { client: createClient('https://synthetic.invalid', 'synthetic-key', { global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false } }), requests };
}
const archives = (requests: ReturnType<typeof sdk>['requests']) => requests.filter(request => request.url.pathname.endsWith('/rpc/calendar_feed_archive_sources'));
const patches = (requests: ReturnType<typeof sdk>['requests']) => requests.filter(request => request.method === 'PATCH');

describe('subscribed source ingestion uses one real SDK archive request under the claim fence', () => {
  beforeEach(() => { h.enabled = true; h.fetch.mockReset(); h.fetch.mockResolvedValue({ ok: true, text: calendar(master, moved), url: feed.url }); });

  it('preserves complete raw master, recurrence, moved original identity and revision without native projection', async () => {
    const { client, requests } = sdk();
    expect(await syncFeed(client, feed)).toEqual({ ok: true, imported: 0, sourceGroups: 1 });
    expect(archives(requests)).toHaveLength(1);
    expect(archives(requests)[0].body).toEqual({ p_feed_id: feed.id, p_fence: fence, p_documents: parseICSSource(calendar(master, moved)) });
    expect(requests.some(request => request.url.pathname.includes('calendar_events') || request.url.pathname.endsWith('/calendar_feed_apply_sync'))).toBe(false);
    expect(patches(requests)).toHaveLength(1); // claim only; archive owns settlement
  });

  it('publishes multiple UID groups and embedded timezone definitions together with exact raw properties', async () => {
    const source = calendar(master, moved, ['UID:second', 'DTSTART;TZID=Publisher/Fixed:20261008T150000', 'DURATION:P1D', 'X-SYNTHETIC:keep-me'])
      .replace('BEGIN:VEVENT', ['BEGIN:VTIMEZONE', 'TZID:Publisher/Fixed', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+004530', 'TZOFFSETTO:+004530', 'END:STANDARD', 'END:VTIMEZONE', 'BEGIN:VEVENT'].join('\r\n'));
    h.fetch.mockResolvedValue({ ok: true, text: source });
    const { client, requests } = sdk();
    expect(await syncFeed(client, feed)).toEqual({ ok: true, imported: 0, sourceGroups: 2 });
    expect(archives(requests)).toHaveLength(1);
    expect(archives(requests)[0].body.p_documents).toEqual(parseICSSource(source));
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['bare cancelled master', ['UID:series', 'STATUS:CANCELLED', 'SEQUENCE:6', 'DTSTAMP:20261008T080000Z']],
    ['detached-only group', moved],
  ])('archives %s without inventing an event row', async (_name, event) => {
    h.fetch.mockResolvedValue({ ok: true, text: calendar(event) });
    const { client, requests } = sdk();
    expect(await syncFeed(client, feed)).toEqual({ ok: true, imported: 0, sourceGroups: 1 });
    expect(archives(requests)[0].body.p_documents).toEqual(parseICSSource(calendar(event)));
    expect(patches(requests)).toHaveLength(1);
  });

  it('reports review explicitly and leaves the atomic revision_review settlement alone', async () => {
    const { client, requests } = sdk({ outcome: 'needs_revision_review', groups: [{ uid: 'series', revision_id: revision, state: 'needs_revision_review', reused: true }] });
    expect(await syncFeed(client, feed)).toMatchObject({ ok: false, revisionReview: true, sourceGroups: 1 });
    expect(patches(requests)).toHaveLength(1);
  });

  it('a stale fence loses without stamping or falling back', async () => {
    const { client, requests } = sdk({ outcome: 'lost', groups: [] });
    expect(await syncFeed(client, feed)).toMatchObject({ ok: false, takenOver: true });
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['missing schema', { code: 'PGRST202', message: 'function missing' }],
    ['known older revision', { code: '22023', message: 'older component revision' }],
  ])('refuses %s with no fallback or partial native writes', async (_name, error) => {
    const { client, requests } = sdk(undefined, error);
    expect(await syncFeed(client, feed)).toMatchObject({ ok: false });
    expect(archives(requests)).toHaveLength(1);
    expect(patches(requests)).toHaveLength(2);
    expect(patches(requests)[1].url.searchParams.get('updated_at')).toBe(`eq.${fence}`);
    expect(requests).toHaveLength(3);
  });

  it.each([
    { outcome: 'applied', groups: [] },
    { outcome: 'applied', groups: [{ uid: 'wrong', revision_id: revision, state: 'ready', reused: false }] },
    { outcome: 'applied', groups: [{ uid: 'series', revision_id: revision, state: 'needs_revision_review', reused: false }] },
    { outcome: 'lost', groups: [{ uid: 'series' }] },
  ])('refuses an invalid atomic receipt %#', async reply => {
    const { client, requests } = sdk(reply);
    expect(await syncFeed(client, feed)).toMatchObject({ ok: false });
    expect(requests.some(request => request.url.pathname.includes('calendar_events'))).toBe(false);
  });

  it('an invalid late component rejects the entire publication before any archive', async () => {
    h.fetch.mockResolvedValue({ ok: true, text: calendar(master, ['UID:bad', 'DTSTART:garbage']) });
    const { client, requests } = sdk();
    expect(await syncFeed(client, feed)).toMatchObject({ ok: false });
    expect(archives(requests)).toHaveLength(0);
    expect(patches(requests)).toHaveLength(2);
  });

  it('rejects oversized raw source before publishing any group', async () => {
    h.fetch.mockResolvedValue({ ok: true, text: calendar(master, ['UID:big', 'DTSTART:20261008T090000Z', `DESCRIPTION:${'a'.repeat(1024 * 1024)}`]) });
    const { client, requests } = sdk();
    expect(await syncFeed(client, feed)).toMatchObject({ ok: false });
    expect(archives(requests)).toHaveLength(0);
  });

  it('keeps the disabled legacy path on the original four-argument RPC', async () => {
    h.enabled = false;
    h.fetch.mockResolvedValue({ ok: true, text: calendar(['UID:single', 'SUMMARY:Visit', 'DTSTART:20261008T090000Z']) });
    const { client, requests } = sdk();
    expect(await syncFeed(client, feed)).toEqual({ ok: true, imported: 1 });
    expect(archives(requests)).toHaveLength(0);
    const apply = requests.find(request => request.url.pathname.endsWith('/calendar_feed_apply_sync'));
    expect(Object.keys(apply!.body).sort()).toEqual(['p_feed_id', 'p_fence', 'p_removals', 'p_upserts']);
  });
});
