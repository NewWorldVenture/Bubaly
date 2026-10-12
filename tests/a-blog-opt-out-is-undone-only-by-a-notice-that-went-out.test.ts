// AUD-1028-M1 — /api/blog/subscribe could put an address that had opted out
// back on the list without the address ever being told, and could overwrite an
// unsubscribe that landed while it was running.
//
// 1. Reactivation was WRITTEN first and the notice sent after it. The notice is
//    the owner's only sign that a stranger re-subscribed them, and
//    sendSubscribeNotice swallows a failed, skipped (no provider) or thrown send
//    — so on any of those the row went back to `active` in silence.
// 2. The single UPDATE every state issues re-asserted the status the lookup had
//    read, with no predicate on it. An owner who unsubscribed between the
//    lookup and that write (from any earlier notice: the token never changes)
//    was written straight back to `active` — by the "already subscribed"
//    re-assert as much as by a reactivation.
// 3. (AUD-1028-M1-R1) The guard that closed 2 refused a write that matched no
//    row with a 500. Two simultaneous submissions of an address that had opted
//    out both read the opt-out, the first reactivates and the second's guard
//    matches nothing — so the pair answered [200, 500] where an active or a
//    never-seen address answered [200, 200], and the 500 named the opt-out to
//    an anonymous caller. A write that a newer state overtook writes nothing
//    and answers like every other accepted submission; only a row that is GONE
//    keeps the 500, so the retry inserts (Audit C1-S9-62).
//
// Driven through the real subscribe and unsubscribe routes and the real notice
// helper, over an in-memory table and the real two-layer limiter. Only the mail
// provider is replaced. The interleavings hold the subscribe route's lookup
// answer (read now, delivered later) while the unsubscribe link runs.
// Negative controls: before the fix each provider failure leaves the row
// `active`, and each held lookup overwrites the unsubscribe. With the guard but
// before R1, both interleavings, the opted-out double submit and the overtaken
// twin whose notice failed answer 500.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type Mail = { to: string; subject: string };
type Provider = 'ok' | 'failed' | 'skipped' | 'throws';

const h = vi.hoisted(() => ({
  db: null as unknown,
  provider: 'ok' as Provider,
  attempts: [] as Mail[],
  delivered: [] as Mail[],
  /** When set, every send waits for it: the window a provider round trip opens. */
  hold: null as Promise<void> | null,
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/email', () => ({
  sendEmail: async (mail: Mail) => {
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

const TOKEN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
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

async function unsubscribeLink() {
  const { GET } = await import('@/app/api/blog/unsubscribe/route');
  const { NextRequest } = await import('next/server');
  const res = await GET(new NextRequest(`https://bubaly.com/api/blog/unsubscribe?token=${TOKEN}`));
  expect(new URL(res.headers.get('location') ?? '').searchParams.get('unsubscribed')).toBe('1');
}

/**
 * The service client with its FIRST blog_subscribers lookup held: the read is
 * made at once, and its answer handed back only on release() — a lookup that
 * is stale by the time the route acts on it.
 */
function holdFirstLookup(target: InMemorySupabase) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atLookup = new Promise<void>((resolve) => { reached = resolve; });
  let armed = true;
  const client = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop !== 'from') return Reflect.get(obj, prop, receiver);
      return (table: string) => {
        const builder = obj.from(table);
        if (table !== 'blog_subscribers' || !armed) return builder;
        armed = false;
        const read = builder.maybeSingle.bind(builder);
        return Object.assign(builder, {
          maybeSingle: async () => {
            const answer = await read();
            reached();
            await gate;
            return answer;
          },
        });
      };
    },
  });
  return { client, release, atLookup };
}

/** A wrapper around the service client's blog_subscribers lookups. */
function onLookup(
  target: InMemorySupabase,
  wrap: (read: () => Promise<unknown>, nth: number) => Promise<unknown>,
): InMemorySupabase {
  let seen = 0;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop !== 'from') return Reflect.get(obj, prop, receiver);
      return (table: string) => {
        const builder = obj.from(table);
        if (table !== 'blog_subscribers') return builder;
        const read = builder.maybeSingle.bind(builder);
        return Object.assign(builder, { maybeSingle: () => wrap(read, ++seen) });
      };
    },
  });
}

