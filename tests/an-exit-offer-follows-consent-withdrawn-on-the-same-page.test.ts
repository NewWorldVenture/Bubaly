// AUD-1028-M4 — the exit-intent offer kept using visit history after consent
// to it was withdrawn, and an unknown visit history was read as "new visitor".
//
// 1. ExitIntent read personalisation consent ONCE, at mount. Withdrawing it on
//    the same page (the consent banner writes the choice at once) left an
//    offer chosen with `returning` in flight or already armed, and it was
//    shown and counted anyway, with the marker still on the device.
// 2. A visitor who declined, and had seen an offer this week, kept their old
//    `bubaly-visited` marker: the recently-seen return came before the cleanup.
// 3. The resolver turned an ABSENT `returning` into `false`, and the matcher
//    reads false as "new visitor", so a "New visitors only" offer was chosen by
//    visit history for exactly the visitors who had declined it.
//
// This mounts the REAL component (hooks driven as slots, no DOM, its listeners
// on a stand-in document) and answers its fetches with the REAL resolve route
// over an in-memory offer table: a returning-only offer, a new-only offer and a
// contextual offer for the page. Negative controls: before the fix the
// withdrawn visitor is shown and counted the returning-only offer, keeps the
// marker, and the declining visitor is given the new-visitors-only offer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = await vi.hoisted(async () => ({
  hooks: (await import('./helpers/hook-slots')).createHookSlots(),
  db: null as unknown,
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/hooks/use-lock-body-scroll', () => ({ useLockBodyScroll: () => {} }));
vi.mock('@/lib/a11y/use-dialog-behavior', () => ({ useDialogBehavior: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { ExitIntent } = await import('@/components/marketing/exit-intent');
const { resetHookSlots } = await import('./helpers/hook-slots');
const { POST: resolveRoute } = await import('@/app/api/exit-intent/resolve/route');
const { NextRequest } = await import('next/server');

const VISITED = 'bubaly-visited';
const SEEN = 'bubaly-ei-seen';
const CONSENT = 'bubaly_consent_v1';

const offer = (id: string, headline: string, match: Record<string, unknown>, priority: number): Row => ({
  id, headline, body: null, cta_label: null, cta_href: null, match, trigger_config: {}, priority,
  status: 'active', created_at: '2026-10-01T00:00:00Z', deleted_at: null,
});
const RETURNING = offer('offer-returning', 'Welcome back', { returning: true }, 10);
const NEW_ONLY = offer('offer-new', 'First time here?', { returning: false }, 10);
const CONTEXT = offer('offer-context', 'Questions about pricing?', { paths: ['/pricing'] }, 0);

let storage: Map<string, string>;
let requests: Record<string, unknown>[];
let tracked: { id: string; kind: string }[];
let pending: Promise<unknown>[];
let listeners: Map<string, Set<(event: unknown) => void>>;
let hold: Promise<void> | null;
let db: InMemorySupabase;

function eventTarget() {
  return {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => { listeners.get(type)?.delete(fn); },
  };
}

function browser() {
  vi.stubGlobal('window', {
    location: { search: '?utm_source=newsletter', pathname: '/pricing', protocol: 'https:' },
    innerHeight: 800,
    ...eventTarget(),
  });
  vi.stubGlobal('document', { documentElement: { scrollTop: 0, scrollHeight: 4000 }, ...eventTarget() });
  vi.stubGlobal('navigator', { userAgent: 'fixture', globalPrivacyControl: false });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url === '/api/exit-intent/track') {
      tracked.push(body as { id: string; kind: string });
      return Promise.resolve(new Response('{}'));
    }
    requests.push(body);
    const gate = hold;
    const answer = (async () => {
      // Resolved against the table as it is NOW; delivered when the gate opens.
      const res = await resolveRoute(new NextRequest(`https://bubaly.com${url}`, {
        method: init.method,
        body: init.body,
        headers: { ...(init.headers as Record<string, string>), 'x-forwarded-for': '198.51.100.4' },
      }));
      if (gate) await gate;
      return res;
    })();
    pending.push(answer);
    return answer;
  });
}

function decided(personalization: boolean) {
  storage.set(CONSENT, JSON.stringify({
    state: { necessary: true, analytics: false, personalization, marketing_email: false, marketing_sms: false },
    decided: true,
    at: 1,
  }));
}

/** Render with the slots kept (an update), run the effects it scheduled. */
function render(): unknown {
  h.hooks.cursor = 0;
  h.hooks.pending = [];
  const tree = ExitIntent();
  for (const run of h.hooks.pending.splice(0)) run();
  return tree;
}

/** Let every fetch answer and every `.then` the component chained on it run. */
async function settle() {
  while (pending.length) await Promise.all(pending.splice(0));
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A first page load: mount, wait for the offer, render it armed. */
async function load() {
  resetHookSlots(h.hooks);
  render();
  await settle();
  return render();
}

/** The pointer leaves through the top of the window — the exit-intent gesture. */
function exitThroughTop() {
  for (const fn of [...(listeners.get('mouseout') ?? [])]) fn({ clientY: 0, relatedTarget: null });
}

function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? text(props.children) : '';
}

