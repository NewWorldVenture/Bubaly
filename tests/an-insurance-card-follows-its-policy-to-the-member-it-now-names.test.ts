import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type FaultCall, type Row } from './helpers/in-memory-supabase';

// TASK-29 / 0486 — an insurance card's member_id is who may read it besides
// the managers (lib/autopilot/audience.ts; 0486 in RLS). The scan copies it
// from family_insurance_policies.member_id when it writes the card, and then
// leaves the card alone for good under its key. So a policy reassigned to
// another member, or a card written before the scan stored the member at all,
// kept naming the old one: the member the policy now names could not read the
// card, and their own scan drafted it, could not see the prior row, inserted,
// met 23505 and carried on, every time they opened Autopilot.
//
// The scan now refreshes a prior insurance card's member_id, and nothing else,
// on the nightly scan and on a manager's own scan; never on a scan by a member
// who may not read both the old card and the new one. Driven through the real
// runAutopilotScan over the in-memory database (no RLS: what is asserted is
// what the scan asks to write).

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async () => ({ ok: true, data: { created: 1 } })),
}));
const { runAutopilotScan } = await import('@/lib/autopilot/scan');

type DB = SupabaseClient<Database>;
const FAMILY = 'f1';
const AT = new Date('2026-09-21T06:30:00Z');
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;
const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'sam', role: 'teen' },
  { id: 'ava', role: 'child' }, { id: 'leo', role: 'child' }, { id: 'neighbour', role: 'guest' },
];
const viewerOf = (id: string) => ({ role: ROSTER.find((m) => m.id === id)?.role, memberId: id });

afterEach(() => { vi.restoreAllMocks(); });

/** The card the scan wrote for a policy renewing 2026-10-11, as it stands. */
function insuranceCard(policyId: string, memberId: string | null, extra: Row = {}): Row {
  return {
    id: `card-${policyId}`, family_id: FAMILY, member_id: memberId, kind: 'insurance',
    title: 'dental insurance (Smile Co) renews in 20 days', detail: 'Review coverage and confirm the renewal before it lapses.',
    confidence: 72, urgency: 1, status: 'open', action_type: 'create_reminder', action_label: 'Add renewal reminder',
    payload: { title: 'Renew dental insurance (Smile Co)', at: '2026-10-11T09:00:00.000Z' },
    source_kind: 'family_insurance_policies', source_id: policyId, dedupe_key: `insurance:${policyId}:2026-10-11`,
    expires_at: '2026-10-11T23:59:59.999Z', resolved_at: null, resolved_by: null, created_by: null,
    created_at: '2026-09-15T06:30:00.000Z', updated_at: '2026-09-15T06:30:00.000Z',
    ...extra,
  };
}

function household(policyMember: string | null, cardMember: string | null, cardExtra: Row = {}) {
  const db = createInMemorySupabase<DB>({
    uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] },
    rpc: { ensure_default_grocery_list: () => 'list-1' },
  });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true, birthday: null })));
  db.seed('family_insurance_policies', [
    { id: 'pol-dental', family_id: FAMILY, policy_type: 'dental', insurer: 'Smile Co', renewal_date: '2026-10-11', member_id: policyMember, is_active: true },
  ]);
  db.seed('autopilot_suggestions', [insuranceCard('pol-dental', cardMember, cardExtra)]);
  return db;
}

const card = (db: ReturnType<typeof household>, id = 'card-pol-dental') =>
  db.table('autopilot_suggestions').find((s) => s.id === id) as Row;

/** The same database, recording every write the scan asks for. */
function recording(db: ReturnType<typeof household>, fail?: (calls: FaultCall[]) => boolean) {
  const memberWrites: FaultCall[][] = [];
  const client = withFaults(db, (table, calls) => {
    const update = calls.find((c) => c.method === 'update');
    if (table === 'autopilot_suggestions' && update && 'member_id' in (update.args[0] as Row)) {
      memberWrites.push([...calls]);
      if (fail?.(calls)) return { code: '42501', message: 'new row violates row-level security policy' };
    }
    return null;
  });
  return { client, memberWrites };
}

