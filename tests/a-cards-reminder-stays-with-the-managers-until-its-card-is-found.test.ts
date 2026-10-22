import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// AUD-1031-REMINDER-ORDER. The scan writes an auto-executed card's reminder
// BEFORE the card (lib/autopilot/scan.ts), and the readers found a reminder's
// audience by looking its card up among the cards narrower than everyone. A
// link that found nothing read as "everyone's", so in the moment between the
// two writes — and for good, when the card failed to save and the clean-up of
// the reminder failed or removed nothing — "Renew dental insurance (Smile Co)"
// was listed to a guest and to a child the policy does not name, and the
// notifier told it to the whole family.
//
// Now a linked reminder goes past the managers only when its card is found
// (lib/autopilot/reminder-cards.ts). Driven through the real scan, held or
// failed at its card's insert, the real Calm page (a reader of the scan's
// `reminders`), the real reminders.listDue (a reader of an accepted card's
// `family_reminders`) and the real notifications generator, over the
// in-memory database.

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;

const h = vi.hoisted(() => ({
  db: null as unknown,
  viewer: { role: 'guest', memberId: 'neighbour' },
  inbox: undefined as unknown,
}));

const FAMILY = 'f1';
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `u-${h.viewer.memberId}` },
    active: {
      familyId: 'f1', role: h.viewer.role,
      member: { id: h.viewer.memberId, display_name: h.viewer.memberId, role: h.viewer.role },
      family: { name: 'Family', timezone: 'UTC' },
    },
  }),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'cookie', messages: getMessages('en-US') }),
}));
vi.mock('@/lib/reasoning/context', () => ({ loadFamilyContext: async () => null }));
vi.mock('@/components/modules/calm-module', () => ({
  CalmModule: (props: { inbox: unknown }) => { h.inbox = props.inbox; return null; },
}));
// The scan's own push and the activity trail are not what is under test.
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async () => ({ ok: true, data: { created: 1 } })),
}));

const { runAutopilotScan } = await import('@/lib/autopilot/scan');
const { resolveSuggestion, suggestionSourceTag } = await import('@/lib/services/autopilot');
const { reminderCardsReader, visibleReminders } = await import('@/lib/autopilot/reminder-cards');
const { mintSuggestionSourceTag } = await import('@/lib/autopilot/reminder-key');
const { makeKey } = await import('@/lib/services/idempotency');
const { AUTOPILOT_SOURCE_TAG } = await import('@/lib/reminders/provenance');
const { generateFamilyNotifications } = await import('@/lib/server/notifications');
const { reminderTools } = await import('@/lib/ai/tools/reminders');
const CalmPage = (await import('@/app/(app)/dashboard/calm/page')).default;

const POLICY = 'Renew dental insurance (Smile Co)';
const PASSPORT = 'Renew Passport';
const REFILL = 'Refill a prescription';
const BINS = 'Put the bins out';
const KIT_BAG = 'Pack the kit bag';
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'sitter', role: 'caregiver' },
  { id: 'sam', role: 'teen' }, { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const EVERYONE = ROSTER.map((m) => m.id);
const MANAGERS = ['mum', 'gran'];
const account = (memberId: string) => `u-${memberId}`;
const accounts = (...ids: string[]) => ids.map(account).sort();

// The cron's hour; every card below is due today, so the scan executes it
// itself and its reminder is at nine. Read at seven, inside the next day.
const SCAN_AT = '2026-09-28T06:30:00Z';
const READ_AT = '2026-09-28T07:00:00Z';
const AVAS_DENTAL = { id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-09-28', member_id: 'ava', is_active: true };
const PASSPORT_ROW = { id: 'ren-1', family_id: FAMILY, title: 'Passport', expires_at: '2026-10-01', status: 'active' };
const KITS_MEDICINE = { id: 'med-kit', family_id: FAMILY, name: 'Amoxicillin', member_id: 'kit', refill_on: '2026-09-28', refill_reminder_days: 5, is_active: true };

function household(): Memory {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']], family_reminders: [['family_id', 'idempotency_key']] },
    defaults: { reminders: { is_done: false, notes: null, recurrence: 'none' } },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', name: 'Family' }]);
  db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: account(m.id), display_name: m.id, is_active: true, birthday: null })));
  h.db = db;
  return db;
}

type Reply = { data: unknown; error: { code: string; message: string } | null };
type Steer = { wait: Promise<void> } | { reply: Reply } | null;

/**
 * The same database, with chosen statements steered as they execute: `steer`
 * sees the table and the builder methods called on it, and answers with a
 * promise the statement waits on before the database answers it, a reply that
 * stands in for the database's, or null.
 */
