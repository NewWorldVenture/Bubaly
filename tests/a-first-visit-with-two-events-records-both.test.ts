// P-08 (2026-09-27 page audit). A visitor's first page can send two track
// events at once (the page view and the one beside it on /ai). Both read "no
// visitor", both insert, and the loser hit mkt_visitors_anonymous_id_key and
// answered 503 — a console error on the page and a lost touchpoint. The loser
// now reads the row it lost to and records against it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const db = vi.hoisted(() => ({
  visitorReads: 0,
  inserted: [] as { table: string; row: unknown }[],
  createError: null as null | { code: string; message: string },
  rereadFinds: true,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/marketing/consent', () => ({
  getConsentState: async () => ({ analytics: true }),
  canRecordAnalytics: () => true,
}));
vi.mock('@/lib/marketing/visitor-cookie', () => ({
  carriedVisitorId: () => 'visitor-1',
  namesAnotherVisitor: () => false,
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      let mode: 'select' | 'insert' = 'select';
      let payload: unknown = null;
      Object.assign(q, {
        select: chain, eq: chain,
        insert: (row: unknown) => { mode = 'insert'; payload = row; return q; },
        maybeSingle: async () => {
          if (table !== 'mkt_visitors') return { data: null, error: null };
          db.visitorReads += 1;
          // First read: no visitor yet (the race). Re-read after the conflict:
          // the row the other request created.
          if (db.visitorReads === 1) return { data: null, error: null };
          return db.rereadFinds ? { data: { id: 'winner-row' }, error: null } : { data: null, error: null };
        },
        single: async () => (db.createError ? { data: null, error: db.createError } : { data: { id: 'new-row' }, error: null }),
        then: (resolve: (v: unknown) => void) => {
          if (mode === 'insert') db.inserted.push({ table, row: payload });
          resolve({ data: null, error: null });
        },
      });
      return q;
    },
  }),
}));

const { POST } = await import('@/app/api/mkt/track/route');

function request() {
  return new NextRequest('https://bubaly.test/api/mkt/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'direct', landingPath: '/ai' }),
  });
}

describe('a first visit that fires two events at once', () => {
  beforeEach(() => {
    db.visitorReads = 0; db.inserted = []; db.createError = null; db.rereadFinds = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('records the event that lost the create race against the row that won it', async () => {
    db.createError = { code: '23505', message: 'duplicate key value violates unique constraint "mkt_visitors_anonymous_id_key"' };
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: true });
    expect(db.inserted.map((i) => i.table).sort()).toEqual(['mkt_sessions', 'mkt_touchpoints']);
    expect(db.inserted.every((i) => (i.row as { visitor_id: string }).visitor_id === 'winner-row')).toBe(true);
  });

  it('records a visitor created without a race (control)', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(db.inserted.every((i) => (i.row as { visitor_id: string }).visitor_id === 'new-row')).toBe(true);
  });

  it('still answers 503 when the create fails for any other reason', async () => {
    db.createError = { code: '57014', message: 'canceling statement due to statement timeout' };
    expect((await POST(request())).status).toBe(503);
    expect(db.inserted).toEqual([]);
  });

  it('answers 503 rather than guessing when the winner cannot be read back', async () => {
    db.createError = { code: '23505', message: 'duplicate key' };
    db.rereadFinds = false;
    expect((await POST(request())).status).toBe(503);
    expect(db.inserted).toEqual([]);
  });
});
