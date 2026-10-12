// P7 — public.rate_limits kept raw client IPs and raw email addresses, with a
// per-window timestamp, for good.
//
// Every public route keys its durable limit on the caller's IP (`contact:<ip>`,
// `form:<ip>`, `mkt:<ip>` …) and /api/blog/subscribe also on the submitted
// address (`blogsub:addr:<email>`). rateLimitDb passed the key verbatim to
// rate_limit_hit, which stores it as `bucket_key`; the only cleanup,
// rate_limit_prune, had no caller. So the table was a permanent log of which IP
// used which public endpoint and which addresses were typed into the blog form.
//
// Now the IP and address parts are a keyed digest before they leave the
// server (equality is all a limiter needs), and the daily automations cron
// prunes old windows and fails visibly when it cannot. Driven through real
// routes; negative controls: before the fix the stored keys contain the IP and
// the address, and the cron never calls the prune.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/email', () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock('@/lib/email', () => ({
  getResend: () => ({ emails: { send: async () => ({ data: { id: 're_1' }, error: null }) } }),
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  APP_URL: 'https://bubaly.test',
}));

let db: InMemorySupabase;
let prunes: number;
let pruneFails: boolean;

function limiter(args: Record<string, unknown>, store: InMemorySupabase) {
  const seconds = Number(args.p_window_seconds);
  const windowStart = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const key = String(args.p_key);
  const rows = store.table('rate_limits');
  let row = rows.find((r) => r.bucket_key === key && r.window_start === windowStart);
  if (!row) { row = { bucket_key: key, window_start: windowStart, count: 0 }; rows.push(row); }
  row.count = Number(row.count) + 1;
  const allowed = Number(row.count) <= Number(args.p_limit);
  return [{ allowed, retry_after: allowed ? 0 : seconds }];
}

async function contact(email: string, ip: string) {
  vi.resetModules(); // a cold instance each time: only the durable table remembers
  const { POST } = await import('@/app/api/contact/route');
  return POST(new Request('https://bubaly.com/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ name: 'Jordan', email, topic: 'general', message: 'Hello there, a question.' }),
  }));
}

async function subscribe(email: string, ip: string) {
  vi.resetModules();
  const { POST } = await import('@/app/api/blog/subscribe/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest('https://bubaly.com/api/blog/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email }),
  }));
}

const storedKeys = () => db.table('rate_limits').map((r) => String(r.bucket_key));

beforeEach(() => {
  // One fixed instant, so no case straddles a limiter window boundary.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  prunes = 0;
  pruneFails = false;
  db = createInMemorySupabase({
    defaults: { blog_subscribers: { status: 'active', unsubscribe_token: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } },
    rpc: {
      rate_limit_hit: limiter,
      rate_limit_prune: () => { prunes += 1; if (pruneFails) throw new Error('permission denied'); return null; },
    },
  });
  h.db = db;
  vi.stubEnv('INTERNAL_SECRET', 'fixture-internal-secret');
  vi.stubEnv('CRON_SECRET', 'cron-fixture-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the limiter stores no IP and no address', () => {
  it('keeps the namespace, drops the IP and the submitted address', async () => {
    const res = await contact('person@example.com', '198.51.100.23');
    expect(res.status).toBe(200);
    const keys = storedKeys();
    for (const key of keys) {
      expect(key).not.toContain('198.51.100.23');
      expect(key).not.toContain('person');
      expect(key).not.toContain('example.com');
    }
    expect(keys.some((k) => k.startsWith('contact:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('automation:form_submitted:'))).toBe(true);
  });

  it('an IPv6 /64 and a blog address are stored as digests too', async () => {
    await subscribe('reader@example.org', '2001:db8:85a3:12::1');
    await subscribe('reader@example.org', '2001:db8:85a3:12::ff');
    const keys = storedKeys();
    expect(keys.some((k) => k.startsWith('blogsub:addr:'))).toBe(true);
    for (const key of keys) {
      expect(key).not.toMatch(/2001:db8|85a3:12|::\/64/);
      expect(key).not.toContain('reader');
    }
    // One /64, one subject: both hosts landed on the same per-IP bucket.
    expect(db.table('rate_limits').filter((r) => String(r.bucket_key).startsWith('blogsub:h.'))).toEqual([
      expect.objectContaining({ count: 2 }),
    ]);
  });

  it('still limits: the sixth message from one IP is refused by the durable count alone', async () => {
    for (let i = 0; i < 5; i += 1) expect((await contact(`p${i}@example.com`, '192.0.2.77')).status).toBe(200);
    const sixth = await contact('p5@example.com', '192.0.2.77');
    expect(sixth.status).toBe(429);
    // …and a different IP is a different subject.
    expect((await contact('p6@example.com', '192.0.2.78')).status).toBe(200);
  });

  it('leaves a signed-in caller’s own id in the key, which rate_limit_hit (0179) requires', async () => {
    const { storedBucketKey } = await import('@/lib/server/rate-limit-db');
    const uid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect(storedBucketKey(`ai:${uid}`)).toBe(`ai:${uid}`);
    expect(storedBucketKey(`invite:${uid}:Someone@Example.com`)).toMatch(new RegExp(`^invite:${uid}:h\\.[0-9a-f]{32}$`));
  });
});

describe('old windows are pruned, and a prune that fails is not silent', () => {
  async function cron() {
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/automations/route');
    const { NextRequest } = await import('next/server');
    return GET(new NextRequest('https://bubaly.test/api/cron/automations', {
      headers: { authorization: 'Bearer cron-fixture-secret' },
    }));
  }

  it('the daily automations cron runs rate_limit_prune', async () => {
    const res = await cron();
    expect(prunes).toBe(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rateLimitsPruned: true, ok: true });
  });

  it('answers 502 when the prune did not land', async () => {
    pruneFails = true;
    const res = await cron();
    expect(prunes).toBe(1);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ rateLimitsPruned: false, ok: false });
  });
});
