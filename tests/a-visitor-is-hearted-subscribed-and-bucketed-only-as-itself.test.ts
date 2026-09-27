// SEC-008. Three more public routes that hold a service-role client took the
// visitor id from the CALLER, the same shape SEC-006 (/api/mkt/consent) and
// SEC-007 (/api/mkt/track) closed:
//
//   GET  /api/blog/like      ?visitorId= in the QUERY STRING → whether that
//                            visitor had hearted a post, with the id in a URL
//   POST /api/blog/like      body.visitorId → add or REMOVE that visitor's ♥
//   POST /api/blog/subscribe body.visitorId → stored as blog_subscribers.visitor_id
//                            on insert and on re-activation, stitching an email
//                            to whatever visitor the caller named
//   POST /api/ab/track       body.visitorId → an exposure/conversion written under
//                            that visitor; the unique index keeps the FIRST one,
//                            so a planted row silently drops their real one
//
// blog_post_likes, blog_subscribers and ab_events all have RLS on and no client
// policies (migrations 0201, 0049), so each handler IS the boundary.
//
// What this file pins is what a visitor would notice: their ♥ is not read or
// toggled from another browser, an email is attributed only to the browser that
// submitted it, and the variant recorded for them is the one they were shown.
// Each route now binds to the `bubaly_vid` cookie the request carries
// (lib/marketing/visitor-cookie.ts) and refuses a named id that is not it.
//
// Scope, stated so nobody over-reads a green run: the id is a random bearer
// value and the cookie is the same bytes, so a holder of a visitor's id can still
// present it as a cookie. That is not what this file claims to stop.
//
// Copy goes through the REAL en-US catalogue with production's own lookup
// (`messages[key] ?? key`), and every refusal asserts its English sentence, so a
// key missing from the catalogue comes back as its key name and fails here.
// `like.notThisVisitor`, `like.visitorCookieRequired`, `subscribe.notThisVisitor`
// and `track.notThisVisitor` are new with this fix and are merged into the
// catalogues centrally: until that merge lands, the cases that assert them are
// red — on purpose, since the body would otherwise carry a key name.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Only the en-US catalogue, not lib/i18n/messages.ts: that module imports every
// catalogue, and no assertion here needs more than English.
vi.mock('@/lib/i18n/server', async () => {
  const { default: enUS } = await import('@/lib/i18n/messages/en-US.json');
  const { translate } = await import('@/lib/i18n/translate');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) =>
      translate(enUS, key, params),
  };
});

// New copy, merged into the catalogues centrally (see the note at the top).
const LIKE_NOT_THIS_VISITOR = 'This heart belongs to a different browser, so it cannot be read or changed from here.';
const LIKE_VISITOR_COOKIE_REQUIRED =
  'This browser has no visitor id yet, so your heart could not be saved. Reload the page and try again.';
const SUBSCRIBE_NOT_THIS_VISITOR =
  "This sign-up names a different browser's visitor id, so it cannot be accepted from here. Reload the page and try again.";
const TRACK_NOT_THIS_VISITOR = "This visit names a different browser's visitor id, so it cannot be recorded from here.";

const createServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClient(),
  createServer: async () => createServiceClient(),
}));

vi.mock('@/lib/server/request-rate-limit', () => ({
  enforceRequestRateLimit: async () => ({ ok: true }),
}));

