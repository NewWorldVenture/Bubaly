// AUD-1028-M5 — the rate-limit digest fell back to a key printed in this
// repository.
//
// rateLimitDb replaces the IP and address parts of a bucket key with an HMAC
// before rate_limit_hit stores it, keyed on INTERNAL_SECRET or the service-role
// key. With neither set it used 'bubaly-dev-rate-limit-subject' — in production
// too. That key is public, so every stored digest of an IPv4 address could be
// reversed by hashing the 2^32 addresses with it: public.rate_limits was a
// visitor log again, one HMAC away.
//
// In production that configuration now fails closed: a key that needs a digest
// is refused (or, for a caller that chose failOpen, allowed) and NOTHING is
// written. Development and tests keep working with the constant, and a key with
// no IP or address in it needs no digest at all.
//
// Driven through the real helper and the real /api/contact route over an
// in-memory rate_limit_hit. Negative control: before the fix the production
// case is allowed and stores a digest keyed on the public constant.
import { createHmac } from 'node:crypto';
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

const PUBLIC_CONSTANT = 'bubaly-dev-rate-limit-subject';
let db: InMemorySupabase;
let hits: string[];

function limiter(args: Record<string, unknown>, store: InMemorySupabase) {
  hits.push(String(args.p_key));
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

/** The environment a deployment would have: which secrets exist, and whether it is production. */
function environment(env: { production: boolean; internal?: string; serviceRole?: string }) {
  vi.stubEnv('NODE_ENV', env.production ? 'production' : 'test');
  vi.stubEnv('INTERNAL_SECRET', env.internal ?? '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', env.serviceRole ?? '');
}

async function rateLimitDb(key: string, opts: { failOpen?: boolean } = {}) {
  const mod = await import('@/lib/server/rate-limit-db');
  return mod.rateLimitDb(db as never, key, { limit: 5, windowMs: 60_000, ...opts });
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

const digestUnder = (key: string, value: string) =>
  `h.${createHmac('sha256', key).update('rate-limit-subject\0').update(value).digest('hex').slice(0, 32)}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  vi.resetModules();
  hits = [];
  db = createInMemorySupabase({ rpc: { rate_limit_hit: limiter } });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('production with no secret: nothing is stored under the public key', () => {
  it('refuses an IP-keyed hit and writes no row', async () => {
    environment({ production: true });
    const result = await rateLimitDb('contact:198.51.100.23');
    expect(result).toEqual({ ok: false, retryAfter: 5 });
    expect(hits, 'the digest would have been keyed on a constant anyone can read').toEqual([]);
    expect(db.table('rate_limits')).toEqual([]);
    // Neither the digest under the public constant nor the raw IP reached the table.
    expect(JSON.stringify(db.table('rate_limits'))).not.toContain(digestUnder(PUBLIC_CONSTANT, '198.51.100.23'));
  });

  it('a blank or whitespace secret is no secret', async () => {
    environment({ production: true, internal: '   ', serviceRole: '\t' });
    expect(await rateLimitDb('blogsub:addr:reader@example.com')).toEqual({ ok: false, retryAfter: 5 });
    expect(hits).toEqual([]);
  });

  it('a caller that chose failOpen is let through, still without a row', async () => {
    environment({ production: true });
    expect(await rateLimitDb('feed:198.51.100.23', { failOpen: true })).toEqual({ ok: true, retryAfter: 0 });
    expect(hits).toEqual([]);
  });

  it('the public contact route answers 429 and stores nothing', async () => {
    environment({ production: true });
    const res = await contact('person@example.com', '198.51.100.23');
    expect(res.status).toBe(429);
    expect(db.table('rate_limits')).toEqual([]);
    expect(db.table('support_tickets')).toEqual([]);
  });

  it('a key with no IP or address in it needs no digest, so it is still limited (positive control)', async () => {
    environment({ production: true });
    const uid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect(await rateLimitDb(`ai:${uid}`)).toEqual({ ok: true, retryAfter: 0 });
    expect(hits).toEqual([`ai:${uid}`]);
  });
});

describe('a configured secret, and development, keep limiting (positive controls)', () => {
  it('production with INTERNAL_SECRET stores a digest keyed on it', async () => {
    environment({ production: true, internal: 'fixture-internal-secret' });
    expect(await rateLimitDb('contact:198.51.100.23')).toEqual({ ok: true, retryAfter: 0 });
    expect(hits).toEqual([`contact:${digestUnder('fixture-internal-secret', '198.51.100.23')}`]);
  });

  it('production with only the service-role key stores a digest keyed on it', async () => {
    environment({ production: true, serviceRole: 'fixture-service-role' });
    expect(await rateLimitDb('contact:198.51.100.23')).toEqual({ ok: true, retryAfter: 0 });
    expect(hits).toEqual([`contact:${digestUnder('fixture-service-role', '198.51.100.23')}`]);
  });

  it('tests and development, with no secret at all, still limit: the sixth message from one IP is refused', async () => {
    environment({ production: false });
    for (let i = 0; i < 5; i += 1) expect((await contact(`p${i}@example.com`, '192.0.2.77')).status).toBe(200);
    expect((await contact('p5@example.com', '192.0.2.77')).status).toBe(429);
    for (const key of db.table('rate_limits').map((r) => String(r.bucket_key))) expect(key).not.toContain('192.0.2.77');
  });
});
