// N16 — "Find a time" showed a failed search as a full calendar.
//
// /api/ai/schedule answers 503 when a calendar, school or sports read fails.
// The modal turned that into a toast and then `setSlots([])` with the search
// marked done, so once the toast was gone the panel said "No shared openings in
// this window. Try a shorter duration or a wider range." — a claim about the
// family's calendar that nobody had read, steering the parent to change the
// search instead of trying again.
//
// A search that did not finish now says so, with a retry, and "no shared
// openings" is shown only for a search that answered with none. Driven through
// the real component on the hook-slot harness.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { byName, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/app/(app)/dashboard/calendar/actions', () => ({ createCalendarEventAction: async () => ({ ok: true }) }));

const { FindTimeModal } = await import('@/components/modules/find-time-modal');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const NO_OPENINGS = t('findTimeModal.noSharedOpeningsInThisWindow');
const DID_NOT_FINISH = t('findTimeModal.searchDidNotFinish');
const members = [{ id: 'm-1', display_name: 'Dana', color: '#888' }] as never;

let answer: () => Promise<Response>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  h.timeZone = 'UTC';
  vi.stubGlobal('fetch', vi.fn(() => answer()));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const screen = (): ReactNode => render(h.hooks, createElement(FindTimeModal, { members, selfMemberId: 'm-1', onClose: () => {}, onScheduled: () => {} }));
const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const alerts = (tree: ReactNode) => nodes(tree).filter((node) => node.props.role === 'alert');

describe('Find a time', () => {
  it.each([
    ['a calendar read failed (503)', json(503, { error: 'Could not load the family.' })],
    ['the server failed (500)', json(500, { error: 'Failed to find times.' })],
    ['the network failed', async () => { throw new TypeError('Failed to fetch'); }],
  ])('says the search did not finish when %s, never that there are no openings', async (_label, reply) => {
    answer = reply as () => Promise<Response>;

    await click(byName(screen(), t('findTimeModal.findOpenTimes')));
    const tree = screen();

    expect(h.toasts.error).toHaveLength(1);
    expect(text(tree)).not.toContain(NO_OPENINGS);
    expect(alerts(tree).map(text).join(' ')).toContain(DID_NOT_FINISH);
  });

  it('offers a retry, and says "no shared openings" only when a search answers with none', async () => {
    answer = json(503, { error: 'Could not load the family.' });
    await click(byName(screen(), t('findTimeModal.findOpenTimes')));

    answer = json(200, { durationMin: 60, slots: [], busyCount: 3 });
    await click(byName(screen(), t('findTimeModal.tryAgain')));
    const tree = screen();

    expect(text(tree)).toContain(NO_OPENINGS);
    expect(alerts(tree)).toEqual([]);
  });
});
