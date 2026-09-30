import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * saveBabysitterAction and archiveBabysitterAction (app/(app)/wallet/actions.ts),
 * run as code. `a-write-the-user-is-told-about-is-confirmed.test.ts` reads their
 * source text; nothing ran either action. This drives both against the
 * in-memory store, with the real message catalogue and `describeActionError`,
 * and asserts what each one writes, leaves alone and answers.
 *
 * Finding: MAIN-F-F07 (money server actions with no test). Register B:
 * ACTION-CF6E77C74E5C (saveBabysitterAction), ACTION-FADA7B86237A
 * (archiveBabysitterAction).
 *
 * `babysitter_profiles` (0088): `name text not null`, `rate_cents bigint check
 * (rate_cents is null or rate_cents >= 0)`, `is_active boolean not null default
 * true`. The store is given that default. Row-level security (0322, 0354) is not
 * exercised here.
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
    active: { familyId: FAMILY, role: harness.role, member: { id: 'member-self', family_id: FAMILY } },
  }),
  effectivePlanLevel: () => 0,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { saveBabysitterAction, archiveBabysitterAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy for table "babysitter_profiles"', details: null, hint: null };
const STAMP = '2026-09-01T12:00:00.000Z';

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ defaults: { babysitter_profiles: { is_active: true } } });
  harness.db = db;
  harness.role = 'parent';
  harness.revalidatePath.mockClear();
  db.seed('babysitter_profiles', [
    { id: 'sitter-1', family_id: FAMILY, name: 'Ava', phone: '555-0100', email: 'ava@example.test', rate_cents: 2_000, notes: 'Loves Lego', is_active: true, created_by: 'user-other', created_at: STAMP, updated_at: STAMP },
    { id: 'sitter-2', family_id: FAMILY, name: 'Ben', phone: null, email: null, rate_cents: null, notes: null, is_active: true, created_by: 'user-other', created_at: STAMP, updated_at: STAMP },
    { id: 'sitter-old', family_id: FAMILY, name: 'Cleo', phone: null, email: null, rate_cents: 1_500, notes: null, is_active: false, created_by: 'user-other', created_at: STAMP, updated_at: STAMP },
    { id: 'sitter-x', family_id: 'family-2', name: 'Xena', phone: '555-0199', email: null, rate_cents: 2_500, notes: null, is_active: true, created_by: 'user-x', created_at: STAMP, updated_at: STAMP },
  ]);
});

/** Replace one table's write so it answers `reply` instead of touching the store. */
function override(method: 'insert' | 'update', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name !== 'babysitter_profiles') return builder;
    const answer = { data: null, count: null, status: 500, statusText: 'Error', ...reply };
    const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve) };
    if (method === 'insert') builder.insert = () => settle;
    if (method === 'update') builder.update = () => { const chain = { eq: () => chain, select: () => settle }; return chain; };
    return builder;
  };
}

const sitters = () => db.table('babysitter_profiles');
const sitter = (id: string) => sitters().find((row) => row.id === id) as Row;
const snapshot = () => structuredClone(sitters());
const others = (rows: Row[], id: string) => rows.filter((row) => row.id !== id);
const created = () => sitters().filter((row) => !['sitter-1', 'sitter-2', 'sitter-old', 'sitter-x'].includes(String(row.id)));