function steered(db: Memory, steer: (table: string, methods: string[]) => Steer): DB {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = target.from(table) as unknown as Record<PropertyKey, unknown>;
        const methods: string[] = [];
        const run = async (execute: () => PromiseLike<unknown>) => {
          const plan = steer(table, methods);
          if (plan && 'reply' in plan) return { count: null, status: plan.reply.error ? 400 : 201, statusText: '', ...plan.reply };
          if (plan) await plan.wait;
          return execute();
        };
        const proxy: object = new Proxy(builder, {
          get(object, key) {
            const value = Reflect.get(object, key);
            if (typeof value !== 'function') return value;
            const method = value as (...args: unknown[]) => unknown;
            if (key === 'then') {
              return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                run(() => new Promise((ok, ko) => { method.call(object, ok, ko); })).then(resolve, reject);
            }
            if (key === 'single' || key === 'maybeSingle') {
              return (...args: unknown[]) => { methods.push(String(key)); return run(() => method.apply(object, args) as PromiseLike<unknown>); };
            }
            return (...args: unknown[]) => {
              methods.push(String(key));
              const result = method.apply(object, args);
              return result === object ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  }) as unknown as DB;
}

/** The scan, held at its card's insert: the reminder is committed, and the card is not yet saved. */
function holdingTheCard(db: Memory) {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const held = new Promise<void>((resolve) => { reached = resolve; });
  const client = steered(db, (table, methods) => {
    if (table !== 'autopilot_suggestions' || !methods.includes('insert')) return null;
    reached();
    return { wait: released };
  });
  vi.setSystemTime(new Date(SCAN_AT));
  const scanning = runAutopilotScan(client, FAMILY, null, 'UTC', 'en-US', echo, new Date(SCAN_AT));
  // A scan that ends without reaching the card's insert fails the case rather than hanging it.
  const reachedTheCard = Promise.race([held, scanning.then(() => { throw new Error('the scan saved no card'); })]);
  return { held: reachedTheCard, release, scanning };
}

/** The reminder titles in this reader's Calm inbox. */
async function calmReminders(memberId: string): Promise<string[]> {
  h.viewer = { role: ROSTER.find((m) => m.id === memberId)!.role, memberId };
  h.inbox = undefined;
  renderToStaticMarkup(await CalmPage());
  const inbox = h.inbox as { needsYou: { source: string; title: string }[]; today: { source: string; title: string }[] };
  return [...inbox.needsYou, ...inbox.today].filter((i) => i.source === 'reminder').map((i) => i.title).sort();
}

/** Who each reader's Calm inbox lists `title` to. */
async function listedTo(title: string): Promise<string[]> {
  const out: string[] = [];
  for (const reader of EVERYONE) if ((await calmReminders(reader)).includes(title)) out.push(reader);
  return out.sort();
}

/** A notification tick at `at`; every reminder notice sent so far, by title, to the accounts (the whole family is every member account). */
async function noticesAfterTick(db: Memory, at: string) {
  vi.setSystemTime(new Date(at));
  await generateFamilyNotifications(db, FAMILY);
  const out = new Map<string, (string | null)[]>();
  for (const n of db.table('notifications').filter((row) => row.related_type === 'reminders' || row.related_type === 'family_reminders')) {
    const title = String(n.title).replace(/^Reminder: /, '');
    out.set(title, [...(out.get(title) ?? []), (n.user_id as string | null) ?? null]);
  }
  for (const [title, users] of out) out.set(title, [...users].sort((a, b) => String(a).localeCompare(String(b))));
  return out;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the scan's reminder, between its commit and its card's", () => {
  it("an insurance renewal's reminder is the managers' alone until its card is saved; then Ava's too, never Kit's or the guest's", async () => {
    const db = household();
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    const scan = holdingTheCard(db);
    await scan.held;
    // The interval the finding names: the reminder is committed, its card is not.
    expect(db.table('reminders')).toEqual([expect.objectContaining({ title: POLICY, member_id: null, related_type: 'renewal', related_id: 'pol-ava' })]);
    expect(db.table('autopilot_suggestions')).toEqual([]);

    // A reminder somebody wrote, and one assigned to Sam, in the same interval.
    db.seed('reminders', [
      { id: 'rem-bins', family_id: FAMILY, title: BINS, remind_at: '2026-09-28T18:00:00Z', member_id: null, is_done: false, related_type: null, related_id: null },
      { id: 'rem-sam', family_id: FAMILY, title: KIT_BAG, remind_at: '2026-09-28T18:00:00Z', member_id: 'sam', is_done: false, related_type: null, related_id: null },
    ]);
    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(POLICY)).toEqual(MANAGERS.sort());
    expect(await calmReminders('kit')).toEqual([BINS, KIT_BAG].sort());
    expect(await calmReminders('neighbour')).toEqual([BINS, KIT_BAG].sort());
    const during = await noticesAfterTick(db, READ_AT);
    expect(during.get(POLICY)).toEqual(accounts(...MANAGERS));
    // The healthy controls are addressed as they always were.
    expect(during.get(BINS)).toEqual(accounts(...EVERYONE)); // the family: one row per member
    expect(during.get(KIT_BAG)).toEqual([account('sam')]);

    scan.release();
    await scan.scanning;
    expect(db.table('autopilot_suggestions')).toEqual([expect.objectContaining({ source_id: 'pol-ava', status: 'auto_executed', member_id: 'ava' })]);
    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(POLICY)).toEqual(['ava', 'gran', 'mum']);
    const after = await noticesAfterTick(db, READ_AT);
    expect(after.get(POLICY)).toEqual(accounts('ava', 'gran', 'mum'));
    expect(after.get(POLICY)).not.toContain(null);
  });

  it("a renewal's reminder is told to no one but the managers until its card is saved; then to everyone but the guest", async () => {
    const db = household();
    db.seed('renewals', [PASSPORT_ROW]);
    const scan = holdingTheCard(db);
    await scan.held;
    expect(db.table('reminders')).toEqual([expect.objectContaining({ title: PASSPORT, member_id: null, related_type: 'renewal', related_id: 'ren-1' })]);

    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(PASSPORT)).toEqual(MANAGERS.sort());
    const during = await noticesAfterTick(db, READ_AT);
    // Never the family-wide notice its unassigned row would otherwise be.
    expect(during.get(PASSPORT)).toEqual(accounts(...MANAGERS));

    scan.release();
    await scan.scanning;
    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(PASSPORT)).toEqual(EVERYONE.filter((id) => id !== 'neighbour').sort());
    const after = await noticesAfterTick(db, READ_AT);
    expect(after.get(PASSPORT)).toEqual(accounts(...EVERYONE.filter((id) => id !== 'neighbour')));
  });

  it("a refill's reminder, a card for everyone, waits for its card too, and is then everyone's and its member's to be told", async () => {
    const db = household();
    db.seed('medications', [KITS_MEDICINE]);
    const scan = holdingTheCard(db);
    await scan.held;
    expect(db.table('reminders')).toEqual([expect.objectContaining({ title: REFILL, member_id: 'kit', related_type: 'renewal', related_id: 'med-kit' })]);

    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(REFILL)).toEqual(MANAGERS.sort());
    expect((await noticesAfterTick(db, READ_AT)).get(REFILL)).toEqual(accounts(...MANAGERS));

    scan.release();
    await scan.scanning;
    // Positively a card for everyone: listed to every reader, the guest
    // included, and told to the member it is for, as any reminder of theirs.
    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(REFILL)).toEqual([...EVERYONE].sort());
    expect((await noticesAfterTick(db, READ_AT)).get(REFILL)).toEqual(accounts('gran', 'kit', 'mum'));
  });
});