/**
 * The service client with its blog_subscribers lookups counted: `all` settles
 * once `n` of them have been answered. Handed to the provider as `h.hold`, it
 * makes "simultaneous" exact rather than a matter of timing: every request has
 * read the row before any request's notice returns, which is the window a real
 * provider round trip (25 ms in the reviewer's probe) leaves open. No read
 * waits on a send, so it cannot deadlock whichever path each request takes.
 */
function afterLookups(target: InMemorySupabase, n: number) {
  let done!: () => void;
  const all = new Promise<void>((resolve) => { done = resolve; });
  const client = onLookup(target, async (read, nth) => {
    const answer = await read();
    if (nth >= n) done();
    return answer;
  });
  return { client, all };
}

/** The service client whose `nth` blog_subscribers lookup is refused. */
const refuseLookup = (target: InMemorySupabase, nth: number) =>
  onLookup(target, async (read, seen) => (seen === nth
    ? { data: null, error: { code: '08006', message: 'connection reset', details: null, hint: null } }
    : read()));

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

function freshTable() {
  return createInMemorySupabase({
    uniques: { blog_subscribers: [['email']] },
    defaults: { blog_subscribers: { status: 'active', unsubscribe_token: TOKEN, unsubscribed_at: null } },
    rpc: { rate_limit_hit: limiter },
  });
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
  db = freshTable();
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** A reader who subscribed (and was told) and then followed the link out. */
async function optedOut() {
  expect((await subscribe(READER, '203.0.113.1')).status).toBe(200);
  expect(row().status).toBe('active');
  vi.setSystemTime(new Date('2026-10-12T10:06:00Z'));
  await unsubscribeLink();
  expect(row().status).toBe('unsubscribed');
  return String(row().unsubscribed_at);
}

describe('an opt-out is reversed only by a notice the provider accepted', () => {
  for (const provider of ['failed', 'skipped', 'throws'] as const) {
    it(`a notice that ${provider === 'throws' ? 'threw' : `was ${provider}`} leaves the opt-out standing`, async () => {
      const at = await optedOut();
      h.provider = provider;
      h.attempts = [];

      const res = await subscribe(READER, '203.0.113.2');
      // The answer does not move: a provider outage must not become an oracle.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(h.attempts.map((m) => m.subject), 'the reactivation notice was attempted').toEqual([
        expect.stringMatching(/back on/i),
      ]);
      expect(row().status, 'nobody told the address, so nothing changed').toBe('unsubscribed');
      expect(row().unsubscribed_at).toBe(at);
    });
  }

  it('a notice that went out re-subscribes the address (positive control)', async () => {
    await optedOut();
    h.delivered = [];
    const res = await subscribe(READER, '203.0.113.2');
    expect(await res.json()).toEqual({ ok: true });
    expect(row().status).toBe('active');
    expect(row().unsubscribed_at).toBeNull();
    expect(h.delivered.map((m) => m.subject)).toEqual([expect.stringMatching(/back on/i)]);
  });

  it('a first-time subscriber is mailed once and is active (positive control)', async () => {
    const res = await subscribe('new@example.com', '203.0.113.3');
    expect(await res.json()).toEqual({ ok: true });
    expect(row()).toMatchObject({ email: 'new@example.com', status: 'active' });
    expect(h.delivered).toEqual([expect.objectContaining({ to: 'new@example.com', subject: expect.stringMatching(/subscribed/i) })]);
  });

  it('an address already on the list is re-asserted, not repainted, and told so (positive control)', async () => {
    await subscribe(READER, '203.0.113.1');
    h.delivered = [];
    const res = await subscribe(READER, '203.0.113.4');
    expect(await res.json()).toEqual({ ok: true });
    expect(row().status).toBe('active');
    expect(h.delivered.map((m) => m.subject)).toEqual([expect.stringMatching(/already/i)]);
  });
});

