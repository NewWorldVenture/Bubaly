import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import type { ServiceScope } from '@/lib/services/types';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// FL2-R1. An insurance card's reminder is nobody's errand but the managers'
// (lib/autopilot/audience.ts reminderMemberFor), so a manager's "Add reminder"
// on a card for Ava's dental policy writes an UNASSIGNED family_reminders row.
// The AI home dashboard listed reminders by "mine or nobody's"
// (`member_id.eq.<me>,member_id.is.null`), and an unassigned row is everybody's
// by that rule: a guest and Kit, a child the policy does not name, were listed
// "Renew dental insurance (Smile Co)" in Today and in Coming Up.
//
// The dashboard now keeps a reminder an Autopilot card made within the card's
// readers (lib/autopilot/reminder-cards.ts): the managers and Ava for this
// card. Driven through the real scan, the real resolution service and the real
// AiHomeDashboard over the in-memory database.

const mocks = vi.hoisted(() => ({ server: vi.fn(), today: vi.fn(), upcoming: vi.fn() }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return false; } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => false }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/i18n/server', () => ({ getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: getMessages('en-US') }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useFamilyTimeZone: () => undefined, useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));
vi.mock('@/components/concierge/ask-bubaly', () => ({ AskBubaly: () => null }));
vi.mock('@/components/concierge/working-on', () => ({ WorkingOn: () => null }));
vi.mock('@/components/concierge/completed-by-bubaly', () => ({ CompletedByBubaly: () => null }));
vi.mock('@/components/dashboard/quick-actions', () => ({ DashboardQuickActions: () => null }));
vi.mock('@/components/dashboard/insight-hero', () => ({ InsightHero: () => null }));
vi.mock('@/components/approvals/approval-card', () => ({ ApprovalCard: () => null }));
vi.mock('@/components/dashboard/home-approval-actions', () => ({ HomeApprovalActions: () => null }));
vi.mock('@/components/family/record-actions', () => ({ RecommendationActions: () => null }));
vi.mock('@/components/concierge/needs-you-actions', () => ({ FactSuggestionActions: () => null, InboxMessageActions: () => null }));
vi.mock('@/lib/home/today', async (original) => {
  const actual = await original<typeof import('@/lib/home/today')>();
  return { ...actual, buildToday: (...args: Parameters<typeof actual.buildToday>) => { mocks.today(...args); return actual.buildToday(...args); } };
});
vi.mock('@/lib/dashboard/upcoming', async (original) => {
  const actual = await original<typeof import('@/lib/dashboard/upcoming')>();
  return { ...actual, mergeUpcoming: (...args: Parameters<typeof actual.mergeUpcoming>) => { mocks.upcoming(...args); return actual.mergeUpcoming(...args); } };
});
// The scan's own push and the activity trail are not what is under test.
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async () => ({ ok: true, data: { created: 1 } })),
}));

const { AiHomeDashboard } = await import('@/components/dashboard/ai-home-dashboard');
const { runAutopilotScan } = await import('@/lib/autopilot/scan');
const { resolveSuggestion, suggestionReminderKey, suggestionSourceTag } = await import('@/lib/services/autopilot');
const { AUTOPILOT_SOURCE_TAG } = await import('@/lib/reminders/provenance');

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;
const FAMILY = 'f1';
const RENEW = 'Renew dental insurance (Smile Co)';
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' },
  { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const role = (id: string) => ROSTER.find((m) => m.id === id)!.role;
const AVAS_DENTAL = { id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-10-01', member_id: 'ava', is_active: true };

function household(): Memory {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']], family_reminders: [['family_id', 'idempotency_key']] },
    defaults: { reminders: { is_done: false, notes: null, recurrence: 'none' } },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', ROSTER.map((m, i) => ({
    ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null, created_at: `2026-01-0${i + 1}T00:00:00Z`,
  })));
  return db;
}