describe("the scan's reminder whose card never saves", () => {
  it.each([
    ['the clean-up fails', { data: null, error: { code: 'XX000', message: 'Fixture delete refused' } }],
    ['the clean-up removes nothing', { data: [], error: null }],
  ] as const)("is the managers' alone when %s", async (_case, cleanup) => {
    const db = household();
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    const client = steered(db, (table, methods) => {
      if (table === 'autopilot_suggestions' && methods.includes('insert')) return { reply: { data: null, error: { code: 'XX000', message: 'Fixture insert refused' } } };
      if (table === 'reminders' && methods.includes('delete')) return { reply: cleanup };
      return null;
    });
    vi.setSystemTime(new Date(SCAN_AT));
    await expect(runAutopilotScan(client, FAMILY, null, 'UTC', 'en-US', echo, new Date(SCAN_AT))).rejects.toThrow('Autopilot could not save the suggestion');
    expect(console.error).toHaveBeenCalledWith('[autopilot] side-effect cleanup failed', expect.anything());
    // Left behind for good: a reminder linked to a policy no card names.
    expect(db.table('reminders')).toEqual([expect.objectContaining({ title: POLICY, member_id: null, related_type: 'renewal', related_id: 'pol-ava' })]);
    expect(db.table('autopilot_suggestions')).toEqual([]);

    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(POLICY)).toEqual(MANAGERS.sort());
    expect((await noticesAfterTick(db, READ_AT)).get(POLICY)).toEqual(accounts(...MANAGERS));
  });
});

