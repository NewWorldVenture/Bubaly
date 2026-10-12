// AUD-1028-M1-REPEAT — /api/blog/subscribe reverses an opt-out only once the
// address has been mailed that it happened: it reads the row, waits for the
// mail provider to accept the "you're back on the list" notice, and then writes
// guarded on the status and opt-out time it read. That notice carries the
// one-click unsubscribe link, and its owner may click it while the provider is
// still answering. The row then still says `unsubscribed` — nothing has been
// reactivated yet — and /api/blog/unsubscribe left a row already unsubscribed
// untouched. Both guarded columns still matched, and the reactivation the owner
// had just refused went through.
//
// Every valid click now re-stamps the opt-out with a later time, which no
// reactivation read before it can match: the newer opt-out stands, and the
// submission is answered like every other accepted one.
//
// AUD-1028-M1-ABA — and the re-stamp was computed from an unlocked read and
// written over whatever the row said by then. Clicks that overlap each other
// around a reactivation could put back an opt-out time the reactivation had
// read: with the clock at T, click A reads T and pauses; B writes T+1; a
// reactivation reads T+1 and waits on its notice; C writes T+2; A lands T+1
// over it, and the reactivation's guard matches again. A click now writes only
// over the row as it read it, re-reads and stamps again when a newer write
// overtook it, and says `error` when it is overtaken on every attempt.
//
// Driven through the real subscribe and unsubscribe routes and the real notice
// helper, over an in-memory table and the real two-layer limiter; only the mail
// provider is replaced. The provider is held open, which is the window a real
// round trip leaves, and the unsubscribe link is followed inside it while the
// original row is still `unsubscribed` — no reactivation in between. A click
// is paused between its read and its write by holding its write back from the
// table (`aroundOptOutWrites`), which is the window the clock leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type Mail = { to: string; subject: string };
type Provider = 'ok' | 'failed' | 'skipped' | 'throws';

const h = vi.hoisted(() => ({
  db: null as unknown,
  provider: 'ok' as Provider,
  attempts: [] as { to: string; subject: string }[],
  delivered: [] as { to: string; subject: string }[],
  /** When set, every send waits for it: the provider's round trip, held open. */
  hold: null as Promise<void> | null,
  /** Sends that have reached the provider, and who is waiting for a count of them. */
  entered: 0,
  waiting: [] as (() => boolean)[],
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/email', () => ({
  sendEmail: async (mail: Mail) => {
    h.entered += 1;
    h.waiting = h.waiting.filter((settled) => !settled());
    if (h.hold) await h.hold;
    h.attempts.push(mail);
    if (h.provider === 'throws') throw new Error('provider unreachable');
    if (h.provider === 'failed') return { ok: false, reason: 'provider_error' };
    if (h.provider === 'skipped') return { ok: true, skipped: true };
    h.delivered.push(mail);
    return { ok: true };
  },
}));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test' }));

const TOKEN = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const READER = 'reader@example.com';

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

let db: InMemorySupabase;

async function subscribe(email: string, ip: string) {
  const { POST } = await import('@/app/api/blog/subscribe/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest('https://bubaly.com/api/blog/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, source: 'blog' }),
  }));
}

/** The owner follows the one-click link; the page says they are unsubscribed. */
async function unsubscribeLink() {
  const { GET } = await import('@/app/api/blog/unsubscribe/route');
  const { NextRequest } = await import('next/server');
  const res = await GET(new NextRequest(`https://bubaly.com/api/blog/unsubscribe?token=${TOKEN}`));
  expect(new URL(res.headers.get('location') ?? '').searchParams.get('unsubscribed')).toBe('1');
}

/** Follows the one-click link and answers the `unsubscribed=` value the page is sent. */
async function click() {
  const { GET } = await import('@/app/api/blog/unsubscribe/route');
  const { NextRequest } = await import('next/server');
  const res = await GET(new NextRequest(`https://bubaly.com/api/blog/unsubscribe?token=${TOKEN}`));
  return new URL(res.headers.get('location') ?? '').searchParams.get('unsubscribed');
}

type Reply = { data: unknown; error: unknown };

/**
 * The service client with hooks around the unsubscribe route's own calls:
 *  - `beforeWrite(n)` runs as the n-th opt-out write (an update that sets
 *    `status: 'unsubscribed'` and an `unsubscribed_at`) is about to reach the
 *    table — after its click read the row and computed its stamp — and may
 *    hold it there or change the row under it;
 *  - `reread(n)`, when it returns a reply, answers the n-th re-read of a row
 *    by id instead of the table.
 */
