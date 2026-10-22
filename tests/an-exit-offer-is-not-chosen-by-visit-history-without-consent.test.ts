// P9 — the exit-intent offer was personalised by returning-visitor status for
// visitors who had declined personalisation.
//
// On every marketing page ExitIntent wrote a persistent `bubaly-visited` marker
// to localStorage and sent `returning: true|false` to /api/exit-intent/resolve,
// which picks offers whose audience says "Returning only" / "New visitors only"
// by it. Nothing consulted consent: personalisation is opt-in and switched off
// by GPC (lib/marketing/consent.ts), and a visitor who pressed "Reject
// non-essential" was still marked on the device and targeted by visit history.
//
// This mounts the REAL component (hooks driven as slots, no DOM) and answers
// its fetch with the REAL resolve route over an in-memory offer table holding a
// "Returning only" offer. Negative controls: before the fix the declining
// visitor is marked, is sent as `returning: true`, and gets that offer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

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
const CONSENT = 'bubaly_consent_v1';

let storage: Map<string, string>;
let sent: Record<string, unknown>[];
let offers: unknown[];
let pending: Promise<unknown>[];

function browser(opts: { gpc?: boolean } = {}) {
  vi.stubGlobal('window', { location: { search: '?utm_source=newsletter', pathname: '/pricing', protocol: 'https:' } });
  vi.stubGlobal('navigator', { userAgent: 'fixture', globalPrivacyControl: opts.gpc === true });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const answer = (async () => {
      const res = await resolveRoute(new NextRequest(`https://bubaly.com${url}`, {
        method: init.method,
        body: init.body,
        headers: { ...(init.headers as Record<string, string>), 'x-forwarded-for': '198.51.100.4' },
      }));
      offers.push(((await res.clone().json()) as { offer: unknown }).offer);
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

/** One page load: render, run the mount effects, wait for the resolve answer. */
async function pageLoad() {
  resetHookSlots(h.hooks);
  ExitIntent();
  for (const run of h.hooks.pending.splice(0)) run();
  await Promise.all(pending.splice(0));
}

let db: InMemorySupabase;

beforeEach(() => {
  storage = new Map();
  sent = [];
  offers = [];
  pending = [];
  db = createInMemorySupabase({ rpc: { rate_limit_hit: () => [{ allowed: true, retry_after: 0 }] } });
  db.seed('marketing_exit_intent', [{
    id: 'offer-returning', headline: 'Welcome back', body: null, cta_label: null, cta_href: null,
    match: { returning: true }, trigger_config: {}, priority: 0, status: 'active',
    created_at: '2026-10-01T00:00:00Z', deleted_at: null,
  }]);
  h.db = db;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('without personalisation consent, visit history is neither kept nor used', () => {
  it('“Reject non-essential”: no marker, no returning flag, no returning-only offer', async () => {
    browser();
    decided(false);
    storage.set(VISITED, '1'); // left by a visit before the choice

    await pageLoad();

    expect(storage.has(VISITED), 'the marker is cleared, not kept').toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('returning');
    // The page and its link are still context the offer may use.
    expect(sent[0]).toMatchObject({ path: '/pricing', source: 'newsletter' });
    expect(offers).toEqual([null]);
  });

  it('GPC with no choice made: the device is not marked across visits', async () => {
    browser({ gpc: true });
    await pageLoad();
    await pageLoad();
    expect(storage.has(VISITED)).toBe(false);
    expect(sent.map((body) => 'returning' in body)).toEqual([false, false]);
    expect(offers).toEqual([null, null]);
  });

  it('no choice made at all: personalisation is opt-in, so nothing is marked', async () => {
    browser();
    await pageLoad();
    await pageLoad();
    expect(storage.has(VISITED)).toBe(false);
    expect(offers).toEqual([null, null]);
  });
});

describe('with personalisation consent the returning-visitor offer still works', () => {
  it('marks the first visit and is offered the returning-only offer on the second (positive control)', async () => {
    browser();
    decided(true);
    await pageLoad();
    expect(storage.get(VISITED)).toBe('1');
    await pageLoad();
    expect(sent.map((body) => body.returning)).toEqual([false, true]);
    expect(offers).toEqual([null, expect.objectContaining({ id: 'offer-returning' })]);
  });
});