describe("an accepted card's reminder whose link resolves to no card", () => {
  const asManager = (db: Memory): ServiceScope => ({
    db, familyId: FAMILY, userId: account('mum'), memberId: 'mum', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-21T08:00:00Z'),
  } as ServiceScope);
  const DUE_AT = '2026-10-01T10:00:00Z';

  /** Mum accepts the scan's open card for `source`; the reminder it wrote. */
  async function accepted(db: Memory, source: string) {
    vi.setSystemTime(new Date('2026-09-21T06:30:00Z'));
    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));
    const card = db.table('autopilot_suggestions').find((s) => s.source_id === source)!;
    expect(card).toMatchObject({ status: 'open', action_type: 'create_reminder' });
    vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
    expect(await resolveSuggestion(asManager(db), { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' }))
      .toMatchObject({ ok: true, status: 'executed' });
    const reminder = db.table('family_reminders').find((r) => r.idempotency_key && (r.tags as string[]).length > 0)!;
    return { card, reminder };
  }

  /** Who reminders.listDue tells about `title`. */
  async function dueTo(db: Memory, title: string): Promise<string[]> {
    const tool = reminderTools.find((t) => t.name === 'reminders.listDue')!;
    const out: string[] = [];
    for (const m of ROSTER) {
      const scope = { db, familyId: FAMILY, userId: account(m.id), memberId: m.id, role: m.role, actorKind: 'member', tz: 'UTC', now: new Date(DUE_AT) } as ServiceScope;
      const res = await tool.execute(scope, {}) as { ok: true; data: { reminders: { title: string }[] } } | { ok: false; error: string };
      if (!res.ok) throw new Error(`reminders.listDue failed: ${res.error}`);
      if (res.data.reminders.some((r) => r.title === title)) out.push(m.id);
    }
    return out.sort();
  }

  it("one whose card has since been deleted is the managers' alone, listed and told", async () => {
    const db = household();
    db.seed('family_insurance_policies', [{ ...AVAS_DENTAL, renewal_date: '2026-10-01' }]);
    const { card } = await accepted(db, 'pol-ava');
    vi.setSystemTime(new Date(DUE_AT));
    expect(await dueTo(db, POLICY)).toEqual(['ava', 'gran', 'mum']);
    // A legacy link: the card is gone, and nothing else on the row says whose it is.
    db.replace('autopilot_suggestions', db.table('autopilot_suggestions').filter((s) => s.id !== card.id));
    expect(await dueTo(db, POLICY)).toEqual(MANAGERS.sort());
    const notices = await noticesAfterTick(db, '2026-10-01T06:00:00Z');
    expect(notices.get(POLICY)).toEqual(accounts(...MANAGERS));
  });

  // RV-R4-1: the module's next occurrence carries the card's tag and no key,
  // and the tag finds the card (tests/a-cards-reminder-copied-without-its-key-
  // is-read-by-its-stamp.test.ts). A tag no card mints is still unresolved.
  it("a copy that carries the card's tag and no key (the module's next occurrence) is its card's readers'; a tag no card mints is the managers' alone", async () => {
    const db = household();
    db.seed('renewals', [{ ...PASSPORT_ROW, expires_at: '2026-10-04' }]);
    const { reminder } = await accepted(db, 'ren-1');
    db.seed('family_reminders', [
      { ...reminder, id: 'next-occurrence', title: 'Renew Passport (next)', idempotency_key: null },
      { ...reminder, id: 'unminted', title: 'Renew Passport (unminted)', idempotency_key: null, tags: [`autopilot-source:${'b'.repeat(64)}`] },
    ]);
    vi.setSystemTime(new Date(DUE_AT));
    expect(await dueTo(db, PASSPORT)).toEqual(EVERYONE.filter((id) => id !== 'neighbour').sort());
    expect(await dueTo(db, 'Renew Passport (next)')).toEqual(EVERYONE.filter((id) => id !== 'neighbour').sort());
    expect(await dueTo(db, 'Renew Passport (unminted)')).toEqual(MANAGERS.sort());
  });

  it("a card for everyone, found, is everyone's; a person's own tag that only looks like the stamp is no link at all", async () => {
    const db = household();
    db.seed('medications', [{ ...KITS_MEDICINE, refill_on: '2026-09-26', refill_reminder_days: 7 }]);
    await accepted(db, 'med-kit');
    db.seed('family_reminders', [{
      id: 'notes', family_id: FAMILY, title: 'Read the Autopilot notes', remind_at: '2026-10-01T09:00:00.000Z', status: 'active', member_id: null,
      idempotency_key: 'reminders.create:read the autopilot notes', tags: ['autopilot-source:notes'], kind: 'time', priority: 'medium', recurrence: 'none', snoozed_until: null,
    }]);
    vi.setSystemTime(new Date(DUE_AT));
    expect(await dueTo(db, REFILL)).toEqual([...EVERYONE].sort());
    expect(await dueTo(db, 'Read the Autopilot notes')).toEqual([...EVERYONE].sort());
  });
});

// AUD-1031-REMINDER-ORDER, R5. The scan's reminder was classified by the
// NEWEST card for its source, and a source has a card per occurrence. The
// family's dental policy named Ava last year and names Kit now; last year's
// card, naming Ava, is retained. Between this year's reminder's commit and its
// card's — and for good when that card failed to save and the clean-up failed
// or removed nothing — last year's card answered for this year's reminder:
// "Renew dental insurance (Smile Co)" was listed to Ava and told to her, the
// member it is no longer for. The scan now records the reminder's id on its
// card (payload.reminder_id), and the reminder is found by that alone; an
// older card for the source is no answer (lib/autopilot/reminder-cards.ts).
const OLD_AT = '2025-09-28T09:00:00.000Z';
/** The family's dental policy, which now names Kit. */
const FAMILY_DENTAL = { ...AVAS_DENTAL, id: 'pol-family', member_id: 'kit' };

/**
 * A retained card for an earlier occurrence of `source`, auto-executed by the
 * scan then: `recorded` when it was saved with its reminder's id (as the scan
 * saves cards now), not when it was saved before the scan recorded it.
 */
function olderCard(source: string, extra: Record<string, unknown>, recorded: boolean) {
  const payload = { title: extra.title, at: OLD_AT };
  return {
    id: `old-${source}`, family_id: FAMILY, action_type: 'create_reminder', status: 'auto_executed', detail: 'Last occurrence.',
    confidence: 95, urgency: 3, action_label: 'Add renewal reminder', source_id: source, dedupe_key: `old:${source}:2025-09-28`,
    resolved_at: '2025-09-28T06:30:00Z', created_at: '2025-09-28T06:30:00Z', updated_at: '2025-09-28T06:30:00Z',
    ...extra,
    payload: recorded ? { ...payload, reminder_id: `old-rem-${source}` } : payload,
  };
}

/** The earlier occurrence's own reminder, long done. */
function olderReminder(source: string, title: string) {
  return { id: `old-rem-${source}`, family_id: FAMILY, title, remind_at: OLD_AT, member_id: null, is_done: true, related_type: 'renewal', related_id: source };
}

const KINDS = {
  insurance: { kind: 'insurance', source_kind: 'family_insurance_policies', member_id: 'ava', title: POLICY },
  refill: { kind: 'medication', source_kind: 'medications', member_id: 'kit', title: REFILL },
  renewal: { kind: 'document', source_kind: 'renewals', member_id: null, title: PASSPORT },
} as const;

type ScanReminder = { id: string; related_type: string | null; related_id: string | null };

/** Who the real reader (reminderCardsReader + visibleReminders) shows `row` to. */
async function shownTo(db: Memory, row: ScanReminder): Promise<string[]> {
  const out: string[] = [];
  for (const m of ROSTER) {
    const cards = reminderCardsReader(db, FAMILY, { onError: () => { throw new Error('the cards were readable'); } });
    if ((await visibleReminders([row], { role: m.role, memberId: m.id }, cards)).length > 0) out.push(m.id);
  }
  return out.sort();
}

/** This scan's reminder for `source` (not the earlier occurrence's). */
function freshReminder(db: Memory, source: string): ScanReminder {
  const row = db.table('reminders').find((r) => r.related_id === source && r.id !== `old-rem-${source}`);
  if (!row) throw new Error(`no reminder for ${source}`);
  return row as ScanReminder;
}

describe("the scan's reminder, beside an older card for the same source naming another member", () => {
  it.each([
    ['saved with its reminder (as cards are now)', true],
    ['saved before cards recorded their reminder', false],
  ] as const)("last year's card %s: this year's reminder is the managers' alone until its own card is saved; then Kit's, never Ava's", async (_case, recorded) => {
    const db = household();
    db.seed('family_insurance_policies', [FAMILY_DENTAL]);
    db.seed('autopilot_suggestions', [olderCard('pol-family', KINDS.insurance, recorded)]);
    db.seed('reminders', [olderReminder('pol-family', POLICY)]);
    const scan = holdingTheCard(db);
    await scan.held;
    const fresh = freshReminder(db, 'pol-family');
    expect(fresh).toMatchObject({ title: POLICY, member_id: null, related_type: 'renewal', related_id: 'pol-family', is_done: false });
    // Only last year's card is saved: the new occurrence's is held.
    expect(db.table('autopilot_suggestions').map((c) => c.member_id)).toEqual(['ava']);

    // A reminder somebody wrote, and one assigned to Sam, in the same interval.
    db.seed('reminders', [
      { id: 'rem-bins', family_id: FAMILY, title: BINS, remind_at: '2026-09-28T18:00:00Z', member_id: null, is_done: false, related_type: null, related_id: null },
      { id: 'rem-sam', family_id: FAMILY, title: KIT_BAG, remind_at: '2026-09-28T18:00:00Z', member_id: 'sam', is_done: false, related_type: null, related_id: null },
    ]);
    vi.setSystemTime(new Date(READ_AT));
    // Neither Ava, whom last year's card names, nor Kit, whom this year's will.
    expect(await shownTo(db, fresh)).toEqual(MANAGERS.sort());
    expect(await listedTo(POLICY)).toEqual(MANAGERS.sort());
    expect(await calmReminders('ava')).toEqual([BINS, KIT_BAG].sort());
    expect(await calmReminders('kit')).toEqual([BINS, KIT_BAG].sort());
    const during = await noticesAfterTick(db, READ_AT);
    expect(during.get(POLICY)).toEqual(accounts(...MANAGERS));
    expect(during.get(BINS)).toEqual(accounts(...EVERYONE)); // the family: one row per member
    expect(during.get(KIT_BAG)).toEqual([account('sam')]);

    scan.release();
    await scan.scanning;
    const card = db.table('autopilot_suggestions').find((c) => c.dedupe_key === 'insurance:pol-family:2026-09-28');
    // The card records the reminder written for it, beside what it proposed.
    expect(card).toMatchObject({ member_id: 'kit', status: 'auto_executed', payload: { title: POLICY, reminder_id: fresh.id } });
    vi.setSystemTime(new Date(READ_AT));
    expect(await shownTo(db, fresh)).toEqual(['gran', 'kit', 'mum']);
    expect(await listedTo(POLICY)).toEqual(['gran', 'kit', 'mum']);
    const after = await noticesAfterTick(db, READ_AT);
    expect(after.get(POLICY)).toEqual(accounts('gran', 'kit', 'mum'));
    expect(after.get(BINS)).toEqual(accounts(...EVERYONE)); // the family: one row per member
    expect(after.get(KIT_BAG)).toEqual([account('sam')]);
  });

  // The broad cards keep their readers once their own card is saved: a
  // refill's (everyone) and a renewal's (everyone but a guest).
  it.each([
    ['a refill', 'refill', 'med-kit', REFILL, [...EVERYONE].sort(), accounts('gran', 'kit', 'mum')],
    ['a renewal', 'renewal', 'ren-1', PASSPORT, EVERYONE.filter((id) => id !== 'neighbour').sort(), accounts(...EVERYONE.filter((id) => id !== 'neighbour'))],
  ] as const)("%s: the managers' alone until its own card is saved, beside last occurrence's card; then its readers'", async (_case, kind, source, title, readers, told) => {
    const db = household();
    if (kind === 'refill') db.seed('medications', [KITS_MEDICINE]);
    else db.seed('renewals', [PASSPORT_ROW]);
    db.seed('autopilot_suggestions', [olderCard(source, KINDS[kind], true)]);
    db.seed('reminders', [olderReminder(source, title)]);
    const scan = holdingTheCard(db);
    await scan.held;
    const fresh = freshReminder(db, source);
    vi.setSystemTime(new Date(READ_AT));
    expect(await shownTo(db, fresh)).toEqual(MANAGERS.sort());
    expect(await listedTo(title)).toEqual(MANAGERS.sort());
    expect((await noticesAfterTick(db, READ_AT)).get(title)).toEqual(accounts(...MANAGERS));

    scan.release();
    await scan.scanning;
    vi.setSystemTime(new Date(READ_AT));
    expect(await shownTo(db, fresh)).toEqual(readers);
    expect(await listedTo(title)).toEqual(readers);
    expect((await noticesAfterTick(db, READ_AT)).get(title)).toEqual(told);
  });
});

describe("the scan's reminder whose card never saves, beside an older card for the same source naming another member", () => {
  const refused = { data: null, error: { code: 'XX000', message: 'Fixture delete refused' } };
  const nothing = { data: [], error: null };
  it.each([
    ['the clean-up fails', 'saved with its reminder', refused, true],
    ['the clean-up fails', 'saved before cards recorded their reminder', refused, false],
    ['the clean-up removes nothing', 'saved with its reminder', nothing, true],
    ['the clean-up removes nothing', 'saved before cards recorded their reminder', nothing, false],
  ] as const)("is the managers' alone when %s, beside last year's card %s", async (_case, _older, cleanup, recorded) => {
    const db = household();
    db.seed('family_insurance_policies', [FAMILY_DENTAL]);
    db.seed('autopilot_suggestions', [olderCard('pol-family', KINDS.insurance, recorded)]);
    db.seed('reminders', [olderReminder('pol-family', POLICY)]);
    const client = steered(db, (table, methods) => {
      if (table === 'autopilot_suggestions' && methods.includes('insert')) return { reply: { data: null, error: { code: 'XX000', message: 'Fixture insert refused' } } };
      if (table === 'reminders' && methods.includes('delete')) return { reply: cleanup };
      return null;
    });
    vi.setSystemTime(new Date(SCAN_AT));
    await expect(runAutopilotScan(client, FAMILY, null, 'UTC', 'en-US', echo, new Date(SCAN_AT))).rejects.toThrow('Autopilot could not save the suggestion');
    expect(console.error).toHaveBeenCalledWith('[autopilot] side-effect cleanup failed', expect.anything());
    // Left behind for good, beside last year's card naming Ava.
    const fresh = freshReminder(db, 'pol-family');
    expect(fresh).toMatchObject({ title: POLICY, member_id: null, is_done: false });
    expect(db.table('autopilot_suggestions').map((c) => c.id)).toEqual(['old-pol-family']);

    vi.setSystemTime(new Date(READ_AT));
    expect(await shownTo(db, fresh)).toEqual(MANAGERS.sort());
    expect(await listedTo(POLICY)).toEqual(MANAGERS.sort());
    expect((await noticesAfterTick(db, READ_AT)).get(POLICY)).toEqual(accounts(...MANAGERS));
  });
});

// THE CONSERVATIVE LEGACY RULE (lib/autopilot/reminder-cards.ts, step 4). A
// reminder the scan wrote before its cards recorded their reminder carries
// nothing that says which of its source's occurrences it is. Where the
// answer cannot depend on that — every card for the source is of one
// audience, and that audience does not turn on the member a card names — the
// newest card answers, as before. An insurance renewal's audience is its
// policy's member, so such a reminder is the managers' alone; and so is any
// reminder of a source whose cards now record theirs, or whose cards differ.
const LEGACY_AT = '2026-09-28T09:00:00.000Z';
function legacyCard(id: string, source: string, extra: Record<string, unknown>, createdAt = '2026-09-27T06:30:00Z') {
  return {
    id, family_id: FAMILY, action_type: 'create_reminder', status: 'auto_executed', detail: null, confidence: 95, urgency: 3,
    source_id: source, dedupe_key: `legacy:${id}`, created_at: createdAt, updated_at: createdAt, ...extra, payload: { title: extra.title, at: LEGACY_AT },
  };
}
function legacyReminder(id: string, source: string, title: string, member: string | null) {
  return { id, family_id: FAMILY, title, remind_at: LEGACY_AT, member_id: member, is_done: false, related_type: 'renewal', related_id: source };
}

describe('a scan reminder written before cards recorded their reminder', () => {
  it("a refill's is everyone's and its member's to be told, a renewal's everyone's but a guest's, as before; an insurance renewal's is the managers' alone", async () => {
    const db = household();
    db.seed('autopilot_suggestions', [
      legacyCard('c-refill', 'med-kit', KINDS.refill),
      legacyCard('c-passport', 'ren-1', KINDS.renewal),
      // Two of the renewal's occurrences, both before the change: one audience.
      legacyCard('c-passport-2025', 'ren-1', KINDS.renewal, '2025-09-27T06:30:00Z'),
      legacyCard('c-dental', 'pol-ava', KINDS.insurance),
    ]);
    db.seed('reminders', [
      legacyReminder('r-refill', 'med-kit', REFILL, 'kit'),
      legacyReminder('r-passport', 'ren-1', PASSPORT, null),
      legacyReminder('r-dental', 'pol-ava', POLICY, null),
    ]);
    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(REFILL)).toEqual([...EVERYONE].sort());
    expect(await listedTo(PASSPORT)).toEqual(EVERYONE.filter((id) => id !== 'neighbour').sort());
    expect(await listedTo(POLICY)).toEqual(MANAGERS.sort());
    const notices = await noticesAfterTick(db, READ_AT);
    expect(notices.get(REFILL)).toEqual([account('kit')]);
    expect(notices.get(PASSPORT)).toEqual(accounts(...EVERYONE.filter((id) => id !== 'neighbour')));
    expect(notices.get(POLICY)).toEqual(accounts(...MANAGERS));
  });

  it.each([
    ['its source has since had a card that records its reminder', [
      legacyCard('c-old', 'med-kit', KINDS.refill, '2026-08-28T06:30:00Z'),
      { ...legacyCard('c-new', 'med-kit', KINDS.refill), payload: { title: REFILL, at: LEGACY_AT, reminder_id: 'r-next' } },
    ]],
    ["its source's cards are of two audiences", [
      legacyCard('c-everyone', 'med-kit', KINDS.refill),
      legacyCard('c-not-guests', 'med-kit', KINDS.renewal, '2026-08-28T06:30:00Z'),
    ]],
  ] as const)("is the managers' alone when %s", async (_case, cards) => {
    const db = household();
    db.seed('autopilot_suggestions', cards.map((c) => ({ ...c })));
    db.seed('reminders', [legacyReminder('r-refill', 'med-kit', REFILL, 'kit')]);
    vi.setSystemTime(new Date(READ_AT));
    expect(await listedTo(REFILL)).toEqual(MANAGERS.sort());
    expect((await noticesAfterTick(db, READ_AT)).get(REFILL)).toEqual(accounts(...MANAGERS));
  });
});

