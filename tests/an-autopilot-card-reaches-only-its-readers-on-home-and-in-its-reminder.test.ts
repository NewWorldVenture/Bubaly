import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// F1/F4 follow-up. lib/autopilot/audience.ts says who an Autopilot card is for:
// a renewal is not a guest's, an insurance renewal is the managers' and the
// member the policy names. Two readers of the card still ignored it.
//
//   Home          "Completed by Bubaly" listed every auto-executed card's title
//                 to every role — a guest was shown "Smile Co dental insurance
//                 renews in 3 days" and "Passport expires in 3 days".
//   its reminder  the scan's auto-created reminder, and a manager's "Add
//                 reminder", were addressed by the reminder's member: none for a
//                 renewal, so "Reminder: Renew Passport" went to the whole
//                 family, guest included; the child the policy names for an
//                 insurance renewal, so only the child heard, and the parents
//                 who renew it did not.
//
// Driven through the real scan, resolution service, Home loader and
// notifications generator, against the in-memory database.

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
// The scan's own "Autopilot handled" push is not what is under test here (see
// autopilot-money-and-policy-cards-reach-only-their-readers.test.ts).
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async () => ({ ok: true, data: { created: 1 } })),
}));
const { runAutopilotScan } = await import('@/lib/autopilot/scan');
const { resolveSuggestion } = await import('@/lib/services/autopilot');
const { loadCompletedByBubaly } = await import('@/lib/home/completed');
const { generateFamilyNotifications } = await import('@/lib/server/notifications');

type DB = SupabaseClient<Database>;
type Memory = ReturnType<typeof createInMemorySupabase<DB>>;
const FAMILY = 'f1';
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'sitter', role: 'caregiver' },
  { id: 'sam', role: 'teen' }, { id: 'ava', role: 'child' }, { id: 'kit', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const account = (memberId: string) => `u-${memberId}`;
const accounts = (...ids: string[]) => ids.map(account).sort();

function household(): Memory {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']], family_reminders: [['family_id', 'idempotency_key']] },
    // The column defaults the scan's reminder insert relies on (0002).
    defaults: { reminders: { is_done: false, notes: null, recurrence: 'none' } },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: account(m.id), display_name: m.id, is_active: true, birthday: null })));
  return db;
}

const AVAS_DENTAL = { id: 'pol-ava', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-10-01', member_id: 'ava', is_active: true };
const HOME_POLICY = { id: 'pol-home', family_id: FAMILY, policy_type: 'home', insurer: 'Acme', renewal_date: '2026-10-01', member_id: null, is_active: true };
const PASSPORT = { id: 'ren-1', family_id: FAMILY, title: 'Passport', expires_at: '2026-10-01', status: 'active' };

/** Run the scan at `at` (06:30 UTC, the cron's hour), with the clock there too. */
async function scan(db: Memory, at: string) {
  vi.setSystemTime(new Date(at));
  await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, new Date(at));
}

