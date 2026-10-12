import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import type { SliceEnv } from '@/lib/ai/context/policy';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// F1/F4 — the Autopilot scan runs on the service role and copies a source row
// into `autopilot_suggestions`, which 0085 lets every member read. A
// subscription charge due tomorrow ("$15.99 charge: Netflix tomorrow"), a
// renewal and an insurance policy's renewal were all announced with
// recipients 'family' — every member with a login, a guest included — although
// the applied 0481 refuses a guest `subscriptions_tracked` and `renewals`, and
// the Insurance Hub shows a child only the policies that name them.
//
// Driven through the real scan (the cron's and Rescan's caller) and the real
// resolution service, against the in-memory database.

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
const sent = vi.hoisted(() => ({ notices: [] as { recipients: unknown; title: string }[] }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async (_scope: unknown, input: { recipients: unknown; title: string }) => {
    sent.notices.push({ recipients: input.recipients, title: input.title });
    return { ok: true, data: { created: 1 } };
  }),
}));
const { runAutopilotScan } = await import('@/lib/autopilot/scan');
const { resolveSuggestion } = await import('@/lib/services/autopilot');
const { proactiveSlice } = await import('@/lib/ai/context/slices/proactive');

type DB = SupabaseClient<Database>;
const FAMILY = 'f1';
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'sitter', role: 'caregiver' },
  { id: 'sam', role: 'teen' }, { id: 'ava', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const NOT_GUESTS = ['mum', 'gran', 'sitter', 'sam', 'ava'];

afterEach(() => { sent.notices = []; });

function household() {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null })));
  return db;
}

describe('the scan tells each card\'s readers, and no one else', () => {
  it('a subscription charge due tomorrow is not pushed to a guest', async () => {
    const db = household();
    db.seed('subscriptions_tracked', [{ id: 'sub-1', family_id: FAMILY, name: 'Netflix', cost_cents: 1599, cadence: 'monthly', next_charge: '2026-09-22', last_used: null, status: 'active' }]);
    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));

    const charge = sent.notices.filter((n) => n.title.includes('Netflix'));
    expect(charge).toHaveLength(1);
    expect(charge[0].recipients).toEqual(NOT_GUESTS);
  });

  it('a renewal is not pushed to a guest', async () => {
    const db = household();
    db.seed('renewals', [{ id: 'ren-1', family_id: FAMILY, title: 'Passport', expires_at: '2026-10-01', status: 'active' }]);
    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));

    const renewal = sent.notices.filter((n) => n.title.includes('Passport'));
    expect(renewal).toHaveLength(1);
    expect(renewal[0].recipients).toEqual(NOT_GUESTS);
  });

  it('an insurance renewal goes to the managers and the member the policy names', async () => {
    const db = household();
    db.seed('family_insurance_policies', [
      { id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-10-01', member_id: 'ava', is_active: true },
      { id: 'pol-home', family_id: FAMILY, policy_type: 'home', insurer: 'Acme', renewal_date: '2026-10-02', member_id: null, is_active: true },
    ]);
    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));

    expect(sent.notices.find((n) => n.title.includes('Smile Co'))?.recipients).toEqual(['mum', 'gran', 'ava']);
    expect(sent.notices.find((n) => n.title.includes('Acme'))?.recipients).toEqual(['mum', 'gran']);
    expect(sent.notices.filter((n) => n.recipients === 'family')).toEqual([]);
    // The card carries whose policy it is, so the screens can apply the same rule.
    expect(db.table('autopilot_suggestions').find((s) => s.source_id === 'pol-ava')?.member_id).toBe('ava');
  });
});

describe('a card a reader is not shown is not theirs to resolve', () => {
  const scopeAs = (db: DB, role: ServiceScope['role'], memberId: string): ServiceScope => ({
    db, familyId: FAMILY, userId: `u-${memberId}`, memberId, role, actorKind: 'member', tz: 'UTC',
  } as ServiceScope);

  it('a guest cannot dismiss a subscription card; a parent can', async () => {
    const db = household();
    db.seed('autopilot_suggestions', [{
      id: 'sug-1', family_id: FAMILY, kind: 'finance', title: '$15.99 charge: Netflix tomorrow', status: 'open',
      source_kind: 'subscriptions_tracked', source_id: 'sub-1', member_id: null, dedupe_key: 'sub-charge:sub-1:2026-09-22',
      updated_at: '2026-09-21T06:30:00.000Z', urgency: 2, confidence: 76, action_type: 'review_subscription', payload: {},
    }]);

    const asGuest = await resolveSuggestion(scopeAs(db, 'guest', 'neighbour'), { suggestionId: 'sug-1', updatedAt: '2026-09-21T06:30:00.000Z', action: 'dismiss' });
    expect(asGuest).toEqual({ ok: false, code: 'notFound' });
    expect(db.table('autopilot_suggestions')[0].status).toBe('open');

    const asParent = await resolveSuggestion(scopeAs(db, 'parent', 'mum'), { suggestionId: 'sug-1', updatedAt: '2026-09-21T06:30:00.000Z', action: 'dismiss' });
    expect(asParent).toEqual({ ok: true, status: 'dismissed' });
  });
});

describe('the assistant is handed only the cards its reader may see', () => {
  it('an unused-subscription flag is not in a guest\'s proactive context; a teen\'s and a parent\'s keep it', async () => {
    const db = household();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.seed('autopilot_suggestions', [{
      id: 'sug-u', family_id: FAMILY, kind: 'finance', title: 'Unused: Netflix — $15.99/mo', status: 'open', urgency: 1, confidence: 71,
      detail: 'No activity in 60+ days. Keep it or cancel to cut waste?', action_label: 'Review',
      source_kind: 'subscriptions_tracked', source_id: 'sub-1', member_id: null, dedupe_key: 'sub-stale:sub-1', payload: {},
    }]);
    const contextFor = async (role: string, canManage: boolean) => {
      const built = await proactiveSlice.load(
        { db, familyId: FAMILY } as unknown as ServiceScope,
        { tz: 'UTC', now: new Date('2026-09-21T06:30:00Z'), viewer: { role, memberId: `m-${role}`, canManage }, members: [], pageContext: null } as unknown as SliceEnv,
      );
      if (!built.ok) throw new Error('the slice did not build');
      return JSON.stringify((built.data.data as { autopilot: unknown[] }).autopilot);
    };
    expect(await contextFor('guest', false)).not.toContain('Netflix');
    expect(await contextFor('teen', false)).toContain('Netflix');
    expect(await contextFor('parent', true)).toContain('Netflix');
  });
});
