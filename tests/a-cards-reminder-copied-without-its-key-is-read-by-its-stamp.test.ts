import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { getMessages, translate } from '@/lib/i18n/messages';
import { pluralize } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// RV-R4-1, RV-R4-2. An accepted Autopilot card's `family_reminders` row
// carries two stamps back to its card: the key (`idempotency_key`) and the tag
// (autopilot-source:<sha-256 of the card>). The next occurrence of a repeating
// one carries the tag alone — the reminders module's `complete` copies the
// tags and not the key — and the readers found a card by its key alone
// (lib/autopilot/reminder-cards.ts). So the next occurrence of Kit's refill, a
// card for everyone that is assigned to him, was listed to the managers and
// told to them, and Kit, whose reminder it is, was neither.
//
// And the assistant's legacy complete_reminder (lib/assistant/tools.ts) wrote
// the next occurrence with no tags at all: a repeating "Renew dental insurance
// (Smile Co)" came back linked to no card, everyone's, and Kit — whom Ava's
// policy does not name — could list it and move it.
//
// Now a row is found by its key, else by its tag, and the next occurrence
// keeps its tag. A tag no card mints is still the managers' alone. Driven
// through the real scan, the real resolution service, the real reminders
// module's read as the browser runs it, the real assistant tools and the real
// notifications generator, over the in-memory database.

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;

const h = vi.hoisted(() => ({
  viewer: { role: 'guest', memberId: 'neighbour' },
  queries: [] as { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> }[],
}));

// The reminders module, as the browser runs it: its read is handed over to be run against the database.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/dashboard/reminders', useSearchParams: () => new URLSearchParams(), redirect: () => {}, notFound: () => {},
}));
vi.mock('@/components/app/app-context', () => ({
  useApp: () => {
    const self = { id: h.viewer.memberId, family_id: 'f1', user_id: `u-${h.viewer.memberId}`, display_name: h.viewer.memberId, role: h.viewer.role, is_active: true };
    return { familyId: 'f1', userId: `u-${h.viewer.memberId}`, role: h.viewer.role, members: [self], selfMember: self, family: { id: 'f1', timezone: 'UTC' } };
  },
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: (config: { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }> }) => {
    h.queries.push({ table: config.table, fetcher: config.fetcher });
    return { data: [], error: null, loading: false, stale: false, refresh: () => {} };
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
const { resolveSuggestion, suggestionSourceTag } = await import('@/lib/services/autopilot');
const { mintSuggestionSourceTag } = await import('@/lib/autopilot/reminder-key');
const { generateFamilyNotifications } = await import('@/lib/server/notifications');
const { reminderTools } = await import('@/lib/ai/tools/reminders');
const { buildAssistantTools } = await import('@/lib/assistant/tools');
const { RemindersModule } = await import('@/components/modules/reminders-module');

const FAMILY = 'f1';
const POLICY = 'Renew dental insurance (Smile Co)';
const REFILL = 'Refill a prescription';
const PASSPORT = 'Renew Passport';
const LIBRARY = 'Renew library books';
const NEXT = 'next-occurrence';
const DAY = 24 * 60 * 60 * 1000;
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'sitter', role: 'caregiver' },
  { id: 'sam', role: 'teen' }, { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const EVERYONE = ROSTER.map((m) => m.id).sort();
const MANAGERS = ['gran', 'mum'];
const POLICY_READERS = ['ava', 'gran', 'mum'];
const role = (id: string) => ROSTER.find((m) => m.id === id)!.role;
const account = (id: string) => `u-${id}`;
const accounts = (ids: string[]) => ids.map(account).sort();

const AVAS_DENTAL = { id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-10-01', member_id: 'ava', is_active: true };
const KITS_MEDICINE = { id: 'med-kit', family_id: FAMILY, name: 'Amoxicillin', member_id: 'kit', refill_on: '2026-09-26', refill_reminder_days: 7, is_active: true };
const PASSPORT_ROW = { id: 'ren-1', family_id: FAMILY, title: 'Passport', expires_at: '2026-10-04', status: 'active' };

function household(): Memory {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']], family_reminders: [['family_id', 'idempotency_key']] },
    defaults: { reminders: { is_done: false, notes: null, recurrence: 'none' } },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', name: 'Family' }]);
  db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: account(m.id), display_name: m.id, is_active: true, birthday: null })));
  return db;
}

const asMember = (db: Memory, memberId: string, at: string): ServiceScope => ({
  db, familyId: FAMILY, userId: account(memberId), memberId, role: role(memberId), actorKind: 'member', tz: 'UTC', now: new Date(at),
} as ServiceScope);

