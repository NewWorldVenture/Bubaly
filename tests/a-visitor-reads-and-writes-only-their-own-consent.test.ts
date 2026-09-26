// SEC-006. /api/mkt/consent is public and holds a service-role client — the
// ledger it fronts (mkt_consent_events) has RLS on and NO policies, so this
// route is the only door to it and the door is the whole boundary.
//
// Both handlers used to let the CALLER say whose ledger to use: GET took the id
// from the query string, POST from the body. So a request could name another
// visitor and get back what they chose about analytics and marketing, and a
// POST could append decisions to that visitor's ledger — including opting them
// IN to marketing email. A POST of `{ necessary: true }` was a quiet read: it
// appends an inert row and hands back the target's full resolved state.
//
// What this file pins is the outcome a visitor would notice: the choices that
// come back, and the choices that land, are the ones belonging to the browser
// that sent the request — the `bubaly_vid` cookie it carries — and naming
// anybody else gets neither their state nor a row in their ledger.
//
// Scope, stated so nobody over-reads a green run: the id is a random bearer
// value and the cookie is the same bytes, so a holder of a visitor's id can still
// present it as a cookie. That is not what this file claims to stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (k: string) => k }));

const createServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClient(),
  createServer: async () => createServiceClient(),
}));

vi.mock('@/lib/server/request-rate-limit', () => ({
  enforceRequestRateLimit: async () => ({ ok: true }),
}));

const VICTIM = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER = '9f8b2c11-1d2e-4a3b-8c4d-5e6f70819a2b';

type Row = { anonymous_id: string; category: string; decision: string; created_at: string };

/**
 * The consent ledger as the route sees it through the service client: reads
 * filter by anonymous_id, inserts append with later timestamps than anything
 * seeded, so "latest decision wins" behaves as it does in Postgres.
 */
function consentLedger(seed: Row[]) {
  const rows: Row[] = [...seed];
  let clock = Date.parse('2026-09-01T00:00:00Z');
  const client = {
    from(table: string) {
      if (table !== 'mkt_consent_events') throw new Error(`unexpected table ${table}`);
      let visitor: string | null = null;
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => { if (column === 'anonymous_id') visitor = value; return chain; },
        order: () => chain,
        limit: () => Promise.resolve({
          data: rows.filter((r) => r.anonymous_id === visitor)
            .map(({ category, decision, created_at }) => ({ category, decision, created_at })),
          error: null,
        }),
        insert: (added: Array<Omit<Row, 'created_at'>>) => {
          for (const row of added) {
            clock += 1000;
            rows.push({
              anonymous_id: row.anonymous_id, category: row.category, decision: row.decision,
              created_at: new Date(clock).toISOString(),
            });
          }
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };
  return { client, rows, of: (id: string) => rows.filter((r) => r.anonymous_id === id) };
}

// The victim said NO to analytics and YES to marketing email and
// personalization — the opposite of the defaults on each, so leaking any of it
// is visible in the answer.
const victimSeed: Row[] = [
  { anonymous_id: VICTIM, category: 'analytics', decision: 'denied', created_at: '2026-01-01T00:00:00Z' },
  { anonymous_id: VICTIM, category: 'marketing_email', decision: 'granted', created_at: '2026-01-01T00:00:01Z' },
  { anonymous_id: VICTIM, category: 'personalization', decision: 'granted', created_at: '2026-01-01T00:00:02Z' },
];
const VICTIM_STATE = {
  necessary: true, analytics: false, personalization: true, marketing_email: true, marketing_sms: false,
};

function get(query: string, cookie?: string) {
  return new NextRequest(`https://bubaly.test/api/mkt/consent${query}`, {
    method: 'GET',
    headers: cookie ? { cookie: `bubaly_vid=${cookie}` } : {},
  });
}

function post(body: unknown, cookie?: string) {
  return new NextRequest('https://bubaly.test/api/mkt/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `bubaly_vid=${cookie}` } : {}) },
    body: JSON.stringify(body),
  });
}

let ledger: ReturnType<typeof consentLedger>;

beforeEach(() => {
  vi.resetModules();
  ledger = consentLedger(victimSeed);
  createServiceClient.mockImplementation(() => ledger.client);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a request reads only the consent of the browser that sent it', () => {
  it('naming another visitor in the query string, with no cookie, gets none of their choices', async () => {
    const { GET } = await import('@/app/api/mkt/consent/route');
    const res = await GET(get(`?anonymousId=${VICTIM}`));
    const json = await res.json();
    expect(res.ok).toBe(false);
    expect(json).not.toHaveProperty('state');
  });

  it('naming another visitor while carrying your own cookie is refused, not answered', async () => {
    const { GET } = await import('@/app/api/mkt/consent/route');
    const res = await GET(get(`?anonymousId=${VICTIM}`, OTHER));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json).not.toHaveProperty('state');
  });

  it('the visitor whose cookie it is still gets their own choices back', async () => {
    const { GET } = await import('@/app/api/mkt/consent/route');
    const res = await GET(get('', VICTIM));
    expect(res.status).toBe(200);
    expect((await res.json()).state).toEqual(VICTIM_STATE);
  });
});

