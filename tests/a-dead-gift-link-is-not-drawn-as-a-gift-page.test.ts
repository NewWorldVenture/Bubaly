// Page audit, /gift/[token] — a gift link that does not exist, or no longer
// works, is answered as one.
//
// The crawl of www.bubaly.com (2026-09-27) opened /gift/<made-up token> and got
// the live gift page's header — "Send a gift to a child", "Gift · a family" —
// over the "no longer active" note: a dead link that looked like a gift page
// with its names blanked out. It now answers the way /pay/[handle] does.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTranslated } from './helpers/render-translated';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const h = vi.hoisted(() => ({ link: null as unknown, reads: [] as string[] }));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      h.reads.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => (table === 'gift_links' ? { data: h.link, error: null } : { data: null, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('@/components/wallet/public-gift-form', () => ({ PublicGiftForm: () => 'GIFT-FORM' }));

const { default: PublicGiftPage } = await import('@/app/gift/[token]/page');
const render = async () => renderTranslated(await PublicGiftPage({ params: Promise.resolve({ token: 'tok' }) }));

beforeEach(() => { h.link = null; h.reads = []; });

describe('a dead gift link', () => {
  it('a token that matches nothing says the link is not active, and draws no gift header or form', async () => {
    const html = await render();
    expect(html).toContain(EN_US['pay.noActiveGiftLink']);
    expect(html).toContain(EN_US['gift.thisGiftLinkIsNoLonger']);
    expect(html).not.toContain(EN_US['gift.sendAGiftTo']);
    expect(html).not.toContain('GIFT-FORM');
  });

  it('a retired link answers the same, and looks up no child or family', async () => {
    h.link = { id: 'g1', is_active: false, occasion: 'birthday', message: 'hi', suggested_cents: [500], child_wallet_id: 'cw1', family_id: 'f1' };
    const html = await render();
    expect(html).toContain(EN_US['pay.noActiveGiftLink']);
    expect(html).not.toContain('GIFT-FORM');
    expect(h.reads).toEqual(['gift_links']);
  });

  it('a live link still draws the gift page and its form', async () => {
    h.link = { id: 'g1', is_active: true, occasion: null, message: null, suggested_cents: [500], child_wallet_id: null, family_id: null };
    const html = await render();
    expect(html).toContain(EN_US['gift.sendAGiftTo']);
    expect(html).toContain('GIFT-FORM');
    expect(html).not.toContain(EN_US['pay.noActiveGiftLink']);
  });
});
