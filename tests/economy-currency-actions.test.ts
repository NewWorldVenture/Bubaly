import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * createCurrencyAction and setCurrencyActiveAction (app/(app)/economy/actions.ts),
 * run as code. No test ran either: the economy tests read source text or the
 * ledger helpers. This drives both against the in-memory store, through the
 * real `normalizeEmoji`, `describeActionError` and message catalogue, and
 * asserts what each writes, leaves alone, refuses and answers.
 *
 * Finding: MAIN-F-F07 (money, kids, economy and missions actions with no
 * test). Register B: ACTION-406DD2DE86E3 (createCurrencyAction),
 * ACTION-0DBCDF276549 (setCurrencyActiveAction).
 *
 * Non-manager refusals assert that nothing is read and the answer is a
 * refusal, not its wording: each borrows a wallet key whose text names another
 * feature (reported in #717).
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
}));

vi.mock('next/cache', async () => {
  const { vi: v } = await import('vitest');
  harness.revalidatePath = v.fn();
  return { revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: { familyId: FAMILY, role: harness.role, member: { id: 'member-self', family_id: FAMILY }, family: { id: FAMILY, timezone: 'UTC' } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { createCurrencyAction, setCurrencyActiveAction } = await import('@/app/(app)/economy/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.role = 'parent';
  harness.revalidatePath.mockClear();
  db.seed('family_currencies', [
    { id: 'cur-stars', family_id: FAMILY, name: 'Stars', emoji: '⭐', unit_label: 'stars', is_active: true, created_by: 'user-other', sort_order: 1 },
    { id: 'cur-hearts', family_id: FAMILY, name: 'Hearts', emoji: '❤️', unit_label: null, is_active: true, created_by: 'user-other', sort_order: 2 },
    { id: 'cur-x', family_id: 'family-2', name: 'Coins', emoji: '🪙', unit_label: null, is_active: true, created_by: 'user-x', sort_order: 1 },
  ]);
});

/** Replace one table's builder method so its call answers `reply`. */
function override(table: string, method: 'insert' | 'update', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (n: string) => unknown }).from = (n: string) => {
    const builder = from(n) as unknown as Record<string, unknown>;
    if (n === table) {
      const answer = { data: null, error: null, count: null, status: 200, statusText: 'OK', ...reply };
      const settled: Record<string, unknown> = {
        eq: () => settled,
        select: () => settled,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve),
      };
      builder[method] = () => settled;
    }
    return builder;
  };
}

const currencies = () => db.table('family_currencies');
const newRows = () => currencies().filter((row) => !['cur-stars', 'cur-hearts', 'cur-x'].includes(String(row.id)));
const create = (over: Partial<Parameters<typeof createCurrencyAction>[0]> = {}) =>
  createCurrencyAction({ name: 'Gems', emoji: '💎', unitLabel: 'gems', ...over });

describe('createCurrencyAction (ACTION-406DD2DE86E3)', () => {
  describe('creating', () => {
    it('writes one currency in this family, by this user, and refreshes /economy once', async () => {
      expect(await create()).toEqual({ ok: true });

      expect(newRows()).toEqual([expect.objectContaining({
        family_id: FAMILY, name: 'Gems', emoji: '💎', unit_label: 'gems', created_by: 'user-self',
      })]);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/economy');
    });

    it('an adult may create one too', async () => {
      harness.role = 'adult';
      expect(await create()).toEqual({ ok: true });
      expect(newRows()).toHaveLength(1);
    });

    it('trims the name and the unit label; a blank or missing unit label is none', async () => {
      await create({ name: '  Gems  ', unitLabel: '  gems  ' });
      await create({ name: 'Points', unitLabel: '   ' });
      await create({ name: 'Bolts', unitLabel: undefined });

      expect(newRows().map((row) => [row.name, row.unit_label])).toEqual([['Gems', 'gems'], ['Points', null], ['Bolts', null]]);
    });

    it('keeps a short icon: trimmed, at most two characters, a star when blank', async () => {
      await create({ name: 'A', emoji: '  🍪  ' });
      await create({ name: 'B', emoji: 'abc' });
      await create({ name: 'C', emoji: '   ' });

      expect(newRows().map((row) => row.emoji)).toEqual(['🍪', 'ab', '⭐']);
    });

    it('leaves every other currency alone, including another family’s', async () => {
      const before = structuredClone(currencies());
      await create();
      expect(currencies().slice(0, 3)).toEqual(before);
    });
  });

  describe('refused, with nothing written and nothing refreshed', () => {
    it.each(NON_MANAGERS)('a %s, before anything is touched', async (role) => {
      harness.role = role;

      const result = await create();

      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(db.log).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it.each(['', '   '])('a name of %j, before anything is touched', async (name) => {
      expect(await create({ name })).toEqual({ ok: false, error: t('actions.giveTheCurrencyAName') });
      expect(db.log).toHaveLength(0);
    });

    it('a refused insert is a failure in words', async () => {
      override('family_currencies', 'insert', { error: PG_ERROR, status: 500 });

      expect(await create()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('economy.couldNotCreateTheCurrency')) });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });
});

describe('setCurrencyActiveAction (ACTION-0DBCDF276549)', () => {
  const currency = (id: string) => currencies().find((row) => row.id === id) as Row;
  const set = (currencyId: string, isActive: boolean) => setCurrencyActiveAction({ currencyId, isActive });

  describe('archiving and restoring', () => {
    it('archives exactly that currency: only its active flag changes, and /economy is refreshed once', async () => {
      const before = structuredClone(currencies());

      expect(await set('cur-stars', false)).toEqual({ ok: true });

      expect(currency('cur-stars')).toEqual({ ...before[0], is_active: false });
      expect(currencies().slice(1)).toEqual(before.slice(1));
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/economy');
    });

    it('restores an archived currency', async () => {
      currency('cur-hearts').is_active = false;
      expect(await set('cur-hearts', true)).toEqual({ ok: true });
      expect(currency('cur-hearts').is_active).toBe(true);
    });

    it('an adult may do it too', async () => {
      harness.role = 'adult';
      expect(await set('cur-stars', false)).toEqual({ ok: true });
      expect(currency('cur-stars').is_active).toBe(false);
    });
  });

  describe('refused, with nothing changed and nothing refreshed', () => {
    it.each(NON_MANAGERS)('a %s, before anything is touched', async (role) => {
      harness.role = role;

      const result = await set('cur-stars', false);

      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(db.log).toHaveLength(0);
      expect(currency('cur-stars').is_active).toBe(true);
    });

    it.each([
      ['another family’s currency', 'cur-x'],
      ['a currency that does not exist', 'cur-missing'],
    ])('%s is not reported as archived', async (_label, id) => {
      const before = structuredClone(currencies());

      expect(await set(id, false)).toEqual({ ok: false, error: t('economy.couldNotUpdateTheCurrency') });
      expect(currencies()).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('an update that matches no row (as row-level security would leave it) is not reported as archived', async () => {
      override('family_currencies', 'update', { data: [] });

      expect(await set('cur-stars', false)).toEqual({ ok: false, error: t('economy.couldNotUpdateTheCurrency') });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('a failed update is a failure in words', async () => {
      override('family_currencies', 'update', { error: PG_ERROR, status: 500 });

      expect(await set('cur-stars', false)).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('economy.couldNotUpdateTheCurrency')) });
      expect(currency('cur-stars').is_active).toBe(true);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });
});