const sendEmail = vi.fn();
vi.mock('@/lib/server/email', () => ({ sendEmail: (args: unknown) => sendEmail(args) }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test' }));

const VICTIM = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER = '9f8b2c11-1d2e-4a3b-8c4d-5e6f70819a2b';
const SLUG = 'a-real-post';

type Row = Record<string, unknown>;

/**
 * The handful of tables these routes touch, as the service client sees them:
 * filters narrow, inserts append and honour the unique constraints the
 * migrations declare (a NULL in a key column never clashes, as in Postgres),
 * updates patch, deletes remove. A write that asks for `.select()` gets the
 * rows it changed back, as PostgREST answers it — this branch's routes confirm
 * a re-activation by exactly that (Audit C1-S9-62), and a fake that answered
 * `null` would report every such write as matching nothing.
 */
function memoryDb(seed: Record<string, Row[]>) {
  const unique: Record<string, string[]> = {
    blog_post_likes: ['post_id', 'visitor_id'],
    blog_subscribers: ['email'],
    ab_events: ['experiment_key', 'visitor_id', 'kind'],
  };
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]),
  );
  let serial = 0;

  function from(table: string) {
    const rows = (tables[table] ??= []);
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    let counting = false;
    let returning = false;
    const filters: Array<(r: Row) => boolean> = [];
    const matches = (r: Row) => filters.every((f) => f(r));

    const run = (): { data: unknown; count?: number | null; error: unknown } => {
      if (mode === 'insert') {
        const keys = unique[table] ?? [];
        const clash = keys.length > 0 && keys.every((k) => payload[k] != null)
          && rows.some((r) => keys.every((k) => r[k] === payload[k]));
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        serial += 1;
        const row = { id: `${table}-${serial}`, unsubscribe_token: `token-${serial}`, ...payload };
        rows.push(row);
        return { data: row, error: null };
      }
      if (mode === 'update') {
        const changed = rows.filter(matches);
        for (const r of changed) Object.assign(r, payload);
        return { data: returning ? changed.map((r) => ({ ...r })) : null, error: null };
      }
      if (mode === 'delete') {
        const removed = rows.filter(matches);
        const keep = rows.filter((r) => !matches(r));
        rows.splice(0, rows.length, ...keep);
        return { data: returning ? removed : null, error: null };
      }
      const found = rows.filter(matches);
      return { data: found, count: counting ? found.length : null, error: null };
    };
    const one = () => {
      const res = run();
      return Promise.resolve({ data: Array.isArray(res.data) ? res.data[0] ?? null : res.data, error: res.error });
    };

    const chain: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string }) => {
        if (opts?.count) counting = true;
        if (mode !== 'select') returning = true;
        return chain;
      },
      insert: (p: Row) => { mode = 'insert'; payload = p; return chain; },
      update: (p: Row) => { mode = 'update'; payload = p; return chain; },
      delete: () => { mode = 'delete'; return chain; },
      eq: (column: string, value: unknown) => { filters.push((r) => r[column] === value); return chain; },
      is: (column: string, value: unknown) => { filters.push((r) => (r[column] ?? null) === value); return chain; },
      maybeSingle: one,
      single: one,
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return chain;
  }

  return { client: { from }, table: (name: string) => tables[name] ?? [] };
}

let db: ReturnType<typeof memoryDb>;

