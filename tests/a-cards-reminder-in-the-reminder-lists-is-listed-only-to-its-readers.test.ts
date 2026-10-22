import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import type { DisplayData } from '@/components/display/display-grid';
import { getMessages, translate } from '@/lib/i18n/messages';
import { pluralize } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// FL-R3-B. A manager's "Add reminder" on an Autopilot card writes a
// `family_reminders` row stamped with the card's key: unassigned for an
// insurance card — "Renew dental insurance (Smile Co)" for Ava's policy — so
// the managers who renew it are reminded, and with no member for a renewal's
// "Renew Passport". The dashboard already listed such a row only to the card's
// readers (lib/autopilot/reminder-cards.ts). Every other list of reminders did
// not, and read by "everyone's" a guest and Kit, a child the policy does not
// name, were listed the policy's renewal, and the guest the passport's:
//
//   /home              Today's reminders
//   /dashboard/reminders the reminders module, read in the browser
//   /display           the kitchen wall's reminders tile
//   /dashboard/planning the hub's four soonest reminders
//   reminders.listDue  the assistant's "what's due?"
//
// Each now applies the card's rule, and lists every other reminder exactly as
// before. Driven through the real scan, the real resolution service and the
// real page, module or tool over the in-memory database.

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;

const h = vi.hoisted(() => ({
  db: null as unknown,
  viewer: { role: 'guest', memberId: 'neighbour' },
  queries: [] as { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> }[],
  rows: {} as Record<string, unknown[]>,
  today: [] as { reminders: { title: string }[] }[],
}));

const FAMILY = 'f1';
const ctx = () => ({
  user: { id: `u-${h.viewer.memberId}`, email: `${h.viewer.memberId}@example.test` },
  active: {
    familyId: FAMILY, role: h.viewer.role,
    member: { id: h.viewer.memberId, display_name: h.viewer.memberId, role: h.viewer.role },
    family: { name: 'Family', timezone: 'UTC' },
  },
});

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ctx(),
  requireFeature: async () => ctx(),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages: messages, translate: tr } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages('en-US'), key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default', messages: messages('en-US') }),
  };
});
// Home: what is not under test answers as empty, and Today's input is recorded.
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/schedule/intelligence-server', () => ({ loadScheduleIntelligence: async () => ({ ok: true, data: { byEvent: {} } }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ loadTimeSaved: async () => ({ show: false }) }));
vi.mock('@/lib/operating-index/server', () => ({ loadOperatingIndex: async () => ({ change: null }) }));
vi.mock('@/lib/home/today', async (original) => {
  const actual = await original<typeof import('@/lib/home/today')>();
  return {
    ...actual,
    buildToday: (...args: Parameters<typeof actual.buildToday>) => {
      h.today.push(args[0] as unknown as { reminders: { title: string }[] });
      return actual.buildToday(...args);
    },
  };
});
// The kitchen display: the page's data is read off the shell it hands it to.
vi.mock('next/navigation', () => ({
  unstable_rethrow: () => {},
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/display', useSearchParams: () => new URLSearchParams(), redirect: () => {}, notFound: () => {},
}));
vi.mock('@/components/display/auto-refresh', () => ({ AutoRefresh: () => null }));
vi.mock('@/components/display/display-shell-client', () => ({ DisplayShellClient: () => null }));
// The reminders module, as the browser runs it: its reads are handed over to be
// run against the database, and the module is rendered with what they returned.
vi.mock('@/components/app/app-context', () => ({
  useApp: () => {
    const self = { id: h.viewer.memberId, family_id: 'f1', user_id: `u-${h.viewer.memberId}`, display_name: h.viewer.memberId, role: h.viewer.role, is_active: true };
    return { familyId: 'f1', userId: `u-${h.viewer.memberId}`, role: h.viewer.role, members: [self], selfMember: self, family: { id: 'f1', timezone: 'UTC' } };
  },
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: (config: { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> }) => {
    h.queries.push({ table: config.table, fetcher: config.fetcher });
    return { data: h.rows[config.table] ?? [], error: null, loading: false, stale: false, refresh: () => {} };
  },
}));
vi.mock('@/lib/hooks/use-action', () => ({ useAction: () => ({ run: vi.fn(), isPending: () => false }) }));
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({ createReminderAction: vi.fn(), deleteReminderAction: vi.fn(), snoozeReminderAction: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => async () => true }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/i18n/locale-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/i18n/locale-provider')>()),
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  usePlural: () => (key: string, count: number) => pluralize(getMessages('en-US'), 'en-US', key, count),
  useLocale: () => ({ code: 'en-US' }),
  useFamilyTimeZone: () => 'UTC',
}));
// The scan's own push and the activity trail are not what is under test.
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async () => ({ ok: true, data: { created: 1 } })),
}));