async function resolve(body: Record<string, unknown>) {
  const res = await resolveRoute(new NextRequest('https://bubaly.com/api/exit-intent/resolve', {
    method: 'POST',
    body: JSON.stringify({ path: '/pricing', ...body }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.5' },
  }));
  return ((await res.json()) as { offer: { id: string } | null }).offer?.id ?? null;
}

beforeEach(() => {
  storage = new Map();
  requests = [];
  tracked = [];
  pending = [];
  listeners = new Map();
  hold = null;
  db = createInMemorySupabase({ rpc: { rate_limit_hit: () => [{ allowed: true, retry_after: 0 }] } });
  db.seed('marketing_exit_intent', [RETURNING, NEW_ONLY, CONTEXT]);
  h.db = db;
  browser();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the resolver keeps an unknown visit history unknown', () => {
  it('true, false and absent each get their own offer; absent is neither audience', async () => {
    expect(await resolve({ returning: true })).toBe('offer-returning');
    expect(await resolve({ returning: false })).toBe('offer-new');
    expect(await resolve({}), 'absent was read as “new visitor”').toBe('offer-context');
    expect(await resolve({ returning: 'false' }), 'a non-boolean is not an answer either').toBe('offer-context');
  });

  it('with only history-targeted offers, an unknown visitor gets none', async () => {
    db.replace('marketing_exit_intent', [RETURNING, NEW_ONLY].map((row) => ({ ...row })));
    expect(await resolve({})).toBeNull();
    expect(await resolve({ returning: false })).toBe('offer-new');
  });

  it('a visitor who declined personalisation is offered the page’s offer, not the new-visitors one', async () => {
    decided(false);
    const tree = await load();
    expect(requests).toEqual([expect.not.objectContaining({ returning: expect.anything() })]);
    expect(tree).toBeNull();
    exitThroughTop();
    expect(text(render())).toContain('Questions about pricing?');
    expect(tracked).toEqual([{ id: 'offer-context', kind: 'impression' }]);
  });
});

describe('consent withdrawn on the same page', () => {
  it('while the answer is in flight: the history-chosen offer is dropped and the page asks again without it', async () => {
    decided(true);
    storage.set(VISITED, '1');
    let release!: () => void;
    hold = new Promise<void>((resolve) => { release = resolve; });

    resetHookSlots(h.hooks);
    render();
    expect(requests).toEqual([expect.objectContaining({ returning: true })]);

    decided(false); // "Reject non-essential" while the answer is on its way
    hold = null;
    release();
    await settle();
    render();
    await settle();
    render();

    expect(storage.has(VISITED), 'the marker written at mount is taken back').toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toHaveProperty('returning');

    exitThroughTop();
    const tree = render();
    expect(text(tree)).toContain('Questions about pricing?');
    expect(text(tree)).not.toContain('Welcome back');
    expect(tracked, 'the returning-only offer was counted for a visitor who withdrew').toEqual([
      { id: 'offer-context', kind: 'impression' },
    ]);
  });

  it('while the offer is armed: it is not shown or counted, and the page re-asks from context', async () => {
    decided(true);
    storage.set(VISITED, '1');
    await load();
    expect(requests).toEqual([expect.objectContaining({ returning: true })]);

    decided(false);
    exitThroughTop();
    expect(text(render()), 'shown after consent was withdrawn').not.toContain('Welcome back');
    expect(tracked).toEqual([]);
    expect(storage.has(VISITED)).toBe(false);
    expect(storage.has(SEEN), 'nothing was shown, so nothing is capped').toBe(false);

    await settle();
    render();
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toHaveProperty('returning');
    exitThroughTop();
    expect(text(render())).toContain('Questions about pricing?');
    expect(tracked).toEqual([{ id: 'offer-context', kind: 'impression' }]);
  });

  it('with consent kept, the armed returning-visitor offer shows and is counted (positive control)', async () => {
    decided(true);
    storage.set(VISITED, '1');
    await load();
    exitThroughTop();
    expect(text(render())).toContain('Welcome back');
    expect(tracked).toEqual([{ id: 'offer-returning', kind: 'impression' }]);
    expect(storage.get(VISITED)).toBe('1');
    expect(requests).toHaveLength(1);
  });

  it('a first visit with consent is offered the new-visitors offer and marked (positive control)', async () => {
    decided(true);
    await load();
    exitThroughTop();
    expect(text(render())).toContain('First time here?');
    expect(storage.get(VISITED)).toBe('1');
  });
});

describe('the marker is cleared even when no offer is due', () => {
  it('a visitor who declined and saw an offer this week loses the old marker', async () => {
    decided(false);
    storage.set(VISITED, '1');
    storage.set(SEEN, String(Date.now() - 24 * 60 * 60 * 1000));
    await load();
    expect(requests, 'recently seen: nothing is asked').toEqual([]);
    expect(storage.has(VISITED), 'the recently-seen return kept the marker of a visitor who declined').toBe(false);
  });

  it('with consent, a recent offer still skips the request and keeps the marker (positive control)', async () => {
    decided(true);
    storage.set(VISITED, '1');
    storage.set(SEEN, String(Date.now() - 24 * 60 * 60 * 1000));
    await load();
    expect(requests).toEqual([]);
    expect(storage.get(VISITED)).toBe('1');
  });
});