/** Mum accepts the scan's open card for `source`: the card, and the reminder it wrote. */
async function accepted(db: Memory, source: string) {
  vi.setSystemTime(new Date('2026-09-21T06:30:00Z'));
  await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
  const card = db.table('autopilot_suggestions').find((s) => s.source_id === source)!;
  expect(card).toMatchObject({ status: 'open', action_type: 'create_reminder' });
  vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
  expect(await resolveSuggestion(asMember(db, 'mum', '2026-09-21T08:00:00Z'), { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' }))
    .toMatchObject({ ok: true, status: 'executed' });
  const reminder = db.table('family_reminders').find((r) => r.idempotency_key && r.title !== LIBRARY)!;
  expect(reminder.tags).toEqual([suggestionSourceTag(card as never)]);
  return { card, reminder };
}

/**
 * The reminders module's `complete` of a weekly reminder: the one done is
 * completed, and the next written as the module writes it — the tags and the
 * member copied, no key. Returns when the next is due.
 */
function completedByTheModule(db: Memory, reminder: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  const at = new Date(Date.parse(String(reminder.remind_at)) + 7 * DAY).toISOString();
  db.replace('family_reminders', db.table('family_reminders').map((r) => (r.id === reminder.id ? { ...r, recurrence: 'weekly', status: 'completed' } : r)));
  const { id: _id, idempotency_key: _key, ...rest } = reminder;
  db.seed('family_reminders', [{ ...rest, id: NEXT, idempotency_key: null, recurrence: 'weekly', remind_at: at, status: 'active', snoozed_until: null, ...overrides }]);
  return at;
}

/** Whom reminders.listDue, at `at`, lists the row `id` to. */
async function listedTo(db: Memory, id: string, at: string): Promise<string[]> {
  const tool = reminderTools.find((t) => t.name === 'reminders.listDue')!;
  const out: string[] = [];
  for (const m of ROSTER) {
    const res = await tool.execute(asMember(db, m.id, at), {}) as { ok: true; data: { reminders: { id: string }[] } } | { ok: false; error: string };
    if (!res.ok) throw new Error(`reminders.listDue failed: ${res.error}`);
    if (res.data.reminders.some((r) => r.id === id)) out.push(m.id);
  }
  return out.sort();
}

/** Whom the reminders module, read as each reader's browser runs it, lists the row `id` to. */
async function moduleListsTo(db: Memory, id: string): Promise<string[]> {
  const out: string[] = [];
  for (const m of ROSTER) {
    h.viewer = { role: m.role, memberId: m.id };
    h.queries = [];
    renderToStaticMarkup(createElement(RemindersModule));
    const query = h.queries.find((q) => q.table === 'family_reminders');
    if (!query) throw new Error('the reminders module did not read its reminders');
    const { data, error } = await query.fetcher(db);
    expect(error).toBeNull();
    if (((data ?? []) as { id: string }[]).some((r) => r.id === id)) out.push(m.id);
  }
  return out.sort();
}

/** The accounts a notification tick at `at` tells about the row `id` (null: the whole family). */
async function toldAbout(db: Memory, id: string, at: string): Promise<(string | null)[]> {
  vi.setSystemTime(new Date(at));
  await generateFamilyNotifications(db, FAMILY);
  return db.table('notifications')
    // Keyed `fr:<id>`, or `fr:<id>:<due>` for a repeating one (lib/reminders/notify.ts).
    .filter((n) => n.related_type === 'family_reminders' && (n.related_id === `fr:${id}` || String(n.related_id).startsWith(`fr:${id}:`)))
    .map((n) => (n.user_id as string | null) ?? null)
    .sort((a, b) => String(a).localeCompare(String(b)));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the tag an accepted card stamps is minted the same in the browser as on the server", () => {
  it('lib/autopilot/reminder-key.ts mintSuggestionSourceTag equals suggestionSourceTag', async () => {
    const cards = [
      { family_id: FAMILY, id: 'card-1', kind: 'health', action_type: 'create_reminder', title: REFILL, detail: 'Amoxicillin', member_id: 'kit', urgency: 2, payload: { title: REFILL, at: '2026-09-26T09:00:00.000Z' } },
      { family_id: ' padded ', id: ' id ', kind: 'insurance', action_type: null, title: ' Renew ', detail: null, member_id: null, urgency: 0, payload: null },
      { family_id: FAMILY, id: 'card-3', kind: 'renewal', action_type: 'create_reminder', title: 'Ünïcødé — “quoted”', detail: '', member_id: null, urgency: 3, payload: { nested: { b: [1, 'two', null], a: true } } },
    ];
    for (const card of cards) expect(await mintSuggestionSourceTag(card), card.id).toBe(suggestionSourceTag(card));
  });

  it('and equals the tag resolveSuggestion wrote', async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    const { card, reminder } = await accepted(db, 'med-kit');
    expect(reminder.tags).toEqual([await mintSuggestionSourceTag(card as never)]);
  });
});

describe("RV-R4-1: the next occurrence of an everyone card's reminder is read by its tag", () => {
  it("Kit's refill, assigned to him, is listed to everyone and told to Kit — on the server and in the browser", async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    const { reminder } = await accepted(db, 'med-kit');
    expect(reminder).toMatchObject({ title: REFILL, member_id: 'kit' });
    const at = completedByTheModule(db, reminder);
    const next = db.table('family_reminders').find((r) => r.id === NEXT)!;
    expect(next).toMatchObject({ member_id: 'kit', idempotency_key: null, tags: reminder.tags });

    expect(await listedTo(db, NEXT, at)).toEqual(EVERYONE);
    vi.setSystemTime(new Date(at));
    expect(await moduleListsTo(db, NEXT)).toEqual(EVERYONE);
    // Told as any reminder of Kit's: to Kit, never the managers in his place.
    expect(await toldAbout(db, NEXT, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual([account('kit')]);
  });

  it("a renewal's next occurrence is everyone's but the guest's; a policy's is the managers' and Ava's", async () => {
    for (const [seed, source, readers] of [
      [() => ({ renewals: [PASSPORT_ROW] }), 'ren-1', EVERYONE.filter((id) => id !== 'neighbour')],
      [() => ({ family_insurance_policies: [AVAS_DENTAL] }), 'pol-ava', POLICY_READERS],
    ] as const) {
      const db = household();
      for (const [table, rows] of Object.entries(seed())) db.seed(table, rows as Record<string, unknown>[]);
      const { reminder } = await accepted(db, source);
      const at = completedByTheModule(db, reminder);
      expect(await listedTo(db, NEXT, at), source).toEqual(readers);
      vi.setSystemTime(new Date(at));
      expect(await moduleListsTo(db, NEXT), source).toEqual(readers);
      expect(await toldAbout(db, NEXT, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString()), source).toEqual(accounts(readers));
    }
  });

  it("a tag no card mints any more — the card changed since — is the managers' alone, listed and told; the original, found by its key, is not", async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    const { card, reminder } = await accepted(db, 'med-kit');
    const at = completedByTheModule(db, reminder);
    db.replace('autopilot_suggestions', db.table('autopilot_suggestions').map((s) => (s.id === card.id ? { ...s, title: 'Refill Amoxicillin' } : s)));
    expect(await listedTo(db, NEXT, at)).toEqual(MANAGERS);
    vi.setSystemTime(new Date(at));
    expect(await moduleListsTo(db, NEXT)).toEqual(MANAGERS);
    expect(await toldAbout(db, NEXT, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual(accounts(MANAGERS));
    // The original row, by its key, is still its card's: everyone's.
    db.replace('family_reminders', db.table('family_reminders').map((r) => (r.id === reminder.id ? { ...r, status: 'active' } : r)));
    expect(await listedTo(db, reminder.id as string, at)).toEqual(EVERYONE);
  });

  it("tags naming two different cards are the managers' alone", async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    const refill = await accepted(db, 'med-kit');
    const policyCard = db.table('autopilot_suggestions').find((s) => s.source_id === 'pol-ava')!;
    const at = completedByTheModule(db, refill.reminder, { tags: [...(refill.reminder.tags as string[]), suggestionSourceTag(policyCard as never)] });
    expect(await listedTo(db, NEXT, at)).toEqual(MANAGERS);
    expect(await toldAbout(db, NEXT, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual(accounts(MANAGERS));
  });

  it('a reminder somebody wrote, assigned or not, is listed and told as before', async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    await accepted(db, 'med-kit');
    const at = '2026-10-02T09:00:00.000Z';
    db.seed('family_reminders', [
      { id: 'bins', family_id: FAMILY, title: 'Put the bins out', remind_at: at, status: 'active', member_id: null, tags: ['autopilot-source:notes'], idempotency_key: null, recurrence: 'weekly', snoozed_until: null },
      { id: 'kit-bag', family_id: FAMILY, title: 'Pack the kit bag', remind_at: at, status: 'active', member_id: 'sam', tags: [], idempotency_key: null, recurrence: 'none', snoozed_until: null },
    ]);
    expect(await listedTo(db, 'bins', at)).toEqual(EVERYONE);
    expect(await listedTo(db, 'kit-bag', at)).toEqual(EVERYONE);
    const tick = '2026-10-02T06:00:00.000Z';
    expect(await toldAbout(db, 'bins', tick)).toEqual([null]);
    expect(await toldAbout(db, 'kit-bag', tick)).toEqual([account('sam')]);
  });
});

describe("RV-R4-2: the assistant's complete_reminder keeps a card's tag on the next occurrence", () => {
  const NOW = '2026-09-30T08:00:00Z';

  /** Ava's dental policy accepted and made yearly by a manager; Kit's own library books, later. */
  async function policyHousehold() {
    const db = household();
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    const { reminder } = await accepted(db, 'pol-ava');
    expect(reminder).toMatchObject({ title: POLICY, member_id: null });
    db.replace('family_reminders', db.table('family_reminders').map((r) => (r.id === reminder.id ? { ...r, recurrence: 'yearly' } : r)));
    db.seed('family_reminders', [{
      id: 'library', family_id: FAMILY, title: LIBRARY, remind_at: '2026-10-05T16:00:00.000Z', status: 'active', member_id: 'kit',
      tags: [], idempotency_key: null, kind: 'time', priority: 'medium', recurrence: 'none', snoozed_until: null, notes: null, location_name: null,
    }]);
    vi.setSystemTime(new Date(NOW));
    return { db, reminder };
  }

  async function legacyTool(db: Memory, memberId: string, name: string, input: Record<string, unknown>) {
    const tools = buildAssistantTools(db, {
      familyId: FAMILY, userId: account(memberId), memberId, role: role(memberId), tz: 'UTC',
      members: ROSTER.map((m) => ({ id: m.id, display_name: m.id })),
    });
    return await tools.find((t) => t.name === name)!.execute(input) as { ok: boolean; summary?: string; error?: string };
  }

  async function aiTool(db: Memory, memberId: string, name: string, input: Record<string, unknown>, at: string) {
    const tool = reminderTools.find((t) => t.name === name)!;
    return await tool.execute(asMember(db, memberId, at), input) as { ok: true; data: { id: string; title: string } } | { ok: false; error: string };
  }

  it("mum completes the repeating policy reminder; its next occurrence never reaches Kit's listDue or snooze, and still reaches Ava", async () => {
    const { db, reminder } = await policyHousehold();
    expect(await legacyTool(db, 'mum', 'complete_reminder', { title: 'dental' })).toEqual({ ok: true, summary: `Completed “${POLICY}” — next one scheduled.` });
    const next = db.table('family_reminders').find((r) => r.title === POLICY && r.status === 'active')!;
    expect(next.id).not.toBe(reminder.id);
    expect(next.idempotency_key ?? null).toBeNull();
    const at = String(next.remind_at);
    expect(Date.parse(at)).toBeGreaterThan(Date.parse(NOW));

    expect(await listedTo(db, next.id as string, at)).toEqual(POLICY_READERS);
    for (const [name, input] of [['reminders.snooze', { title: 'dental', minutes: 60 }], ['reminders.complete', { title: 'smile' }]] as const) {
      const res = await aiTool(db, 'kit', name, input, at);
      expect(res, name).toMatchObject({ ok: false });
      expect(JSON.stringify(res), name).not.toContain(POLICY);
    }
    // Kit's "e" is his own library books, never the policy's title.
    const own = await aiTool(db, 'kit', 'reminders.snooze', { title: 'e', minutes: 60 }, NOW);
    expect(own).toMatchObject({ ok: true, data: { title: LIBRARY } });
    expect(JSON.stringify(own)).not.toContain(POLICY);
    for (const [name, input] of [['snooze_reminder', { title: 'dental', remind_at: '2027-11-01T09:00:00' }], ['complete_reminder', { title: 'dental' }]] as const) {
      const res = await legacyTool(db, 'kit', name, input);
      expect(res, name).toMatchObject({ ok: false });
      expect(JSON.stringify(res), name).not.toContain(POLICY);
    }
    expect(db.table('family_reminders').find((r) => r.id === next.id)).toMatchObject({ status: 'active', remind_at: at });
    expect(await toldAbout(db, next.id as string, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual(accounts(POLICY_READERS));

    // The policy's readers still reach it.
    vi.setSystemTime(new Date(NOW));
    expect(await aiTool(db, 'ava', 'reminders.snooze', { title: 'dental', minutes: 60 }, NOW)).toMatchObject({ ok: true, data: { id: next.id, title: POLICY } });
    // Because it carries its card's tag, as the module's next occurrence does.
    expect(next.tags).toEqual(reminder.tags);
  });
});