const { runAutopilotScan } = await import('@/lib/autopilot/scan');
const { resolveSuggestion, suggestionReminderKey } = await import('@/lib/services/autopilot');
const { mintSuggestionReminderKey } = await import('@/lib/autopilot/reminder-key');
const { default: HomePage } = await import('@/app/(app)/home/page');
const { default: DisplayPage } = await import('@/app/(app)/display/page');
const { default: PlanningPage } = await import('@/app/(app)/dashboard/planning/page');
const { RemindersModule } = await import('@/components/modules/reminders-module');
const { reminderTools } = await import('@/lib/ai/tools/reminders');

const POLICY = 'Renew dental insurance (Smile Co)';
const PASSPORT = 'Renew Passport';
const BINS = 'Put the bins out';
const NOW = '2026-10-12T10:00:00Z';
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'sitter', role: 'caregiver' },
  { id: 'sam', role: 'teen' }, { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const as = (memberId: string) => { h.viewer = { role: ROSTER.find((m) => m.id === memberId)!.role, memberId }; };

/** Who is listed what: the policy's reminder is the managers' and Ava's, the passport's everyone's but the guest's, the bins everyone's. */
const EXPECTED: Record<string, string[]> = {
  mum: [BINS, POLICY, PASSPORT], gran: [BINS, POLICY, PASSPORT], ava: [BINS, POLICY, PASSPORT],
  kit: [BINS, PASSPORT], sam: [BINS, PASSPORT], sitter: [BINS, PASSPORT], neighbour: [BINS],
};
const sorted = (titles: string[]) => [...titles].sort();

/**
 * Mum accepts the scan's card for Ava's dental policy (ten days out) and the
 * one for the family's passport (twenty-four days out); the bins are a
 * reminder somebody wrote. Read on the 12th, when all three are due.
 */
async function household(): Promise<Memory> {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']], family_reminders: [['family_id', 'idempotency_key']] },
    defaults: { reminders: { is_done: false, notes: null, recurrence: 'none' } },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', name: 'Family' }]);
  db.seed('family_members', ROSTER.map((m, i) => ({
    ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null, created_at: `2026-01-0${i + 1}T00:00:00Z`,
  })));
  db.seed('family_insurance_policies', [{ id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-10-01', member_id: 'ava', is_active: true }]);
  db.seed('renewals', [{ id: 'ren-1', family_id: FAMILY, title: 'Passport', expires_at: '2026-10-15', status: 'active' }]);
  vi.setSystemTime(new Date('2026-09-21T06:30:00Z'));
  await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
  vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
  const scope = { db, familyId: FAMILY, userId: 'u-mum', memberId: 'mum', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-21T08:00:00Z') } as ServiceScope;
  for (const source of ['pol-ava', 'ren-1']) {
    const card = db.table('autopilot_suggestions').find((s) => s.source_id === source)!;
    expect(card, source).toMatchObject({ status: 'open' });
    expect(await resolveSuggestion(scope, { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' }), source)
      .toMatchObject({ ok: true, status: 'executed' });
  }
  // Unassigned, so the managers are reminded; each stamped with its card's key.
  expect(db.table('family_reminders').map((r) => [r.title, r.member_id]).sort()).toEqual([[POLICY, null], [PASSPORT, null]].sort());
  for (const r of db.table('family_reminders')) expect(Date.parse(String(r.remind_at))).toBeLessThan(Date.parse(NOW));
  db.seed('family_reminders', [{
    id: 'bins', family_id: FAMILY, title: BINS, remind_at: '2026-10-12T08:00:00.000Z', status: 'active', member_id: null,
    tags: [], idempotency_key: null, kind: 'time', priority: 'medium', recurrence: 'none', snoozed_until: null, subtasks: [],
  }]);
  vi.setSystemTime(new Date(NOW));
  h.db = db;
  return db;
}

/** Every string a React tree carries, server components unexpanded. */
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement<Record<string, unknown>>(node)) return '';
  return Object.values(node.props).map((value) => (typeof value === 'string' ? value : textOf(value as ReactNode))).join(' ');
}

/** /home as this reader: Today's reminders, and whether the page carries each title. */
async function homeToday(memberId: string) {
  as(memberId);
  h.today = [];
  const tree = await HomePage();
  expect(h.today).toHaveLength(1);
  return { titles: sorted(h.today[0].reminders.map((r) => r.title)), text: textOf(tree) };
}

/** /display as this reader: the reminders tile's rows. */
async function displayTile(memberId: string): Promise<string[]> {
  as(memberId);
  const node = await DisplayPage();
  const find = (input: ReactNode): DisplayData | undefined => {
    if (Array.isArray(input)) return input.map(find).find(Boolean);
    if (!isValidElement<{ data?: DisplayData; children?: ReactNode }>(input)) return undefined;
    return input.props.data ?? find(input.props.children);
  };
  const data = find(node);
  if (!data) throw new Error('the kitchen display rendered no data');
  expect(data.loadStatus?.reminders).toBe('ok');
  return sorted(data.reminders.map((r) => r.title));
}

/** /dashboard/planning as this reader: the page's reminder card. */
async function planningCard(memberId: string) {
  as(memberId);
  const text = textOf(await PlanningPage());
  return { text, titles: sorted([POLICY, PASSPORT, BINS].filter((title) => text.includes(title))) };
}

/** /dashboard/reminders as this reader's browser runs it: the rows read, and the page. */
async function remindersModule(memberId: string, db: unknown) {
  as(memberId);
  h.queries = [];
  h.rows = {};
  renderToStaticMarkup(createElement(RemindersModule));
  const query = h.queries.find((q) => q.table === 'family_reminders');
  if (!query) throw new Error('the reminders module did not read its reminders');
  const { data, error } = await query.fetcher(db);
  expect(error).toBeNull();
  h.rows = { family_reminders: data ?? [], reminder_lists: [] };
  const html = renderToStaticMarkup(createElement(RemindersModule));
  return { titles: sorted(((data ?? []) as { title: string }[]).map((r) => r.title)), html };
}

/** The assistant's reminders.listDue as this reader. */
async function assistantDue(memberId: string, db: unknown = h.db): Promise<string[]> {
  as(memberId);
  const tool = reminderTools.find((t) => t.name === 'reminders.listDue')!;
  const scope = { db, familyId: FAMILY, userId: `u-${memberId}`, memberId, role: h.viewer.role, actorKind: 'member', tz: 'UTC', now: new Date(NOW) } as ServiceScope;
  const res = await tool.execute(scope, {}) as { ok: true; data: { reminders: { title: string }[] } } | { ok: false; error: string };
  if (!res.ok) throw new Error(`reminders.listDue failed: ${res.error}`);
  return sorted(res.data.reminders.map((r) => r.title));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the key an accepted card stamps is minted the same in the browser as on the server", () => {
  it('lib/autopilot/reminder-key.ts mintSuggestionReminderKey equals suggestionReminderKey', async () => {
    for (const [family, card] of [[FAMILY, 'card-1'], ['8a0c1f9e-1b2c-4d5e-8f70-112233445566', 'b2b5c3d4-0000-4111-8222-333344445555'], [' padded ', ' id ']]) {
      expect(await mintSuggestionReminderKey(family, card)).toBe(suggestionReminderKey(family, card));
    }
  });
});

describe("/home's Today lists an accepted card's reminder only to the card's readers", () => {
  it.each(Object.keys(EXPECTED))('%s', async (reader) => {
    await household();
    const seen = await homeToday(reader);
    expect(seen.titles).toEqual(sorted(EXPECTED[reader]));
    for (const title of [POLICY, PASSPORT]) {
      if (!EXPECTED[reader].includes(title)) expect(seen.text, title).not.toContain(title);
    }
  });

  it('a failed read of the cards lists them to the managers alone', async () => {
    const db = await household();
    h.db = withFaults(db, (table, calls) => (table === 'autopilot_suggestions' && calls.some((c) => c.method === 'eq' && c.args[0] === 'action_type') ? { message: 'Fixture read refused' } : null));
    expect((await homeToday('mum')).titles).toEqual(sorted(EXPECTED.mum));
    expect((await homeToday('ava')).titles).toEqual([BINS]);
    expect(console.error).toHaveBeenCalledWith('[home] autopilot reminder cards read failed', expect.anything());
  });
});

describe("/dashboard/reminders lists an accepted card's reminder only to the card's readers", () => {
  it.each(Object.keys(EXPECTED))('%s', async (reader) => {
    const db = await household();
    const seen = await remindersModule(reader, db);
    expect(seen.titles).toEqual(sorted(EXPECTED[reader]));
    for (const title of [POLICY, PASSPORT]) {
      if (EXPECTED[reader].includes(title)) expect(seen.html, title).toContain(title);
      else expect(seen.html, title).not.toContain(title);
    }
  });

  it('every listed reminder keeps its edit and delete controls', async () => {
    const db = await household();
    const edit = `aria-label="${translate(getMessages('en-US'), 'reminders.editReminder')}"`;
    const remove = `aria-label="${translate(getMessages('en-US'), 'reminders.deleteReminder')}"`;
    for (const reader of ['mum', 'kit']) {
      const { html } = await remindersModule(reader, db);
      expect(html.split(edit).length - 1, reader).toBe(EXPECTED[reader].length);
      expect(html.split(remove).length - 1, reader).toBe(EXPECTED[reader].length);
    }
  });

  it('a failed read of the cards lists them to the managers alone', async () => {
    const db = await household();
    const faulty = withFaults(db, (table, calls) => (table === 'autopilot_suggestions' && calls.some((c) => c.method === 'eq' && c.args[0] === 'action_type') ? { message: 'Fixture read refused' } : null));
    expect((await remindersModule('gran', faulty)).titles).toEqual(sorted(EXPECTED.gran));
    expect((await remindersModule('ava', faulty)).titles).toEqual([BINS]);
    expect(console.error).toHaveBeenCalledWith('[reminders] autopilot reminder cards read failed', expect.anything());
  });
});

describe("the kitchen display's reminders tile lists an accepted card's reminder only to the card's readers", () => {
  it.each(Object.keys(EXPECTED))('%s', async (reader) => {
    await household();
    expect(await displayTile(reader)).toEqual(sorted(EXPECTED[reader]));
  });
});

describe("the planning hub lists an accepted card's reminder only to the card's readers", () => {
  it.each(Object.keys(EXPECTED))('%s', async (reader) => {
    await household();
    const seen = await planningCard(reader);
    expect(seen.titles).toEqual(sorted(EXPECTED[reader]));
  });
});

describe("the assistant's reminders.listDue tells a reader an accepted card's reminder only if it is theirs", () => {
  it.each(Object.keys(EXPECTED))('%s', async (reader) => {
    await household();
    expect(await assistantDue(reader)).toEqual(sorted(EXPECTED[reader]));
  });
});