describe('saveBabysitterAction (ACTION-CF6E77C74E5C)', () => {
  describe('creating a profile', () => {
    it('adds one active profile to the family, trimmed, credited to the user, and refreshes the page', async () => {
      const before = snapshot();

      const result = await saveBabysitterAction({
        name: '  Dana  ', phone: ' 555-0142 ', email: ' dana@example.test ', rateCents: 1_850, notes: '  Allergic to cats ',
      });

      expect(result).toEqual({ ok: true });
      expect(created()).toHaveLength(1);
      expect(created()[0]).toMatchObject({
        family_id: FAMILY, name: 'Dana', phone: '555-0142', email: 'dana@example.test',
        rate_cents: 1_850, notes: 'Allergic to cats', created_by: 'user-self', is_active: true,
      });
      expect(created()[0].id).toBeTruthy();
      expect(sitters().filter((row) => created()[0] !== row)).toEqual(before);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/babysitters');
    });

    it('an adult may add one too', async () => {
      harness.role = 'adult';
      expect(await saveBabysitterAction({ name: 'Dana' })).toEqual({ ok: true });
      expect(created()).toHaveLength(1);
    });

    it.each([
      ['left out', {}],
      ['blank', { phone: '   ', email: '', notes: ' \n ' }],
    ])('optional fields %s are stored as empty, not as blanks', async (_label, fields) => {
      expect(await saveBabysitterAction({ name: 'Dana', ...fields })).toEqual({ ok: true });
      expect(created()[0]).toMatchObject({ phone: null, email: null, rate_cents: null, notes: null });
    });

    it('a rate of zero is kept as zero, not dropped', async () => {
      expect(await saveBabysitterAction({ name: 'Dana', rateCents: 0 })).toEqual({ ok: true });
      expect(created()[0].rate_cents).toBe(0);
    });

    it('a refused insert is a failure in words, adds nothing, and refreshes nothing', async () => {
      override('insert', { error: RLS_DENIED });

      expect(await saveBabysitterAction({ name: 'Dana' })).toEqual({ ok: false, error: describeActionError(RLS_DENIED, t('actions.couldNotSaveThatBabysitter')) });
      expect(created()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('updating a profile', () => {
    it('rewrites that profile’s details and nothing else about it or any other', async () => {
      const before = snapshot();

      const result = await saveBabysitterAction({
        id: 'sitter-1', name: ' Ava Q. ', phone: ' 555-0101 ', email: ' ava.q@example.test ', rateCents: 2_250, notes: ' Weekends only ',
      });

      expect(result).toEqual({ ok: true });
      expect(sitter('sitter-1')).toEqual({
        ...before.find((row) => row.id === 'sitter-1'),
        name: 'Ava Q.', phone: '555-0101', email: 'ava.q@example.test', rate_cents: 2_250, notes: 'Weekends only',
      });
      expect(others(sitters(), 'sitter-1')).toEqual(others(before, 'sitter-1'));
      expect(created()).toHaveLength(0);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/babysitters');
    });

    it('keeps who created it, when, which family, and whether it is active', async () => {
      await saveBabysitterAction({ id: 'sitter-1', name: 'Ava' });

      expect(sitter('sitter-1')).toMatchObject({ id: 'sitter-1', family_id: FAMILY, created_by: 'user-other', created_at: STAMP, is_active: true });
    });

    it('a field left blank on the form is cleared, the rate included', async () => {
      expect(await saveBabysitterAction({ id: 'sitter-1', name: 'Ava', phone: ' ', email: '', notes: '' })).toEqual({ ok: true });
      expect(sitter('sitter-1')).toMatchObject({ phone: null, email: null, rate_cents: null, notes: null });
    });

    it('a rate changed to zero is kept as zero', async () => {
      expect(await saveBabysitterAction({ id: 'sitter-1', name: 'Ava', rateCents: 0 })).toEqual({ ok: true });
      expect(sitter('sitter-1').rate_cents).toBe(0);
    });

    it('editing an archived profile does not bring it back', async () => {
      expect(await saveBabysitterAction({ id: 'sitter-old', name: 'Cleo', rateCents: 1_600 })).toEqual({ ok: true });
      expect(sitter('sitter-old')).toMatchObject({ rate_cents: 1_600, is_active: false });
    });

    it.each([
      ['another family’s profile', 'sitter-x'],
      ['a profile that does not exist', 'sitter-missing'],
    ])('%s is not updated, and the action says so', async (_label, id) => {
      const before = snapshot();

      expect(await saveBabysitterAction({ id, name: 'Taken over', rateCents: 1 })).toEqual({ ok: false, error: t('actions.couldNotUpdateThatBabysitter') });
      expect(sitters()).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('an update that matches no row (as RLS would leave it) is not reported as saved', async () => {
      override('update', { data: [], error: null, status: 200, statusText: 'OK' });

      expect(await saveBabysitterAction({ id: 'sitter-1', name: 'Ava' })).toEqual({ ok: false, error: t('actions.couldNotUpdateThatBabysitter') });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('a failed update is a failure in words, and refreshes nothing', async () => {
      override('update', { error: PG_ERROR });

      expect(await saveBabysitterAction({ id: 'sitter-1', name: 'Ava' })).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotUpdateThatBabysitter')) });
      expect(sitter('sitter-1').name).toBe('Ava');
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('what it refuses before touching the database', () => {
    it.each(NON_MANAGERS)('a %s, whether creating or updating', async (role) => {
      harness.role = role;
      const before = snapshot();

      expect(await saveBabysitterAction({ name: 'Dana' })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan12') });
      expect(await saveBabysitterAction({ id: 'sitter-1', name: 'Dana' })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan12') });
      expect(db.log).toHaveLength(0);
      expect(sitters()).toEqual(before);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('the role is checked before the input: a child with a blank name hears about the role', async () => {
      harness.role = 'child';
      expect(await saveBabysitterAction({ name: '' })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan12') });
    });

    it.each(['', '   ', '\t\n'])('a name of %j', async (name) => {
      expect(await saveBabysitterAction({ name })).toEqual({ ok: false, error: t('actions.enterAName') });
      expect(await saveBabysitterAction({ id: 'sitter-1', name })).toEqual({ ok: false, error: t('actions.enterAName') });
      expect(db.log).toHaveLength(0);
    });

    it('a name of 121 characters; 120 is allowed, and surrounding spaces do not count', async () => {
      expect(await saveBabysitterAction({ name: 'a'.repeat(121) })).toEqual({ ok: false, error: t('actions.nameIsTooLong') });
      expect(db.log).toHaveLength(0);

      expect(await saveBabysitterAction({ name: `  ${'b'.repeat(120)}  ` })).toEqual({ ok: true });
      expect(created()[0].name).toBe('b'.repeat(120));
    });

    it.each([-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('a rate of %s', async (rateCents) => {
      expect(await saveBabysitterAction({ name: 'Dana', rateCents })).toEqual({ ok: false, error: t('actions.rateMustBeAPositive') });
      expect(await saveBabysitterAction({ id: 'sitter-1', name: 'Ava', rateCents })).toEqual({ ok: false, error: t('actions.rateMustBeAPositive') });
      expect(db.log).toHaveLength(0);
      expect(sitter('sitter-1').rate_cents).toBe(2_000);
    });
  });
});

describe('archiveBabysitterAction (ACTION-FADA7B86237A)', () => {
  it('turns off only that profile’s active flag, keeps the row, and refreshes the page', async () => {
    const before = snapshot();

    expect(await archiveBabysitterAction({ id: 'sitter-1' })).toEqual({ ok: true });

    expect(sitters()).toHaveLength(before.length);
    expect(sitter('sitter-1')).toEqual({ ...before.find((row) => row.id === 'sitter-1'), is_active: false });
    expect(others(sitters(), 'sitter-1')).toEqual(others(before, 'sitter-1'));
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/babysitters');
  });

  it('an adult may archive too', async () => {
    harness.role = 'adult';
    expect(await archiveBabysitterAction({ id: 'sitter-2' })).toEqual({ ok: true });
    expect(sitter('sitter-2').is_active).toBe(false);
  });

  it('archiving one already archived is still archived', async () => {
    expect(await archiveBabysitterAction({ id: 'sitter-old' })).toEqual({ ok: true });
    expect(sitter('sitter-old').is_active).toBe(false);
  });

  it.each(NON_MANAGERS)('refuses a %s before touching the database', async (role) => {
    harness.role = role;
    const before = snapshot();

    expect(await archiveBabysitterAction({ id: 'sitter-1' })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan12') });
    expect(db.log).toHaveLength(0);
    expect(sitters()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['another family’s profile', 'sitter-x'],
    ['a profile that does not exist', 'sitter-missing'],
  ])('%s is not archived, and the action says so', async (_label, id) => {
    const before = snapshot();

    expect(await archiveBabysitterAction({ id })).toEqual({ ok: false, error: t('actions.couldNotArchiveThatBabysitter') });
    expect(sitters()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('an archive that matches no row (as RLS would leave it) is not reported as done', async () => {
    override('update', { data: [], error: null, status: 200, statusText: 'OK' });

    expect(await archiveBabysitterAction({ id: 'sitter-1' })).toEqual({ ok: false, error: t('actions.couldNotArchiveThatBabysitter') });
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a failed archive is a failure in words, the profile stays active, and nothing is refreshed', async () => {
    override('update', { error: PG_ERROR });

    expect(await archiveBabysitterAction({ id: 'sitter-1' })).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotArchiveThatBabysitter')) });
    expect(sitter('sitter-1').is_active).toBe(true);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
