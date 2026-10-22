// P10 — GET /api/services/descriptions answered a FAILED read of
// service_descriptions as 200 `{ overrides: {} }` under
// `public, max-age=60, s-maxage=300, stale-while-revalidate=600`.
//
// So one transient database error was stored at the edge as "there are no
// custom descriptions" and served to every visitor in the region for the life
// of the entry — the same defect app/api/blog/search-index fixed for its index
// (review 5372934636). A failure now answers 503 with no-store and Retry-After;
// only a read that worked carries the public cache header.
//
// Drives the real route. Negative control: before the fix both failure cases
// below answer 200 with the public cache header.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reply: { data: [] as unknown, error: null as unknown },
  throws: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        limit: async () => {
          if (h.throws) throw new Error('fetch failed');
          return h.reply;
        },
      }),
    }),
  }),
}));

const { GET } = await import('@/app/api/services/descriptions/route');

beforeEach(() => {
  h.reply = { data: [{ service_key: '/dashboard/meals', description: 'Plan dinners together.' }], error: null };
  h.throws = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a failed override read is not cached as “no overrides”', () => {
  it('answers a refused read 503, uncacheable, with a retry hint', async () => {
    h.reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await res.text();
    expect(body).not.toContain('overrides');
    expect(body).not.toContain('statement timeout');
  });

  it('answers a thrown read the same way', async () => {
    h.throws = true;
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps the public cache for a read that worked, including an empty one (positive control)', async () => {
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    expect(await ok.json()).toEqual({ overrides: { '/dashboard/meals': 'Plan dinners together.' } });

    h.reply = { data: [], error: null };
    const empty = await GET();
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ overrides: {} });
  });
});