describe("a card that records a scan reminder answers for it only as that reminder's one card", () => {
  const card = (id: string, source: string, member: string, reminderId: string | null) => ({
    id, family_id: FAMILY, kind: 'insurance', source_kind: 'family_insurance_policies', source_id: source, member_id: member,
    action_type: 'create_reminder', status: 'auto_executed', title: `${id} renews today`, detail: null, urgency: 3, confidence: 95,
    dedupe_key: `k-${id}`, payload: reminderId ? { title: POLICY, at: LEGACY_AT, reminder_id: reminderId } : { title: POLICY, at: LEGACY_AT },
  });
  it.each([
    ['two cards record it', [card('c-ava', 'pol-ava', 'ava', 'r-1'), card('c-kit', 'pol-ava', 'kit', 'r-1')]],
    ['the card that records it names another source', [card('c-elsewhere', 'pol-kit', 'kit', 'r-1'), card('c-ava', 'pol-ava', 'ava', null)]],
  ] as const)("is the managers' alone when %s", async (_case, cards) => {
    const db = household();
    db.seed('autopilot_suggestions', cards.map((c) => ({ ...c })));
    db.seed('reminders', [legacyReminder('r-1', 'pol-ava', POLICY, null)]);
    vi.setSystemTime(new Date(READ_AT));
    expect(await shownTo(db, { id: 'r-1', related_type: 'renewal', related_id: 'pol-ava' })).toEqual(MANAGERS.sort());
    expect(await listedTo(POLICY)).toEqual(MANAGERS.sort());
    expect((await noticesAfterTick(db, READ_AT)).get(POLICY)).toEqual(accounts(...MANAGERS));
  });
});

