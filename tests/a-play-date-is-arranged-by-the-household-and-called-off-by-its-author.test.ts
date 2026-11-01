// household-roles N3, N9, N10 — play dates.
//
// PlayDatesView wrote play_dates straight from the browser under 0114's
// role-blind policies and offered Schedule, Mark, Cancel and Delete to every
// role. So a guest (an invited grandparent or neighbour) scheduled, cancelled
// and deleted the family's play dates — a guest views the household and does
// not write to it (0464) — and a child called off or deleted one a parent had
// arranged. The insert sent `created_by` from the browser.
//
// The writes are now server actions. Driven here: those actions against an
// in-memory database, and the real view through tests/helpers/module-harness
// with the same actions behind it.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const session = vi.hoisted(() => ({ role: 'parent', userId: 'user-parent' }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
// The server side of the same actions: the session and the database.
vi.mock('next/cache', () => ({ revalidatePath() {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: session.userId, email: null }, memberships: [],
    active: { familyId: h.app.familyId, role: session.role, member: { id: `member-${session.role}` }, family: { id: h.app.familyId, timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const messages = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages.SOURCE_MESSAGES, key, params) };
});

const { PlayDatesView } = await import('@/components/family/play-dates-view');
const { createPlayDateAction, setPlayDateStatusAction, deletePlayDateAction } = await import('@/app/(app)/dashboard/family/play-dates/actions');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const GUEST_REFUSED = 'Guests can view this, but not change it.';
const NOT_SAVED = t('errors.thatChangeWasNotSaved');
let db: InMemorySupabase;

/** Sign in, on both sides of the action boundary. */
function as(role: string) {
  session.role = role;
  session.userId = `user-${role}`;
  (h.app as unknown as { role: string }).role = role;
  h.app.userId = `user-${role}`;
}
const playDate = (id: string, createdBy: string, status = 'planned') => ({
  id, family_id: h.app.familyId, member_id: null, title: `Play date ${id}`, with_kids: null, location: 'Riverside Park', place_id: null,
  starts_at: '2026-11-07T15:00:00.000Z', ends_at: null, status, contact_name: 'Sam', contact_phone: '555-0100', notes: null, created_by: createdBy,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
});
const screen = () => render(h.hooks, createElement(PlayDatesView));
const row = (id: string) => db.table('play_dates').find((r) => r.id === id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.stubGlobal('confirm', () => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [
    { id: 'member-parent', family_id: h.app.familyId, user_id: 'user-parent', role: 'parent', display_name: 'Ana', is_active: true },
    { id: 'member-elsewhere', family_id: 'another-family', user_id: 'user-x', role: 'child', display_name: 'Not ours', is_active: true },
  ]);
  as('parent');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the play-date actions', () => {
  const input = { title: 'Park after school', starts_at: '2026-11-07T15:00:00.000Z', contact_phone: '555-0100' };

  it('refuse a guest every write, and leave the play dates as they were', async () => {
    db.seed('play_dates', [playDate('pd-1', 'user-parent')]);
    as('guest');
    expect(await createPlayDateAction(input)).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(await setPlayDateStatusAction('pd-1', 'cancelled')).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(await setPlayDateStatusAction('pd-1', 'confirmed')).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(await deletePlayDateAction('pd-1')).toEqual({ ok: false, error: GUEST_REFUSED });
    expect(db.table('play_dates')).toHaveLength(1);
    expect(row('pd-1')?.status).toBe('planned');
  });

  it('take the family and the author from the session, whatever the browser sends', async () => {
    as('child');
    const forged = { ...input, created_by: 'user-parent', family_id: 'another-family' } as typeof input;
    expect(await createPlayDateAction(forged)).toEqual({ ok: true });
    expect(db.table('play_dates')).toHaveLength(1);
    expect(db.table('play_dates')[0]).toMatchObject({ family_id: h.app.familyId, created_by: 'user-child', title: 'Park after school' });
  });

  it('refuse a child named from another family', async () => {
    expect(await createPlayDateAction({ ...input, member_id: 'member-elsewhere' })).toEqual({ ok: false, error: t('actions.thatUserIsNotAn') });
    expect(db.table('play_dates')).toEqual([]);
  });

  it('let a child move a parent\'s play date along, but not call it off or delete it', async () => {
    db.seed('play_dates', [playDate('pd-1', 'user-parent')]);
    as('child');
    expect(await setPlayDateStatusAction('pd-1', 'cancelled')).toEqual({ ok: false, error: NOT_SAVED });
    expect(await deletePlayDateAction('pd-1')).toEqual({ ok: false, error: NOT_SAVED });
    expect(row('pd-1')?.status).toBe('planned');
    expect(await setPlayDateStatusAction('pd-1', 'confirmed')).toEqual({ ok: true });
    expect(row('pd-1')?.status).toBe('confirmed');
  });

  it('let the author call off and delete their own, and a parent anyone\'s', async () => {
    db.seed('play_dates', [playDate('pd-child', 'user-child'), playDate('pd-other', 'user-teen')]);
    as('child');
    expect(await setPlayDateStatusAction('pd-child', 'cancelled')).toEqual({ ok: true });
    expect(await deletePlayDateAction('pd-child')).toEqual({ ok: true });
    as('parent');
    expect(await deletePlayDateAction('pd-other')).toEqual({ ok: true });
    expect(db.table('play_dates')).toEqual([]);
  });

  // N10-R1: only calling a play date off was held back, so a child undid a
  // parent's cancellation by setting it back to planned or confirmed.
  it.each(['planned', 'confirmed', 'completed'])('do not let a child call a parent\'s cancelled play date back on as %s', async (status) => {
    db.seed('play_dates', [playDate('pd-1', 'user-parent', 'cancelled')]);
    as('child');
    expect(await setPlayDateStatusAction('pd-1', status)).toEqual({ ok: false, error: NOT_SAVED });
    expect(row('pd-1')?.status).toBe('cancelled');
  });

  it('do not let a child move a parent\'s play date backwards or skip a step', async () => {
    db.seed('play_dates', [playDate('pd-done', 'user-parent', 'completed'), playDate('pd-new', 'user-parent', 'planned')]);
    as('child');
    expect(await setPlayDateStatusAction('pd-done', 'planned')).toEqual({ ok: false, error: NOT_SAVED });
    expect(await setPlayDateStatusAction('pd-new', 'completed')).toEqual({ ok: false, error: NOT_SAVED });
    expect(row('pd-done')?.status).toBe('completed');
    expect(row('pd-new')?.status).toBe('planned');
  });

  it('let the author, and a parent, call a cancelled play date back on (control)', async () => {
    db.seed('play_dates', [playDate('pd-child', 'user-child', 'cancelled'), playDate('pd-teen', 'user-teen', 'cancelled')]);
    as('child');
    expect(await setPlayDateStatusAction('pd-child', 'planned')).toEqual({ ok: true });
    expect(row('pd-child')?.status).toBe('planned');
    as('parent');
    expect(await setPlayDateStatusAction('pd-teen', 'confirmed')).toEqual({ ok: true });
    expect(row('pd-teen')?.status).toBe('confirmed');
  });

  it('let anyone take each forward step on a play date someone else arranged (control)', async () => {
    db.seed('play_dates', [playDate('pd-1', 'user-parent')]);
    as('child');
    expect(await setPlayDateStatusAction('pd-1', 'confirmed')).toEqual({ ok: true });
    expect(await setPlayDateStatusAction('pd-1', 'completed')).toEqual({ ok: true });
    expect(row('pd-1')?.status).toBe('completed');
  });

  it('refuse a status that is not a play date\'s', async () => {
    db.seed('play_dates', [playDate('pd-1', 'user-parent')]);
    expect(await setPlayDateStatusAction('pd-1', 'deleted')).toEqual({ ok: false, error: NOT_SAVED });
    expect(row('pd-1')?.status).toBe('planned');
  });
});

