// /dashboard/moments is the one screen whose whole job is "what do we still need
// to get ready for". Three reads behind it answered a FAILURE with the same words
// they use for a fresh start, and each lie costs the family something different:
//
//   loadMomentPrep          a refused prefs read returned {} — byte-identical to
//                           "nothing ticked yet". Every card read `0/5`, the strip
//                           said "5 need prep", and the next tap sent that
//                           emptiness back as the event's COMPLETE done-list, so
//                           setMomentPrepDoneAction (map[eventId] = doneIds)
//                           deleted the four steps they really had ticked.
//   grocery_lists lookup    a refused read looked like "this family has no list",
//                           so the action created a SECOND "Groceries" and put the
//                           snacks on it. The shopping module opens the OLDEST
//                           list, so the items are invisible on the page that just
//                           said it added them.
//   grocery_items dedupe    a refused read looked like "the list is empty", which
//                           quietly cancels the promise in the function's own
//                           docstring ("tapping twice never duplicates") and
//                           reports "Added 3" for the second tap — the one answer
//                           that reads exactly like the first.
//
// PostgREST RESOLVES with { data: null, error }; it does not throw. So none of
// these were visible to a caller, and the page could not have known.
//
// The page is rendered (not grepped) with the prefs read succeeding and then
// failing, so what is under test is what a parent sees on the card.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { buildMomentPrep } from '@/lib/moments/prep';

// The REAL en-US catalogue, and nothing else: a key it does not hold renders as
// the raw key, exactly as lib/i18n/translate.ts does in the product. The copy
// this change adds is asserted below as the ENGLISH SENTENCE, never looked up, so
// a missing catalogue entry fails here instead of shipping
// "momentsView.couldNotLoadYourPrepSteps" to a family. Those keys are merged into
// all seven locales by the audit's i18n pass (scratchpad/i18n-asks/
// m22+m23+m24.json); until that merge lands, the cases that assert this copy are
// RED on purpose.
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const say = (key: string) => MESSAGES[key] ?? key;
const PREP_FAILED = 'We could not load which prep steps you have already ticked.';
const LIST_UNOPENED = 'We could not open your grocery list. Nothing was added — try again.';
const LIST_UNREAD = 'We could not check what is already on your grocery list. Nothing was added — try again.';

// Saturday's soccer game, two days out, with a location — so the card builds the
// full prep bundle (leave-by, forecast, kit, snacks, photos).
const EVENT = {
  id: 'evt-soccer',
  title: 'Soccer game',
  category: 'sports',
  location: 'Riverside Park',
  starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  all_day: false,
  description: null,
};
const TOTAL_STEPS = buildMomentPrep({
  id: EVENT.id, title: EVENT.title, category: EVENT.category, location: EVENT.location,
  starts_at: EVENT.starts_at, all_day: EVENT.all_day, description: EVENT.description,
}).items.length;

type Reply = { data: unknown; error: unknown; count?: number | null };

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  loadScheduleIntelligence: vi.fn(),
  rows: { current: [] as unknown[] },
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => say }));
vi.mock('@/lib/schedule/intelligence-server', () => ({ loadScheduleIntelligence: mocks.loadScheduleIntelligence }));
// The organizing band is a separate surface; keep it out of the markup under test.
vi.mock('@/lib/moments/organizer', () => ({ activeMoments: () => [] }));

vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({ familyId: 'fam-1', userId: 'user-1', members: [], selfMember: { id: 'mem-1', display_name: 'Alex' } }),
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({ data: mocks.rows.current, loading: false, error: null, refresh: () => {}, setData: () => {} }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, show: () => {} }),
}));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => say(key),
  useLocale: () => ({ code: 'en-US' }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {} }),
  usePathname: () => '/dashboard/moments',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/moments/use-default-forecast', () => ({ useDefaultForecast: () => ({}) }));

