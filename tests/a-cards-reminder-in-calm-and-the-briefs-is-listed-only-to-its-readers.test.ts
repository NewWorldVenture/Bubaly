import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getMessages, translate } from '@/lib/i18n/messages';
import { entitledServiceClient } from './helpers/entitled-service-client';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// FL2-R2. The scan executes an insurance or renewal card itself when it is a
// few days out, and leaves a `reminders` row behind: "Renew dental insurance
// (Smile Co)" for Ava's policy, "Renew Passport" for the family's renewal. The
// row names its source (related_type 'renewal', related_id the policy or
// renewal), not the card's readers, and `reminders` is guest-readable. Four
// readers listed its title to anyone:
//
//   /dashboard/calm        the inbox's "coming up soon" reminders
//   /api/ai/briefing       the reminder lines of the brief's prompt
//   /api/ai/weekly-briefing the week ahead's reminder lines
//   the briefing module    Kitchen Mode's urgent reminders, read in the browser
//
// Each now keeps a card's reminder within the card's readers
// (lib/autopilot/reminder-cards.ts): the renewal is not a guest's; the policy's
// is the managers' and Ava's. Driven through the real scan and the real page,
// routes and module over the in-memory database.

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;

const h = vi.hoisted(() => ({
  db: null as unknown,
  viewer: { role: 'guest', memberId: 'neighbour' },
  inbox: undefined as unknown,
  prompts: [] as string[],
  queries: [] as { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> }[],
}));

const FAMILY = 'f1';
const ctx = () => ({
  user: { id: `u-${h.viewer.memberId}` },
  active: {
    familyId: FAMILY, role: h.viewer.role,
    member: { id: h.viewer.memberId, display_name: h.viewer.memberId, role: h.viewer.role },
    family: { name: 'Family', timezone: 'UTC' },
  },
});

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ctx(),
  isSuperAdmin: async () => false,
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => entitledServiceClient() }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 2 }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ countHandledThisWeek: async () => ({ total: 0 }) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _input: unknown, body: (obs: { used: () => void; failed: () => void }) => unknown) => body({ used: () => {}, failed: () => {} }),
}));
// The model is not called; what it would be told is recorded.
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({
    complete: async (request: { messages: { content: string }[] }) => {
      h.prompts.push(request.messages.map((m) => m.content).join('\n'));
      return { text: 'not a brief', model: 'fixture' };
    },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'cookie', messages: getMessages('en-US') }),
}));
vi.mock('@/lib/reasoning/context', () => ({ loadFamilyContext: async () => null }));
vi.mock('@/components/modules/calm-module', () => ({
  CalmModule: (props: { inbox: unknown }) => { h.inbox = props.inbox; return null; },
}));
// The briefing module, rendered once to hand over the fetchers it would run.
vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({
    familyId: FAMILY, userId: `u-${h.viewer.memberId}`, role: h.viewer.role, isSuperAdmin: false, planLevel: 2, featureTiers: {}, members: [],
    selfMember: { id: h.viewer.memberId, family_id: FAMILY, user_id: `u-${h.viewer.memberId}`, role: h.viewer.role, is_active: true, updated_at: '2026-09-01T00:00:00Z' },
  }),
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: (config: { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> }) => {
    h.queries.push({ table: config.table, fetcher: config.fetcher });
    return { data: [], error: null, loading: false, stale: false, refresh: () => {} };
  },
}));
vi.mock('@/components/i18n/locale-provider', async (importOriginal) => {
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    ...(await importOriginal<typeof import('@/components/i18n/locale-provider')>()),
    useFamilyTimeZone: () => 'UTC',
    useLocale: () => localeOrDefault('en-US'),
    useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  };
});
vi.mock('@/components/approvals/approval-card', () => ({ ApprovalCard: () => null }));
vi.mock('@/components/dashboard/home-approval-actions', () => ({ HomeApprovalActions: () => null }));
vi.mock('@/components/family/record-actions', () => ({ RecommendationActions: () => null }));
// The scan's own push and the activity trail are not what is under test.
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async () => ({ ok: true, data: { created: 1 } })),
}));

const { runAutopilotScan } = await import('@/lib/autopilot/scan');
const CalmPage = (await import('@/app/(app)/dashboard/calm/page')).default;
const { POST: briefingPOST } = await import('@/app/api/ai/briefing/route');
const { POST: weeklyPOST } = await import('@/app/api/ai/weekly-briefing/route');
const { BriefingModule } = await import('@/components/modules/briefing-module');

