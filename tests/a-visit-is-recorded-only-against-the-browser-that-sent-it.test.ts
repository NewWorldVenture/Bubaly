// SEC-007. POST /api/mkt/track is public and holds a service-role client — the
// tables it writes (mkt_visitors, mkt_sessions, mkt_touchpoints) and the consent
// ledger it gates on (mkt_consent_events) have RLS on and NO policies, so the
// route is the only door to them and the door is the whole boundary.
//
// It used to take the visitor id from the request BODY. So anyone holding a
// visitor's id could:
//   - learn whether that visitor had turned analytics off — the route answered
//     `{recorded:false, reason:'analytics_consent_absent'}` for them and
//     `{recorded:true}` for everyone else, a one-bit read of their consent;
//   - and, for a visitor who had NOT turned it off, bump their session count,
//     overwrite their device and country, and write sessions and touchpoints
//     into their profile, from a request they never made.
// And the banner split one browser across two ids: it recorded consent against
// the cookie at the moment of the click, then sent the touch under the id it
// had captured at mount — so after the cookie rotated, the touch was gated on a
// visitor who was no longer this browser.
//
// What this file pins is what a visitor, or the operator reading the visitor
// intelligence, would notice: the answer to a request naming someone else says
// nothing about them, their profile is exactly as they left it, and a visit (and
// the touch after a consent choice) lands on the visitor this browser IS.
//
// Scope, so nobody over-reads a green run: the id is a random bearer value and
// the `bubaly_vid` cookie is the same bytes, so a holder of a visitor's id can
// still present it as a cookie. That is not what this file claims to stop.
//
// Copy goes through the REAL en-US catalogue with production's own lookup
// (`messages[key] ?? key`), and the refusals assert the English sentence, so a
// key missing from the catalogue comes back as its key name and fails here.
// `track.visitorCookieRequired` and `track.notThisVisitor` are new with this fix
// and are merged into the catalogues centrally: until that merge lands, the two
// cases that assert them are red — on purpose, since the body would otherwise
// carry a key name.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Only the en-US catalogue, not lib/i18n/messages.ts: that module imports all
// eleven catalogues, and transforming them cost this file tens of seconds on a
// loaded machine for no assertion that needs them.
vi.mock('@/lib/i18n/server', async () => {
  const { default: enUS } = await import('@/lib/i18n/messages/en-US.json');
  const { translate } = await import('@/lib/i18n/translate');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) =>
      translate(enUS, key, params),
  };
});

// The banner itself is driven through a hook-slot harness (this suite has no
// DOM): state lives in numbered slots, and an effect runs once, after the render
// that first reached it — every effect in ConsentManager has `[]` deps, so that
// is exactly React's behaviour for this component.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  pending: [] as Array<() => void | (() => void)>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => {
      hooks.slots[index] = typeof value === 'function' ? (value as (p: unknown) => unknown)(hooks.slots[index]) : value;
    }];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const index = hooks.cursor++;
    if (index in hooks.slots) return;
    hooks.slots[index] = 'effect-ran';
    hooks.pending.push(effect);
  },
  useCallback: <T,>(fn: T) => fn,
}));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { default: enUS } = await import('@/lib/i18n/messages/en-US.json');
  const { translate } = await import('@/lib/i18n/translate');
  return { useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(enUS, key, params) };
});
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

const createServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClient(),
  createServer: async () => createServiceClient(),
}));

vi.mock('@/lib/server/request-rate-limit', () => ({
  enforceRequestRateLimit: async () => ({ ok: true }),
}));

// A visitor who turned analytics OFF, one who never said anything (analytics
// defaults on), and the browser making the requests.
const DENIER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CONSENTER = '6c1f0b4e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
const CALLER = '9f8b2c11-1d2e-4a3b-8c4d-5e6f70819a2b';

// New copy, merged into the catalogues centrally (see the note at the top).
const NOT_THIS_VISITOR = "This visit names a different browser's visitor id, so it cannot be recorded from here.";
const VISITOR_COOKIE_REQUIRED =
  'This browser has no visitor id yet, so this visit could not be recorded. Reload the page and try again.';