function request(url: string, init: { method: 'GET' | 'POST'; body?: unknown; cookie?: string }) {
  return new NextRequest(url, {
    method: init.method,
    headers: {
      'x-forwarded-for': '203.0.113.9',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.cookie ? { cookie: `bubaly_vid=${init.cookie}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

// Every case re-imports its route after vi.resetModules(), which re-EVALUATES
// the graph but keeps its transform. The first transform (the three routes and
// the ~900 KB en-US catalogue) is a one-off cost of the FILE, so it is paid here
// under a timeout of its own rather than charged to whichever case runs first;
// the cases themselves stay well inside vitest's 5 s default.
beforeAll(async () => {
  await Promise.all([
    import('@/lib/i18n/messages/en-US.json'),
    import('@/app/api/blog/like/route'),
    import('@/app/api/blog/subscribe/route'),
    import('@/app/api/ab/track/route'),
  ]);
}, 120_000);

beforeEach(() => {
  vi.resetModules();
  sendEmail.mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

// ─── /api/blog/like ────────────────────────────────────────────────────────

describe('a visitor’s ♥ is read and toggled only by the browser it belongs to', () => {
  beforeEach(() => {
    db = memoryDb({
      blog_posts: [{ id: 'post-1', slug: SLUG, published: true }],
      // The victim hearted the post; nobody else has.
      blog_post_likes: [{ id: 'like-v', post_id: 'post-1', visitor_id: VICTIM }],
    });
    createServiceClient.mockImplementation(() => db.client);
  });

  const likesOf = (visitor: string) => db.table('blog_post_likes').filter((r) => r.visitor_id === visitor);
  const get = async (query: string, cookie?: string) => {
    const { GET } = await import('@/app/api/blog/like/route');
    return GET(request(`https://bubaly.test/api/blog/like?slug=${SLUG}${query}`, { method: 'GET', cookie }));
  };
  const post = async (body: unknown, cookie?: string) => {
    const { POST } = await import('@/app/api/blog/like/route');
    return POST(request('https://bubaly.test/api/blog/like', { method: 'POST', body, cookie }));
  };

  it('naming another visitor in the URL, with no cookie, does not say whether they hearted it', async () => {
    const res = await get(`&visitorId=${VICTIM}`);
    expect(res.status).toBe(403);
    // The whole body: the refusal, in English, and nothing about the victim.
    // Red until the catalogue merge lands (see the note at the top).
    expect(await res.json()).toEqual({ error: LIKE_NOT_THIS_VISITOR });
    // And the same bytes for a visitor who never hearted it: no one-bit read.
    const aboutNobody = await get(`&visitorId=${OTHER}`);
    expect([aboutNobody.status, await aboutNobody.json()]).toEqual([403, { error: LIKE_NOT_THIS_VISITOR }]);
  });

  it('naming another visitor in the URL while carrying your own cookie is refused, not answered', async () => {
    const res = await get(`&visitorId=${VICTIM}`, OTHER);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: LIKE_NOT_THIS_VISITOR });
  });

  it('each browser sees its own ♥ and the public count', async () => {
    expect(await (await get('', VICTIM)).json()).toEqual({ liked: true, count: 1 });
    expect(await (await get('', OTHER)).json()).toEqual({ liked: false, count: 1 });
    // No visitor at all still gets the public count, as it always did.
    expect(await (await get('')).json()).toEqual({ liked: false, count: 1 });
  });

  it('another browser cannot remove your ♥ by naming you', async () => {
    const withCookie = await post({ slug: SLUG, visitorId: VICTIM }, OTHER);
    expect(withCookie.status).toBe(403);
    expect(await withCookie.json()).toEqual({ error: LIKE_NOT_THIS_VISITOR });
    // Naming someone else is the same refusal whether or not the caller carries
    // a cookie of its own — as GET answers — not a 400 about its cookie jar.
    const withoutCookie = await post({ slug: SLUG, visitorId: VICTIM });
    expect(withoutCookie.status).toBe(403);
    expect(await withoutCookie.json()).toEqual({ error: LIKE_NOT_THIS_VISITOR });
    expect(likesOf(VICTIM), 'the victim’s ♥ must survive both').toHaveLength(1);
    expect(likesOf(OTHER), 'and nothing lands under the caller either').toHaveLength(0);
  });

  it('another browser cannot add a ♥ in your name', async () => {
    db.table('blog_post_likes').splice(0);
    const res = await post({ slug: SLUG, visitorId: VICTIM }, OTHER);
    expect(res.status).toBe(403);
    expect(likesOf(VICTIM)).toHaveLength(0);
  });

  it('your own ♥ still toggles — on for you, off for you — without naming anyone', async () => {
    const on = await post({ slug: SLUG }, OTHER);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ liked: true, count: 2 });
    expect(likesOf(OTHER)).toHaveLength(1);

    const off = await post({ slug: SLUG }, VICTIM);
    expect(await off.json()).toEqual({ liked: false, count: 1 });
    expect(likesOf(VICTIM)).toHaveLength(0);
    expect(likesOf(OTHER), 'unliking yours leaves theirs').toHaveLength(1);
  });

  it('a cached client that names its OWN cookie is still served', async () => {
    const res = await post({ slug: SLUG, visitorId: OTHER }, OTHER);
    expect(res.status).toBe(200);
    expect(likesOf(OTHER)).toHaveLength(1);
  });

  it('a toggle with no visitor cookie is refused rather than written under nobody', async () => {
    const res = await post({ slug: SLUG });
    expect(res.status).toBe(400);
    // Red until the catalogue merge lands (see the note at the top).
    expect(await res.json()).toEqual({ error: LIKE_VISITOR_COOKIE_REQUIRED });
    expect(db.table('blog_post_likes')).toHaveLength(1);
  });
});

