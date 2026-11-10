import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, has, nodes, render, settle, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// A gift claimed, let go or marked bought on Wish Lists shows on its card at
// once, without a reload, and the giver who bought it keeps the controls for
// their own claim.
//
// 1. `wishlist_items` is not in the realtime publication
//    (lib/realtime/published-tables.ts), so `useRealtimeQuery` opens no
//    channel for it and the list changes only when the module reads it again.
//    Since #821 the wish's own save and remove read back; the gift side did
//    not. A giver pressed "Claim gift", was told "You claimed this gift", and
//    the card still said "Unclaimed" with the Claim button, so "Mark bought"
//    never appeared until the page was reloaded; "Mark bought" left "Mark
//    bought" on screen; and a released claim still read "You're getting this".
//
// 2. A bought gift reads 'purchased' (lib/wishlists/gifts.ts claimState) for
//    every giver, its claimer too, and the card keyed the claimer's controls on
//    'claimed_by_you'. So the giver who had bought it lost the "Bought" toggle,
//    and their claim button fell back to a primary "Claim gift" while its click
//    still released the claim, which also resets is_purchased: the present
//    they had bought went back on the list, unclaimed and unbought, for someone
//    else to buy again.
//
// Driven with the module harness: the real component and lib helpers against
// an in-memory database, with a list that changes only when the component asks
// it to, which is what the real hook does for an unpublished table.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/wishlists/before-you-buy', () => ({ BeforeYouBuy: () => null }));

const { WishlistsModule } = await import('@/components/modules/wishlists-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const ME = 'member-1';
const BO = 'member-2';
let db: ReturnType<typeof createInMemorySupabase>;

const wish = (over: Record<string, unknown> = {}) => ({
  id: 'w1', family_id: FAMILY, member_id: BO, title: 'Kite', url: null, price: null, priority: 'medium', notes: null,
  claimed_by: null, claimed_at: null, is_purchased: false, created_by: 'user-2', ...over,
});

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  h.timeZone = 'UTC';
  h.app.members = [
    { id: ME, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: BO, display_name: 'Bo', role: 'child', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { await settle(); vi.restoreAllMocks(); });

const screen = () => render(h.hooks, createElement(WishlistsModule));
/** Ada opens Bo's list from the member tabs. */
async function openBosList() {
  const tab = nodes(screen()).find((n) => n.type === 'button' && text(n).startsWith('Bo'));
  if (!tab) throw new Error('no tab for Bo');
  await click(tab);
}
const badge = () => nodes(screen()).filter((n) => n.type === 'span' && String(n.props.className ?? '').includes('text-[11px]')).map((n) => text(n));
const buttonLabels = () => nodes(screen()).filter((n) => n.type === 'button').map((n) => text(n).trim());

describe('a gift claim shows on its card at once', () => {
  it('claiming a gift turns the card into "You\'re getting this" with Mark bought', async () => {
    db.seed('wishlist_items', [wish()]);
    await openBosList();
    expect(badge()).toEqual(['Unclaimed']);

    await click(byName(screen(), t('wishlists.claimGift')));

    expect(db.table('wishlist_items')[0]).toMatchObject({ claimed_by: ME });
    expect(h.toasts.error).toEqual([]);
    expect(badge()).toEqual(['You\'re getting this']);
    expect(buttonLabels()).toContain('Mark bought');
    expect(buttonLabels()).toContain(t('wishlists.claimed'));
    expect(buttonLabels()).not.toContain(t('wishlists.claimGift'));
  });

  it('marking a claimed gift bought shows "Purchased", and Bought undoes it', async () => {
    db.seed('wishlist_items', [wish({ claimed_by: ME, claimed_at: '2026-10-30T10:00:00Z' })]);
    await openBosList();
    expect(buttonLabels()).toContain('Mark bought');

    await click(byName(screen(), 'Mark bought'));

    expect(db.table('wishlist_items')[0]).toMatchObject({ is_purchased: true });
    expect(h.toasts.error).toEqual([]);
    expect(badge()).toEqual(['Purchased']);
    expect(buttonLabels()).toContain('Bought');
    expect(buttonLabels()).not.toContain('Mark bought');

    // The screen now says what the row says, so the next press undoes it.
    await click(byName(screen(), 'Bought'));
    expect(db.table('wishlist_items')[0]).toMatchObject({ is_purchased: false });
    expect(buttonLabels()).toContain('Mark bought');
  });

  it('the giver who bought a gift is not offered "Claim gift" on it, and it stays bought', async () => {
    // As the card is drawn on the next visit, after the purchase.
    db.seed('wishlist_items', [wish({ claimed_by: ME, claimed_at: '2026-10-30T10:00:00Z', is_purchased: true })]);
    await openBosList();

    expect(badge()).toEqual(['Purchased']);
    expect(buttonLabels()).not.toContain(t('wishlists.claimGift'));
    // Their own claim's controls: undo the purchase, or let the claim go.
    expect(buttonLabels()).toContain('Bought');
    expect(buttonLabels()).toContain(t('wishlists.claimed'));
    expect(db.table('wishlist_items')[0]).toMatchObject({ claimed_by: ME, is_purchased: true });
  });

  it('another giver sees a bought gift closed, with no controls', async () => {
    db.seed('wishlist_items', [wish({ claimed_by: 'member-3', claimed_at: '2026-10-30T10:00:00Z', is_purchased: true })]);
    await openBosList();

    expect(badge()).toEqual(['Purchased']);
    expect(buttonLabels()).not.toContain(t('wishlists.claimGift'));
    expect(buttonLabels()).not.toContain(t('wishlists.claimed'));
    expect(buttonLabels()).not.toContain('Bought');
    expect(buttonLabels()).not.toContain('Mark bought');
  });

  it('letting a claim go puts the gift back on the list for everyone', async () => {
    db.seed('wishlist_items', [wish({ claimed_by: ME, claimed_at: '2026-10-30T10:00:00Z' })]);
    await openBosList();
    expect(badge()).toEqual(['You\'re getting this']);

    await click(byName(screen(), t('wishlists.claimed')));

    expect(db.table('wishlist_items')[0]).toMatchObject({ claimed_by: null, is_purchased: false });
    expect(badge()).toEqual(['Unclaimed']);
    expect(buttonLabels()).toContain(t('wishlists.claimGift'));
    expect(buttonLabels()).not.toContain('Mark bought');
  });

  it('a refused claim reports it and is not shown as claimed', async () => {
    db.seed('wishlist_items', [wish()]);
    await openBosList();
    // 0481's write guard refuses a gift another giver claimed first.
    h.fault = (table, calls) => (table === 'wishlist_items' && calls.includes('update')
      ? { code: '42501', message: 'this gift is claimed by someone else' } : null);

    await click(byName(screen(), t('wishlists.claimGift')));

    expect(db.table('wishlist_items')[0]).toMatchObject({ claimed_by: null });
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toHaveLength(1);
    expect(has(screen(), 'You\'re getting this')).toBe(false);
  });
});