type ConsentRow = { anonymous_id: string; category: string; decision: string; created_at: string };
type Visitor = {
  id: string; anonymous_id: string; session_count: number;
  device_type: string | null; country: string | null; last_seen: string | null;
};
type Written = { visitor_id: string; source: string | null; kind?: string };

/**
 * The marketing tables as the routes see them through the service client:
 * consent reads filter by anonymous_id and inserts append later than anything
 * seeded; visitors are looked up by anonymous_id and updated by id, and an
 * `undefined` field in an update is dropped, as supabase-js drops it from JSON.
 */
function marketingStore(seed: { consent: ConsentRow[]; visitors: Visitor[] }) {
  const consent = [...seed.consent];
  const visitors = seed.visitors.map((v) => ({ ...v }));
  const sessions: Written[] = [];
  const touchpoints: Written[] = [];
  let clock = Date.parse('2026-09-01T00:00:00Z');
  let nextVisitor = 1;

  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      if (table === 'mkt_consent_events') {
        const chain = {
          select: () => chain,
          eq: (column: string, value: string) => { filters[column] = value; return chain; },
          order: () => chain,
          limit: () => Promise.resolve({
            data: consent.filter((r) => r.anonymous_id === filters.anonymous_id)
              .map(({ category, decision, created_at }) => ({ category, decision, created_at })),
            error: null,
          }),
          insert: (added: Array<Omit<ConsentRow, 'created_at'>>) => {
            for (const row of added) {
              clock += 1000;
              consent.push({
                anonymous_id: row.anonymous_id, category: row.category, decision: row.decision,
                created_at: new Date(clock).toISOString(),
              });
            }
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      }
      if (table === 'mkt_visitors') {
        let patch: Partial<Visitor> | null = null;
        const chain = {
          select: () => chain,
          eq: (column: string, value: string) => {
            filters[column] = value;
            if (!patch) return chain;
            const target = visitors.find((v) => v.id === filters.id);
            if (target) {
              for (const [key, val] of Object.entries(patch)) {
                if (val !== undefined) (target as Record<string, unknown>)[key] = val;
              }
            }
            return Promise.resolve({ error: null });
          },
          maybeSingle: () => Promise.resolve({
            data: visitors.find((v) => v.anonymous_id === filters.anonymous_id) ?? null, error: null,
          }),
          update: (next: Partial<Visitor>) => { patch = next; return chain; },
          insert: (row: Omit<Visitor, 'id' | 'last_seen'>) => {
            const created: Visitor = { id: `visitor-${nextVisitor++}`, last_seen: null, ...row };
            visitors.push(created);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: created.id }, error: null }) }) };
          },
        };
        return chain;
      }
      if (table === 'mkt_sessions' || table === 'mkt_touchpoints') {
        return {
          insert: (row: Written) => {
            (table === 'mkt_sessions' ? sessions : touchpoints).push({ ...row });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  const visitorOf = (anonymousId: string) => visitors.find((v) => v.anonymous_id === anonymousId) ?? null;
  const writtenFor = (anonymousId: string) => {
    const id = visitorOf(anonymousId)?.id;
    return {
      sessions: id ? sessions.filter((s) => s.visitor_id === id) : [],
      touchpoints: id ? touchpoints.filter((s) => s.visitor_id === id) : [],
    };
  };
  return {
    client, visitors, sessions, touchpoints, visitorOf, writtenFor,
    consentOf: (id: string) => consent.filter((r) => r.anonymous_id === id),
  };
}

const CONSENTER_PROFILE: Visitor = {
  id: 'visitor-consenter', anonymous_id: CONSENTER, session_count: 3,
  device_type: 'desktop', country: 'NL', last_seen: '2026-08-01T00:00:00Z',
};

function freshStore() {
  return marketingStore({
    consent: [
      { anonymous_id: DENIER, category: 'analytics', decision: 'denied', created_at: '2026-01-01T00:00:00Z' },
    ],
    visitors: [CONSENTER_PROFILE],
  });
}

function track(body: unknown, cookie?: string) {
  return new NextRequest('https://bubaly.test/api/mkt/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `bubaly_vid=${cookie}` } : {}) },
    body: JSON.stringify(body),
  });
}

let store: ReturnType<typeof marketingStore>;

// Every case re-imports the routes and helpers after vi.resetModules(), which
// re-EVALUATES them but keeps their transform. The first transform of this
// graph (the routes, the en-US catalogue, the banner and what it imports) is a
// one-off cost of the FILE, measured at well over 5 s on a loaded shared box, so
// it is paid here, under a timeout of its own, instead of being charged to
// whichever case happens to run first. The cases themselves stay fast.
beforeAll(async () => {
  await Promise.all([
    import('@/lib/i18n/messages/en-US.json'),
    import('@/app/api/mkt/track/route'),
    import('@/app/api/mkt/consent/route'),
    import('@/lib/marketing/visitor'),
    import('@/lib/marketing/consent-ui'),
    import('@/components/marketing/consent-manager'),
  ]);
}, 120_000);

beforeEach(() => {
  vi.resetModules();
  store = freshStore();
  createServiceClient.mockImplementation(() => store.client);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a request naming another visitor learns nothing about them and changes nothing of theirs", () => {
  it('cannot tell a visitor who turned analytics off from one who did not', async () => {
    const { POST } = await import('@/app/api/mkt/track/route');
    const aboutDenier = await POST(track({ anonymousId: DENIER, kind: 'touch' }, CALLER));
    const aboutConsenter = await POST(track({ anonymousId: CONSENTER, kind: 'touch' }, CALLER));
    const denierAnswer = await aboutDenier.json();
    const consenterAnswer = await aboutConsenter.json();

    // The same answer either way: the caller's own request is refused, and the
    // refusal is decided before anyone's consent is read.
    expect(aboutDenier.status).toBe(aboutConsenter.status);
    expect(denierAnswer).toEqual(consenterAnswer);
    expect(aboutDenier.ok).toBe(false);
    expect(denierAnswer).not.toHaveProperty('reason');
    expect(denierAnswer).not.toHaveProperty('recorded');
    // What the refusal says, in English — red until the catalogue merge lands.
    expect(denierAnswer).toEqual({ error: NOT_THIS_VISITOR });
  });

  it('with no cookie at all, naming a visitor who turned analytics off still says nothing about them', async () => {
    const { POST } = await import('@/app/api/mkt/track/route');
    const res = await POST(track({ anonymousId: DENIER, kind: 'touch' }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json).not.toHaveProperty('reason');
    expect(json).not.toHaveProperty('recorded');
    // Red until the catalogue merge lands (see the note at the top).
    expect(json).toEqual({ error: VISITOR_COOKIE_REQUIRED });
  });

  it("cannot add a session to a consenting visitor's profile or rewrite their device and country", async () => {
    const { POST } = await import('@/app/api/mkt/track/route');
    const res = await POST(track({
      anonymousId: CONSENTER, kind: 'conversion', source: 'forged', deviceType: 'mobile', country: 'KP',
    }, CALLER));

    expect(res.status).toBe(403);
    // Their profile is exactly as they left it.
    expect(store.visitorOf(CONSENTER)).toEqual(CONSENTER_PROFILE);
    expect(store.writtenFor(CONSENTER)).toEqual({ sessions: [], touchpoints: [] });
    // Refused, not quietly re-targeted onto the caller's own profile either.
    expect(store.visitorOf(CALLER)).toBeNull();
    expect(store.sessions).toHaveLength(0);
    expect(store.touchpoints).toHaveLength(0);
  });
});

describe("the browser's own visit is still recorded", () => {
  it('a consenting visitor, sending no id at all, gets their session and touch recorded', async () => {
    const { POST } = await import('@/app/api/mkt/track/route');
    const res = await POST(track({ kind: 'touch', source: 'newsletter', deviceType: 'mobile' }, CONSENTER));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: true });
    expect(store.visitorOf(CONSENTER)).toMatchObject({ session_count: 4, device_type: 'mobile', country: 'NL' });
    const written = store.writtenFor(CONSENTER);
    expect(written.sessions.map((s) => s.source)).toEqual(['newsletter']);
    expect(written.touchpoints.map((s) => [s.source, s.kind])).toEqual([['newsletter', 'touch']]);
  });

  it('a visitor who turned analytics off is not profiled from their own browser', async () => {
    const { POST } = await import('@/app/api/mkt/track/route');
    const res = await POST(track({ kind: 'touch' }, DENIER));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded: false });
    expect(store.visitorOf(DENIER)).toBeNull();
    expect(store.sessions).toHaveLength(0);
  });

  it('an older cached client that names its own cookie id is still recorded', async () => {
    const { POST } = await import('@/app/api/mkt/track/route');
    const res = await POST(track({ anonymousId: CONSENTER, kind: 'touch' }, CONSENTER));
    expect(res.status).toBe(200);
    expect(store.visitorOf(CONSENTER)?.session_count).toBe(4);
  });
});