/** Run the notifications generator at `at`; the accounts each reminder notice went to. */
async function remindersSentAt(db: Memory | DB, rows: () => Record<string, unknown>[], at: string) {
  vi.setSystemTime(new Date(at));
  await generateFamilyNotifications(db as DB, FAMILY);
  const out = new Map<string, (string | null)[]>();
  for (const n of rows().filter((n) => n.related_type === 'reminders' || n.related_type === 'family_reminders')) {
    const title = String(n.title);
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

describe('Home lists an auto-executed card only to its readers', () => {
  async function titlesFor(db: Memory, viewer: { role: string; memberId: string }) {
    const res = await loadCompletedByBubaly(db, FAMILY, { now: new Date('2026-09-28T12:00:00Z'), viewer });
    if (!res.ok) throw new Error(`the Home ledger did not load: ${res.error}`);
    return res.data.map((item) => item.title).join(' | ');
  }

  it('a guest is not listed the renewal or the insurance card the scan handled; a parent is listed both', async () => {
    const db = household();
    db.seed('renewals', [PASSPORT]);
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    // Three days out: confidence 95, at or over AUTO_THRESHOLD, so the scan
    // executes both cards itself and they land in "Completed by Bubaly".
    await scan(db, '2026-09-28T06:30:00Z');
    expect(db.table('autopilot_suggestions').filter((s) => s.status === 'auto_executed').map((s) => s.source_id).sort()).toEqual(['pol-ava', 'ren-1']);

    const guest = await titlesFor(db, { role: 'guest', memberId: 'neighbour' });
    expect(guest).not.toContain('Passport');
    expect(guest).not.toContain('Smile Co');

    const parent = await titlesFor(db, { role: 'parent', memberId: 'mum' });
    expect(parent).toContain('Passport');
    expect(parent).toContain('Smile Co');
  });

  it('the child a policy names is listed its card; another child is not, and still sees the renewal', async () => {
    const db = household();
    db.seed('renewals', [PASSPORT]);
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    await scan(db, '2026-09-28T06:30:00Z');

    const ava = await titlesFor(db, { role: 'child', memberId: 'ava' });
    expect(ava).toContain('Smile Co');
    expect(ava).toContain('Passport');
    const kit = await titlesFor(db, { role: 'child', memberId: 'kit' });
    expect(kit).not.toContain('Smile Co');
    expect(kit).toContain('Passport');
  });

  it('a guest still gets the newest cards that ARE theirs when hidden ones crowd the newest page', async () => {
    const db = household();
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
    const card = (n: number, extra: Record<string, unknown>) => ({
      id: `s-${n}`, family_id: FAMILY, status: 'auto_executed', created_at: `2026-09-28T0${n}:00:00.000Z`, dedupe_key: `k-${n}`, ...extra,
    });
    db.seed('autopilot_suggestions', [
      card(1, { title: 'Snacks for the match added', kind: 'moment', source_kind: 'calendar_events', member_id: null }),
      card(2, { title: 'Snacks for the picnic added', kind: 'moment', source_kind: 'calendar_events', member_id: null }),
      ...[3, 4, 5, 6, 7, 8].map((n) => card(n, { title: `Policy ${n} renews soon`, kind: 'insurance', source_kind: 'family_insurance_policies', member_id: 'ava' })),
    ]);
    const guest = await titlesFor(db, { role: 'guest', memberId: 'neighbour' });
    expect(guest).toBe('Snacks for the picnic added | Snacks for the match added');
    const parent = await titlesFor(db, { role: 'parent', memberId: 'mum' });
    expect(parent.split(' | ')).toHaveLength(6);
    expect(parent).not.toContain('Snacks');
  });
});

describe("the scan's own reminder is told to the card's readers", () => {
  it('"Renew Passport" goes to everyone but the guest, never to the whole family', async () => {
    const db = household();
    db.seed('renewals', [PASSPORT]);
    await scan(db, '2026-09-28T06:30:00Z');
    expect(db.table('reminders')).toEqual([expect.objectContaining({ title: 'Renew Passport', member_id: null, related_type: 'renewal', related_id: 'ren-1' })]);

    const sent = await remindersSentAt(db, () => db.table('notifications'), '2026-09-28T07:00:00Z');
    expect(sent.get('Reminder: Renew Passport')).toEqual(accounts('ava', 'gran', 'kit', 'mum', 'sam', 'sitter'));
  });

  it('an insurance renewal naming a child goes to the managers and that child, not to a guest or another child', async () => {
    const db = household();
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    await scan(db, '2026-09-28T06:30:00Z');
    // The card is still Ava's to read (F1/F4); the reminder is nobody's errand
    // but the managers', so it is not assigned to her.
    expect(db.table('autopilot_suggestions').find((s) => s.source_id === 'pol-ava')).toMatchObject({ status: 'auto_executed', member_id: 'ava' });
    expect(db.table('reminders')).toEqual([expect.objectContaining({ title: 'Renew dental insurance (Smile Co)', member_id: null, related_id: 'pol-ava' })]);

    const sent = await remindersSentAt(db, () => db.table('notifications'), '2026-10-01T06:00:00Z');
    const readers = sent.get('Reminder: Renew dental insurance (Smile Co)');
    expect(readers).toEqual(accounts('ava', 'gran', 'mum'));
    expect(readers).not.toContain(account('neighbour'));
    expect(readers).not.toContain(account('kit'));
    expect(readers).not.toContain(null);
  });

  it('a policy that names no one is reminded to the managers alone', async () => {
    const db = household();
    db.seed('family_insurance_policies', [HOME_POLICY]);
    await scan(db, '2026-09-28T06:30:00Z');
    const sent = await remindersSentAt(db, () => db.table('notifications'), '2026-10-01T06:00:00Z');
    expect(sent.get('Reminder: Renew home insurance (Acme)')).toEqual(accounts('gran', 'mum'));
  });

  it('a reminder no narrower card made is addressed as before: its member, or the family', async () => {
    const db = household();
    vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
    db.seed('reminders', [
      { id: 'rem-family', family_id: FAMILY, title: 'Put the bins out', remind_at: '2026-10-01T18:00:00Z', member_id: null, is_done: false, related_type: null, related_id: null },
      { id: 'rem-sam', family_id: FAMILY, title: 'Pack the kit bag', remind_at: '2026-10-01T18:00:00Z', member_id: 'sam', is_done: false, related_type: null, related_id: null },
    ]);
    const sent = await remindersSentAt(db, () => db.table('notifications'), '2026-10-01T06:00:00Z');
    expect(sent.get('Reminder: Put the bins out')).toEqual([null]);
    expect(sent.get('Reminder: Pack the kit bag')).toEqual([account('sam')]);
  });

  it('a failed read of the cards never widens the audience: the managers are told, no one else', async () => {
    const db = household();
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    await scan(db, '2026-09-28T06:30:00Z');
    const faulty = withFaults(db, (table, calls) => (table === 'autopilot_suggestions' && calls.some((c) => c.method === 'select') ? { message: 'Fixture read refused' } : null));
    const sent = await remindersSentAt(faulty as unknown as DB, () => db.table('notifications'), '2026-10-01T06:00:00Z');
    expect(sent.get('Reminder: Renew dental insurance (Smile Co)')).toEqual(accounts('gran', 'mum'));
    expect(console.error).toHaveBeenCalledWith('[notifications] generation source read failed', expect.objectContaining({ table: 'autopilot_suggestions' }));
  });
});

describe("a manager's \"Add reminder\" on a card is told to the card's readers", () => {
  const asManager = (db: Memory): ServiceScope => ({
    db, familyId: FAMILY, userId: account('mum'), memberId: 'mum', role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-21T08:00:00Z'),
  } as ServiceScope);

  it('the manager who added it, the other manager and the child the policy names are reminded; a guest and another child are not', async () => {
    const db = household();
    db.seed('family_insurance_policies', [AVAS_DENTAL]);
    // Ten days out: confidence 82, a card for a person to accept.
    await scan(db, '2026-09-21T06:30:00Z');
    const card = db.table('autopilot_suggestions').find((s) => s.source_id === 'pol-ava')!;
    expect(card).toMatchObject({ status: 'open', member_id: 'ava' });

    vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
    const accepted = await resolveSuggestion(asManager(db), { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' });
    expect(accepted).toMatchObject({ ok: true, status: 'executed' });
    expect(db.table('family_reminders')).toEqual([expect.objectContaining({ title: 'Renew dental insurance (Smile Co)', member_id: null })]);

    const sent = await remindersSentAt(db, () => db.table('notifications'), '2026-10-01T06:00:00Z');
    const readers = sent.get('Reminder: Renew dental insurance (Smile Co)');
    expect(readers).toEqual(accounts('ava', 'gran', 'mum'));
    expect(readers).not.toContain(account('neighbour'));
    expect(readers).not.toContain(account('kit'));
    expect(readers).not.toContain(null);
  });

  it('a renewal card a manager accepted is not told to the guest', async () => {
    const db = household();
    db.seed('renewals', [{ ...PASSPORT, expires_at: '2026-10-15' }]);
    // Twenty-four days out: an open card.
    await scan(db, '2026-09-21T06:30:00Z');
    const card = db.table('autopilot_suggestions').find((s) => s.source_id === 'ren-1')!;
    expect(card.status).toBe('open');

    vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
    expect(await resolveSuggestion(asManager(db), { suggestionId: card.id as string, updatedAt: card.updated_at as string, action: 'reminder' })).toMatchObject({ ok: true });
    // Three days before the lapse, at nine.
    const sent = await remindersSentAt(db, () => db.table('notifications'), '2026-10-12T06:00:00Z');
    expect(sent.get('Reminder: Renew Passport')).toEqual(accounts('ava', 'gran', 'kit', 'mum', 'sam', 'sitter'));
  });
});
