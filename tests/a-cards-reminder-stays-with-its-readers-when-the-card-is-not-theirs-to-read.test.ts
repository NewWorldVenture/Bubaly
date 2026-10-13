import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ReminderLink } from '@/lib/autopilot/reminder-cards';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// RV486-1. lib/autopilot/reminder-cards.ts hides a card's reminder from a
// reader the card is not for by READING the card. 0486 lets a reader read only
// the cards that are theirs, so once it is applied a guest's read of the cards
// holds no renewal card and an unnamed teen's no insurance card. The lookup
// answered a card it could not find as "no card's reminder", and the reminder
// was shown: a guest listed "Renew Passport" and "Renew home insurance
// (Acme)", a teen the home policy's renewal, the very rows the base schema
// hides from them.
//
// Each household below is read through the real reader
// (reminderCardsReader + visibleReminders) over a database that answers
// `autopilot_suggestions` with the rows each schema gives that reader: the base
// schema (0085, every card to every member) and 0486 (the card's audience, the
// rows docs/audit/an-autopilot-card-is-read-by-its-audience-check.sql pins).
// The answer is the same under both.

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));

const { reminderCardsReader, visibleReminders } = await import('@/lib/autopilot/reminder-cards');
const { suggestionReminderKey, suggestionSourceTag } = await import('@/lib/services/autopilot');
const { AUTOPILOT_SOURCE_TAG } = await import('@/lib/reminders/provenance');
const { generateFamilyNotifications } = await import('@/lib/server/notifications');

type DB = SupabaseClient<Database>;
const FAMILY = 'f1';
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' },
  { id: 'sam', role: 'teen' }, { id: 'ava', role: 'child' }, { id: 'neighbour', role: 'guest' },
] as const;
type Reader = (typeof ROSTER)[number]['id'];
const viewer = (id: Reader) => ({ role: ROSTER.find((m) => m.id === id)!.role, memberId: id });

const PASSPORT = 'Renew Passport';
const HOME = 'Renew home insurance (Acme)';
const DENTAL = 'Renew dental insurance (Smile Co)';
const REFILL = 'Refill a prescription';
const BINS = 'Put the bins out';
const CAKE = 'Pick up the cake';
const NOTES = 'Read the school notes';

/**
 * The scan's auto-executed reminder cards, one per source, as lib/autopilot/scan.ts
 * writes them: each records the reminder written for it (`reminder_id`, the
 * `r-<card>` rows of SCAN_REMINDERS below).
 */
const CARDS = [
  { id: 'c-passport', kind: 'document', source_kind: 'renewals', source_id: 'ren-1', member_id: null, title: PASSPORT },
  { id: 'c-home', kind: 'insurance', source_kind: 'family_insurance_policies', source_id: 'pol-home', member_id: null, title: HOME },
  { id: 'c-dental', kind: 'insurance', source_kind: 'family_insurance_policies', source_id: 'pol-ava', member_id: 'ava', title: DENTAL },
  // An everyone card whose reminder is also related_type 'renewal'.
  { id: 'c-refill', kind: 'medication', source_kind: 'medications', source_id: 'med-1', member_id: null, title: REFILL },
].map((c, i) => ({
  ...c, family_id: FAMILY, action_type: 'create_reminder', status: 'auto_executed', detail: null, payload: { reminder_id: `r-${c.id}` },
  dedupe_key: `k-${c.id}`, created_at: `2026-09-2${i}T06:30:00Z`, updated_at: `2026-09-2${i}T06:30:00Z`,
}));
type CardId = (typeof CARDS)[number]['id'];

/** What `select … from autopilot_suggestions` answers each reader under each schema. */
const SCHEMAS: Record<'base' | '0486', Record<Reader, CardId[]>> = {
  base: Object.fromEntries(ROSTER.map((m) => [m.id, CARDS.map((c) => c.id)])) as Record<Reader, CardId[]>,
  '0486': {
    mum: ['c-passport', 'c-home', 'c-dental', 'c-refill'],
    gran: ['c-passport', 'c-home', 'c-dental', 'c-refill'],
    sam: ['c-passport', 'c-refill'],
    ava: ['c-passport', 'c-dental', 'c-refill'],
    neighbour: ['c-refill'],
  },
};