/**
 * A browser on /pricing?utm_source=podcast that is currently `startAs`: a cookie
 * jar, local and session storage, and a same-origin fetch that attaches whatever
 * cookie the jar holds WHEN the request is sent and hands it to the real routes.
 */
async function browserAs(startAs: string) {
  let jar = `bubaly_vid=${startAs}`;
  const storage = new Map<string, string>();
  const session = new Map<string, string>();
  const inFlight = new Set<Promise<unknown>>();
  const answered: Array<[string, number]> = [];
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'https:', pathname: '/pricing', search: '?utm_source=podcast' });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)' });
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
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => { session.set(k, v); },
  });

  const consentRoute = await import('@/app/api/mkt/consent/route');
  const trackRoute = await import('@/app/api/mkt/track/route');
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const req = new NextRequest(`https://bubaly.test${url}`, {
      method: init.method, body: init.body as string,
      headers: { ...(init.headers as Record<string, string>), cookie: jar },
    });
    let answer: Promise<Response>;
    if (url === '/api/mkt/consent') answer = consentRoute.POST(req);
    else if (url === '/api/mkt/track') answer = trackRoute.POST(req);
    else throw new Error(`unexpected fetch ${url}`);
    inFlight.add(answer);
    void answer.then((res) => { answered.push([url, res.status]); }).finally(() => inFlight.delete(answer));
    return answer;
  });

  return {
    /** The visitor this browser is right now. */
    carried: () => jar.slice('bubaly_vid='.length),
    /** Every request this browser sent, with the status it was answered. */
    answered: () => [...answered],
    /**
     * Let every request a click started — and any request those chain into —
     * run to the end. The next request in a chain is sent from a microtask of
     * the one before it, so three idle turns in a row mean nothing is left.
     */
    async drain() {
      for (let idle = 0; idle < 3;) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        idle = inFlight.size ? 0 : idle + 1;
      }
    },
  };
}