// ─── /api/blog/subscribe ───────────────────────────────────────────────────

describe('an email is attributed only to the browser that subscribed it', () => {
  const post = async (body: unknown, cookie?: string) => {
    const { POST } = await import('@/app/api/blog/subscribe/route');
    return POST(request('https://bubaly.test/api/blog/subscribe', { method: 'POST', body, cookie }));
  };
  const subscriber = (email: string) => db.table('blog_subscribers').find((r) => r.email === email);

  beforeEach(() => {
    db = memoryDb({
      blog_subscribers: [{
        id: 'sub-left', email: 'left@example.com', status: 'unsubscribed',
        source: 'blog', visitor_id: null, unsubscribe_token: 'tok-left',
      }],
    });
    createServiceClient.mockImplementation(() => db.client);
  });

  it('a new subscription cannot be stitched to another visitor', async () => {
    const withCookie = await post({ email: 'new@example.com', visitorId: VICTIM }, OTHER);
    expect(withCookie.status).toBe(403);
    // Red until the catalogue merge lands (see the note at the top).
    expect(await withCookie.json()).toEqual({ error: SUBSCRIBE_NOT_THIS_VISITOR });
    const withoutCookie = await post({ email: 'new@example.com', visitorId: VICTIM });
    expect(withoutCookie.status).toBe(403);
    expect(await withoutCookie.json()).toEqual({ error: SUBSCRIBE_NOT_THIS_VISITOR });

    expect(subscriber('new@example.com'), 'nothing may be written under a name that is not the caller').toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a re-subscription cannot re-attribute an address to another visitor', async () => {
    const res = await post({ email: 'left@example.com', visitorId: VICTIM }, OTHER);
    expect(res.status).toBe(403);
    expect(subscriber('left@example.com')).toMatchObject({ status: 'unsubscribed', visitor_id: null });
  });

  it('the subscribing browser is the one recorded, on insert and on re-activation', async () => {
    expect((await post({ email: 'new@example.com', source: 'article' }, OTHER)).status).toBe(200);
    expect(subscriber('new@example.com')).toMatchObject({ source: 'article', visitor_id: OTHER });

    expect((await post({ email: 'left@example.com' }, OTHER)).status).toBe(200);
    expect(subscriber('left@example.com')).toMatchObject({ status: 'active', visitor_id: OTHER });
  });

  it('no cookie means no attribution, not a refusal to subscribe', async () => {
    expect((await post({ email: 'new@example.com' })).status).toBe(200);
    expect(subscriber('new@example.com')).toMatchObject({ email: 'new@example.com', visitor_id: null });
  });

  it('the refusal is the same for an address on the list and one never seen', async () => {
    // SEC-002 made every accepted answer identical; the new refusal must not
    // become an oracle of its own. It depends on the request alone.
    const onKnown = await post({ email: 'left@example.com', visitorId: VICTIM }, OTHER);
    const onUnknown = await post({ email: 'nobody@example.com', visitorId: VICTIM }, OTHER);
    expect([onKnown.status, await onKnown.text()]).toEqual([onUnknown.status, await onUnknown.text()]);
  });

  it('the form no longer puts a visitor id in the body', () => {
    const form = readFileSync('components/blog/subscribe-form.tsx', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const body = form.match(/body:\s*JSON\.stringify\(([^)]*)\)/)?.[1] ?? '';
    expect(body, 'the fetch body was not found').toMatch(/email/);
    expect(body).not.toMatch(/visitorId|getAnonymousId/);
  });
});

