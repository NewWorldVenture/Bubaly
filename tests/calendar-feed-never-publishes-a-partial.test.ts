import { describe, expect, it, vi, beforeEach } from 'vitest';

// An iCalendar feed is not a list — it is the subscriber's COPY. Apple Calendar,
// Outlook and Google reconcile their local store against the body they fetch, so
// an event missing from it is an event DELETED from that person's device.
//
// `readAll` reports a truncated or failed read as an error while `rows` still
// holds the partial set, and this route destructured only `rows`. A transient
// database failure, or a calendar busier than the 2,000-row ceiling, therefore
// published a SHORT FEED AT HTTP 200 and silently removed the remainder from
// every subscribed device. Audit C4-S4-06.
//
// A 5xx is strictly better than a partial 200: every calendar client answers a
// failed fetch by keeping what it already has and retrying.

const h = vi.hoisted(() => ({
  readAll: vi.fn(),
  calendar: { id: 'cal-1', name: 'Family', description: null, timezone: 'UTC', feed_enabled: true } as
    | { id: string; name: string; description: string | null; timezone: string; feed_enabled: boolean }
    | null,
}));

vi.mock('@/lib/supabase/read-all', () => ({ readAll: h.readAll }));
vi.mock('@/lib/sync/feed-request', () => ({ isValidFeedToken: () => true }));
vi.mock('@/lib/server/rate-limit', () => ({ clientIp: () => '127.0.0.1', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      for (const m of ['select', 'eq', 'is', 'lte', 'order', 'range']) q[m] = chain;
      q.maybeSingle = async () => ({ data: h.calendar, error: null });
      return q;
    },
  }),
}));

const EVENT = {
  id: 'e1', uid: 'e1@bubaly.com', title: 'Soccer', description: null, location: null,
  starts_at: '2026-06-22T15:00:00.000Z', ends_at: '2026-06-22T16:00:00.000Z',
  all_day: false, recurrence_rule: null, status: 'confirmed', updated_at: '2026-06-01T00:00:00.000Z',
};

async function callFeed() {
  const { GET } = await import('@/app/api/sync/feeds/[token]/route');
  const req = new Request('https://bubaly.com/api/sync/feeds/tok') as never;
  return GET(req, { params: Promise.resolve({ token: 'tok' }) });
}

describe('the public calendar feed never publishes a partial calendar (C4-S4-06)', () => {
  beforeEach(() => { vi.resetModules(); h.readAll.mockReset(); });

  it('publishes the feed when the read is complete', async () => {
    h.readAll.mockResolvedValue({ rows: [EVENT], error: null });
    const res = await callFeed();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('Soccer');
  });

  it('refuses with 5xx when the read was truncated, rather than serving what it got', async () => {
    // This is the case that mattered: rows came back, AND so did an error.
    // Serving those rows is what deleted events from subscribers' devices.
    h.readAll.mockResolvedValue({ rows: [EVENT], error: { message: 'read truncated at ceiling' } });
    const res = await callFeed();
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.text();
    expect(body).not.toContain('BEGIN:VCALENDAR');
    // A client must be told to come back, not to cache the refusal.
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
  });

  it('refuses when the read failed outright', async () => {
    h.readAll.mockResolvedValue({ rows: [], error: { message: 'connection reset' } });
    const res = await callFeed();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).not.toContain('BEGIN:VCALENDAR');
  });
});
