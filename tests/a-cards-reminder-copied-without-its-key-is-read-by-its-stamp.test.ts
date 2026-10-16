import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { getMessages, translate } from '@/lib/i18n/messages';
import { pluralize } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// RV-R4-1/RV-R4-2, updated for the immutable-origin schema. Keys and tags
// remain informational compatibility stamps; only database origin/card IDs
// authorize a generated occurrence. Drive scan, acceptance, trusted recurrence,
// browser/server reads, legacy assistant actions and notification audiences.
// Historical/unresolved copies must remain manager-only, including forged tags.

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
  db.setRpcAuth(null, 'service_role');
  await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
  const card = db.table('autopilot_suggestions').find((s) => s.source_id === source)!;
  expect(card).toMatchObject({ status: 'open', action_type: 'create_reminder' });
  vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
  db.setRpcAuth(account('mum'));
  expect(await resolveSuggestion(asMember(db, 'mum', '2026-09-21T08:00:00Z'), { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' }))
    .toMatchObject({ ok: true, status: 'executed' });
  const reminder = db.table('family_reminders').find((r) => r.idempotency_key && r.title !== LIBRARY)!;
  expect(reminder.tags).toEqual([suggestionSourceTag(card as never)]);
  return { card, reminder };
}

/** The module completes its parent before the trusted recurrence RPC copies its origin. */
async function completedByTheModule(db: Memory, reminder: Record<string, unknown>) {
  const at = new Date(Date.parse(String(reminder.remind_at)) + 7 * DAY).toISOString();
  db.replace('family_reminders', db.table('family_reminders').map((r) => (r.id === reminder.id ? { ...r, recurrence: 'weekly', status: 'completed' } : r)));
  db.setRpcAuth(account('mum'));
  const result = await db.rpc('repeat_card_family_reminder', { p_parent_id: reminder.id as string, p_at: at }).maybeSingle();
  expect(result.error).toBeNull();
  expect(result.data).toMatchObject({ family_id: FAMILY, autopilot_origin: true, autopilot_card_id: reminder.autopilot_card_id, status: 'active', remind_at: at });
  if (!result.data || typeof result.data !== 'object' || !('id' in result.data) || typeof result.data.id !== 'string' || !result.data.id) {
    throw new Error('The trusted recurrence writer returned no reminder ID');
  }
  const nextId = result.data.id;
  return { at, nextId };
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

/** The accounts a notification tick at `at` tells about the row `id` (the whole family is every member's account). */
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

describe("RV-R4-1: the next occurrence keeps its immutable card origin", () => {
  it("Kit's refill, assigned to him, is listed to everyone and told to Kit — on the server and in the browser", async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    const { reminder } = await accepted(db, 'med-kit');
    expect(reminder).toMatchObject({ title: REFILL, member_id: 'kit' });
    const { at, nextId } = await completedByTheModule(db, reminder);
    const next = db.table('family_reminders').find((r) => r.id === nextId)!;
    expect(next).toMatchObject({ member_id: 'kit', autopilot_origin: true, autopilot_card_id: reminder.autopilot_card_id, tags: reminder.tags });
    expect(next.idempotency_key).toEqual(expect.any(String));

    expect(await listedTo(db, nextId, at)).toEqual(EVERYONE);
    vi.setSystemTime(new Date(at));
    expect(await moduleListsTo(db, nextId)).toEqual(EVERYONE);
    // Told as any reminder of Kit's: to Kit, never the managers in his place.
    expect(await toldAbout(db, nextId, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual([account('kit')]);
  });

  it("a renewal's next occurrence is everyone's but the guest's; a policy's is the managers' and Ava's", async () => {
    for (const [seed, source, readers] of [
      [() => ({ renewals: [PASSPORT_ROW] }), 'ren-1', EVERYONE.filter((id) => id !== 'neighbour')],
      [() => ({ family_insurance_policies: [AVAS_DENTAL] }), 'pol-ava', POLICY_READERS],
    ] as const) {
      const db = household();
      for (const [table, rows] of Object.entries(seed())) db.seed(table, rows as Record<string, unknown>[]);
      const { reminder } = await accepted(db, source);
      const { at, nextId } = await completedByTheModule(db, reminder);
      expect(await listedTo(db, nextId, at), source).toEqual(readers);
      vi.setSystemTime(new Date(at));
      expect(await moduleListsTo(db, nextId), source).toEqual(readers);
      expect(await toldAbout(db, nextId, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString()), source).toEqual(accounts(readers));
    }
  });

  it("a changed public card title does not detach the immutable origin of either occurrence", async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    const { card, reminder } = await accepted(db, 'med-kit');
    const { at, nextId } = await completedByTheModule(db, reminder);
    db.replace('autopilot_suggestions', db.table('autopilot_suggestions').map((s) => (s.id === card.id ? { ...s, title: 'Refill Amoxicillin' } : s)));
    expect(await listedTo(db, nextId, at)).toEqual(EVERYONE);
    vi.setSystemTime(new Date(at));
    expect(await moduleListsTo(db, nextId)).toEqual(EVERYONE);
    expect(await toldAbout(db, nextId, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual([account('kit')]);
    // The original and the repeat both keep the same trusted card ID.
    db.replace('family_reminders', db.table('family_reminders').map((r) => (r.id === reminder.id ? { ...r, status: 'active' } : r)));
    expect(await listedTo(db, reminder.id as string, at)).toEqual(EVERYONE);
  });

  it("conflicting public tags cannot replace a trusted origin; a stamp-only historical copy stays manager-only", async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    const refill = await accepted(db, 'med-kit');
    const policyCard = db.table('autopilot_suggestions').find((s) => s.source_id === 'pol-ava')!;
    const { at, nextId } = await completedByTheModule(db, refill.reminder);
    const tags = [...(refill.reminder.tags as string[]), suggestionSourceTag(policyCard as never)];
    // Historical stored-data fixture, not a permitted browser mutation of stamps.
    db.replace('family_reminders', db.table('family_reminders').map(r => r.id === nextId ? { ...r, tags } : r));
    db.seed('family_reminders', [{ ...refill.reminder, id: 'stamp-only', idempotency_key: null, tags, autopilot_origin: true, autopilot_card_id: null, remind_at: at }]);
    expect(await listedTo(db, nextId, at)).toEqual(EVERYONE);
    expect(await moduleListsTo(db, nextId)).toEqual(EVERYONE);
    expect(await toldAbout(db, nextId, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual([account('kit')]);
    expect(await listedTo(db, 'stamp-only', at)).toEqual(MANAGERS);
    expect(await moduleListsTo(db, 'stamp-only')).toEqual(MANAGERS);
    expect(await toldAbout(db, 'stamp-only', new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual(accounts(MANAGERS));
  });

  it('a reminder somebody wrote, assigned or not, is listed and told as before', async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    await accepted(db, 'med-kit');
    const at = '2026-10-02T09:00:00.000Z';
    db.seed('family_reminders', [
      { id: 'bins', family_id: FAMILY, autopilot_origin: false, autopilot_card_id: null, title: 'Put the bins out', remind_at: at, status: 'active', member_id: null, tags: ['autopilot-source:notes'], idempotency_key: null, recurrence: 'weekly', snoozed_until: null },
      { id: 'kit-bag', family_id: FAMILY, autopilot_origin: false, autopilot_card_id: null, title: 'Pack the kit bag', remind_at: at, status: 'active', member_id: 'sam', tags: [], idempotency_key: null, recurrence: 'none', snoozed_until: null },
    ]);
    expect(await listedTo(db, 'bins', at)).toEqual(EVERYONE);
    expect(await listedTo(db, 'kit-bag', at)).toEqual(EVERYONE);
    const tick = '2026-10-02T06:00:00.000Z';
    // The whole family: one row per member with a login.
    expect(await toldAbout(db, 'bins', tick)).toEqual(accounts(EVERYONE));
    expect(await toldAbout(db, 'kit-bag', tick)).toEqual([account('sam')]);
  });
});

describe("RV-R4-2: the assistant's complete_reminder keeps a card's trusted origin on the next occurrence", () => {
  const NOW = '2026-09-30T08:00:00Z';

  /** Ava's dental policy accepted and made yearly by a manager; Kit's own library books, later. */
  async function policyHousehold() {
    const db = household();
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    const { reminder } = await accepted(db, 'pol-ava');
    expect(reminder).toMatchObject({ title: POLICY, member_id: null });
    db.replace('family_reminders', db.table('family_reminders').map((r) => (r.id === reminder.id ? { ...r, recurrence: 'yearly' } : r)));
    db.seed('family_reminders', [{
      id: 'library', family_id: FAMILY, autopilot_origin: false, autopilot_card_id: null, title: LIBRARY, remind_at: '2026-10-05T16:00:00.000Z', status: 'active', member_id: 'kit',
      tags: [], idempotency_key: null, kind: 'time', priority: 'medium', recurrence: 'none', snoozed_until: null, notes: null, location_name: null,
    }]);
    vi.setSystemTime(new Date(NOW));
    return { db, reminder };
  }

  async function legacyTool(db: Memory, memberId: string, name: string, input: Record<string, unknown>) {
    db.setRpcAuth(account(memberId));
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

  describe.each(['complete_reminder', 'snooze_reminder'])('%s visibility metadata failures', name => {
    it.each(['family_reminders', 'reminders', 'autopilot_suggestions'].flatMap(table =>
      ['mum', 'ava'].flatMap(member => ['42703', ''].map(code => ({ table, member, code }))),
    ))('refuses $member when $table returns error code "$code", without writing', async ({ table, member, code }) => {
      const { db } = await policyHousehold();
      const before = structuredClone(db.table('family_reminders'));
      const writes: string[] = [];
      let failures = 0;
      const client = withFaults(db, (queriedTable, calls) => {
        if (calls.some(call => ['insert', 'update', 'delete', 'upsert'].includes(call.method))) writes.push(queriedTable);
        const projection = calls.find(call => call.method === 'select')?.args[0];
        if (queriedTable === table && (table === 'autopilot_suggestions' || projection === 'id, family_id, autopilot_origin, autopilot_card_id')) {
          failures++;
          return { code, message: 'Synthetic private metadata outage' };
        }
        return null;
      });
      expect(await legacyTool(client, member, name, { title: 'dental', remind_at: '2027-11-01T09:00:00' }))
        .toEqual({ ok: false, error: 'Could not find the reminder.' });
      expect(failures).toBeGreaterThan(0);
      expect(writes).toEqual([]);
      expect(db.table('family_reminders')).toEqual(before);
    });

    it('preserves manager fallback when the linked card is absent after a successful read', async () => {
      const { db, reminder } = await policyHousehold();
      db.replace('autopilot_suggestions', []);
      db.replace('family_reminders', db.table('family_reminders').map(row => row.id === reminder.id ? { ...row, recurrence: 'none' } : row));
      const before = structuredClone(db.table('family_reminders'));
      const input = { title: 'dental', remind_at: '2027-11-01T09:00:00' };
      expect(await legacyTool(db, 'ava', name, input)).toMatchObject({ ok: false });
      expect(db.table('family_reminders')).toEqual(before);
      expect(await legacyTool(db, 'mum', name, input)).toMatchObject({ ok: true });
      expect(db.table('family_reminders').find(row => row.id === reminder.id)).toMatchObject(name === 'complete_reminder'
        ? { status: 'completed' } : { status: 'active', remind_at: '2027-11-01T09:00:00.000Z' });
    });

    it('retains the content-read error when a later page fails after metadata also failed', async () => {
      const { db } = await policyHousehold();
      const before = structuredClone(db.table('family_reminders'));
      const contentError = { code: '40001', message: 'Synthetic content page failure' };
      let metadataFailed = false;
      const client = withFaults(db, (table, calls) => {
        if (table !== 'family_reminders') return null;
        if (calls.find(call => call.method === 'select')?.args[0] === 'id, family_id, autopilot_origin, autopilot_card_id') {
          metadataFailed = true;
          return { code: '42703', message: 'Synthetic origin metadata failure' };
        }
        return calls.some(call => call.method === 'range' && Number(call.args[0]) > 0) ? contentError : null;
      });
      expect(await legacyTool(client, 'ava', name, { title: 'dental', remind_at: '2027-11-01T09:00:00' }))
        .toEqual({ ok: false, error: 'Could not find the reminder.' });
      expect(metadataFailed).toBe(true);
      expect(console.error).toHaveBeenLastCalledWith('[assistant] find the reminder failed:', expect.objectContaining(contentError));
      expect(db.table('family_reminders')).toEqual(before);
    });
  });

  it("mum completes the repeating policy reminder; its next occurrence never reaches Kit's listDue or snooze, and still reaches Ava", async () => {
    const { db, reminder } = await policyHousehold();
    expect(await legacyTool(db, 'mum', 'complete_reminder', { title: 'dental' })).toEqual({ ok: true, summary: `Completed “${POLICY}” — next one scheduled.` });
    const next = db.table('family_reminders').find((r) => r.title === POLICY && r.status === 'active')!;
    expect(next.id).not.toBe(reminder.id);
    expect(next.idempotency_key).toEqual(expect.any(String));
    expect(next).toMatchObject({ autopilot_origin: true, autopilot_card_id: reminder.autopilot_card_id });
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
    // Informational tags are retained alongside the authoritative origin.
    expect(next.tags).toEqual(reminder.tags);
  });

  it.each(['refused', 'missing receipt', 'foreign receipt', 'changed origin'] as const)('retains the completed parent after a %s recurrence result and creates no child', async mode => {
    const { db, reminder } = await policyHousehold();
    const repeat = vi.fn(async () => mode === 'refused'
      ? { data: null, error: { code: '42501', message: 'Synthetic recurrence refusal' } }
      : { data: mode === 'missing receipt' ? null : {
        ...reminder, id: 'untrusted-next', family_id: mode === 'foreign receipt' ? 'f2' : FAMILY,
        autopilot_origin: mode !== 'changed origin',
      }, error: null });
    const client = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'rpc') return Reflect.get(target, property, receiver);
        return (name: string, args: Record<string, unknown>) => name === 'repeat_card_family_reminder'
          ? { maybeSingle: () => repeat() } : target.rpc(name as never, args as never);
      },
    }) as Memory;
    const before = db.table('family_reminders').map(row => row.id);
    expect(await legacyTool(client, 'mum', 'complete_reminder', { title: 'dental' })).toEqual({
      ok: false, error: 'Reminder completed, but we could not confirm the next occurrence. Check your reminders before completing this again or adding another.',
    });
    expect(repeat).toHaveBeenCalledOnce();
    expect(db.table('family_reminders').map(row => row.id)).toEqual(before);
    expect(db.table('family_reminders').find(row => row.id === reminder.id)).toMatchObject({
      status: 'completed', completed_at: new Date(NOW).toISOString(),
      autopilot_origin: true, autopilot_card_id: reminder.autopilot_card_id,
    });
  });

  it('a manager can repeat a historical generated reminder without granting a public stamp its old audience', async () => {
    const { db, reminder } = await policyHousehold();
    db.replace('family_reminders', db.table('family_reminders').map(row => row.id === reminder.id ? { ...row, autopilot_card_id: null } : row));
    expect(await legacyTool(db, 'ava', 'complete_reminder', { title: 'dental' })).toMatchObject({ ok: false });
    expect(await legacyTool(db, 'mum', 'complete_reminder', { title: 'dental' })).toMatchObject({ ok: true });
    const next = db.table('family_reminders').find(row => row.title === POLICY && row.status === 'active')!;
    expect(next).toMatchObject({ autopilot_origin: true, autopilot_card_id: null, tags: reminder.tags });
    expect(next.id).not.toBe(reminder.id);
    const at = String(next.remind_at);
    expect(await listedTo(db, next.id as string, at)).toEqual(MANAGERS);
    expect(await moduleListsTo(db, next.id as string)).toEqual(MANAGERS);
    expect(await toldAbout(db, next.id as string, new Date(Date.parse(at) - 3 * 60 * 60 * 1000).toISOString())).toEqual(accounts(MANAGERS));
  });

  it('a manually created recurring reminder retains its ordinary insertion path', async () => {
    const { db } = await policyHousehold();
    db.replace('family_reminders', db.table('family_reminders').map(row => row.id === 'library' ? { ...row, recurrence: 'weekly' } : row));
    const client = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'rpc') return Reflect.get(target, property, receiver);
        return () => { throw new Error('Manual recurrence must not call a generated-card RPC'); };
      },
    }) as Memory;
    expect(await legacyTool(client, 'kit', 'complete_reminder', { title: 'library' })).toMatchObject({ ok: true });
    const next = db.table('family_reminders').find(row => row.title === LIBRARY && row.status === 'active');
    expect(next).toMatchObject({ autopilot_origin: false, autopilot_card_id: null, member_id: 'kit' });
    expect(next!.id).not.toBe('library');
  });

});