describe('an insurance card follows its policy to the member it now names', () => {
  it('the nightly scan moves a reassigned policy\'s card to its new member, by id and family, confirmed, and writes nothing else', async () => {
    const db = household('leo', 'ava');
    // A second policy whose card already names its member, and an appointment
    // card whose appointment changed hands: neither is the refresh's to write.
    db.seed('family_insurance_policies', [
      { id: 'pol-home', family_id: FAMILY, policy_type: 'home', insurer: 'Acme', renewal_date: '2026-10-11', member_id: 'mum', is_active: true },
    ]);
    db.seed('autopilot_suggestions', [insuranceCard('pol-home', 'mum')]);
    db.seed('appointments', [{ id: 'appt-1', family_id: FAMILY, title: 'Orthodontist', starts_at: '2026-09-22T16:00:00Z', member_id: 'sam' }]);
    db.seed('autopilot_suggestions', [{
      id: 'card-appt', family_id: FAMILY, member_id: 'ava', kind: 'appointment', title: 'Orthodontist is tomorrow', status: 'open',
      source_kind: 'appointments', source_id: 'appt-1', dedupe_key: 'appt:appt-1:2026-09-22', urgency: 2, confidence: 86,
      action_type: 'create_reminder', payload: {},
    }]);
    const before = structuredClone(card(db));
    const untouched = structuredClone([card(db, 'card-pol-home'), card(db, 'card-appt')]);
    const { client, memberWrites } = recording(db);

    await runAutopilotScan(client, FAMILY, null, 'UTC', 'en-US', echo, AT);

    expect(card(db)).toEqual({ ...before, member_id: 'leo' });
    expect([card(db, 'card-pol-home'), card(db, 'card-appt')]).toEqual(untouched);
    expect(db.table('autopilot_suggestions').filter((s) => s.source_id === 'pol-dental')).toHaveLength(1);
    expect(memberWrites).toHaveLength(1);
    expect(memberWrites[0]).toEqual([
      { method: 'update', args: [{ member_id: 'leo' }] },
      { method: 'eq', args: ['id', 'card-pol-dental'] },
      { method: 'eq', args: ['family_id', FAMILY] },
      // Only while the card still names the member this scan read on it.
      { method: 'eq', args: ['member_id', 'ava'] },
      { method: 'select', args: ['id'] },
    ]);
  });

  it('the nightly scan names the member on a card written before the scan stored one', async () => {
    const db = household('ava', null);
    const before = structuredClone(card(db));

    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, AT);

    expect(card(db)).toEqual({ ...before, member_id: 'ava' });
  });

  it('a manager\'s own scan moves it, and a resolved card keeps its status, its resolution and every other column', async () => {
    const db = household('leo', 'ava', { status: 'dismissed', resolved_at: '2026-09-18T19:00:00.000Z', resolved_by: 'u-gran' });
    const before = structuredClone(card(db));

    await runAutopilotScan(db, FAMILY, 'u-gran', 'UTC', 'en-US', echo, AT, viewerOf('gran'));

    expect(card(db)).toEqual({ ...before, member_id: 'leo' });
    expect(card(db).status).toBe('dismissed');
  });

  // 0327's resolver guard keeps resolved_by the resolver's: a manager's write
  // to a card somebody else resolved is refused in RLS, so the scan does not
  // ask for it, and the nightly scan (the service role) moves it (RV0486R2-1).
  it('a manager\'s own scan leaves a card another member resolved for the nightly scan', async () => {
    const db = household('leo', 'ava', { status: 'dismissed', resolved_at: '2026-09-18T19:00:00.000Z', resolved_by: 'u-mum' });
    const before = structuredClone(card(db));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, memberWrites } = recording(db);

    await runAutopilotScan(client, FAMILY, 'u-gran', 'UTC', 'en-US', echo, AT, viewerOf('gran'));
    expect(memberWrites).toEqual([]);
    expect(card(db)).toEqual(before);
    expect(logged).not.toHaveBeenCalledWith('[autopilot] insurance card member refresh failed', expect.anything());

    await runAutopilotScan(client, FAMILY, null, 'UTC', 'en-US', echo, AT);
    expect(memberWrites).toHaveLength(1);
    expect(card(db)).toEqual({ ...before, member_id: 'leo' });
  });

  it('a teen\'s own scan does not write it, nor the scan of the member it named or of the member it now names, nor a guest\'s; it waits for one that may', async () => {
    const db = household('leo', 'ava');
    const before = structuredClone(card(db));
    const { client, memberWrites } = recording(db);

    for (const member of ['sam', 'ava', 'leo', 'neighbour']) {
      await runAutopilotScan(client, FAMILY, `u-${member}`, 'UTC', 'en-US', echo, AT, viewerOf(member));
    }
    expect(memberWrites).toEqual([]);
    expect(card(db)).toEqual(before);
    expect(db.table('autopilot_suggestions').filter((s) => s.source_id === 'pol-dental')).toHaveLength(1);

    await runAutopilotScan(client, FAMILY, null, 'UTC', 'en-US', echo, AT);
    expect(memberWrites).toHaveLength(1);
    expect(card(db)).toEqual({ ...before, member_id: 'leo' });
  });

  it('a failed refresh is logged and the scan carries on', async () => {
    const db = household('leo', 'ava');
    db.seed('subscriptions_tracked', [{ id: 'sub-1', family_id: FAMILY, name: 'Netflix', cost_cents: 1599, cadence: 'monthly', next_charge: '2026-09-22', last_used: null, status: 'active' }]);
    const before = structuredClone(card(db));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, memberWrites } = recording(db, () => true);

    await expect(runAutopilotScan(client, FAMILY, null, 'UTC', 'en-US', echo, AT)).resolves.toMatchObject({ scanned: expect.any(Number) });

    expect(memberWrites).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith('[autopilot] insurance card member refresh failed', expect.objectContaining({ code: '42501' }));
    expect(card(db)).toEqual(before);
    // The rest of the scan still ran: the subscription charge is written.
    expect(db.table('autopilot_suggestions').some((s) => s.source_id === 'sub-1')).toBe(true);
  });
});