const { loadMomentPrep, addMomentGroceryAction, setMomentPrepDoneAction } = await import('@/app/(app)/dashboard/moment-actions');
const MomentsPage = (await import('@/app/(app)/dashboard/moments/page')).default;

// What each read answers, and every write that was attempted.
let prefsRead: Reply;
let listRead: Reply;
let itemsRead: Reply;
let writes: { table: string; rows: unknown }[];

function makeClient() {
  function from(table: string) {
    let op: 'select' | 'insert' | 'upsert' = 'select';
    let payload: unknown = null;
    const q: Record<string, unknown> = {};
    const same = () => q;
    const reply = (): Reply => {
      if (op !== 'select') {
        if (table === 'grocery_lists') return { data: { id: 'list-created' }, error: null };
        if (table === 'grocery_items') {
          const rows = Array.isArray(payload) ? payload : [payload];
          return { data: rows.map((_, i) => ({ id: `item-${i}` })), error: null };
        }
        return { data: null, error: null };
      }
      if (table === 'user_preferences') return prefsRead;
      if (table === 'grocery_lists') return listRead;
      if (table === 'grocery_items') return itemsRead;
      return { data: [], error: null, count: 0 };
    };
    Object.assign(q, {
      select: same, eq: same, is: same, not: same, gte: same, lte: same, lt: same,
      order: same, limit: same, maybeSingle: same, single: same, in: same,
      insert: (rows: unknown) => { op = 'insert'; payload = rows; writes.push({ table, rows }); return q; },
      upsert: (rows: unknown) => { op = 'upsert'; payload = rows; writes.push({ table, rows }); return q; },
      then: (resolve: (v: Reply) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(reply()).then(resolve, reject),
    });
    return q;
  }
  return { from };
}

async function renderMomentsPage() {
  const tree = await MomentsPage();
  return renderToStaticMarkup(tree as React.ReactElement);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prefsRead = { data: null, error: null };
  listRead = { data: [], error: null };
  itemsRead = { data: [], error: null };
  writes = [];
  mocks.rows.current = [EVENT];
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1', email: 'parent@example.com' },
    active: { familyId: 'fam-1', family: { id: 'fam-1', timezone: 'UTC' }, role: 'parent' },
  });
  mocks.createServer.mockImplementation(async () => makeClient());
  mocks.loadScheduleIntelligence.mockResolvedValue({ ok: true, data: { departures: {} } });
});