describe('a request writes only to the consent ledger of the browser that sent it', () => {
  it('cannot opt another visitor in to marketing email', async () => {
    const { POST } = await import('@/app/api/mkt/consent/route');
    const before = ledger.of(VICTIM).length;
    const res = await POST(post({ anonymousId: VICTIM, consents: { marketing_sms: true, analytics: true } }, OTHER));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).not.toHaveProperty('state');
    // Their ledger is exactly what they left it as.
    expect(ledger.of(VICTIM)).toHaveLength(before);
    expect(ledger.of(VICTIM).some((r) => r.category === 'marketing_sms')).toBe(false);
    // And nothing was written under the sender's own id on the victim's behalf.
    expect(ledger.of(OTHER)).toHaveLength(0);
  });

  it('cannot use an inert write as a read of someone else', async () => {
    const { POST } = await import('@/app/api/mkt/consent/route');
    const res = await POST(post({ anonymousId: VICTIM, consents: { necessary: true } }));
    const json = await res.json();
    expect(res.ok).toBe(false);
    expect(json).not.toHaveProperty('state');
    expect(ledger.of(VICTIM)).toHaveLength(victimSeed.length);
  });

  it('an older cached client that names its own cookie id is still recorded', async () => {
    const { POST } = await import('@/app/api/mkt/consent/route');
    const res = await POST(post({ anonymousId: OTHER, consents: { analytics: false } }, OTHER));
    expect(res.status).toBe(200);
    expect((await res.json()).state.analytics).toBe(false);
    expect(ledger.of(OTHER).map((r) => [r.category, r.decision])).toEqual([['analytics', 'denied']]);
  });
});

describe("the banner's choice lands on the visitor this browser is", () => {
  it('Reject non-essential from the banner is recorded against the cookie and reconciled', async () => {
    // A browser that is visitor OTHER: cookie jar, storage and a same-origin
    // fetch that sends the jar's cookie to the real route, as a browser would.
    let jar = `bubaly_vid=${OTHER}`;
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', { protocol: 'https:', pathname: '/', search: '' });
    vi.stubGlobal('document', {
      get cookie() { return jar; },
      set cookie(v: string) {
        const [pair] = v.split(';');
        const [name, value] = pair.split('=');
        if (name === 'bubaly_vid') jar = `bubaly_vid=${value}`;
      },
    });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    });
    const { POST } = await import('@/app/api/mkt/consent/route');
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => POST(new NextRequest(`https://bubaly.test${url}`, {
      method: init.method, body: init.body as string,
      headers: { ...(init.headers as Record<string, string>), cookie: jar },
    })));

    const { postConsent } = await import('@/lib/marketing/visitor');
    const { presetRejectNonEssential } = await import('@/lib/marketing/consent-ui');
    const resolved = await postConsent(presetRejectNonEssential(), false, 'banner_reject');

    // The server answered (the banner reconciles from it rather than falling
    // back to its local guess), and the refusal is in THIS visitor's ledger.
    expect(resolved).toEqual({
      necessary: true, analytics: false, personalization: false, marketing_email: false, marketing_sms: false,
    });
    expect(ledger.of(OTHER).find((r) => r.category === 'analytics')?.decision).toBe('denied');
    expect(ledger.of(VICTIM)).toHaveLength(victimSeed.length);
  });
});