// AUD-1031-REFRESH-CONSISTENCY. Two scans can overlap, each with its own read
// of the policy, and an accepted card's reminders carry a tag minted from the
// card's columns, member_id among them.
describe('the refresh neither puts back an older member nor strands an accepted card\'s reminders', () => {
  /** `db`, holding the first member refresh until `release` is called. */
  function holdingFirstRefresh(db: ReturnType<typeof household>) {
    let held = false;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atWrite = new Promise<void>((resolve) => { reached = resolve; });
    const client = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'from') return Reflect.get(target, property, receiver);
        return (table: string) => {
          const builder = target.from(table);
          let refresh = false;
          const proxy: object = new Proxy(builder, {
            get(object, key) {
              if (key === 'then') {
                return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
                  if (!refresh || held) return object.then(resolve as never, reject);
                  held = true;
                  reached();
                  return gate.then(() => object.then(resolve as never, reject));
                };
              }
              const value = Reflect.get(object, key);
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                if (table === 'autopilot_suggestions' && key === 'update' && 'member_id' in (args[0] as Row)) refresh = true;
                const result = Reflect.apply(value, object, args);
                return result === object ? proxy : result;
              };
            },
          });
          return proxy;
        };
      },
    });
    return { client: client as typeof db, release, atWrite };
  }

  it('a scan that read the policy before it was reassigned again does not put its member back over a newer scan\'s', async () => {
    // The card names Ava; the policy names Leo when the first scan reads it.
    const db = household('leo', 'ava');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = holdingFirstRefresh(db);
    const older = runAutopilotScan(first.client, FAMILY, null, 'UTC', 'en-US', echo, AT);
    await first.atWrite;

    // Meanwhile the policy is reassigned to Sam and a second scan follows it.
    await db.from('family_insurance_policies').update({ member_id: 'sam' }).eq('id', 'pol-dental').select('id');
    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, AT);
    expect(card(db).member_id).toBe('sam');

    first.release();
    await older;
    expect(card(db).member_id).toBe('sam');
    expect(logged).not.toHaveBeenCalledWith('[autopilot] insurance card member refresh failed', expect.anything());

    // The next scan reconciles the card with the policy as it then stands.
    await db.from('family_insurance_policies').update({ member_id: 'leo' }).eq('id', 'pol-dental').select('id');
    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, AT);
    expect(card(db).member_id).toBe('leo');
  });

  it('an accepted card keeps the member it was accepted under, so its reminder and the reminder\'s next occurrence answer alike', async () => {
    const { suggestionReminderKey, suggestionSourceTag } = await import('@/lib/services/autopilot');
    const { reminderCardsReader, visibleReminders } = await import('@/lib/autopilot/reminder-cards');
    const { generateFamilyNotifications } = await import('@/lib/server/notifications');
    const db = household('leo', 'ava', { status: 'executed', resolved_at: '2026-09-16T08:00:00.000Z', resolved_by: 'u-mum' });
    const accepted = structuredClone(card(db));
    const tag = suggestionSourceTag(accepted as never);
    const due = { family_id: FAMILY, member_id: null, status: 'active', remind_at: '2026-09-21T09:00:00.000Z', early_reminder_minutes: 0, snoozed_until: null, priority: 'medium' };
    db.seed('family_reminders', [
      // The reminder accepting the card wrote, under the card's key and tag...
      { ...due, id: 'fr-original', title: 'Renew dental (accepted)', recurrence: 'yearly', idempotency_key: suggestionReminderKey(FAMILY, accepted.id as string), tags: [tag] },
      // ...its next occurrence, which carries the tag alone...
      { ...due, id: 'fr-next', title: 'Renew dental (next year)', recurrence: 'yearly', idempotency_key: null, tags: [tag] },
      // ...and one somebody typed.
      { ...due, id: 'fr-typed', title: 'Call the dentist', recurrence: 'none', idempotency_key: null, tags: [] },
    ]);

    await runAutopilotScan(db, FAMILY, null, 'UTC', 'en-US', echo, AT);
    expect(card(db)).toEqual(accepted);

    const rows = db.table('family_reminders') as unknown as { id: string; title: string; idempotency_key: string | null; tags: string[] }[];
    const shown = async (member: string) => (await visibleReminders(rows, viewerOf(member), reminderCardsReader(db, FAMILY, {
      keyOf: (id) => suggestionReminderKey(FAMILY, id), sourceTagOf: suggestionSourceTag, onError: () => { throw new Error('the cards were readable'); },
    }))).map((r) => r.id).sort();
    expect(await shown('mum')).toEqual(['fr-next', 'fr-original', 'fr-typed']);
    expect(await shown('ava')).toEqual(['fr-next', 'fr-original', 'fr-typed']);
    expect(await shown('leo')).toEqual(['fr-typed']);
    expect(await shown('sam')).toEqual(['fr-typed']);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-21T08:30:00Z'));
      await generateFamilyNotifications(db, FAMILY);
    } finally {
      vi.useRealTimers();
    }
    const told = (title: string) => db.table('notifications')
      .filter((n) => n.related_type === 'family_reminders' && n.title === `Reminder: ${title}`)
      .map((n) => (n.user_id as string | null) ?? null).sort((a, b) => String(a).localeCompare(String(b)));
    expect(told('Renew dental (accepted)')).toEqual(told('Renew dental (next year)'));
    expect(told('Renew dental (accepted)')).toContain('u-ava');
    expect(told('Renew dental (accepted)')).not.toContain('u-leo');
    expect(told('Call the dentist')).toEqual([null]);
  });
});