describe('the Moments card when the saved prep steps could not be read', () => {
  it('says so instead of counting the family back to zero', async () => {
    prefsRead = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };

    const html = await renderMomentsPage();

    expect(html, 'the page must name the failed read').toContain(PREP_FAILED);
    expect(html, 'a failed read must offer a way back').toContain(say('momentsView.tryAgain'));
    // The two claims a parent acts on. Either one sends them to redo prep they
    // already did, on the page whose only job is telling them what is left.
    expect(html, `"0/${TOTAL_STEPS}" is a claim about prep we could not read`)
      .not.toContain(`>0/${TOTAL_STEPS}<`);
    expect(html, '"need prep" counts unread ticks as undone').not.toContain(say('moments.needPrep'));
    // And nothing to tap: whether a step is done — so which way a tap goes — is
    // exactly what we could not read.
    expect(html, 'the tick boxes must be inert while the ticks are unknown').toContain('disabled=""');
    // The rows must not make the claim the hidden count stopped making: a
    // screen reader hears aria-pressed="false" and "Mark … done" as "not done".
    expect(html, 'no box may announce itself as not done').not.toContain('aria-pressed="false"');
    expect(html, 'no box may announce itself as done either').not.toContain('aria-pressed="true"');
    expect(html, 'no box may offer to mark a step done').not.toContain('aria-label="Mark ');
  });

  it('carries the failure sentence in the catalogue, not as a raw key', () => {
    // Red until the audit's i18n merge adds the key (see the note at the top).
    expect(MESSAGES['momentsView.couldNotLoadYourPrepSteps']).toBe(PREP_FAILED);
  });

  it('shows the real ticks — and no failure note — when the read succeeds', async () => {
    prefsRead = { data: { notification_prefs: { momentPrep: { 'evt-soccer': ['leave-by'] } } }, error: null };

    const html = await renderMomentsPage();

    expect(html, 'one of the steps is ticked').toContain(`>1/${TOTAL_STEPS}<`);
    expect(html, 'the strip still tallies what needs prep').toContain(say('moments.needPrep'));
    expect(html, 'nothing failed, so say nothing failed').not.toContain(PREP_FAILED);
    expect(html, 'the tick boxes stay tappable').not.toContain('disabled=""');
    // The same markup the failed case must not produce, produced here — so the
    // aria assertions above are about the failure, not about a renamed prop.
    expect(html, 'the ticked step says so').toContain('aria-pressed="true"');
    expect(html, 'the unticked steps say so').toContain('aria-pressed="false"');
  });

  it('still treats a member with no saved prep as a fresh start, not a failure', async () => {
    prefsRead = { data: null, error: null };

    const html = await renderMomentsPage();

    expect(html, 'no row is genuinely "nothing ticked yet"').toContain(`>0/${TOTAL_STEPS}<`);
    expect(html).not.toContain(PREP_FAILED);
  });

  it('reports the refused read to its caller rather than an empty set of ticks', async () => {
    prefsRead = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    await expect(loadMomentPrep()).resolves.toEqual({ ok: false });

    prefsRead = { data: { notification_prefs: { momentPrep: { 'evt-1': ['pack', 'shop'] } } }, error: null };
    await expect(loadMomentPrep()).resolves.toEqual({ ok: true, done: { 'evt-1': ['pack', 'shop'] } });
  });
});

// The screen's picture of the ticks is not always current even when the read
// worked: a back/forward navigation re-mounts /dashboard/moments from Next's
// router cache (restoreReducer reuses the cached payload, no refetch), showing
// the ticks as they stood when the page was first rendered. When a tap sent that
// picture as the event's whole done-list, the steps ticked since were deleted.
// A tap now names one step; the server merges it into what is really saved.
describe('saving one prep step', () => {
  /** The member's real blob: moments ticks beside settings that are not ours. */
  const saved = (momentPrep: Record<string, string[]>) => ({
    data: { notification_prefs: { sidebarNav: ['home', 'calendar'], momentPrep } }, error: null,
  });
  const writtenPrep = () => {
    expect(writes, 'exactly one write').toHaveLength(1);
    const row = writes[0].rows as { notification_prefs: { sidebarNav: unknown; momentPrep: unknown } };
    expect(row.notification_prefs.sidebarNav, 'other settings survive').toEqual(['home', 'calendar']);
    return row.notification_prefs.momentPrep;
  };

  it('keeps the steps a stale screen never showed when it ticks another', async () => {
    // The page was rendered with only "leave-by" ticked; "pack" was ticked after
    // that, then the parent went back to the page. The database knows both.
    prefsRead = saved({ 'evt-soccer': ['leave-by', 'pack'], 'evt-other': ['shop'] });

    await expect(setMomentPrepDoneAction({ eventId: 'evt-soccer', stepId: 'photo', done: true }))
      .resolves.toEqual({ ok: true });

    expect(writtenPrep()).toEqual({ 'evt-soccer': ['leave-by', 'pack', 'photo'], 'evt-other': ['shop'] });
  });

  it('unticks only the step it names, and drops the event once none is left', async () => {
    prefsRead = saved({ 'evt-soccer': ['leave-by', 'pack'] });
    await setMomentPrepDoneAction({ eventId: 'evt-soccer', stepId: 'pack', done: false });
    expect(writtenPrep()).toEqual({ 'evt-soccer': ['leave-by'] });

    writes = [];
    prefsRead = saved({ 'evt-soccer': ['leave-by'], 'evt-other': ['shop'] });
    await setMomentPrepDoneAction({ eventId: 'evt-soccer', stepId: 'leave-by', done: false });
    expect(writtenPrep()).toEqual({ 'evt-other': ['shop'] });
  });

  it('ticking a step that is already ticked changes nothing', async () => {
    prefsRead = saved({ 'evt-soccer': ['leave-by', 'pack'] });
    await setMomentPrepDoneAction({ eventId: 'evt-soccer', stepId: 'pack', done: true });
    expect(writtenPrep()).toEqual({ 'evt-soccer': ['leave-by', 'pack'] });
  });

  it('refuses a save that does not say which way, rather than guess "not done"', async () => {
    prefsRead = saved({ 'evt-soccer': ['leave-by', 'pack'] });
    // What a malformed request looks like once the action receives it.
    const withoutDone: Parameters<typeof setMomentPrepDoneAction>[0] = JSON.parse('{"eventId":"evt-soccer","stepId":"pack"}');

    const res = await setMomentPrepDoneAction(withoutDone);

    expect(writes, 'an unsaid direction must not untick anything').toEqual([]);
    expect(res.ok).toBe(false);
    // Red until the i18n merge lands (see the note at the top of this file).
    expect(res.error).toBe('Missing step');
  });
});