const POLICY = 'Renew dental insurance (Smile Co)';
const PASSPORT = 'Renew Passport';
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' },
  { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const as = (memberId: string) => { h.viewer = { role: ROSTER.find((m) => m.id === memberId)!.role, memberId }; };

/** Ava's dental policy renews today and the passport in three days: the scan handles both itself. */
async function scannedHousehold(): Promise<Memory> {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] },
    defaults: { reminders: { is_done: false, notes: null, recurrence: 'none' } },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', name: 'Family' }]);
  db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null })));
  db.seed('family_insurance_policies', [{ id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-09-28', member_id: 'ava', is_active: true }]);
  db.seed('renewals', [{ id: 'ren-1', family_id: FAMILY, title: 'Passport', expires_at: '2026-10-01', status: 'active' }]);
  vi.setSystemTime(new Date('2026-09-28T06:30:00Z'));
  await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-28T06:30:00Z'));
  expect(db.table('autopilot_suggestions').filter((s) => s.status === 'auto_executed').map((s) => s.source_id).sort()).toEqual(['pol-ava', 'ren-1']);
  expect(db.table('reminders').map((r) => [r.title, r.member_id, r.related_type, r.related_id])).toEqual(expect.arrayContaining([
    [POLICY, null, 'renewal', 'pol-ava'], [PASSPORT, null, 'renewal', 'ren-1'],
  ]));
  expect(db.table('reminders')).toHaveLength(2);
  vi.setSystemTime(new Date('2026-09-28T06:45:00Z'));
  h.db = db;
  return db;
}

/** The reminder titles in this reader's Calm inbox. */
async function calmReminders(memberId: string): Promise<string[]> {
  as(memberId);
  h.inbox = undefined;
  renderToStaticMarkup(await CalmPage());
  const inbox = h.inbox as { needsYou: { source: string; title: string }[]; today: { source: string; title: string }[] };
  return [...inbox.needsYou, ...inbox.today].filter((i) => i.source === 'reminder').map((i) => i.title).sort();
}

/** What the model would be told for this reader. */
async function briefPrompt(memberId: string, route: 'daily' | 'weekly'): Promise<string> {
  as(memberId);
  h.prompts = [];
  const request = new NextRequest(`http://localhost/api/ai/${route === 'daily' ? 'briefing' : 'weekly-briefing'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'morning' }),
  });
  const response = await (route === 'daily' ? briefingPOST(request) : weeklyPOST(request));
  expect(response.status).toBe(200);
  expect(h.prompts).toHaveLength(1);
  return h.prompts[0];
}

/** Kitchen Mode's reminder read, as the briefing module runs it in this reader's browser. */
async function kitchenReminders(memberId: string, db: unknown): Promise<string[]> {
  as(memberId);
  h.queries = [];
  renderToStaticMarkup(createElement(BriefingModule));
  const query = h.queries.find((q) => q.table === 'reminders');
  if (!query) throw new Error('the briefing module did not read its reminders');
  const { data, error } = await query.fetcher(db);
  expect(error).toBeNull();
  return ((data ?? []) as { title: string }[]).map((r) => r.title).sort();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the Calm inbox lists the scan-made reminder only to its card\'s readers', () => {
  it('a guest is listed neither; Kit is not listed the policy; mum, gran and Ava are listed both', async () => {
    await scannedHousehold();
    expect(await calmReminders('neighbour')).toEqual([]);
    expect(await calmReminders('kit')).toEqual([PASSPORT]);
    for (const reader of ['mum', 'gran', 'ava']) expect(await calmReminders(reader), reader).toEqual([POLICY, PASSPORT].sort());
  });

  it('a reminder somebody wrote is still in everyone\'s inbox', async () => {
    const db = await scannedHousehold();
    db.seed('reminders', [{ id: 'rem-bins', family_id: FAMILY, title: 'Put the bins out', remind_at: '2026-09-28T18:00:00Z', member_id: null, is_done: false, related_type: null, related_id: null }]);
    expect(await calmReminders('neighbour')).toEqual(['Put the bins out']);
    expect(await calmReminders('kit')).toEqual([PASSPORT, 'Put the bins out'].sort());
  });

  it('a failed read of the cards lists them to the managers alone', async () => {
    const db = await scannedHousehold();
    h.db = withFaults(db, (table, calls) => (table === 'autopilot_suggestions' && calls.some((c) => c.method === 'eq' && c.args[0] === 'action_type') ? { message: 'Fixture read refused' } : null));
    expect(await calmReminders('mum')).toEqual([POLICY, PASSPORT].sort());
    for (const reader of ['ava', 'kit', 'neighbour']) expect(await calmReminders(reader), reader).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('[dashboard-calm] autopilot reminder cards read failed', expect.anything());
  });
});

describe('the daily and weekly briefs tell the model a card\'s reminder only for its readers', () => {
  it.each(['daily', 'weekly'] as const)('%s: not to a guest, the policy not to Kit; both to mum and Ava', async (route) => {
    await scannedHousehold();
    const guest = await briefPrompt('neighbour', route);
    expect(guest).not.toContain(POLICY);
    expect(guest).not.toContain(PASSPORT);
    const kit = await briefPrompt('kit', route);
    expect(kit).not.toContain(POLICY);
    expect(kit).toContain(PASSPORT);
    for (const reader of ['mum', 'ava']) {
      const prompt = await briefPrompt(reader, route);
      expect(prompt, reader).toContain(POLICY);
      expect(prompt, reader).toContain(PASSPORT);
    }
  });
});

describe("the briefing module's Kitchen Mode reads a card's reminder only for its readers", () => {
  it('not for a guest, the policy not for Kit; both for mum and Ava', async () => {
    const db = await scannedHousehold();
    expect(await kitchenReminders('neighbour', db)).toEqual([]);
    expect(await kitchenReminders('kit', db)).toEqual([PASSPORT]);
    for (const reader of ['mum', 'ava']) expect(await kitchenReminders(reader, db), reader).toEqual([POLICY, PASSPORT].sort());
  });
});

describe('the Calm inbox takes its cards after the reader\'s rule, not before', () => {
  // Review on #1031 (RV-R4R2-1): the page took a hundred open cards in no
  // order and only then dropped the ones the reader may not see, so a hundred
  // cards hidden from Kit emptied his inbox of the card behind them.
  const SNACKS = 'Pack snacks for Saturday match';
  async function calmCards(memberId: string): Promise<string[]> {
    as(memberId);
    h.inbox = undefined;
    renderToStaticMarkup(await CalmPage());
    const inbox = h.inbox as { needsYou: { source: string; title: string }[]; today: { source: string; title: string }[]; later?: { source: string; title: string }[] };
    return [...inbox.needsYou, ...inbox.today, ...(inbox.later ?? [])].filter((i) => i.source === 'autopilot').map((i) => i.title);
  }
  /** `maxRows`: the server's cap on one response (PostgREST's db-max-rows); none by default. */
  function household(hidden: number, maxRows?: number): void {
    const db = createInMemorySupabase<DB>(maxRows === undefined ? {} : { maxRows });
    db.seed('families', [{ id: FAMILY, timezone: 'UTC', name: 'Family' }]);
    db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null })));
    db.seed('autopilot_suggestions', [
      ...Array.from({ length: hidden }, (_, i) => ({
        id: `ins-${String(i).padStart(3, '0')}`, family_id: FAMILY, status: 'open', kind: 'insurance', source_kind: 'family_insurance_policies',
        member_id: 'ava', urgency: 3, title: `Renew policy ${i}`, detail: null, payload: {},
      })),
      { id: 'zz-snacks', family_id: FAMILY, status: 'open', kind: 'moment', source_kind: null, member_id: null, urgency: 2, title: SNACKS, detail: null, payload: {} },
    ]);
    h.db = db;
  }

  it('a hundred cards hidden from Kit ahead of his own still leave his card in his inbox', async () => {
    household(100);
    expect(await calmCards('kit')).toContain(SNACKS);
    expect(await calmCards('kit')).not.toContain('Renew policy 0');
  });

  it('control: with nothing hidden ahead, Kit sees his card', async () => {
    household(0);
    expect(await calmCards('kit')).toContain(SNACKS);
  });

  it('control: a manager still sees the policy cards first', async () => {
    household(100);
    const cards = await calmCards('mum');
    expect(cards).toContain('Renew policy 0');
  });

  // AUD-1031-VISIBLE-PREFIX, R5: a page the server capped (db-max-rows) is not
  // the end of the read. Asked for rows 100–299 after a hundred hidden ones, a
  // server capping at a hundred answered 100–199, and that short page ended
  // the read before Kit's card at row 200.
  it('two hundred cards hidden from Kit, from a server capping every response at a hundred, still leave his card in his inbox', async () => {
    household(200, 100);
    const kit = await calmCards('kit');
    expect(kit).toContain(SNACKS);
    expect(kit).not.toContain('Renew policy 0');
    expect(await calmCards('mum')).toContain('Renew policy 0');
  });
});