/** Who is shown which card reminder, whichever schema answers: the card's rule (lib/autopilot/audience.ts). */
const EXPECTED: Record<Reader, string[]> = {
  mum: [PASSPORT, HOME, DENTAL, REFILL],
  gran: [PASSPORT, HOME, DENTAL, REFILL],
  sam: [PASSPORT, REFILL],
  ava: [PASSPORT, DENTAL, REFILL],
  neighbour: [REFILL],
};
const READERS = ROSTER.map((m) => m.id);
const CASES = (['base', '0486'] as const).flatMap((schema) => READERS.map((reader) => [schema, reader] as const));

/** The database as `reader`'s session sees it under `schema`. */
function seen(schema: 'base' | '0486', reader: Reader) {
  const db = createInMemorySupabase<DB>({});
  db.seed('autopilot_suggestions', CARDS.filter((c) => SCHEMAS[schema][reader].includes(c.id)));
  return db as unknown as DB;
}

/** The scan's `reminders` rows (related_type 'renewal', related_id the source), and two nobody's card made. */
const SCAN_REMINDERS = [
  ...CARDS.map((c) => ({ id: `r-${c.id}`, title: c.title, member_id: null, related_type: 'renewal', related_id: c.source_id })),
  { id: 'r-bins', title: BINS, member_id: null, related_type: null, related_id: null },
  { id: 'r-cake', title: CAKE, member_id: null, related_type: 'calendar_event', related_id: 'ev-1' },
];

/** A manager's "Add reminder" on each card (`family_reminders`, the card's key and stamp), and two reminders somebody typed. */
const ACCEPTED_REMINDERS = [
  ...CARDS.map((c) => ({
    id: `fr-${c.id}`, title: c.title, member_id: null,
    idempotency_key: suggestionReminderKey(FAMILY, c.id), tags: [`${AUTOPILOT_SOURCE_TAG}${'a'.repeat(64)}`],
  })),
  { id: 'fr-bins', title: BINS, member_id: null, idempotency_key: 'typed-1', tags: [] },
  // A tag somebody typed that starts with the stamp's prefix is not a stamp.
  { id: 'fr-notes', title: NOTES, member_id: null, idempotency_key: 'typed-2', tags: ['autopilot-source:notes'] },
];

const sorted = (titles: string[]) => [...titles].sort();
const onError = () => { throw new Error('the cards were readable'); };
/** How an accepted card's key and tag are minted (lib/autopilot/reminder-cards.ts takes both or neither). */
const MINTS = { keyOf: (id: string) => suggestionReminderKey(FAMILY, id), sourceTagOf: suggestionSourceTag };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the scan's reminder of a card is shown only to the card's readers, under the base schema and under 0486", () => {
  it.each(CASES)('%s: %s', async (schema, reader) => {
    const db = seen(schema, reader);
    for (const mints of [{}, MINTS]) {
      const shown = await visibleReminders(SCAN_REMINDERS, viewer(reader), reminderCardsReader(db, FAMILY, { ...mints, onError }));
      expect(sorted(shown.map((r) => r.title)), `mints ${'keyOf' in mints ? 'given' : 'absent'}`).toEqual(sorted([...EXPECTED[reader], BINS, CAKE]));
    }
  });
});

describe("an accepted card's reminder is shown only to the card's readers, under the base schema and under 0486", () => {
  it.each(CASES)('%s: %s', async (schema, reader) => {
    const cards = reminderCardsReader(seen(schema, reader), FAMILY, { ...MINTS, onError });
    const shown = await visibleReminders(ACCEPTED_REMINDERS, viewer(reader), cards);
    expect(sorted(shown.map((r) => r.title))).toEqual(sorted([...EXPECTED[reader], BINS, NOTES]));
  });
});