describe('adding a moment\'s snacks to the grocery list', () => {
  const SNACKS = ['Water bottles', 'Orange slices', 'Granola bars'];

  it('does not create a second "Groceries" when the list lookup fails', async () => {
    listRead = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };

    const res = await addMomentGroceryAction({ familyId: 'fam-1', items: SNACKS });

    expect(writes, 'a family with a list must not be given a second one').toEqual([]);
    expect(res.ok, 'an add that did not happen is not ok').toBe(false);
    expect(res.added).toBeUndefined();
    // Red until the i18n merge lands (see the note at the top of this file).
    expect(res.error, 'the toast says what happened, in words').toBe(LIST_UNOPENED);
  });

  it('does not re-add the same three items when the duplicate read fails', async () => {
    listRead = { data: [{ id: 'list-1' }], error: null };
    itemsRead = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };

    const res = await addMomentGroceryAction({ familyId: 'fam-1', items: SNACKS });

    // "Added 3" on a second tap is the whole defect: it reads exactly like the
    // first tap, and the shopper walks the aisle with every line twice.
    expect(writes, 'nothing may be written on a dedupe read that did not happen').toEqual([]);
    expect(res.ok).toBe(false);
    expect(res.added).toBeUndefined();
    // Red until the i18n merge lands (see the note at the top of this file).
    expect(res.error, 'the toast says what happened, in words').toBe(LIST_UNREAD);
  });

  it('still skips what is already on the list when both reads work', async () => {
    listRead = { data: [{ id: 'list-1' }], error: null };
    itemsRead = { data: [{ name: 'water bottles' }], error: null };

    const res = await addMomentGroceryAction({ familyId: 'fam-1', items: SNACKS });

    expect(res).toMatchObject({ ok: true, added: 2 });
    expect(writes).toHaveLength(1);
    expect((writes[0].rows as { name: string }[]).map((r) => r.name)).toEqual(['Orange slices', 'Granola bars']);
  });

  it('reports nothing added when every item is already there', async () => {
    listRead = { data: [{ id: 'list-1' }], error: null };
    itemsRead = { data: SNACKS.map((name) => ({ name })), error: null };

    await expect(addMomentGroceryAction({ familyId: 'fam-1', items: SNACKS }))
      .resolves.toMatchObject({ ok: true, added: 0 });
    expect(writes, 'a second tap writes nothing').toEqual([]);
  });

  it('still creates the first list for a family that genuinely has none', async () => {
    listRead = { data: [], error: null };

    const res = await addMomentGroceryAction({ familyId: 'fam-1', items: ['Water bottles'] });

    expect(res).toMatchObject({ ok: true, added: 1 });
    expect(writes.map((w) => w.table)).toEqual(['grocery_lists', 'grocery_items']);
  });
});
