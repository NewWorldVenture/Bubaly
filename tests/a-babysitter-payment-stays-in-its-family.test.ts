import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A babysitter payment named another family's babysitter and event.
 *
 * `recordBabysitterPaymentAction` inserted `babysitter_id` and `event_id`
 * exactly as given. On the real schema both are plain foreign keys (0088) —
 * a missing id fails, another family's existing id does not — and the
 * `babysitter_payments` insert policies check only the row's own `family_id`
 * (0354). Measured as a real authenticated parent of family A on the local
 * replay: a payment filed in A, naming B's sitter and B's date night, is
 * INSERTED, while A cannot even read that sitter.
 *
 * The action now reads both references back inside the caller's family before
 * anything else runs, the way `saveWalletRuleAction` checks its wallet, and
 * writes nothing — no payment, no audit row, no Trust call — when either is
 * missing, another family's, or cannot be read. An event stays optional.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown, revalidatePath: vi.fn(), evaluateTrust: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: { familyId: FAMILY, role: 'parent', member: { id: 'member-self', family_id: FAMILY } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/trust/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/trust/server')>()),
  evaluateTrust: (...args: unknown[]) => harness.evaluateTrust(...args),
}));

const { recordBabysitterPaymentAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const COULD_NOT_RECORD = translate(SOURCE_MESSAGES, 'actions.couldNotRecordThatBabysitter');
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockReset();
  harness.evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', reason: 'Allowed.', basis: 'role_default' } });
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('babysitter_profiles', [
    { id: 'sitter-own', family_id: FAMILY, name: 'Ava', is_active: true },
    { id: 'sitter-archived', family_id: FAMILY, name: 'Cleo', is_active: false },
    { id: 'sitter-other', family_id: 'family-2', name: 'Xena', is_active: true },
  ]);
  db.seed('calendar_events', [
    { id: 'event-own', family_id: FAMILY, title: 'Date night' },
    { id: 'event-other', family_id: 'family-2', title: 'Their date night' },
  ]);
});

const pay = (babysitterId: string, eventId?: string) =>
  recordBabysitterPaymentAction({ babysitterId, eventId, hours: 3, rateCents: 2_000, tipCents: 0, amountCents: 6_000 });

/** Nothing about a refused payment may reach the database or the Trust Engine. */
function expectNothingWritten() {
  expect(db.table('babysitter_payments')).toHaveLength(0);
  expect(db.table('wallet_audit_logs')).toHaveLength(0);
  expect(harness.evaluateTrust).not.toHaveBeenCalled();
  expect(harness.revalidatePath).not.toHaveBeenCalled();
}

/** Make one table's single-row read answer a database error. */
function failRead(table: string) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === table) builder.maybeSingle = async () => ({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' });
    return builder;
  };
}