describe('the play-dates screen offers each role what the actions allow', () => {
  const SCHEDULE = t('playDates.schedulePlayDate');
  const CANCEL = t('playDates.cancel');
  const DELETE = t('playDates.delete');
  const MARK = /^Mark /;

  it('a guest sees the play dates and no control to change them', () => {
    db.seed('play_dates', [playDate('pd-1', 'user-parent')]);
    as('guest');
    const tree = screen();
    expect(has(tree, 'Play date pd-1')).toBe(true);
    expect(allByName(tree, SCHEDULE)).toHaveLength(0);
    expect(allByName(tree, MARK)).toHaveLength(0);
    expect(allByName(tree, CANCEL)).toHaveLength(0);
    expect(allByName(tree, DELETE)).toHaveLength(0);
  });

  it('a child may schedule and move a parent\'s play date along, and call off only their own', () => {
    db.seed('play_dates', [playDate('pd-parent', 'user-parent'), playDate('pd-child', 'user-child')]);
    as('child');
    const tree = screen();
    expect(allByName(tree, SCHEDULE).length).toBeGreaterThan(0);
    expect(allByName(tree, MARK)).toHaveLength(2);
    expect(allByName(tree, CANCEL)).toHaveLength(1);
    expect(allByName(tree, DELETE)).toHaveLength(1);
  });

  it('a parent may call off and delete every play date, and the delete goes through the action', async () => {
    db.seed('play_dates', [playDate('pd-parent', 'user-parent'), playDate('pd-child', 'user-child')]);
    as('parent');
    const tree = screen();
    expect(allByName(tree, CANCEL)).toHaveLength(2);
    expect(allByName(tree, DELETE)).toHaveLength(2);
    await click(byName(tree, DELETE));
    expect(db.table('play_dates')).toHaveLength(1);
    expect(h.toasts.success).toContain(t('playDatesView.deleted'));
    // The browser no longer writes play_dates itself.
    expect(h.calls.filter((c) => c.table === 'play_dates' && c.calls.some((m) => ['insert', 'update', 'delete'].includes(m)))).toEqual([]);
  });
});
