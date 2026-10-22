// A dictionary walk of Pay-IDs meets a per-address limit (audit N3).
//
// /pay/<handle> resolves a human-chosen 3–20 character handle to the child's
// newest gift link and forwards to /gift/<token>, which names the child and the
// family. Neither public READ page applied any limiter — only the pledge action
// did — so an anonymous caller walking a list of first names collected (child,
// family, live token) for every active Pay-ID at request speed. Both pages now
// refuse past a per-address limit, before any read, with the same shell a failed
// read draws; the controls prove a real visitor is still served and a miss still
// reads as a miss.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { renderTranslated } from './helpers/render-translated';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const FAMILY = '00000000-0000-4000-8000-00000000a6f1';
const PAY_RESOLVE_PER_MINUTE = 20;
const GIFT_VIEW_PER_MINUTE = 30;
// The retryable shell's words, minus the apostrophe React escapes as `&#x27;`.
const RETRY_SHELL = 'load this gift link right now';

const h = vi.hoisted(() => ({
  db: null as unknown,
  ip: '203.0.113.9',
  RedirectSignal: class RedirectSignal extends Error {
    constructor(readonly path: string) { super(`redirect ${path}`); }
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new h.RedirectSignal(path); } }));
vi.mock('@/components/wallet/public-gift-form', () => ({ PublicGiftForm: () => 'GIFT-FORM' }));

type Db = ReturnType<typeof createInMemorySupabase>;
let db: Db;

function seedHousehold(target: Db) {
  target.seed('families', [{ id: FAMILY, name: 'Example House' }]);
  target.seed('family_members', [{ id: 'm-mia', family_id: FAMILY, display_name: 'Mia Example' }]);
  target.seed('child_wallets', [{ id: 'cw-mia', family_id: FAMILY, member_id: 'm-mia' }]);
  target.seed('pay_handles', [{ handle: 'mia', family_id: FAMILY, child_wallet_id: 'cw-mia', is_active: true }]);
  target.seed('gift_links', [{
    id: 'g1', token: 'tok-mia', family_id: FAMILY, child_wallet_id: 'cw-mia', is_active: true,
    occasion: 'birthday', message: null, suggested_cents: [500],
  }]);
}

beforeEach(() => {
  vi.resetModules();
  h.ip = '203.0.113.9';
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  seedHousehold(db);
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const reads = (table: string) => db.log.filter((entry) => entry.table === table).length;

async function pay(handle: string): Promise<{ redirect: string } | { html: string }> {
  const { default: PayHandlePage } = await import('@/app/pay/[handle]/page');
  try {
    return { html: renderTranslated(await PayHandlePage({ params: Promise.resolve({ handle }) })) };
  } catch (error) {
    if (error instanceof h.RedirectSignal) return { redirect: error.path };
    throw error;
  }
}

async function gift(token: string): Promise<string> {
  const { default: PublicGiftPage } = await import('@/app/gift/[token]/page');
  return renderTranslated(await PublicGiftPage({ params: Promise.resolve({ token }) }));
}

describe('/pay/<handle>', () => {
  it(`forwards the first ${PAY_RESOLVE_PER_MINUTE} lookups from one address and then answers the retry shell without reading`, async () => {
    for (let i = 0; i < PAY_RESOLVE_PER_MINUTE; i += 1) {
      expect(await pay('mia')).toEqual({ redirect: '/gift/tok-mia' });
    }
    const before = reads('pay_handles');
    const refused = await pay('mia');
    expect('html' in refused && refused.html).toContain(EN_US['pay.couldNotCheckThisPayId']);
    // Refused BEFORE the read: a walk past the limit costs no lookup.
    expect(reads('pay_handles')).toBe(before);
    expect(reads('gift_links')).toBe(PAY_RESOLVE_PER_MINUTE);
  });

  it('past the limit, a handle that exists and one that does not get the identical shell', async () => {
    for (let i = 0; i < PAY_RESOLVE_PER_MINUTE; i += 1) await pay(`guess${i}`);
    const hit = await pay('mia');
    const miss = await pay('nobody');
    expect(hit).toEqual(miss);
    expect('html' in hit && hit.html).toContain(EN_US['pay.couldNotCheckThisPayId']);
    expect('html' in hit && hit.html).not.toContain(EN_US['pay.noActiveGiftLink']);
  });

  it('another address is still served, and a miss still reads as a miss (control)', async () => {
    for (let i = 0; i <= PAY_RESOLVE_PER_MINUTE; i += 1) await pay('mia');
    h.ip = '198.51.100.7';
    expect(await pay('mia')).toEqual({ redirect: '/gift/tok-mia' });
    const miss = await pay('nobody');
    expect('html' in miss && miss.html).toContain(EN_US['pay.noActiveGiftLink']);
  });
});

describe('/gift/<token>', () => {
  it(`serves the first ${GIFT_VIEW_PER_MINUTE} views from one address and then answers the retry shell without reading`, async () => {
    for (let i = 0; i < GIFT_VIEW_PER_MINUTE; i += 1) {
      const html = await gift('tok-mia');
      expect(html).toContain('GIFT-FORM');
      expect(html).toContain('Mia Example');
    }
    const before = reads('gift_links');
    const refused = await gift('tok-mia');
    expect(refused).toContain(RETRY_SHELL);
    expect(refused).not.toContain('GIFT-FORM');
    expect(refused).not.toContain('Mia Example');
    expect(refused).not.toContain('Example House');
    expect(reads('gift_links')).toBe(before);
  });

  it('another address is still served (control)', async () => {
    for (let i = 0; i <= GIFT_VIEW_PER_MINUTE; i += 1) await gift('tok-mia');
    h.ip = '198.51.100.7';
    expect(await gift('tok-mia')).toContain('Mia Example');
  });

  it('a limiter that cannot be read answers the retry shell, never the names', async () => {
    db = createInMemorySupabase();
    seedHousehold(db);
    h.db = db;
    const html = await gift('tok-mia');
    expect(html).toContain(RETRY_SHELL);
    expect(html).not.toContain('Mia Example');
    expect(reads('gift_links')).toBe(0);
  });
});