describe("the scan's record of its reminder is not part of the card's tag", () => {
  // An accepted card's family_reminders row is found by a tag minted from the
  // card's content (lib/services/autopilot suggestionSourceTag). The reminder
  // id the scan now saves on an auto-executed card is bookkeeping, not content:
  // the tag is the one the card's proposal always minted, on the server and in
  // the browser alike.
  it('a card minted with and without `reminder_id` carries one tag, the one its proposal always carried', async () => {
    const proposal = {
      family_id: FAMILY, id: 'card-1', kind: 'insurance', action_type: 'create_reminder', title: 'Dental insurance (Smile Co) renews today',
      detail: 'Review coverage and confirm the renewal before it lapses.', member_id: 'ava', urgency: 3,
      payload: { title: POLICY, at: '2026-09-28T09:00:00.000Z' },
    };
    const recorded = { ...proposal, payload: { ...proposal.payload, reminder_id: 'rem-1' } };
    // The mint as it stood before the scan recorded anything on a card.
    const always = `${AUTOPILOT_SOURCE_TAG}${makeKey([proposal.family_id, proposal.id, proposal.kind, proposal.action_type,
      proposal.title, proposal.detail, proposal.member_id, proposal.urgency, JSON.stringify(proposal.payload)])}`;
    expect(suggestionSourceTag(proposal)).toBe(always);
    expect(suggestionSourceTag(recorded)).toBe(always);
    expect(await mintSuggestionSourceTag(proposal)).toBe(always);
    expect(await mintSuggestionSourceTag(recorded)).toBe(always);
    // The card's proposal still makes the tag: a changed one is another tag.
    expect(suggestionSourceTag({ ...recorded, payload: { ...recorded.payload, at: '2026-09-29T09:00:00.000Z' } })).not.toBe(always);
    // And the card itself is left as it was read.
    expect(recorded.payload).toEqual({ title: POLICY, at: '2026-09-28T09:00:00.000Z', reminder_id: 'rem-1' });
  });
});