function aroundOptOutWrites(
  target: InMemorySupabase,
  hooks: { beforeWrite?: (nth: number) => Promise<void> | void; reread?: (nth: number) => Reply | undefined },
): InMemorySupabase {
  let writes = 0;
  let rereads = 0;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop !== 'from') return Reflect.get(obj, prop, receiver);
      return (table: string) => {
        const builder = obj.from(table);
        if (table !== 'blog_subscribers') return builder;
        const update = builder.update.bind(builder);
        const select = builder.select.bind(builder);
        const eq = builder.eq.bind(builder);
        const maybeSingle = builder.maybeSingle.bind(builder);
        const run = builder.then.bind(builder);
        let columns = '';
        let byId = false;
        return Object.assign(builder, {
          update: (patch: Record<string, unknown>) => {
            if (patch.status !== 'unsubscribed' || !('unsubscribed_at' in patch) || !hooks.beforeWrite) return update(patch);
            const nth = ++writes;
            const before = hooks.beforeWrite;
            Object.assign(builder, {
              then: (onFulfilled?: Parameters<typeof run>[0], onRejected?: Parameters<typeof run>[1]) =>
                Promise.resolve(before(nth)).then(() => run(onFulfilled, onRejected)),
            });
            return update(patch);
          },
          select: (list?: string, opts?: { count?: 'exact'; head?: boolean }) => { columns = list ?? ''; return select(list, opts); },
          eq: (column: string, value: unknown) => { if (column === 'id') byId = true; return eq(column, value); },
          maybeSingle: async () => {
            if (!byId || !columns.includes('unsubscribed_at')) return maybeSingle();
            const answer = hooks.reread?.(++rereads);
            return answer ?? maybeSingle();
          },
        });
      };
    },
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Holds every send at the provider until `release()`; `reached(n)` settles once n sends are waiting there. */
function holdProvider() {
  let release!: () => void;
  h.hold = new Promise<void>((resolve) => { release = resolve; });
  h.entered = 0;
  const reached = (n: number) => new Promise<void>((resolve) => {
    const settled = () => { if (h.entered < n) return false; resolve(); return true; };
    if (!settled()) h.waiting.push(settled);
  });
  return { release: () => { h.hold = null; release(); }, reached };
}

/** Everything a caller can observe in an answer; `date` is a clock, not a signal. */
async function observable(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()]
      .filter(([k]) => k.toLowerCase() !== 'date')
      .map(([k, v]) => `${k.toLowerCase()}: ${v}`)
      .sort(),
  };
}

const row = () => db.table('blog_subscribers')[0];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
  h.provider = 'ok';
  h.attempts = [];
  h.delivered = [];
  h.hold = null;
  h.entered = 0;
  h.waiting = [];
  db = createInMemorySupabase({
    uniques: { blog_subscribers: [['email']] },
    defaults: { blog_subscribers: { status: 'active', unsubscribe_token: TOKEN, unsubscribed_at: null } },
    rpc: { rate_limit_hit: limiter },
  });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** A reader who subscribed (and was told) and then followed the link out at 10:06. */
async function optedOut() {
  expect((await subscribe(READER, '203.0.113.1')).status).toBe(200);
  expect(row().status).toBe('active');
  vi.setSystemTime(new Date('2026-10-12T10:06:00Z'));
  await unsubscribeLink();
  expect(row()).toMatchObject({ status: 'unsubscribed', unsubscribed_at: '2026-10-12T10:06:00.000Z' });
  h.attempts = [];
  h.delivered = [];
  return String(row().unsubscribed_at);
}

