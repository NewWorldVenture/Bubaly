import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Redeeming a reward no longer takes the client's word for anything.
 *
 * Both write paths were direct browser inserts and updates that chose `status`,
 * `decided_by` AND `cost_points` client-side, picking 'approved' when the
 * client believed the member was a manager. Anyone who could edit the request
 * could grant themselves a reward, at any price they liked.
 *
 * Migration 0295 is the durable fix, because `reward_redemptions` is reachable
 * from PostgREST whatever these actions do — and it is unapplied, because the
 * migration workflow is F5's blocker. This is the half that ships without it:
 * the deployed app decides nothing on the client, so the forgery now needs a
 * hand-crafted API call rather than the browser console.
 */

const FAMILY = 'family-1';
const state = vi.hoisted(() => ({ db: null as unknown, role: 'parent', memberId: 'member-parent' }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'someone@example.com' },
    memberships: [],
    active: {
      familyId: FAMILY,
      role: state.role,
      member: { id: state.memberId, family_id: FAMILY, user_id: 'user-1' },
      family: { id: FAMILY, name: 'Test household', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});

const { requestRedemptionAction, decideRedemptionAction } = await import('@/app/(app)/dashboard/rewards/actions');

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<DB>({ defaults: { reward_redemptions: { status: 'requested', cost_points: 0 } } });
  db.seed('families', [{ id: FAMILY, name: 'Test household', timezone: 'UTC' }]);
  db.seed('rewards', [{ id: 'reward-1', family_id: FAMILY, title: 'Extra screen time', cost_points: 100 }]);
  state.db = db;
  state.role = 'parent';
  state.memberId = 'member-parent';
});

const redemptions = () => db.table('reward_redemptions');

describe('asking for a reward', () => {
  it('queues a child’s request rather than approving it', async () => {
    state.role = 'child';
    state.memberId = 'member-child';

    const result = await requestRedemptionAction({ rewardId: 'reward-1', forMemberId: 'member-child' });

    expect(result).toMatchObject({ ok: true });
    expect(redemptions()[0]).toMatchObject({ status: 'requested', decided_by: null, decided_at: null });
  });

  it('prices it from the reward, not from the caller', async () => {
    // The quieter half of the finding: cost_points is a deliberate snapshot so
    // history survives the reward being edited, and a snapshot the spender
    // supplies is not a snapshot.
    state.role = 'child';
    state.memberId = 'member-child';

    await requestRedemptionAction({ rewardId: 'reward-1', forMemberId: 'member-child' });

    expect(redemptions()[0]).toMatchObject({ cost_points: 100, reward_title: 'Extra screen time' });
  });

  it('lets a manager redeeming for themselves take it at once', async () => {
    const result = await requestRedemptionAction({ rewardId: 'reward-1', forMemberId: 'member-parent' });

    expect(result).toMatchObject({ ok: true });
    expect(redemptions()[0]).toMatchObject({ status: 'approved', decided_by: 'member-parent' });
  });

  it('queues even a manager’s request when it is for someone else', async () => {
    const result = await requestRedemptionAction({ rewardId: 'reward-1', forMemberId: 'member-child' });

    expect(result).toMatchObject({ ok: true });
    expect(redemptions()[0]).toMatchObject({ status: 'requested', decided_by: null });
  });

  it('refuses a reward from another family', async () => {
    db.seed('rewards', [{ id: 'reward-elsewhere', family_id: 'family-2', title: 'Not yours', cost_points: 5 }]);

    const result = await requestRedemptionAction({ rewardId: 'reward-elsewhere', forMemberId: 'member-parent' });

    expect(result).toMatchObject({ ok: false });
    expect(redemptions()).toHaveLength(0);
  });
});

describe('deciding a queued redemption', () => {
  beforeEach(() => {
    db.seed('reward_redemptions', [{
      id: 'red-1', family_id: FAMILY, member_id: 'member-child',
      reward_title: 'Extra screen time', cost_points: 100, status: 'requested',
      decided_by: null, decided_at: null,
    }]);
  });

  it.each(['child', 'teen', 'guest'])('refuses a %s, and the request stays queued', async (role) => {
    state.role = role;
    state.memberId = 'member-child';

    const result = await decideRedemptionAction({ id: 'red-1', decision: 'approved' });

    expect(result).toMatchObject({ ok: false });
    expect(redemptions()[0]).toMatchObject({ status: 'requested', decided_by: null });
  });

  it.each(['parent', 'adult'])('lets a %s approve', async (role) => {
    state.role = role;

    const result = await decideRedemptionAction({ id: 'red-1', decision: 'approved' });

    expect(result).toMatchObject({ ok: true });
    expect(redemptions()[0]).toMatchObject({ status: 'approved', decided_by: 'member-parent' });
  });

  it('records the decider from the session, never the caller', async () => {
    await decideRedemptionAction({ id: 'red-1', decision: 'rejected' });

    expect(redemptions()[0]).toMatchObject({ status: 'rejected', decided_by: 'member-parent' });
  });

  it('refuses a decision that is not one', async () => {
    const result = await decideRedemptionAction({ id: 'red-1', decision: 'requested' as never });

    expect(result).toMatchObject({ ok: false });
    expect(redemptions()[0]).toMatchObject({ status: 'requested' });
  });
});

describe('neither screen writes the table directly any more', () => {
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (rel: string) => stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));

  it.each([
    'components/modules/rewards-module.tsx',
    'components/modules/chores-module.tsx',
  ])('%s goes through the action', (file) => {
    const source = read(file);
    // READS stay in the client — both screens subscribe to the table through
    // useRealtimeQuery, and that is the point of a live board. It is the WRITES
    // that had to move, so this forbids those specifically rather than any
    // mention of the table.
    expect(source).not.toMatch(/from\('reward_redemptions'\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/);
    expect(source).toMatch(/RedemptionAction\(/);
  });
});
