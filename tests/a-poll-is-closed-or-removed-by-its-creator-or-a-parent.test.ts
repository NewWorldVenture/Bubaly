// A poll is closed, reopened or removed by the person who asked it, or by a
// parent or another adult. Nobody else.
//
// The Group Voting page wrote family_polls straight from the browser and
// offered Close, Reopen and the bin to every member, and RLS on family_polls
// (0078, unchanged by 0481) lets any non-guest member update or delete any
// poll. So a child could close the parent's "Where do we go this summer?"
// while their pick was ahead, reopen it after the deadline, or delete it. Poll
// OPTIONS were already the author's or a manager's (0481); the poll was not.
//
// Close, Reopen and delete now go through checked server actions
// (app/(app)/dashboard/voting/actions.ts) that read the poll by id and family
// and refuse anyone but its creator or a manager, and the page offers the
// controls only to them. The database half (an update/delete policy on
// family_polls) needs a schema change; until then the direct PostgREST path
// stays open. These drive the REAL actions against an in-memory database.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(MESSAGES, key, params),
}));

const { deletePollAction, setPollStatusAction } = await import('@/app/(app)/dashboard/voting/actions');

const FAMILY = 'family-1';
const NOT_ALLOWED = MESSAGES['actionRefusal.notAllowed'];
const NOT_SAVED = MESSAGES['errors.thatChangeWasNotSaved'];
const PARENT_USER = 'user-parent';
const KID_USER = 'user-kid';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const as = (role: string, userId: string) => mocks.requireUserContext.mockResolvedValue({
  user: { id: userId, email: null },
  active: { familyId: FAMILY, role, family: { name: 'Family One', timezone: 'UTC' }, member: { id: `member-${userId}` } },
});
const poll = (id = 'poll-1') => db.table('family_polls').find((row) => row.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T15:00:00Z'));
  db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('family_polls', [
    { id: 'poll-1', family_id: FAMILY, question: 'Where this summer?', kind: 'single', status: 'open', closes_at: null, created_by: PARENT_USER },
    { id: 'poll-kid', family_id: FAMILY, question: 'Movie night pick?', kind: 'single', status: 'open', closes_at: null, created_by: KID_USER },
    { id: 'poll-past', family_id: FAMILY, question: 'Pizza or tacos?', kind: 'single', status: 'open', closes_at: '2026-10-22T00:00:00.000Z', created_by: PARENT_USER },
    { id: 'poll-other', family_id: 'family-2', question: 'Another house', kind: 'single', status: 'open', closes_at: null, created_by: KID_USER },
  ]);
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('someone else\'s poll', () => {
  it.each(['teen', 'child', 'caregiver', 'guest'])('a %s cannot close, reopen or delete a parent\'s poll', async (role) => {
    as(role, KID_USER);
    expect(await setPollStatusAction('poll-1', 'closed')).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(await setPollStatusAction('poll-past', 'open')).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(await deletePollAction('poll-1')).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(poll('poll-1')).toMatchObject({ status: 'open', closes_at: null });
    expect(poll('poll-past')).toMatchObject({ status: 'open', closes_at: '2026-10-22T00:00:00.000Z' });
    expect(db.table('family_polls')).toHaveLength(4);
  });

  it('another family\'s poll is not found, whoever asks', async () => {
    as('parent', PARENT_USER);
    expect(await setPollStatusAction('poll-other', 'closed')).toEqual({ ok: false, error: NOT_SAVED });
    expect(await deletePollAction('poll-other')).toEqual({ ok: false, error: NOT_SAVED });
    expect(poll('poll-other')).toMatchObject({ status: 'open' });
  });
});

describe('the poll\'s creator and the managers', () => {
  it('a child runs the poll they asked', async () => {
    as('child', KID_USER);
    expect(await setPollStatusAction('poll-kid', 'closed')).toMatchObject({ ok: true, id: 'poll-kid' });
    expect(poll('poll-kid')).toMatchObject({ status: 'closed' });
    expect(await deletePollAction('poll-kid')).toEqual({ ok: true, id: 'poll-kid' });
    expect(poll('poll-kid')).toBeUndefined();
  });

  it.each(['parent', 'adult'])('a %s closes and deletes a poll someone else asked', async (role) => {
    as(role, 'user-another-adult');
    expect(await setPollStatusAction('poll-kid', 'closed')).toMatchObject({ ok: true });
    expect(poll('poll-kid')).toMatchObject({ status: 'closed' });
    expect(await deletePollAction('poll-1')).toEqual({ ok: true, id: 'poll-1' });
    expect(poll('poll-1')).toBeUndefined();
  });

  it('reopening a poll its deadline closed clears the deadline, so it really opens', async () => {
    as('parent', PARENT_USER);
    expect(await setPollStatusAction('poll-past', 'open')).toMatchObject({ ok: true, status: 'open', closesAt: null });
    expect(poll('poll-past')).toMatchObject({ status: 'open', closes_at: null });
  });

  it('a write the database refuses (no error, no row) is not reported as done', async () => {
    as('parent', PARENT_USER);
    // RLS answers a refused update or delete with zero rows and no error.
    const real = db.from.bind(db);
    mocks.createServer.mockResolvedValue(new Proxy(db, { get: (target, key, receiver) => (key !== 'from' ? Reflect.get(target, key, receiver)
      : (table: string) => {
        const builder = real(table as never) as unknown as Record<string, unknown>;
        if (table !== 'family_polls') return builder;
        const nothing: Record<string, unknown> = {};
        nothing.eq = () => nothing;
        nothing.select = () => Promise.resolve({ data: [], error: null });
        return new Proxy(builder, { get: (b, k) => (k === 'update' || k === 'delete' ? () => nothing : Reflect.get(b, k)) });
      }) }));
    expect(await setPollStatusAction('poll-1', 'closed')).toEqual({ ok: false, error: NOT_SAVED });
    expect(await deletePollAction('poll-1')).toEqual({ ok: false, error: NOT_SAVED });
  });

  it('a reopen the database answers still past its deadline is not reported as open', async () => {
    as('parent', PARENT_USER);
    // The write landed, but the row that came back still carries the deadline
    // (a trigger, a stale column): the poll is still closed, so it is no success.
    const real = db.from.bind(db);
    const stillClosed: Record<string, unknown> = {};
    stillClosed.eq = () => stillClosed;
    stillClosed.select = () => Promise.resolve({ data: [{ id: 'poll-past', status: 'open', closes_at: '2026-10-22T00:00:00.000Z' }], error: null });
    mocks.createServer.mockResolvedValue(new Proxy(db, { get: (target, key, receiver) => (key !== 'from' ? Reflect.get(target, key, receiver)
      : (table: string) => {
        const builder = real(table as never) as unknown as Record<string, unknown>;
        return table !== 'family_polls' ? builder : new Proxy(builder, { get: (b, k) => (k === 'update' ? () => stillClosed : Reflect.get(b, k)) });
      }) }));
    expect(await setPollStatusAction('poll-past', 'open')).toEqual({ ok: false, error: NOT_SAVED });
  });

  it('a status that is not open or closed is refused, not written', async () => {
    as('parent', PARENT_USER);
    expect(await setPollStatusAction('poll-1', 'archived' as never)).toMatchObject({ ok: false });
    expect(poll('poll-1')).toMatchObject({ status: 'open' });
  });
});