describe('a click on the unsubscribe link while a reactivation notice is out', () => {
  it('keeps the address off the list: the reactivation read before the click writes nothing', async () => {
    await optedOut();

    // Someone re-submits the address; its notice is with the provider.
    const provider = holdProvider();
    const pending = subscribe(READER, '203.0.113.2');
    await provider.reached(1);

    // The owner clicks the link. The row still says `unsubscribed`: nothing was reactivated.
    vi.setSystemTime(new Date('2026-10-12T10:07:00Z'));
    expect(row().status).toBe('unsubscribed');
    await unsubscribeLink();
    expect(row().status).toBe('unsubscribed');

    provider.release();
    const res = await pending;
    expect(h.delivered.map((m) => m.subject), 'the notice did go out').toEqual([expect.stringMatching(/back on/i)]);
    expect(row().status, 'the reactivation the owner had just refused went through').toBe('unsubscribed');
    expect(row().unsubscribed_at, 'the opt-out is the click’s').toBe('2026-10-12T10:07:00.000Z');
    // Answered like every accepted submission: the answer does not say the owner left.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does so within the same millisecond as the opt-out it repeats', async () => {
    const before = await optedOut();

    const provider = holdProvider();
    const pending = subscribe(READER, '203.0.113.3');
    await provider.reached(1);
    // The clock has not moved since the first opt-out.
    await unsubscribeLink();

    provider.release();
    expect((await pending).status).toBe(200);
    expect(row().status, 'the reactivation the owner had just refused went through').toBe('unsubscribed');
    expect(Date.parse(String(row().unsubscribed_at)), 'the click is the newer opt-out').toBeGreaterThan(Date.parse(before));
  });

  it('a second click with nothing in flight is still unsubscribed, and moves the opt-out forward', async () => {
    await optedOut();
    vi.setSystemTime(new Date('2026-10-12T10:08:00Z'));
    await unsubscribeLink();
    expect(row()).toMatchObject({ status: 'unsubscribed', unsubscribed_at: '2026-10-12T10:08:00.000Z' });
  });

  it('holds against two submissions in flight together, which are answered alike', async () => {
    await optedOut();

    const provider = holdProvider();
    const pending = [subscribe(READER, '198.51.100.31'), subscribe(READER, '198.51.100.32')];
    await provider.reached(2);
    vi.setSystemTime(new Date('2026-10-12T10:07:00Z'));
    await unsubscribeLink();

    provider.release();
    const [a, b] = await Promise.all((await Promise.all(pending)).map(observable));
    expect(row().status).toBe('unsubscribed');
    expect(db.table('blog_subscribers')).toHaveLength(1);
    expect([a.status, a.body]).toEqual([200, '{"ok":true}']);
    expect(b).toEqual(a);
  });

  for (const provider of ['failed', 'skipped', 'throws'] as const) {
    it(`a notice that ${provider === 'throws' ? 'threw' : `was ${provider}`} leaves the opt-out standing either way (control)`, async () => {
      await optedOut();
      h.provider = provider;

      const held = holdProvider();
      const pending = subscribe(READER, '203.0.113.4');
      await held.reached(1);
      vi.setSystemTime(new Date('2026-10-12T10:07:00Z'));
      await unsubscribeLink();

      held.release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(row().status).toBe('unsubscribed');
    });
  }
});