describe('a babysitter payment names only this family’s babysitter and event', () => {
  describe('refused, and nothing written', () => {
    it('another family’s babysitter', async () => {
      expect(await pay('sitter-other')).toEqual({ ok: false, error: COULD_NOT_RECORD });
      expectNothingWritten();
    });

    it('another family’s calendar event, even with this family’s babysitter', async () => {
      expect(await pay('sitter-own', 'event-other')).toEqual({ ok: false, error: COULD_NOT_RECORD });
      expectNothingWritten();
    });

    it('a babysitter that does not exist', async () => {
      expect(await pay('sitter-missing')).toEqual({ ok: false, error: COULD_NOT_RECORD });
      expectNothingWritten();
    });

    it('an event that does not exist', async () => {
      expect(await pay('sitter-own', 'event-missing')).toEqual({ ok: false, error: COULD_NOT_RECORD });
      expectNothingWritten();
    });

    it('a babysitter that cannot be read, in words', async () => {
      failRead('babysitter_profiles');
      expect(await pay('sitter-own')).toEqual({ ok: false, error: describeActionError(PG_ERROR, COULD_NOT_RECORD) });
      expectNothingWritten();
    });

    it('an event that cannot be read, in words', async () => {
      failRead('calendar_events');
      expect(await pay('sitter-own', 'event-own')).toEqual({ ok: false, error: describeActionError(PG_ERROR, COULD_NOT_RECORD) });
      expectNothingWritten();
    });
  });

  // The reads above are separate statements from the insert, with the Trust
  // Engine awaited between them. Here the Trust call itself moves the row to
  // family-2 after both reads passed — standing in for a concurrent update by a
  // caller who manages both families (#701 review 5918702743).
  describe('a reference moved to another family while Trust is awaited', () => {
    const MOVED = [
      ['babysitter', 'babysitter_profiles', 'sitter-own'],
      ['calendar event', 'calendar_events', 'event-own'],
    ] as const;

    function moveDuringTrust(table: string, id: string) {
      harness.evaluateTrust.mockImplementationOnce(async () => {
        (db.table(table).find((row) => row.id === id) as { family_id: string }).family_id = 'family-2';
        return { decision: { effect: 'allow', reason: 'Allowed.', basis: 'role_default' } };
      });
    }

    // KNOWN GAP, kept visible rather than green: the action alone cannot refuse
    // this, because a second read would only move the window. `it.fails` passes
    // while the payment is still recorded, and turns red if the action ever
    // does refuse it on its own, so this is revisited rather than forgotten.
    // What does refuse it is the database: migration 0472.
    it.fails.each(MOVED)('without the database guard, the action alone still records a %s moved mid-check', async (_kind, table, id) => {
      moveDuringTrust(table, id);

      expect(await pay('sitter-own', 'event-own')).toEqual({ ok: false, error: COULD_NOT_RECORD });
      expect(db.table('babysitter_payments')).toHaveLength(0);
    });

    // 0472 refuses the write itself: its insert trigger re-reads the parent
    // FOR SHARE and raises 42501 when the parent is now another family's. This
    // stands in for that answer, and pins what the action then does with it.
    it.each(MOVED)('with the database guard, a %s moved mid-check is not recorded, and the refusal is a failure in words', async (_kind, table, id) => {
      const guardError = { code: '42501', message: `babysitter_payments points at a row in another family`, details: null, hint: null };
      const from = db.from.bind(db);
      (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
        const builder = from(name) as unknown as Record<string, unknown>;
        if (name === 'babysitter_payments') {
          const insert = (builder.insert as (row: Record<string, unknown>) => unknown).bind(builder);
          builder.insert = (row: Record<string, unknown>) => {
            const owner = (tbl: string, ref: unknown) => db.table(tbl).find((r) => r.id === ref)?.family_id;
            const crosses = (row.babysitter_id != null && owner('babysitter_profiles', row.babysitter_id) !== row.family_id)
              || (row.event_id != null && owner('calendar_events', row.event_id) !== row.family_id);
            return crosses
              ? { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: guardError, count: null, status: 403, statusText: 'Forbidden' }).then(resolve) }
              : insert(row);
          };
        }
        return builder;
      };
      moveDuringTrust(table, id);

      expect(await pay('sitter-own', 'event-own')).toEqual({ ok: false, error: describeActionError(guardError, COULD_NOT_RECORD) });
      expect(db.table('babysitter_payments')).toHaveLength(0);
      expect(db.table('wallet_audit_logs')).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('still recorded', () => {
    it('this family’s babysitter, with no event', async () => {
      expect(await pay('sitter-own')).toEqual({ ok: true });
      expect(db.table('babysitter_payments')).toEqual([expect.objectContaining({ family_id: FAMILY, babysitter_id: 'sitter-own', event_id: null, amount_cents: 6_000 })]);
      expect(db.table('wallet_audit_logs')).toHaveLength(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/babysitters');
    });

    it('this family’s babysitter for this family’s event', async () => {
      expect(await pay('sitter-own', 'event-own')).toEqual({ ok: true });
      expect(db.table('babysitter_payments')).toEqual([expect.objectContaining({ babysitter_id: 'sitter-own', event_id: 'event-own' })]);
    });

    it('a babysitter this family has since archived — a late payment is still theirs', async () => {
      expect(await pay('sitter-archived')).toEqual({ ok: true });
      expect(db.table('babysitter_payments')).toEqual([expect.objectContaining({ babysitter_id: 'sitter-archived' })]);
    });
  });
});