// ─── /api/ab/track ─────────────────────────────────────────────────────────

describe('the A/B variant recorded for a visitor is the one they were shown', () => {
  const post = async (body: unknown, cookie?: string) => {
    const { POST } = await import('@/app/api/ab/track/route');
    return POST(request('https://bubaly.test/api/ab/track', { method: 'POST', body, cookie }));
  };
  const exposuresOf = (visitor: string | null) =>
    db.table('ab_events').filter((r) => r.visitor_id === visitor && r.kind === 'exposure').map((r) => r.variant_key);

  beforeEach(() => {
    db = memoryDb({
      ab_experiments: [{
        key: 'hero', status: 'running', deleted_at: null,
        variants: [{ key: 'control', label: 'Control' }, { key: 'b', label: 'Variant B' }],
      }],
      ab_events: [],
    });
    createServiceClient.mockImplementation(() => db.client);
  });

  it('a planted exposure in another visitor’s name does not pre-empt their real one', async () => {
    // Before: this landed as VICTIM/b, and the victim's own control exposure
    // below then hit the unique index and was dropped as a duplicate.
    const withCookie = await post({ experiment: 'hero', variant: 'b', visitorId: VICTIM }, OTHER);
    expect(withCookie.status).toBe(403);
    // Red until the catalogue merge lands (see the note at the top).
    expect(await withCookie.json()).toEqual({ error: TRACK_NOT_THIS_VISITOR });
    const withoutCookie = await post({ experiment: 'hero', variant: 'b', visitorId: VICTIM });
    expect(withoutCookie.status).toBe(403);
    expect(await withoutCookie.json()).toEqual({ error: TRACK_NOT_THIS_VISITOR });

    expect((await post({ experiment: 'hero', variant: 'control' }, VICTIM)).status).toBe(200);
    expect(exposuresOf(VICTIM)).toEqual(['control']);
  });

  it('an event is recorded under the browser that sent it', async () => {
    const res = await post({ experiment: 'hero', variant: 'b' }, OTHER);
    expect(await res.json()).toEqual({ ok: true, recorded: true });
    expect(exposuresOf(OTHER)).toEqual(['b']);
    // A cached client naming its own cookie is still served, and deduped.
    expect((await post({ experiment: 'hero', variant: 'b', visitorId: OTHER }, OTHER)).status).toBe(200);
    expect(exposuresOf(OTHER)).toEqual(['b']);
  });

  it('a malformed body is refused, not a 500', async () => {
    // `.trim()` on a non-string threw inside the handler.
    expect((await post({ experiment: 'hero', variant: 'b', visitorId: 12345678 }, OTHER)).status).toBe(403);
    const numericExperiment = await post({ experiment: 42, variant: 'b' }, OTHER);
    expect(numericExperiment.status).toBe(422);
    expect(await numericExperiment.json()).toEqual({ error: 'experiment and variant are required' });
    expect((await post({ experiment: 'hero', variant: ['b'] }, OTHER)).status).toBe(422);
    expect(db.table('ab_events')).toHaveLength(0);
  });

  it('no cookie records a visitor-less event rather than refusing it', async () => {
    // What the route comment and docs/AGENT_HANDOFF.md promise an integrator.
    const res = await post({ experiment: 'hero', variant: 'control' });
    expect(await res.json()).toEqual({ ok: true, recorded: true });
    expect(exposuresOf(null)).toEqual(['control']);
    expect(exposuresOf(VICTIM)).toEqual([]);
  });
});