describe('clicks that overlap each other around a reactivation (AUD-1028-M1-ABA)', () => {
  /** A click paused between its read and its write: `paused` settles at the write, `release()` lets it reach the table. */
  function pauseFirstClick() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    h.db = aroundOptOutWrites(db, { beforeWrite: async (nth) => { if (nth === 1) { reached(); await gate; } } });
    return { paused, release };
  }

  it('a stale click cannot put back an opt-out time a newer click replaced, so the reactivation that read it writes nothing', async () => {
    const t = Date.parse(await optedOut());
    // The clock stays at T throughout: every stamp below is "later than the row".

    const a = pauseFirstClick();
    const stale = click();
    await a.paused;
    expect(row().unsubscribed_at, 'click A has read T and not written yet').toBe(iso(t));

    expect(await click(), 'click B').toBe('1');
    expect(row().unsubscribed_at).toBe(iso(t + 1));

    // Someone re-submits the address: it reads T+1 and waits on its notice.
    const provider = holdProvider();
    const pending = subscribe(READER, '203.0.113.6');
    await provider.reached(1);

    expect(await click(), 'click C').toBe('1');
    expect(row().unsubscribed_at).toBe(iso(t + 2));

    // Click A's write reaches the table now, then the notice is accepted.
    a.release();
    expect(await stale, 'click A is still an unsubscribe that took').toBe('1');
    provider.release();
    const res = await pending;

    expect(h.delivered.map((m) => m.subject), 'the notice did go out').toEqual([expect.stringMatching(/back on/i)]);
    expect(row().status, 'the reactivation went through on an opt-out time click A put back').toBe('unsubscribed');
    expect(Date.parse(String(row().unsubscribed_at)), 'the opt-out moved back').toBeGreaterThan(t + 2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('the same when the stale click read the reader still on the list', async () => {
    expect((await subscribe(READER, '203.0.113.1')).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-12T10:06:00Z'));
    const t = Date.now();
    h.delivered = [];

    const a = pauseFirstClick();
    const stale = click();
    await a.paused;
    expect(row()).toMatchObject({ status: 'active', unsubscribed_at: null });

    expect(await click(), 'click B').toBe('1');
    expect(row()).toMatchObject({ status: 'unsubscribed', unsubscribed_at: iso(t) });

    const provider = holdProvider();
    const pending = subscribe(READER, '203.0.113.7');
    await provider.reached(1);
    expect(await click(), 'click C').toBe('1');
    expect(row().unsubscribed_at).toBe(iso(t + 1));

    a.release();
    expect(await stale).toBe('1');
    provider.release();
    expect((await pending).status).toBe(200);

    expect(row().status, 'the reactivation went through on the opt-out time click A put back').toBe('unsubscribed');
    expect(Date.parse(String(row().unsubscribed_at))).toBeGreaterThan(t + 1);
  });

  it('a click overtaken on every attempt says it could not record the opt-out, and writes nothing over the newer one', async () => {
    const t = Date.parse(await optedOut());
    let attempts = 0;
    // Another click lands between this click's read and each of its writes.
    h.db = aroundOptOutWrites(db, {
      beforeWrite: (nth) => {
        attempts = nth;
        row().unsubscribed_at = iso(Date.parse(String(row().unsubscribed_at)) + 1);
      },
    });

    expect(await click(), 'claimed an opt-out it never wrote').toBe('error');
    expect(attempts, 'bounded: the first write and two retries').toBe(3);
    expect(row()).toMatchObject({ status: 'unsubscribed', unsubscribed_at: iso(t + 3) });
  });

  it('a click overtaken once re-reads the row and lands later than everything it saw', async () => {
    const t = Date.parse(await optedOut());
    h.db = aroundOptOutWrites(db, {
      beforeWrite: (nth) => { if (nth === 1) row().unsubscribed_at = iso(t + 5); },
    });

    expect(await click()).toBe('1');
    expect(row()).toMatchObject({ status: 'unsubscribed', unsubscribed_at: iso(t + 6) });
  });

  it('a re-read that is refused is not taken for a deleted row', async () => {
    const t = Date.parse(await optedOut());
    h.db = aroundOptOutWrites(db, {
      beforeWrite: (nth) => { if (nth === 1) row().unsubscribed_at = iso(t + 1); },
      reread: () => ({ data: null, error: { code: '08006', message: 'connection reset', details: null, hint: null } }),
    });

    expect(await click()).toBe('error');
    expect(row().unsubscribed_at).toBe(iso(t + 1));
  });

  it('a row deleted between the read and the write is still an unsubscribe that took (control)', async () => {
    await optedOut();
    h.db = aroundOptOutWrites(db, { beforeWrite: () => { db.replace('blog_subscribers', []); } });

    expect(await click()).toBe('1');
    expect(db.table('blog_subscribers')).toEqual([]);
  });
});

describe('what a click does not reach (positive controls)', () => {
  it('an ordinary unsubscribe takes an active reader off the list at the time of the click', async () => {
    await subscribe(READER, '203.0.113.1');
    vi.setSystemTime(new Date('2026-10-12T10:06:30Z'));
    await unsubscribeLink();
    expect(row()).toMatchObject({ status: 'unsubscribed', unsubscribed_at: '2026-10-12T10:06:30.000Z' });
  });

  it('an ordinary re-subscribe whose notice went out puts the reader back, after one click or two', async () => {
    await optedOut();
    vi.setSystemTime(new Date('2026-10-12T10:08:00Z'));
    await unsubscribeLink();

    vi.setSystemTime(new Date('2026-10-12T10:09:00Z'));
    const res = await subscribe(READER, '203.0.113.5');
    expect(await res.json()).toEqual({ ok: true });
    expect(row()).toMatchObject({ status: 'active', unsubscribed_at: null });
    expect(h.delivered.map((m) => m.subject)).toEqual([expect.stringMatching(/back on/i)]);
  });

  it('two re-subscribes in flight together with no click: the told reactivation stands, answered alike', async () => {
    await optedOut();

    const provider = holdProvider();
    const pending = [subscribe(READER, '198.51.100.33'), subscribe(READER, '198.51.100.34')];
    await provider.reached(2);
    provider.release();
    const [a, b] = await Promise.all((await Promise.all(pending)).map(observable));
    expect(row()).toMatchObject({ status: 'active', unsubscribed_at: null });
    expect([a.status, a.body]).toEqual([200, '{"ok":true}']);
    expect(b).toEqual(a);
  });
});
