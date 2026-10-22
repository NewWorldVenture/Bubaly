// P3 / P8 — /api/blog/subscribe, unauthenticated, with its per-address mail
// throttle (3 notices an hour, "rotating IPs does not lift it").
//
// P3. The throttle was keyed on the address AS TYPED. `victim+1@gmail.com`,
// `victim+2@gmail.com` and `v.ictim@gmail.com` are three keys, three new rows
// and three "You're subscribed" notices — all delivered to one inbox, bounded
// only by the per-IP limit of 20 a minute.
//
// P8. An `unsubscribed` row was reactivated on ANY submission, notice or not.
// The notice is the address owner's only sign it happened, and it is throttled:
// spend the address's three notices, let the owner unsubscribe from one of them,
// submit again inside the hour — and the opt-out is silently undone.
//
// Driven through the real subscribe and unsubscribe routes with the real
// two-layer limiter over an in-memory rate_limit_hit. Negative controls: before
// the fix the +tag burst mails the inbox once per spelling, and the fourth
// submission leaves the row `active` with no notice sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, notices: [] as { to: string; subject: string }[] }));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/email', () => ({
  sendEmail: async (mail: { to: string; subject: string }) => { h.notices.push(mail); return { ok: true }; },
}));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test' }));

const TOKEN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function limiter(args: Record<string, unknown>, db: InMemorySupabase) {
  const seconds = Number(args.p_window_seconds);
  const windowStart = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const key = String(args.p_key);
  const rows = db.table('rate_limits');
  let row = rows.find((r) => r.bucket_key === key && r.window_start === windowStart);
  if (!row) { row = { bucket_key: key, window_start: windowStart, count: 0 }; rows.push(row); }
  row.count = Number(row.count) + 1;
  const allowed = Number(row.count) <= Number(args.p_limit);
  return [{ allowed, retry_after: allowed ? 0 : seconds }];
}

let db: InMemorySupabase;

async function subscribe(email: string, ip = '198.51.100.7') {
  const { POST } = await import('@/app/api/blog/subscribe/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest('https://bubaly.com/api/blog/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, source: 'blog' }),
  }));
}

async function unsubscribeLink(token: string) {
  const { GET } = await import('@/app/api/blog/unsubscribe/route');
  const { NextRequest } = await import('next/server');
  return GET(new NextRequest(`https://bubaly.com/api/blog/unsubscribe?token=${token}`));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  h.notices = [];
  db = createInMemorySupabase({
    uniques: { blog_subscribers: [['email']] },
    defaults: { blog_subscribers: { status: 'active', unsubscribe_token: TOKEN, unsubscribed_at: null } },
    rpc: { rate_limit_hit: limiter },
  });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('P3: the notice throttle counts the inbox, not the spelling', () => {
  it('+tags and Gmail dots do not buy one inbox more notices', async () => {
    const spellings = ['victim@gmail.com', 'victim+1@gmail.com', 'victim+2@gmail.com', 'v.ictim@gmail.com', 'victim+3@googlemail.com', 'vic.tim+4@gmail.com'];
    for (const email of spellings) {
      const res = await subscribe(email);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(h.notices).toHaveLength(3);
    // Every address is still stored as typed; only the mail is bounded.
    expect(db.table('blog_subscribers').map((r) => r.email)).toEqual(spellings);
  });

  it('a different inbox keeps its own allowance (positive control)', async () => {
    for (let i = 0; i < 3; i += 1) await subscribe(`first+${i}@example.com`);
    await subscribe('second@example.com');
    expect(h.notices.map((n) => n.to)).toEqual([
      'first+0@example.com', 'first+1@example.com', 'first+2@example.com', 'second@example.com',
    ]);
  });
});

describe('P8: an opt-out is not reversed without telling the address', () => {
  it('a submission that cannot be noticed leaves the unsubscribe standing', async () => {
    for (let i = 0; i < 3; i += 1) await subscribe('reader@example.com', `203.0.113.${i + 1}`);
    expect(h.notices).toHaveLength(3);

    // The owner follows the link in one of those notices.
    const out = await unsubscribeLink(TOKEN);
    expect(new URL(out.headers.get('location') ?? '').searchParams.get('unsubscribed')).toBe('1');
    expect(db.table('blog_subscribers')[0].status).toBe('unsubscribed');

    // A fourth submission inside the hour: the throttle refuses the notice, so
    // the opt-out must stand. The answer is the same uniform one.
    const res = await subscribe('reader@example.com', '203.0.113.9');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [row] = db.table('blog_subscribers');
    expect(row.status).toBe('unsubscribed');
    expect(row.unsubscribed_at).not.toBeNull();
    expect(h.notices).toHaveLength(3);
  });

  it('once a notice can go out again, re-subscribing works and says so (positive control)', async () => {
    for (let i = 0; i < 3; i += 1) await subscribe('reader@example.com', `203.0.113.${i + 1}`);
    await unsubscribeLink(TOKEN);

    vi.setSystemTime(new Date('2026-10-12T11:05:00Z'));
    await subscribe('reader@example.com', '203.0.113.9');
    const [row] = db.table('blog_subscribers');
    expect(row.status).toBe('active');
    expect(row.unsubscribed_at).toBeNull();
    expect(h.notices).toHaveLength(4);
    expect(h.notices[3].subject).toMatch(/back on/i);
  });
});
