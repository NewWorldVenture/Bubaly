// The ⌘K bar's record search, called the way the bar calls it, by every
// household role, against two households whose records both match the query.
//
// THE POLICY, from the sources rather than from the action:
//   - The action is read-only (app/(app)/dashboard/search/actions.ts header):
//     it writes nothing, for any caller.
//   - Money and account-number sources (bills, warranties, renewals) are a
//     parent's or adult's: lib/services/search/index.ts rule 2 and
//     MANAGER_ONLY_KINDS, isManager in lib/constants/roles.ts. A guest is kept
//     off the same money pages by lib/auth/guest-scope.ts (bills, renewals).
//   - Trips and vacations are withheld from a role whose view of `travel` the
//     trust engine refuses — a guest and a child (TRAVEL_KINDS,
//     canSearchTravel); a teen and a caregiver keep them.
//   - Sensitive documents (Secure Vault and the sensitive categories) are a
//     manager's (canSeeSensitiveDocuments, as lib/services/documents).
//   - Every source is read for the caller's own family only: a family's
//     records never answer another family's search.
//
// Mocked: the session, the server client factory and the translator (the real
// en-US source catalogue through `translate`). The search service, the ranker
// and the trust engine run for real against the in-memory client.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CALLERS, FAMILY_A, FAMILY_B, type Caller } from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
}));

vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { searchRecordsAction } = await import('@/app/(app)/dashboard/search/actions');

// Family A's records, one per kind the roles are told apart by. Every one
// mentions "Harbor", and so does family B's event.
const EVENT_A = 'a0000000-0000-4000-8000-0000000c0001';
const NOTE_A = 'a0000000-0000-4000-8000-0000000c0002';
const TRIP_A = 'a0000000-0000-4000-8000-0000000c0003';
const BILL_A = 'a0000000-0000-4000-8000-0000000c0004';
const SECURE_DOC_A = 'a0000000-0000-4000-8000-0000000c0005';
const EVENT_B = 'b0000000-0000-4000-8000-0000000c0001';
const NOTE_B = 'b0000000-0000-4000-8000-0000000c0002';
const BILL_B = 'b0000000-0000-4000-8000-0000000c0004';

const MONEY_KINDS = ['bill', 'warranty', 'renewal'];
const TRAVEL_KINDS = ['trip', 'vacation'];
const COULD_NOT_SEARCH = 'Could not search your records. Please try again.';

/** What each role is answered: the ids it finds and the kinds it is told were not searched. */
const EXPECTED: Record<Caller, { ids: string[]; withheld: string[] }> = {
  parent: { ids: [EVENT_A, NOTE_A, TRIP_A, BILL_A, SECURE_DOC_A], withheld: [] },
  adult: { ids: [EVENT_A, NOTE_A, TRIP_A, BILL_A, SECURE_DOC_A], withheld: [] },
  teen: { ids: [EVENT_A, NOTE_A, TRIP_A], withheld: MONEY_KINDS },
  caregiver: { ids: [EVENT_A, NOTE_A, TRIP_A], withheld: MONEY_KINDS },
  child: { ids: [EVENT_A, NOTE_A], withheld: [...MONEY_KINDS, ...TRAVEL_KINDS] },
  kid: { ids: [EVENT_A, NOTE_A], withheld: [...MONEY_KINDS, ...TRAVEL_KINDS] },
  guest: { ids: [EVENT_A, NOTE_A], withheld: [...MONEY_KINDS, ...TRAVEL_KINDS] },
};

let db: InMemorySupabase;
/** Every builder call the action made, by table, so a write would be seen. */
let calls: Array<{ table: string; method: string }>;
const WRITES = ['insert', 'update', 'upsert', 'delete', 'rpc'];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  calls = [];
  harness.db = withFaults(db, (table: string, made: FaultCall[]) => {
    for (const call of made) calls.push({ table, method: call.method });
    return null;
  });
  harness.caller = 'parent';
  const at = '2026-10-01T12:00:00Z';
  for (const [family, event, note, bill] of [[FAMILY_A, EVENT_A, NOTE_A, BILL_A], [FAMILY_B, EVENT_B, NOTE_B, BILL_B]]) {
    db.seed('calendar_events', [{ id: event, family_id: family, title: 'Harbor picnic', description: null, location: 'Pier', starts_at: '2026-10-10T16:00:00Z', created_at: at, updated_at: at }]);
    db.seed('notes', [{ id: note, family_id: family, title: 'Harbor parking', body: 'Lot C', created_at: at, updated_at: at }]);
    db.seed('bills', [{ id: bill, family_id: family, name: 'Harbor marina fee', category: 'housing', due_date: '2026-10-20', status: 'unpaid', created_at: at, updated_at: at }]);
  }
  db.seed('trips', [{ id: TRIP_A, family_id: FAMILY_A, name: 'Harbor weekend', destination: 'Harbor town', notes: null, start_date: '2026-11-01', created_at: at, updated_at: at }]);
  db.seed('documents', [{ id: SECURE_DOC_A, family_id: FAMILY_A, title: 'Harbor slip lease', category: 'legal', is_secure: true, expires_at: null, created_at: at, updated_at: at }]);
});

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('searchRecordsAction (ACTION-A549F00E8641)', () => {
  it.each(CALLERS)('ACTION-A549F00E8641 a %s finds only the records of their own family their role may read, and writes nothing', async (caller) => {
    as(caller);
    const result = await searchRecordsAction('harbor');

    expect(result.ok).toBe(true);
    const answer = result as Extract<typeof result, { ok: true }>;
    expect(answer.records.map((r) => r.id).sort()).toEqual([...EXPECTED[caller].ids].sort());
    expect([...answer.withheld].sort()).toEqual([...EXPECTED[caller].withheld].sort());
    expect(answer.partial).toEqual([]);
    expect(calls.filter((c) => WRITES.includes(c.method))).toEqual([]);
  });

  it.each(CALLERS)('ACTION-A549F00E8641 a %s is never answered with a record of another family', async (caller) => {
    as(caller);
    const result = await searchRecordsAction('harbor');

    const ids = (result as Extract<typeof result, { ok: true }>).records.map((r) => r.id);
    expect(ids).not.toContain(EVENT_B);
    expect(ids).not.toContain(NOTE_B);
    expect(ids).not.toContain(BILL_B);
  });

  it('ACTION-A549F00E8641 a non-manager is not answered from the money sources at all: they are not read', async () => {
    as('teen');
    await searchRecordsAction('harbor');
    const read = new Set(calls.map((c) => c.table));
    expect(read.has('bills')).toBe(false);
    expect(read.has('home_warranties')).toBe(false);
    expect(read.has('renewals')).toBe(false);
    expect(read.has('calendar_events')).toBe(true);
  });

  it('ACTION-A549F00E8641 a signed-out caller is answered with no records and nothing is read', async () => {
    as(null);
    expect(await searchRecordsAction('harbor')).toEqual({ ok: false, error: COULD_NOT_SEARCH });
    expect(calls).toEqual([]);
  });
});
