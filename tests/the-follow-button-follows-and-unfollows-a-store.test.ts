// CONTROL sweep, components/marketplace/follow-button.tsx (1 row).
//
// The Follow / Following toggle on a creator store, driven through the real
// FollowButton on hook slots. Only the server action module and the toast are
// boundaries.
//
// Guard: the button has no role check and needs none. A follow is the
// member's own bookmark: toggleFollowAction writes with the caller's member id
// (app/(app)/marketplace/actions.ts:96,114), and 0154_marketplace_ownership.sql:205
// refuses an insert whose member_id is not the caller's. The pages that render
// it withhold it from the store's own owner
// (app/(app)/marketplace/creators/page.tsx:112, creators/[id]/page.tsx:112).
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const spies = vi.hoisted(() => ({
  toggleFollow: vi.fn(async (..._args: unknown[]): Promise<{ ok: true; following: boolean } | { ok: false; error: string }> => ({ ok: true, following: true })),
}));
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/app/(app)/marketplace/actions', () => ({ toggleFollowAction: spies.toggleFollow }));

const { FollowButton } = await import('@/components/marketplace/follow-button');
const STORE = '5a5a5a5a-0000-4000-8000-000000000001';
const screen = (following: boolean) => render(h.hooks, createElement(FollowButton, { storeId: STORE, following }));

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  spies.toggleFollow.mockClear();
  spies.toggleFollow.mockResolvedValue({ ok: true, following: true });
});

describe('the Follow button on a creator store', () => {
  it('CONTROL-F1DF85609216 follows the store it was given and then reads "Following"', async () => {
    const before = byName(screen(false), 'Follow', 'button');
    expect(before.props['aria-pressed']).toBe(false);
    expect(before.props.disabled).toBe(false);

    await click(before);

    expect(spies.toggleFollow.mock.calls).toEqual([[STORE]]);
    const after = byName(screen(false), 'Following', 'button');
    expect(after.props['aria-pressed']).toBe(true);
    expect(h.toasts.error).toEqual([]);
  });

  it('CONTROL-F1DF85609216 unfollows a followed store', async () => {
    spies.toggleFollow.mockResolvedValue({ ok: true, following: false });
    const before = byName(screen(true), 'Following', 'button');
    expect(before.props['aria-pressed']).toBe(true);

    await click(before);

    expect(spies.toggleFollow.mock.calls).toEqual([[STORE]]);
    expect(byName(screen(true), 'Follow', 'button').props['aria-pressed']).toBe(false);
  });

  it('CONTROL-F1DF85609216 goes back to "Follow" and says why when the server refuses', async () => {
    spies.toggleFollow.mockResolvedValue({ ok: false, error: 'Could not follow the store.' });

    await click(byName(screen(false), 'Follow', 'button'));

    expect(spies.toggleFollow.mock.calls).toEqual([[STORE]]);
    expect(byName(screen(false), 'Follow', 'button').props['aria-pressed']).toBe(false);
    expect(h.toasts.error).toEqual(['Could not follow the store.']);
  });
});
