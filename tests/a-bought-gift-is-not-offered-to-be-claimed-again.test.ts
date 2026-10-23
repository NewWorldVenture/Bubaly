// N12-purchased (round 3) — releasing a removed member's gift claims keeps
// is_purchased (lib/wishlists/release-claims.ts), as the hard delete's ON
// DELETE SET NULL on claimed_by does. But canToggleClaim returned true for any
// gift with no claimer, so the released Telescope (claimed_by null,
// is_purchased true) read "Purchased" and still offered "Claim gift". Claiming
// it sent {claimed_by: self}; clicking again sent the release branch,
// {claimed_by: null, claimed_at: null, is_purchased: false}, and the bought
// present was back on the list to be bought a second time. Measured as a
// giver (role authenticated) on a copy with owner action #3: the claim got
// UPDATE 1 (claimed, still bought), the release UPDATE 1 (unclaimed, not
// bought). A bought gift with no claimer is now closed; an unbought one the
// release gave back stays claimable.
//
// Driven through the real release helper and the REAL WishlistsModule
// (tests/helpers/module-harness.tsx) against the in-memory database.
import { createElement, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, click, nodes, render, settle, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

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
const { releaseRemovedMembersGiftClaims } = await import('@/lib/wishlists/release-claims');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const SIB = 'member-sib';
const KID = 'member-kid';
const CARER = 'member-carer';
// The carer has been removed: the screen's member list no longer has them.
const MEMBERS = [
  { id: KID, family_id: FAMILY, display_name: 'Kid', role: 'child', is_active: true, color: null, birthday: null },
  { id: SIB, family_id: FAMILY, display_name: 'Sib', role: 'child', is_active: true, color: null, birthday: null },
];

let db: InMemorySupabase;
const wish = (id: string) => db.table('wishlist_items').find((row) => row.id === id)!;

beforeEach(async () => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  h.app = { ...h.app, familyId: FAMILY, userId: 'u-kid', members: MEMBERS, selfMember: MEMBERS[0], family: { id: FAMILY, name: 'Fixture', timezone: 'UTC' } };
  (h.app as unknown as { role: string }).role = 'child';
  const wishOf = (id: string, title: string, over: Record<string, unknown>) => ({
    id, family_id: FAMILY, member_id: SIB, title, priority: 'medium', url: null, price: null, notes: null, created_by: 'u-sib',
    claimed_by: null, claimed_at: null, is_purchased: false, ...over,
  });
  db.seed('wishlist_items', [
    // Claimed and bought by the carer before they were removed.
    wishOf('wish-telescope', 'Telescope', { claimed_by: CARER, claimed_at: '2026-10-01T10:00:00Z', is_purchased: true }),
    // Claimed by the carer, not bought yet.
    wishOf('wish-puzzle', 'Puzzle', { claimed_by: CARER, claimed_at: '2026-10-01T10:00:00Z' }),
  ]);
  // The removal's release, as both removal paths call it.
  expect(await releaseRemovedMembersGiftClaims(db as unknown as SupabaseClient, FAMILY, CARER)).toEqual({ ok: true, released: 2 });
});
afterEach(async () => { await settle(); vi.restoreAllMocks(); });

const screen = () => render(h.hooks, createElement(WishlistsModule));
/** Open Sib's list, the way Kid would: Sib's tab. */
async function openSibsList(): Promise<ReactNode> {
  const tab = nodes(screen()).find((node) => node.type === 'button' && text(node).startsWith('Sib'));
  if (!tab) throw new Error('no tab for Sib');
  await click(tab);
  return screen();
}
function card(tree: ReactNode, title: string): Node {
  const found = nodes(tree).find((node) => node.type === 'div'
    && String(node.props.className).startsWith('rounded-2xl border p-4 flex flex-col')
    && nodes(node).some((child) => child.props.className === 'mt-2 font-semibold text-fg' && text(child) === title));
  if (!found) throw new Error(`no card for ${title}`);
  return found;
}
const claimButtons = (tree: ReactNode, title: string) => allByName(card(tree, title), t('wishlists.claimGift'));

describe('a gift the removed member had already bought', () => {
  it('reads Purchased and is not offered to be claimed again', async () => {
    expect(wish('wish-telescope')).toMatchObject({ claimed_by: null, is_purchased: true });
    const tree = await openSibsList();

    expect(text(card(tree, 'Telescope'))).toContain('Purchased');
    expect(claimButtons(tree, 'Telescope')).toHaveLength(0);
    expect(wish('wish-telescope')).toMatchObject({ claimed_by: null, is_purchased: true });
  });
});

describe('control: a gift the removed member had not bought', () => {
  it('is back on the list, and another giver claims it', async () => {
    const tree = await openSibsList();

    expect(text(card(tree, 'Puzzle'))).toContain('Unclaimed');
    expect(claimButtons(tree, 'Puzzle')).toHaveLength(1);
    await click(claimButtons(tree, 'Puzzle')[0]);

    expect(wish('wish-puzzle')).toMatchObject({ claimed_by: KID, is_purchased: false });
    expect(h.toasts.error).toEqual([]);
  });
});
