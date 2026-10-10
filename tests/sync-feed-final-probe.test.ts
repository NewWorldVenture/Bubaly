import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({ db: null as unknown, size: 2000, cap: 500, failAt: null as number | null, mode: 'http', offsets: [] as number[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/sync/feed-request', () => ({ isValidFeedToken: () => true }));
vi.mock('@/lib/server/rate-limit', () => ({ clientIp: () => '127.0.0.1', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
import { GET } from '@/app/api/sync/feeds/[token]/route';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.size = 2000; h.cap = 500; h.failAt = null; h.mode = 'http'; h.offsets = [];
  h.db = createClient('https://synthetic-feed.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/sync_calendars')) {
        expect(url.searchParams.get('feed_token')).toBe('eq.synthetic-token');
        expect(url.searchParams.get('feed_enabled')).toBe('eq.true');
        return Response.json({ id: 'synthetic-calendar', name: 'Synthetic family', description: null, timezone: 'UTC', feed_enabled: true });
      }
      expect(url.pathname).toBe('/rest/v1/sync_calendar_events');
      expect(url.searchParams.get('calendar_id')).toBe('eq.synthetic-calendar');
      expect(url.searchParams.get('deleted_at')).toBe('is.null');
      expect(url.searchParams.get('order')).toBe('starts_at.asc,id.asc');
      expect(url.searchParams.get('starts_at')).toMatch(/^lte\./);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const requested = Number(url.searchParams.get('limit'));
      h.offsets.push(offset);
      if (offset === h.failAt) {
        if (h.mode === 'throw') throw new Error('synthetic final probe network failure');
        return Response.json({ message: 'synthetic final probe timeout', code: '57014' }, { status: 503 });
      }
      const count = Math.max(0, Math.min(h.cap, requested, h.size - offset));
      return Response.json(Array.from({ length: count }, (_, index) => {
        const id = String(offset + index).padStart(4, '0');
        return { id: `event-${id}`, uid: `event-${id}@synthetic.invalid`, title: `Synthetic ${id}`, description: null, location: null,
          starts_at: '2026-10-08T10:00:00.000Z', ends_at: '2026-10-08T11:00:00.000Z', all_day: false,
          recurrence_rule: null, status: 'confirmed', updated_at: '2026-10-08T09:00:00.000Z' };
      }));
    } },
  });
});
afterEach(() => vi.restoreAllMocks());
async function poll() {
  return GET(new Request('https://synthetic.invalid/api/sync/feeds/synthetic-token') as never,
    { params: Promise.resolve({ token: 'synthetic-token' }) });
}

describe('actual SDK feed pagination and final completeness probe', () => {
  it.each(['http', 'throw'])('refuses %s failure after exactly 2000 accumulated rows', async mode => {
    h.failAt = 2000; h.mode = mode;
    const response = await poll();
    expect(h.offsets.slice(0, 4)).toEqual([0, 500, 1000, 1500]);
    // The real SDK retries transient GET failures at the same final offset.
    expect(h.offsets.slice(4).length).toBeGreaterThan(0);
    expect(h.offsets.slice(4).every(offset => offset === 2000)).toBe(true);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe('300');
    expect(await response.text()).not.toContain('BEGIN:VCALENDAR');
  });
  it('accepts exactly 2000 only after the final empty probe succeeds', async () => {
    const response = await poll();
    expect(response.status).toBe(200);
    expect(h.offsets).toEqual([0, 500, 1000, 1500, 2000]);
    expect((await response.text()).split('BEGIN:VEVENT')).toHaveLength(2001);
  });
  it('retains the explicit nearest-2000 policy only after an extra row proves truncation', async () => {
    h.size = 2001;
    const response = await poll();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event-1999@synthetic.invalid');
    expect(body).not.toContain('event-2000@synthetic.invalid');
    expect(body.split('BEGIN:VEVENT')).toHaveLength(2001);
  });
  it('advances by actual received rows under a two-row cap', async () => {
    h.size = 5; h.cap = 2;
    const response = await poll();
    expect(response.status).toBe(200);
    expect(h.offsets).toEqual([0, 2, 4, 5]);
    expect((await response.text()).split('BEGIN:VEVENT')).toHaveLength(6);
  });
  it('refuses a failed intermediate page with no calendar body', async () => {
    h.failAt = 500;
    const response = await poll();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('BEGIN:VCALENDAR');
  });
});