type Node = ReactElement<Record<string, unknown>>;

function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  if (typeof node.type === 'function') return expand((node.type as (props: unknown) => ReactNode)(node.props));
  return createElement(node.type, { ...node.props, key: node.key }, expand(node.props.children as ReactNode));
}
function nodes(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...nodes(node.props.children as ReactNode)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function button(tree: ReactNode, label: string): Node {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node).trim() === label);
  if (!found) throw new Error(`Missing button "${label}"`);
  return found;
}
const click = (node: Node) => (node.props.onClick as () => unknown)();

describe('the touch after a consent choice lands on the visitor who made the choice', () => {
  it('after the cookie rotates, Accept all records consent AND the touch on the new visitor', async () => {
    // The browser starts as DENIER — the visitor who had turned analytics off.
    const browser = await browserAs(DENIER);
    const visitor = await import('@/lib/marketing/visitor');
    const { presetAcceptAll } = await import('@/lib/marketing/consent-ui');

    // The banner mounts as DENIER; then a verified account switch forks the
    // attribution, and this browser is a new visitor.
    expect(visitor.getAnonymousId()).toBe(DENIER);
    expect(visitor.resetAnonymousId(DENIER)).toBe(true);
    const fresh = browser.carried();
    expect(fresh).not.toBe(DENIER);

    // Accept all, as the banner's commit() does it: record the choice, then
    // fire the touch it now permits.
    const resolved = (await visitor.postConsent(presetAcceptAll(), false, 'banner_accept_all'))!;
    expect(resolved.analytics).toBe(true);
    await visitor.trackTouchOnce(resolved, false);

    // The visitor who just said yes is the one whose visit was recorded.
    expect(store.consentOf(fresh).find((r) => r.category === 'analytics')?.decision).toBe('granted');
    const written = store.writtenFor(fresh);
    expect(written.touchpoints.map((t) => [t.source, t.kind])).toEqual([['podcast', 'touch']]);
    expect(written.sessions).toHaveLength(1);
    // And the previous visitor's refusal is untouched, with no profile made.
    expect(store.consentOf(DENIER).map((r) => r.decision)).toEqual(['denied']);
    expect(store.visitorOf(DENIER)).toBeNull();
  });

  // The case above calls the client helpers directly, so it cannot see the
  // place the split identity actually lived: ConsentManager captured the id at
  // mount, held it in state, and handed it to every later touch. This one drives
  // the mounted component itself — the footer's "Privacy choices" link, then the
  // preference centre's "Accept all" — across a cookie rotation, so a component
  // that holds a mount-time id (or calls trackTouchOnce with its old argument
  // list) fails here rather than only at typecheck.
  it("the mounted banner's Accept all, after the cookie rotates, lands on the visitor who clicked", async () => {
    hooks.slots = []; hooks.cursor = 0; hooks.pending = [];
    const browser = await browserAs(DENIER);
    const visitor = await import('@/lib/marketing/visitor');
    const { presetRejectNonEssential } = await import('@/lib/marketing/consent-ui');
    const { ConsentManager, ConsentReopenLink } = await import('@/components/marketing/consent-manager');

    // DENIER said no earlier in this browser, and the banner remembers it: no
    // banner, and no touch at mount.
    visitor.writeLocalConsent(presetRejectNonEssential(), true);
    const render = (): ReactNode => {
      hooks.cursor = 0;
      const tree = expand(createElement(ConsentManager));
      for (const effect of hooks.pending.splice(0)) effect();
      return tree;
    };
    expect(render()).toBeNull();   // mount: the effects run after this first render
    const mounted = render();
    expect(mounted).not.toBeNull();
    expect(nodes(mounted).some((node) => node.type === 'button')).toBe(false);
    await browser.drain();
    expect(browser.answered()).toEqual([]);

    // A verified account switch forks the attribution while the page stays up.
    expect(visitor.resetAnonymousId(DENIER)).toBe(true);
    const fresh = browser.carried();
    expect(fresh).not.toBe(DENIER);

    // The visitor opens their privacy choices from the footer and accepts all.
    click(button(expand(createElement(ConsentReopenLink)), 'Privacy choices'));
    click(button(render(), 'Accept all'));
    await browser.drain();

    // Two requests, both answered: the choice, then the touch it permits. (A
    // banner that sent the mount-time id would get a 403 on the second; one that
    // called trackTouchOnce with the old argument list would never send it.)
    expect(browser.answered()).toEqual([['/api/mkt/consent', 200], ['/api/mkt/track', 200]]);

    // The choice and the touch it permits belong to the same, current visitor.
    expect(store.consentOf(fresh).find((r) => r.category === 'analytics')?.decision).toBe('granted');
    expect(store.writtenFor(fresh).touchpoints.map((t) => [t.source, t.kind])).toEqual([['podcast', 'touch']]);
    expect(store.touchpoints).toHaveLength(1);
    // Nothing was written for the visitor this browser used to be.
    expect(store.consentOf(DENIER).map((r) => r.decision)).toEqual(['denied']);
    expect(store.visitorOf(DENIER)).toBeNull();
  });
});
