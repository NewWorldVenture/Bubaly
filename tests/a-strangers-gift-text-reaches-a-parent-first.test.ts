import { isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A gift link is opened by someone who has not signed in, and their name (80
 * chars) and message (500 chars) are free text. That text used to reach every
 * member before any parent had looked at it: the "gift waiting" notice went to
 * recipients:'family' — one row every member reads — with the giver's name in
 * its title, and /wallet/gift loaded and rendered every pending gift's name and
 * message for every viewer, a child included. Approve/decline were hidden, the
 * text was not.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'child', notify: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'example.test' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async () => ({ familyId: 'family-1' }) }));
vi.mock('@/lib/services/notifications', () => ({ notify: harness.notify }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' }, memberships: [],
    active: { familyId: 'family-1', role: harness.role, member: { id: 'member-1', family_id: 'family-1' } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { submitGiftPledgeAction } = await import('@/app/gift/actions');
const { default: WalletGiftPage } = await import('@/app/(app)/wallet/gift/page');

const STRANGER = 'Call me 555-0100';
const MESSAGE = 'DM me on my socials';
let db: InMemorySupabase;

beforeEach(() => {
  harness.notify.mockReset();
  harness.notify.mockResolvedValue({ ok: true, data: { created: 1 } });
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('gift_links', [{ id: 'link-1', family_id: 'family-1', child_wallet_id: 'wallet-1', token: 'tok', is_active: true, occasion: 'birthday' }]);
  db.seed('child_wallets', [{ id: 'wallet-1', family_id: 'family-1', member_id: 'member-kid', is_active: true }]);
  db.seed('family_members', [{ id: 'member-kid', family_id: 'family-1', display_name: 'Kid' }]);
});

describe('the gift-waiting notice', () => {
  it('goes to the parents and adults only, and does not carry the giver\'s text', async () => {
    expect(await submitGiftPledgeAction({ token: 'tok', giverName: STRANGER, amountCents: 1_000, message: MESSAGE })).toEqual({ ok: true });
    expect(harness.notify).toHaveBeenCalledTimes(1);
    const [, input] = harness.notify.mock.calls[0];
    expect(input.recipients).toBe('managers');
    expect(`${input.title} ${input.body ?? ''}`).not.toContain(STRANGER);
    expect(`${input.title} ${input.body ?? ''}`).not.toContain(MESSAGE);
  });
});

function giftViewProps(tree: unknown): { pending: { giverName: string | null; message: string | null }[]; canManage: boolean } {
  const root = tree as ReactElement<{ children: unknown[] }>;
  const view = root.props.children.find((c) => isValidElement(c) && 'pending' in (c.props as object)) as ReactElement<{ pending: never; canManage: boolean }>;
  return view.props;
}

describe('/wallet/gift', () => {
  beforeEach(() => {
    db.seed('gift_payments', [{
      id: 'gift-1', family_id: 'family-1', gift_link_id: 'link-1', child_wallet_id: 'wallet-1',
      giver_name: STRANGER, message: MESSAGE, amount_cents: 1_000, occasion: 'birthday', status: 'pending', created_at: '2026-10-01T00:00:00Z',
    }]);
  });

  it.each(['child', 'teen'])('does not load or hand a %s the pending gifts\' giver text', async (role) => {
    harness.role = role;
    const props = giftViewProps(await WalletGiftPage());
    expect(props.pending).toEqual([]);
    expect(db.log.map((l) => l.table)).not.toContain('gift_payments');
  });

  it('shows a parent the pending gift with its name and message to review', async () => {
    harness.role = 'parent';
    const props = giftViewProps(await WalletGiftPage());
    expect(props.canManage).toBe(true);
    expect(props.pending).toEqual([expect.objectContaining({ giverName: STRANGER, message: MESSAGE })]);
  });
});
