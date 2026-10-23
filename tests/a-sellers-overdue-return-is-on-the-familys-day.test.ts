import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import type { UserContext } from '@/lib/supabase/auth';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';

// The seller cockpit flagged a rental as an overdue return when its `ends_on`
// was before `now.toISOString().slice(0, 10)` — the HOST's UTC calendar day.
// For a family west of UTC the host's day is already tomorrow from
// mid-afternoon (17:00 in Los Angeles), so an item due back TODAY was listed as
// overdue for the rest of the family's day; a family east of UTC saw the
// inverse, an overdue item not flagged until their next morning. The sibling
// /marketplace/orders page already computes the same status with
// `todayKeyFor(ctx, now)`.
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const SELLER = '00000000-0000-4000-8000-0000000000a1';
const LISTING = '00000000-0000-4000-8000-00000000001a';

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

function household(tz: string) {
  h.ctx = {
    user: { id: 'user-1', email: null },
    memberships: [],
    active: {
      familyId: FAMILY,
      family: { id: FAMILY, name: 'The Hughens', timezone: tz },
      role: 'parent',
      member: { id: SELLER, user_id: 'user-1', display_name: 'Dana' },
    },
  } as unknown as UserContext;
  db.seed('marketplace_listings', [{
    id: LISTING, family_id: FAMILY, member_id: SELLER, title: 'Pressure washer', photo_url: null, kind: 'rent',
    status: 'available', price_cents: 2500, sale_format: 'fixed', bid_count: 0, auction_starts_at: null, auction_ends_at: null,
    created_at: '2026-10-01T00:00:00Z',
  }]);
  for (const table of ['marketplace_saves', 'marketplace_offers', 'marketplace_negotiations', 'marketplace_questions', 'marketplace_handoffs']) {
    db.seed(table, []);
  }
}

function rentedOut(endsOn: string) {
  db.seed('marketplace_orders', [{
    id: '00000000-0000-4000-8000-00000000000d', listing_id: LISTING, family_id: FAMILY, seller_member: SELLER,
    buyer_member: '00000000-0000-4000-8000-0000000000b1', kind: 'rent', status: 'active', ends_on: endsOn, returned_at: null,
  }]);
}

async function render(): Promise<string> {
  const { default: SellingPage } = await import('@/app/(app)/marketplace/selling/page');
  return renderServerPage(await SellingPage());
}

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a seller’s overdue return is judged on the family’s day', () => {
  it('an item due back today is not overdue at 7pm in Los Angeles, though it is tomorrow in Greenwich', async () => {
    household('America/Los_Angeles');
    // 2026-10-21 02:00Z is 2026-10-20 19:00 PDT: the family's day is still the 20th.
    vi.setSystemTime(new Date('2026-10-21T02:00:00Z'));
    rentedOut('2026-10-20');
    const html = await render();
    expect(html).not.toContain('overdue return');
    expect(html).toContain('>0</div><div class="text-[11px] text-muted">Needs attention');
  });

  it('an item due back yesterday is overdue at 5am in Tokyo, though Greenwich has not turned the day', async () => {
    household('Asia/Tokyo');
    // 2026-10-21 20:00Z is 2026-10-22 05:00 JST: the family's day is the 22nd.
    vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
    rentedOut('2026-10-21');
    const html = await render();
    expect(html).toContain('1 overdue return');
    expect(html).toContain('>1</div><div class="text-[11px] text-muted">Needs attention');
  });

  it('the control: an item due back the day before yesterday is overdue everywhere', async () => {
    household('America/Los_Angeles');
    vi.setSystemTime(new Date('2026-10-21T02:00:00Z'));
    rentedOut('2026-10-18');
    const html = await render();
    expect(html).toContain('1 overdue return');
  });
});