describe('under 0486 the guest and the teen the policy does not name read no card that is not theirs, and are shown no reminder of one', () => {
  it('the rows RLS answers them hold no renewal card for the guest and no insurance card for the teen', async () => {
    const guestCards = await reminderCardsReader(seen('0486', 'neighbour'), FAMILY, { ...MINTS, onError })();
    const teenCards = await reminderCardsReader(seen('0486', 'sam'), FAMILY, { ...MINTS, onError })();
    expect([...guestCards!.bySource.keys()]).toEqual(['med-1']);
    expect([...teenCards!.bySource.keys()].sort()).toEqual(['med-1', 'ren-1']);
  });

  it.each([['neighbour', [PASSPORT, HOME, DENTAL]], ['sam', [HOME, DENTAL]]] as const)('%s', async (reader, hidden) => {
    for (const rows of [SCAN_REMINDERS, ACCEPTED_REMINDERS] as (ReminderLink & { title: string })[][]) {
      const shown = (await visibleReminders(rows, viewer(reader), reminderCardsReader(seen('0486', reader), FAMILY, { ...MINTS, onError }))).map((r) => r.title);
      for (const title of hidden) expect(shown, title).not.toContain(title);
      expect(shown).toContain(REFILL);
    }
  });
});

describe('a reminder that looks like a card\'s whose card was never written is the managers\'', () => {
  const ORPHANS = [
    { id: 'r-orphan', title: 'Renew Gym pass', member_id: null, related_type: 'renewal', related_id: 'ren-gone' },
    { id: 'fr-orphan', title: 'Renew Library card', member_id: null, idempotency_key: suggestionReminderKey(FAMILY, 'c-gone'), tags: [`${AUTOPILOT_SOURCE_TAG}${'b'.repeat(64)}`] },
  ];

  it.each(CASES)('%s: %s', async (schema, reader) => {
    const cards = reminderCardsReader(seen(schema, reader), FAMILY, { ...MINTS, onError });
    const shown = await visibleReminders(ORPHANS, viewer(reader), cards);
    expect(shown.map((r) => r.title)).toEqual(['mum', 'gran'].includes(reader) ? ORPHANS.map((r) => r.title) : []);
  });

  it('and is told to the managers alone by the notifications generator', async () => {
    const db = createInMemorySupabase<DB>({});
    db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
    db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null })));
    db.seed('autopilot_suggestions', CARDS);
    db.seed('reminders', [
      { id: 'r-orphan', family_id: FAMILY, title: 'Renew Gym pass', remind_at: '2026-10-01T18:00:00Z', member_id: null, is_done: false, related_type: 'renewal', related_id: 'ren-gone' },
      { id: 'r-c-refill', family_id: FAMILY, title: REFILL, remind_at: '2026-10-01T18:00:00Z', member_id: null, is_done: false, related_type: 'renewal', related_id: 'med-1' },
      { id: 'r-bins', family_id: FAMILY, title: BINS, remind_at: '2026-10-01T18:00:00Z', member_id: null, is_done: false, related_type: null, related_id: null },
    ]);
    vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
    await generateFamilyNotifications(db as unknown as DB, FAMILY);
    const told = (title: string) => db.table('notifications')
      .filter((n) => n.related_type === 'reminders' && n.title === `Reminder: ${title}`)
      .map((n) => (n.user_id as string | null) ?? null).sort((a, b) => String(a).localeCompare(String(b)));
    expect(told('Renew Gym pass')).toEqual(['u-gran', 'u-mum']);
    // An everyone card's reminder, and one nobody's card made, are told as before: to the family —
    // one row per member with a login, so each member's read state is their own.
    const family = READERS.map((id) => `u-${id}`).sort();
    expect(told(REFILL)).toEqual(family);
    expect(told(BINS)).toEqual(family);
  });
});