describe('an unsubscribe that lands mid-request is not overwritten', () => {
  it('“already subscribed”: the owner leaves between the lookup and the write', async () => {
    await subscribe(READER, '203.0.113.1');
    expect(row().status).toBe('active');

    const held = holdFirstLookup(db);
    h.db = held.client;
    const pending = subscribe(READER, '203.0.113.5');
    await held.atLookup; // the route has read `active`
    h.db = db;

    vi.setSystemTime(new Date('2026-10-12T10:07:00Z'));
    await unsubscribeLink();
    const at = String(row().unsubscribed_at);
    h.delivered = [];

    held.release();
    const res = await pending;
    expect(row().status, 'the stale `active` was written over the unsubscribe').toBe('unsubscribed');
    expect(row().unsubscribed_at).toBe(at);
    // Nothing written, and answered like every accepted submission: the newer
    // opt-out stands, and the answer does not say there was one.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.delivered, 'nobody is told “already on the list” after they left it').toEqual([]);
  });

  it('a reactivation in flight does not undo a newer unsubscribe', async () => {
    await optedOut();

    // A reads the opted-out row, and is held there.
    const held = holdFirstLookup(db);
    h.db = held.client;
    const pending = subscribe(READER, '203.0.113.6');
    await held.atLookup;
    h.db = db;

    // Meanwhile B re-subscribes the address (and it is told), and the owner
    // leaves again from that notice.
    vi.setSystemTime(new Date('2026-10-12T10:08:00Z'));
    await subscribe(READER, '203.0.113.7');
    expect(row().status).toBe('active');
    vi.setSystemTime(new Date('2026-10-12T10:09:00Z'));
    await unsubscribeLink();
    const at = String(row().unsubscribed_at);

    held.release();
    const res = await pending;
    expect(row().status, 'A reactivated over the owner’s newer opt-out').toBe('unsubscribed');
    expect(row().unsubscribed_at).toBe(at);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('with nothing in between, the same held lookup still re-subscribes (positive control)', async () => {
    await optedOut();
    const held = holdFirstLookup(db);
    h.db = held.client;
    const pending = subscribe(READER, '203.0.113.8');
    await held.atLookup;
    h.db = db;
    held.release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(row().status).toBe('active');
    expect(row().unsubscribed_at).toBeNull();
  });
});

describe('two simultaneous submissions get the same answers for every address (AUD-1028-M1-R1)', () => {
  type Seen = Awaited<ReturnType<typeof observable>>;
  const ACCEPTED_BODY = '{"ok":true}';

  /** Two POSTs of one address, in flight together, from two IPs. */
  async function doubleSubmit(email: string): Promise<Seen[]> {
    const race = afterLookups(db, 2);
    h.db = race.client;
    h.hold = race.all;
    const answers = await Promise.all([subscribe(email, '198.51.100.21'), subscribe(email, '198.51.100.22')]);
    h.db = db;
    h.hold = null;
    return Promise.all(answers.map(observable));
  }

  /**
   * Each state on a table of its own, so it starts from exactly that state, and
   * at an inbox of its own, so no case spends another's notice allowance (the
   * limiter's in-process layer outlives a table).
   */
  function useFreshTable() {
    db = freshTable();
    h.db = db;
  }

  it('never seen, on the list and opted out each answer [{ ok: true }, { ok: true }]', async () => {
    const answers: Record<string, Seen[]> = {};

    answers['never seen'] = await doubleSubmit('stranger@example.com');
    expect(db.table('blog_subscribers'), 'one row for the pair').toEqual([
      expect.objectContaining({ email: 'stranger@example.com', status: 'active' }),
    ]);

    useFreshTable();
    await subscribe('listed@example.com', '203.0.113.1');
    expect(row().status).toBe('active');
    answers['on the list'] = await doubleSubmit('listed@example.com');
    expect(row().status).toBe('active');

    useFreshTable();
    await optedOut();
    h.attempts = [];
    answers['opted out'] = await doubleSubmit(READER);
    // The race this case is about really ran: BOTH requests read the opt-out
    // and dispatched a reactivation notice before either wrote, so the second
    // request's guarded write met a row the first had already moved.
    expect(h.attempts.map((m) => m.subject), 'both requests read the opt-out').toEqual([
      expect.stringMatching(/back on/i), expect.stringMatching(/back on/i),
    ]);
    // The reactivation that landed (and that the address was told of) stands.
    expect(row().status).toBe('active');
    expect(row().unsubscribed_at).toBeNull();
    expect(db.table('blog_subscribers')).toHaveLength(1);

    for (const [label, pair] of Object.entries(answers)) {
      expect(pair.map((a) => a.status), `${label}: ${JSON.stringify(answers, null, 2)}`).toEqual([200, 200]);
      expect(pair.map((a) => a.body), label).toEqual([ACCEPTED_BODY, ACCEPTED_BODY]);
      expect(pair, label).toEqual(answers['never seen']);
    }
  });

  it('the losing twin whose notice failed answers alike, and the told reactivation stands', async () => {
    // The overtaken write need not be a reactivation. A reads the opt-out and
    // is held; B re-subscribes the address (and it is told); A's own notice
    // then fails, so A re-asserts the opt-out it read, guarded on it — a row B
    // has already moved. That write matches nothing, writes nothing, and A is
    // answered like B.
    await optedOut();
    const held = holdFirstLookup(db);
    h.db = held.client;
    const pending = subscribe(READER, '198.51.100.23');
    await held.atLookup;
    h.db = db;

    const b = await observable(await subscribe(READER, '198.51.100.24'));
    expect(row().status).toBe('active');
    h.provider = 'failed';
    h.attempts = [];

    held.release();
    const a = await observable(await pending);
    expect(h.attempts.map((m) => m.subject), 'A did try to tell the address').toEqual([expect.stringMatching(/back on/i)]);
    expect(a).toEqual(b);
    expect([a.status, a.body]).toEqual([200, ACCEPTED_BODY]);
    expect(row().status, 'the reactivation the address was told of').toBe('active');
    expect(row().unsubscribed_at).toBeNull();
  });
});

describe('a row that is gone mid-request is still refused, so the retry inserts (Audit C1-S9-62)', () => {
  it('deleted between the lookup and the write: 500, no mail, and the retry subscribes', async () => {
    await subscribe(READER, '203.0.113.1');
    const id = String(row().id);

    const held = holdFirstLookup(db);
    h.db = held.client;
    const pending = subscribe(READER, '203.0.113.9');
    await held.atLookup; // the route has read `active`
    h.db = db;
    const { data: gone } = await db.from('blog_subscribers').delete().eq('id', id).select('id');
    expect(gone).toEqual([{ id }]);
    h.delivered = [];

    held.release();
    const res = await pending;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'subscribe.couldNotSubscribeRightNow' });
    expect(h.delivered, 'no notice carries a token for a row that is not there').toEqual([]);

    const retry = await subscribe(READER, '203.0.113.10');
    expect(await retry.json()).toEqual({ ok: true });
    expect(db.table('blog_subscribers'), 'the retry took the insert path').toEqual([
      expect.objectContaining({ email: READER, status: 'active' }),
    ]);
  });

  it('a refused re-read is not “the row is there”: 500, and nothing is written', async () => {
    await subscribe(READER, '203.0.113.1');

    // The route's first lookup is held; its second, the re-read, is refused.
    const held = holdFirstLookup(refuseLookup(db, 2));
    h.db = held.client;
    const pending = subscribe(READER, '203.0.113.11');
    await held.atLookup;
    h.db = db;

    vi.setSystemTime(new Date('2026-10-12T10:07:00Z'));
    await unsubscribeLink();
    const at = String(row().unsubscribed_at);
    h.delivered = [];

    held.release();
    const res = await pending;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'subscribe.couldNotSubscribeRightNow' });
    expect(row().status).toBe('unsubscribed');
    expect(row().unsubscribed_at).toBe(at);
    expect(h.delivered).toEqual([]);
  });
});
