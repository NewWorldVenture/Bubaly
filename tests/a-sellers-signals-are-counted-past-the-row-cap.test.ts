import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import type { UserContext } from '@/lib/supabase/auth';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';

// The seller cockpit read each of its signals — saves, offers, negotiations,
// questions, handoffs, rentals — with ONE `.in('listing_id', ids)` over up to
// 200 listings and no paging (review R3-SELLER-COCKPIT-SIGNALS). PostgREST
// answers that with at most `db-max-rows` (1,000) and no error, so a seller
// whose listings had more than a thousand watchers saw a thousand, and the
// per-listing counts were summed from whichever thousand rows came back. Buyers
// keep saving while the page reads, so the pages are taken on the id: on
// offsets, a save landing between two pages is counted twice.
const CAP = 1000;
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const SELLER = '00000000-0000-4000-8000-0000000000a1';
const LISTINGS = 150;
const pad = (i: number) => String(i).padStart(6, '0');
const listing = (i: number) => `lst-${pad(i)}`;
/** The listing past the first chunk of 100 whose watchers outnumber the cap. */
const POPULAR = 120;
const SAVES = 1300;
const QUESTIONS = 1200;

const h = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => h.ctx }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));

let db: InMemorySupabase;

function seedShop() {
  h.ctx = {
    user: { id: 'user-1', email: null },
    memberships: [],
    active: {
      familyId: FAMILY,
      family: { id: FAMILY, name: 'The Hughens', timezone: 'UTC' },
      role: 'parent',
      member: { id: SELLER, user_id: 'user-1', display_name: 'Dana' },
    },
  } as unknown as UserContext;
  db.seed('marketplace_listings', Array.from({ length: LISTINGS }, (_, i) => ({
    id: listing(i), family_id: FAMILY, member_id: SELLER, title: `Item ${i}`, photo_url: null, kind: 'sell',
    status: 'available', price_cents: 1000, sale_format: 'fixed', bid_count: 0, auction_starts_at: null, auction_ends_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
  })));
  // Saved by 1,300 other households; asked 1,200 questions nobody answered.
  db.seed('marketplace_saves', Array.from({ length: SAVES }, (_, i) => ({
    id: `save-${pad(i)}`, family_id: `buyer-fam-${pad(i)}`, listing_id: listing(POPULAR), member_id: `buyer-${pad(i)}`,
  })));
  db.seed('marketplace_questions', Array.from({ length: QUESTIONS }, (_, i) => ({
    id: `q-${pad(i)}`, family_id: `buyer-fam-${pad(i)}`, listing_id: listing(i % 2 === 0 ? 5 : POPULAR), question: `Question ${i}?`, answer: null,
  })));
  for (const table of ['marketplace_offers', 'marketplace_negotiations', 'marketplace_handoffs', 'marketplace_orders']) db.seed(table, []);
}

async function render(): Promise<string> {
  const { default: SellingPage } = await import('@/app/(app)/marketplace/selling/page');
  return renderServerPage(await SellingPage());
}

/** The value a cockpit tile renders above `label`. */
function tile(html: string, label: string): string {
  const match = new RegExp(`<div class="text-2xl font-bold">([^<]*)</div><div class="text-\\[11px\\] text-muted">${label}</div>`).exec(html);
  if (!match) throw new Error(`the "${label}" tile is not on the page`);
  return match[1];
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the seller cockpit counts every signal', () => {
  it('the control: one .in() over the listings stops at 1,000 rows and says nothing', async () => {
    seedShop();
    const ids = Array.from({ length: LISTINGS }, (_, i) => listing(i));
    const { data, error } = await db.from('marketplace_saves').select('listing_id').in('listing_id', ids);
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
  });

  it('Watchers and Questions are every save and every open question, and so is each listing\'s chip', async () => {
    seedShop();
    const html = await render();
    expect(tile(html, 'Watchers')).toBe(String(SAVES));
    expect(tile(html, 'Questions')).toBe(String(QUESTIONS));
    expect(html).toContain(`>${SAVES} watchers</span>`);
    expect(html).toContain(`>${QUESTIONS / 2} questions to answer</span>`);
  });

  it('a save landing between two pages does not count a watcher twice', async () => {
    seedShop();
    let wrote = false;
    h.db = withFaults(db, (table, calls) => {
      if (wrote || table !== 'marketplace_saves') return null;
      const secondPage = calls.some((c) => (c.method === 'gt' && c.args[0] === 'id') || (c.method === 'range' && Number(c.args[0]) > 0));
      if (!secondPage) return null;
      // A new save, at an id that sorts below every cursor.
      db.seed('marketplace_saves', [{ id: 'save-000000a', family_id: 'buyer-fam-new', listing_id: listing(POPULAR), member_id: 'buyer-new' }]);
      wrote = true;
      return null;
    });
    const html = await render();
    expect(wrote).toBe(true);
    expect(tile(html, 'Watchers')).toBe(String(SAVES));
  });

  it('a signal read that fails is the read failure, not zero watchers', async () => {
    seedShop();
    h.db = withFaults(db, (table, calls) => (table === 'marketplace_saves' && calls.some((c) => c.method === 'gt') ? { message: 'saves unavailable' } : null));
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['selling.couldNotLoadSellerActivity']);
    expect(html).not.toContain('>Watchers</div>');
  });
});
