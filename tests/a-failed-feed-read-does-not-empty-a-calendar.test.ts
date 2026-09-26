import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A calendar feed that could not be read must not be published as an empty one.
 *
 * Apple Calendar, Outlook and Google poll /api/sync/feeds/<token> for as long as
 * the subscription lives, and treat each answer as the truth: an empty
 * VCALENDAR deletes every Bubaly event on the device. The route ignored the
 * error from its paged events read, so a transient database failure published
 * an empty feed — with `Cache-Control: public, s-maxage=900`, so the edge served
 * it for fifteen minutes. A failed calendar lookup answered 404, which some
 * clients take as "this feed was deleted".
 */

const state = vi.hoisted(() => ({
  calendar: { data: { id: 'cal-1', name: 'Family', description: null, timezone: 'UTC', feed_enabled: true } as unknown, error: null as unknown },
  events: { rows: [] as unknown[], error: null as unknown },
}));

vi.mock('@/lib/sync/feed-request', () => ({ isValidFeedToken: () => true }));
vi.mock('@/lib/server/rate-limit', () => ({ clientIp: () => '1.1.1.1', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/read-all', () => ({ readAll: async () => state.events }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { from: () => chain, select: () => chain, eq: () => chain, maybeSingle: async () => state.calendar });
    return chain;
  },
}));

const event = (i: number) => ({
  id: `e${i}`, uid: `e${i}@bubaly.com`, title: `Event ${i}`, description: null, location: null,
  starts_at: '2026-10-01T10:00:00Z', ends_at: '2026-10-01T11:00:00Z', all_day: false,
  recurrence_rule: null, status: 'confirmed', updated_at: '2026-09-01T00:00:00Z',
});

async function poll() {
  const { GET } = await import('@/app/api/sync/feeds/[token]/route');
  const res = await GET(new Request('https://bubaly.test/api/sync/feeds/tok') as never, { params: Promise.resolve({ token: 'tok' }) });
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.text() };
}

describe('a subscribed calendar feed', () => {
  beforeEach(() => {
    vi.resetModules();
    state.calendar = { data: { id: 'cal-1', name: 'Family', description: null, timezone: 'UTC', feed_enabled: true }, error: null };
    state.events = { rows: [event(1), event(2)], error: null };
  });

  it('publishes the events it read (control)', async () => {
    const { status, body } = await poll();
    expect(status).toBe(200);
    expect(body).toContain('BEGIN:VEVENT');
    expect(body).toContain('Event 2');
  });

  // The finding.
  it('answers 503, uncached, when the events could not be read — never an empty calendar', async () => {
    state.events = { rows: [], error: { message: 'statement timeout' } };
    const { status, cache, body } = await poll();
    expect(status, 'a failed read was published as a feed').toBe(503);
    expect(cache).toBe('no-store');
    expect(body).not.toContain('BEGIN:VCALENDAR');
  });

  it('answers 503 rather than 404 when the calendar lookup fails', async () => {
    state.calendar = { data: null, error: { message: 'connection reset' } };
    expect((await poll()).status).toBe(503);
  });

  it('still answers 404 for a feed that does not exist (control)', async () => {
    state.calendar = { data: null, error: null };
    expect((await poll()).status).toBe(404);
  });

  it('publishes the nearest events when a busy calendar reaches the cap', async () => {
    state.events = { rows: Array.from({ length: 2000 }, (_, i) => event(i)), error: { message: 'readAll reached the caller\'s max of 2000 rows' } };
    const { status, body } = await poll();
    expect(status).toBe(200);
    expect(body.split('BEGIN:VEVENT').length - 1).toBe(2000);
  });
});