/** Mum accepts the card the scan made for Ava's policy ten days out; the reminder it wrote. */
async function acceptedInsuranceReminder(db: Memory) {
  db.seed('family_insurance_policies', [AVAS_DENTAL]);
  vi.setSystemTime(new Date('2026-09-21T06:30:00Z'));
  await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
  const card = db.table('autopilot_suggestions').find((s) => s.source_id === 'pol-ava')!;
  expect(card).toMatchObject({ status: 'open', member_id: 'ava' });
  vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
  const scope = { db, familyId: FAMILY, userId: 'u-mum', memberId: 'mum', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-21T08:00:00Z') } as ServiceScope;
  expect(await resolveSuggestion(scope, { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' }))
    .toMatchObject({ ok: true, status: 'executed' });
  const [reminder] = db.table('family_reminders');
  // Unassigned, so the managers are reminded (blocker 2 of the first round).
  expect(reminder).toMatchObject({ title: RENEW, member_id: null });
  return reminder;
}

/** The dashboard as `memberId` sees it at `at`: its Today and Coming Up reminder titles, and the page. */
async function dashboardFor(db: Memory | DB, memberId: string, at: string) {
  vi.setSystemTime(new Date(at));
  mocks.today.mockClear(); mocks.upcoming.mockClear();
  mocks.server.mockResolvedValue(db);
  const ctx = {
    user: { id: `u-${memberId}`, email: `${memberId}@example.test` },
    active: { familyId: FAMILY, role: role(memberId), member: { id: memberId, display_name: memberId }, family: { name: 'Family', timezone: 'UTC' } },
  } as unknown as UserContext;
  const html = renderToStaticMarkup(await AiHomeDashboard({ ctx }));
  const today = (mocks.today.mock.calls[0][0].reminders as { title: string }[]).map((r) => r.title);
  const comingUp = (mocks.upcoming.mock.calls[0][1] as { title: string }[]).map((r) => r.title);
  return { today, comingUp, html };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the dashboard lists an accepted card's reminder only to the card's readers", () => {
  it('Coming Up lists it to mum and Ava, not to Kit or the guest', async () => {
    const db = household();
    const reminder = await acceptedInsuranceReminder(db);
    // A day before it is due: in the next seven days, past today.
    const dayBefore = new Date(Date.parse(String(reminder.remind_at)) - 86_400_000).toISOString();
    for (const reader of ['mum', 'gran', 'ava']) {
      const seen = await dashboardFor(db, reader, dayBefore);
      expect(seen.comingUp, reader).toEqual([RENEW]);
      expect(seen.html, reader).toContain(RENEW);
    }
    for (const reader of ['kit', 'neighbour']) {
      const seen = await dashboardFor(db, reader, dayBefore);
      expect(seen.comingUp, reader).toEqual([]);
      expect(seen.html, reader).not.toContain(RENEW);
    }
  });

  it('Today lists it, due, to mum and Ava, not to Kit or the guest', async () => {
    const db = household();
    const reminder = await acceptedInsuranceReminder(db);
    const anHourAfter = new Date(Date.parse(String(reminder.remind_at)) + 3_600_000).toISOString();
    for (const reader of ['mum', 'ava']) {
      const seen = await dashboardFor(db, reader, anHourAfter);
      expect(seen.today, reader).toEqual([RENEW]);
      expect(seen.html, reader).toContain(RENEW);
    }
    for (const reader of ['kit', 'neighbour']) {
      const seen = await dashboardFor(db, reader, anHourAfter);
      expect(seen.today, reader).toEqual([]);
      expect(seen.html, reader).not.toContain(RENEW);
    }
  });

  it("a reminder somebody wrote is still everyone's, and a renewal card's is everyone's but the guest's", async () => {
    const db = household();
    db.seed('renewals', [{ id: 'ren-1', family_id: FAMILY, title: 'Passport', expires_at: '2026-10-15', status: 'active' }]);
    vi.setSystemTime(new Date('2026-09-21T06:30:00Z'));
    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
    const card = db.table('autopilot_suggestions').find((s) => s.source_id === 'ren-1')!;
    vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
    const scope = { db, familyId: FAMILY, userId: 'u-mum', memberId: 'mum', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-21T08:00:00Z') } as ServiceScope;
    expect(await resolveSuggestion(scope, { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' })).toMatchObject({ ok: true });
    const [renewal] = db.table('family_reminders');
    db.seed('family_reminders', [{ id: 'bins', family_id: FAMILY, title: 'Put the bins out', remind_at: renewal.remind_at, status: 'active', member_id: null, tags: [], idempotency_key: null }]);
    const dayBefore = new Date(Date.parse(String(renewal.remind_at)) - 86_400_000).toISOString();

    expect((await dashboardFor(db, 'neighbour', dayBefore)).comingUp).toEqual(['Put the bins out']);
    for (const reader of ['mum', 'kit']) {
      expect((await dashboardFor(db, reader, dayBefore)).comingUp.sort(), reader).toEqual(['Put the bins out', 'Renew Passport']);
    }
  });

  it('a failed read of the cards lists such a reminder to the managers alone', async () => {
    const db = household();
    const reminder = await acceptedInsuranceReminder(db);
    const dayBefore = new Date(Date.parse(String(reminder.remind_at)) - 86_400_000).toISOString();
    const faulty = withFaults(db, (table, calls) => (table === 'autopilot_suggestions' && calls.some((c) => c.method === 'eq' && c.args[0] === 'action_type') ? { message: 'Fixture read refused' } : null));
    expect((await dashboardFor(faulty as unknown as DB, 'mum', dayBefore)).comingUp).toEqual([RENEW]);
    expect((await dashboardFor(faulty as unknown as DB, 'ava', dayBefore)).comingUp).toEqual([]);
    expect((await dashboardFor(faulty as unknown as DB, 'neighbour', dayBefore)).comingUp).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('[dashboard-home] autopilot reminder cards read failed', expect.anything());
  });

  it("a guest's Coming Up still holds their own soonest when hidden card reminders crowd the first ten", async () => {
    const db = household();
    vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
    const cards = Array.from({ length: 10 }, (_, i) => ({
      id: `card-${i}`, family_id: FAMILY, kind: 'insurance', source_kind: 'family_insurance_policies', source_id: `pol-${i}`, member_id: 'ava',
      action_type: 'create_reminder', status: 'executed', title: `Policy ${i}`, dedupe_key: `k-${i}`, created_at: '2026-09-20T00:00:00Z',
    }));
    db.seed('autopilot_suggestions', cards);
    db.seed('family_reminders', [
      ...cards.map((c, i) => ({
        id: `r-${i}`, family_id: FAMILY, title: `Renew policy ${i}`, remind_at: `2026-09-23T0${i}:00:00.000Z`, status: 'active', member_id: null,
        idempotency_key: suggestionReminderKey(FAMILY, c.id), tags: [`${AUTOPILOT_SOURCE_TAG}${'a'.repeat(64)}`],
      })),
      { id: 'bins', family_id: FAMILY, title: 'Put the bins out', remind_at: '2026-09-24T18:00:00.000Z', status: 'active', member_id: null, idempotency_key: null, tags: [] },
      { id: 'mine', family_id: FAMILY, title: 'Water the plants', remind_at: '2026-09-25T18:00:00.000Z', status: 'active', member_id: 'neighbour', idempotency_key: null, tags: [] },
    ]);
    expect((await dashboardFor(db, 'neighbour', '2026-09-21T08:00:00Z')).comingUp).toEqual(['Put the bins out', 'Water the plants']);
    const parent = await dashboardFor(db, 'mum', '2026-09-21T08:00:00Z');
    expect(parent.comingUp).toHaveLength(10);
    expect(parent.comingUp.every((title) => title.startsWith('Renew policy'))).toBe(true);
  });
});

describe('the shared lookup (lib/autopilot/reminder-cards.ts)', () => {
  it("an accepted card's reminder read without a way to mint its key is the managers' alone, never nobody's card", async () => {
    const { reminderCardsReader, visibleReminders } = await import('@/lib/autopilot/reminder-cards');
    const db = household();
    const reminder = await acceptedInsuranceReminder(db);
    const withoutKeys = reminderCardsReader(db, FAMILY, { onError: () => { throw new Error('the cards were readable'); } });
    const withKeys = reminderCardsReader(db, FAMILY, { keyOf: (id) => suggestionReminderKey(FAMILY, id), sourceTagOf: suggestionSourceTag, onError: () => { throw new Error('the cards were readable'); } });
    const rows = [reminder as { id: string; idempotency_key: string | null; tags: string[] | null }];
    expect(await visibleReminders(rows, { role: 'parent', memberId: 'mum' }, withoutKeys)).toHaveLength(1);
    expect(await visibleReminders(rows, { role: 'child', memberId: 'ava' }, withoutKeys)).toHaveLength(0);
    expect(await visibleReminders(rows, { role: 'child', memberId: 'ava' }, withKeys)).toHaveLength(1);
    expect(await visibleReminders(rows, { role: 'child', memberId: 'kit' }, withKeys)).toHaveLength(0);
  });
});
