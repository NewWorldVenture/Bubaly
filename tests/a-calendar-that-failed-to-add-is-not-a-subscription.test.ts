// Settings → Calendar → "Add Calendar" → paste a URL → "Add & Sync Now".
//
// addCalendarFeed (app/(app)/dashboard/sync/feeds/actions.ts) used to insert
// the calendar_feeds row, commit it, and only then try the first sync. When
// that sync failed — a school calendar behind a login (403), a timeout, a file
// over 1 MiB — it returned the error and LEFT the row. The panel keeps the
// form open with the URL still typed in on a failure, so the family's next act
// is to press the button again, and nothing stopped a second row for the same
// URL (0045 put no uniqueness on calendar_feeds.url). Three presses, three red
// "School" entries; once the URL answered, each imported the same events under
// its own feed_id, and uq_calendar_events_feed_uid (0285) is per feed, so every
// school event landed on the family calendar three times. The failed add also
// stamped the `calendar_imported` activation milestone before it failed.
//
// These tests drive the real action and the real syncFeed/parseICS against the
// in-memory Supabase, with the family's calendar_feeds uniqueness read out of
// the migrations themselves — so a duplicate is refused here exactly when the
// real database would refuse it, and not otherwise.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  fetchPublicCalendarText: vi.fn(),
  recordActivationServer: vi.fn(),
  revalidatePath: vi.fn(),
}));
// The real en-US catalogue, not a key echo: a message this action adds must
// fail here while its copy is missing from the catalogue. Four of the keys these
// cases read (calendarSync.couldNotCheckExistingFeeds, .feedSavedButNotSynced,
// .alreadySubscribedResynced, .feedUrlTooLong) are new with this fix and arrive
// with the catalogue merge that lands in the same commit; until that merge the
// cases asserting their sentences are red, which is the point.
vi.mock('@/lib/i18n/server', async () => {
  const { default: enUS } = await import('@/lib/i18n/messages/en-US.json');
  const { translate } = await import('@/lib/i18n/translate');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) =>
      translate(enUS, key, params),
  };
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({ fetchPublicCalendarText: mocks.fetchPublicCalendarText }));
vi.mock('@/lib/analytics/activation-server', () => ({ recordActivationServer: mocks.recordActivationServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { addCalendarFeed } from '@/app/(app)/dashboard/sync/feeds/actions';
import { feedAddedMessage } from '@/lib/calendar/feeds';
import { getTranslations } from '@/lib/i18n/server';

const FAMILY = 'family-1';
const USER = 'user-1';
const PASTED = 'webcal://school.example/district.ics';
const STORED = 'https://school.example/district.ics';
const PROVIDER_DOWN = 'Calendar provider could not be reached.';

// What the family reads, in English, as the catalogue will carry it.
const savedButNotSynced = (error: string) =>
  `This calendar was saved but could not be synced (${error}). Use Sync on it in your calendar list to try again instead of adding it a second time.`;
const COULD_NOT_CHECK =
  'We could not check which calendars your family already subscribes to, so nothing was added. Please try again.';
const alreadySubscribedAs = (name: string) =>
  `You already subscribe to this calendar as “${name}”, so it was synced again instead of being added twice.`;

const SCHOOL_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:term-start@school.example',
  'SUMMARY:First day of term',
  'DTSTART;VALUE=DATE:20261005',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:sports-day@school.example',
  'SUMMARY:Sports day',
  'DTSTART:20261016T090000Z',
  'DTEND:20261016T150000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

/**
 * Every unique key the migrations put on public.calendar_feeds — read from the
 * SQL, not restated here, so the fake refuses a duplicate only if Postgres would.
 */
function calendarFeedUniquesFromMigrations(): string[][] {
  const keys: string[][] = [];
  for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '');
    const index = /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?\w+\s+on\s+public\.calendar_feeds\s*\(([^)]*)\)/gi;
    for (const match of sql.matchAll(index)) keys.push(match[1].split(',').map((c) => c.trim()));
  }
  return keys;
}

const FEED_UNIQUES = calendarFeedUniquesFromMigrations();

let db: InMemorySupabase;

function household(): InMemorySupabase {
  return createInMemorySupabase({
    uniques: {
      calendar_feeds: FEED_UNIQUES,
      calendar_events: [['feed_id', 'external_uid']],
    },
    defaults: {
      calendar_feeds: { color: 'blue', last_status: 'pending', last_error: null, last_synced_at: null, event_count: 0 },
    },
  });
}

const reachable = () => ({ ok: true as const, url: STORED, text: SCHOOL_ICS });
const unreachable = () => ({ ok: false as const, error: PROVIDER_DOWN, status: 422 });

/** What Settings → Calendar lists for this family. */
const subscriptions = () => db.table('calendar_feeds').filter((f) => f.family_id === FAMILY);
/** What lands on the family calendar from feeds. */
const importedEvents = () => db.table('calendar_events').filter((e) => e.family_id === FAMILY && e.feed_id);

/** Make one operation on calendar_feeds answer the way a refused request does. */
function refuseOnCalendarFeeds(op: 'lookup' | 'delete', reply: { data: unknown; error: unknown }) {
  const realFrom = db.from.bind(db);
  const answered = { count: null, status: reply.error ? 500 : 200, statusText: reply.error ? 'Error' : 'OK', ...reply };
  const refused: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve(answered).then(resolve);
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(answered);
      return () => refused;
    },
  });
  vi.spyOn(db, 'from').mockImplementation(((table: string) => {
    const builder = realFrom(table) as unknown as Record<string | symbol, unknown>;
    if (table !== 'calendar_feeds') return builder;
    let writing = false;
    return new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === 'insert' || prop === 'update' || prop === 'upsert') writing = true;
        if (op === 'delete' && prop === 'delete') return () => refused;
        if (op === 'lookup' && prop === 'select' && !writing) return () => refused;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }) as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.fetchPublicCalendarText.mockReset();
  mocks.recordActivationServer.mockReset();
  mocks.revalidatePath.mockReset();
  db = household();
  mocks.createServer.mockImplementation(async () => db);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: USER, email: 'parent@example.com' },
    active: { familyId: FAMILY, family: { created_at: '2026-09-01T00:00:00.000Z' } },
  });
});

describe('a calendar whose first sync fails', () => {
  it('is not left behind in the family’s calendar list, and does not count as an import', async () => {
    mocks.fetchPublicCalendarText.mockResolvedValueOnce(unreachable());

    const result = await addCalendarFeed({ name: 'School', url: PASTED });

    expect(result).toEqual({ ok: false, error: PROVIDER_DOWN });
    expect(subscriptions()).toEqual([]);
    expect(importedEvents()).toEqual([]);
    expect(mocks.recordActivationServer).not.toHaveBeenCalled();
  });

  it('can be retried with the same button, and the retry leaves ONE subscription with each event once', async () => {
    mocks.fetchPublicCalendarText
      .mockResolvedValueOnce(unreachable())
      .mockResolvedValueOnce(unreachable())
      .mockResolvedValueOnce(reachable());

    expect((await addCalendarFeed({ name: 'School', url: PASTED })).ok).toBe(false);
    expect((await addCalendarFeed({ name: 'School', url: PASTED })).ok).toBe(false);
    const third = await addCalendarFeed({ name: 'School', url: PASTED });

    expect(third).toEqual({ ok: true, imported: 2 });
    const [only, ...extra] = subscriptions();
    expect(extra).toEqual([]);
    expect(only).toMatchObject({ name: 'School', url: STORED, last_status: 'ok', last_error: null, event_count: 2 });
    expect(importedEvents().map((e) => [e.feed_id, e.external_uid]).sort()).toEqual([
      [only.id, 'sports-day@school.example'],
      [only.id, 'term-start@school.example'],
    ]);
    expect(mocks.recordActivationServer).toHaveBeenCalledTimes(1);
  });

  it('when the unfilled row cannot be removed, tells the family it WAS saved — and a retry reuses it', async () => {
    refuseOnCalendarFeeds('delete', { data: null, error: { code: '42501', message: 'permission denied for table calendar_feeds', details: null, hint: null } });
    mocks.fetchPublicCalendarText.mockResolvedValueOnce(unreachable()).mockResolvedValueOnce(reachable());

    const first = await addCalendarFeed({ name: 'School', url: PASTED });

    // The message must match what the list now shows: one saved, failing entry.
    expect(first).toEqual({ ok: false, error: savedButNotSynced(PROVIDER_DOWN) });
    expect(subscriptions()).toHaveLength(1);
    expect(subscriptions()[0]).toMatchObject({ last_status: 'error', last_error: PROVIDER_DOWN });
    const savedId = subscriptions()[0].id;

    const retry = await addCalendarFeed({ name: 'School', url: PASTED });

    expect(retry).toEqual({ ok: true, imported: 2, alreadySubscribedAs: 'School' });
    expect(subscriptions().map((f) => f.id)).toEqual([savedId]);
    expect(new Set(importedEvents().map((e) => e.feed_id))).toEqual(new Set([savedId]));
  });

  it('a delete that quietly removed nothing is not taken as a removal', async () => {
    refuseOnCalendarFeeds('delete', { data: [], error: null });
    mocks.fetchPublicCalendarText.mockResolvedValueOnce(unreachable());

    const result = await addCalendarFeed({ name: 'School', url: PASTED });

    expect(result).toEqual({ ok: false, error: savedButNotSynced(PROVIDER_DOWN) });
    expect(subscriptions()).toHaveLength(1);
  });

  it('is kept when another member’s add of the same URL synced it while this first fetch was still out', async () => {
    // The row is visible from its insert until the rollback — the whole first
    // fetch, up to its 15 s timeout — so a second add of the URL finds it and
    // syncs it. Undoing "the row I created" must not undo that member's import.
    let answerFirstFetch: (reply: ReturnType<typeof unreachable>) => void = () => {
      throw new Error('the first add has not started its fetch');
    };
    mocks.fetchPublicCalendarText
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirstFetch = resolve; }))
      .mockResolvedValueOnce(reachable());

    const first = addCalendarFeed({ name: 'School', url: PASTED });
    await vi.waitFor(() => expect(mocks.fetchPublicCalendarText).toHaveBeenCalledTimes(1));
    const [created, ...none] = subscriptions();
    expect(none).toEqual([]);

    const second = await addCalendarFeed({ name: 'Kids school', url: PASTED });
    expect(second).toEqual({ ok: true, imported: 2, alreadySubscribedAs: 'School' });

    answerFirstFetch(unreachable());
    const firstResult = await first;

    // The first add's own sync did fail, and the calendar IS in the list.
    expect(firstResult).toEqual({ ok: false, error: savedButNotSynced(PROVIDER_DOWN) });
    expect(subscriptions().map((f) => f.id)).toEqual([created.id]);
    expect(importedEvents().map((e) => [e.feed_id, e.external_uid]).sort()).toEqual([
      [created.id, 'sports-day@school.example'],
      [created.id, 'term-start@school.example'],
    ]);
  });
});

describe('a calendar the family already subscribes to', () => {
  const EXISTING = 'feed-school';

  beforeEach(() => {
    db.seed('calendar_feeds', [{
      id: EXISTING, family_id: FAMILY, name: 'School', url: STORED, color: 'green',
      last_status: 'ok', last_error: null, last_synced_at: '2026-09-20T02:00:00.000Z', event_count: 1,
      created_by: USER, created_at: '2026-09-10T08:00:00.000Z',
    }]);
    db.seed('calendar_events', [{
      id: 'ev-term', family_id: FAMILY, feed_id: EXISTING, external_uid: 'term-start@school.example',
      title: 'First day of term', starts_at: '2026-10-05T00:00:00.000Z', all_day: true,
    }]);
  });

  it('is re-synced when added again, not added a second time', async () => {
    mocks.fetchPublicCalendarText.mockResolvedValueOnce(reachable());

    const result = await addCalendarFeed({ name: 'Kids school', url: PASTED });

    // Not "Added": the name typed on this add was not applied, so the panel
    // names the subscription it actually synced.
    expect(result).toEqual({ ok: true, imported: 2, alreadySubscribedAs: 'School' });
    expect(feedAddedMessage(result.ok ? result : {}, await getTranslations())).toBe(alreadySubscribedAs('School'));
    expect(subscriptions().map((f) => f.id)).toEqual([EXISTING]);
    expect(subscriptions()[0]).toMatchObject({ name: 'School', color: 'green' });
    expect(importedEvents()).toHaveLength(2);
    expect(new Set(importedEvents().map((e) => e.feed_id))).toEqual(new Set([EXISTING]));
  });

  it('is kept, with its events, when that re-sync fails', async () => {
    mocks.fetchPublicCalendarText.mockResolvedValueOnce(unreachable());

    const result = await addCalendarFeed({ name: 'School', url: PASTED });

    expect(result).toEqual({ ok: false, error: PROVIDER_DOWN });
    expect(subscriptions().map((f) => f.id)).toEqual([EXISTING]);
    expect(subscriptions()[0]).toMatchObject({ last_status: 'error', last_error: PROVIDER_DOWN });
    expect(importedEvents().map((e) => e.id)).toEqual(['ev-term']);
  });
});

describe('two adds of the same calendar at the same moment', () => {
  it('the one that loses the race syncs the winner’s subscription instead of failing or duplicating', async () => {
    // The database must be what refuses the second row: a lookup in the action
    // cannot see an insert that has not landed yet.
    expect(FEED_UNIQUES).toContainEqual(['family_id', 'url']);

    // The other member's insert lands between this add's lookup and its insert.
    const realFrom = db.from.bind(db);
    let raced = false;
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const builder = realFrom(table) as unknown as Record<string | symbol, unknown>;
      if (table !== 'calendar_feeds') return builder;
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (prop === 'insert' && !raced) {
            raced = true;
            db.seed('calendar_feeds', [{ id: 'feed-winner', family_id: FAMILY, name: 'School', url: STORED, created_by: 'user-2' }]);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    }) as never);
    mocks.fetchPublicCalendarText.mockResolvedValueOnce(reachable());

    const result = await addCalendarFeed({ name: 'School', url: PASTED });

    expect(raced).toBe(true);
    expect(result).toEqual({ ok: true, imported: 2, alreadySubscribedAs: 'School' });
    expect(subscriptions().map((f) => f.id)).toEqual(['feed-winner']);
    expect(new Set(importedEvents().map((e) => e.feed_id))).toEqual(new Set(['feed-winner']));
  });
});

describe('a lookup of the family’s calendars that fails', () => {
  it('adds nothing and says so, rather than inserting blind', async () => {
    refuseOnCalendarFeeds('lookup', { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } });

    const result = await addCalendarFeed({ name: 'School', url: PASTED });

    expect(result).toEqual({ ok: false, error: COULD_NOT_CHECK });
    expect(subscriptions()).toEqual([]);
    expect(mocks.fetchPublicCalendarText).not.toHaveBeenCalled();
  });
});

describe('a link longer than the one-subscription-per-URL index can hold', () => {
  // uq_calendar_feeds_family_url (0363) is a btree over url; Postgres refuses an
  // entry over ~2.7 KB with 54000, whose raw message would reach the family.
  const BASE = `${STORED}?token=`;
  const ofLength = (n: number) => BASE + 'a'.repeat(n - BASE.length);

  it('is refused with a message the family can act on, before anything is looked up, saved or fetched', async () => {
    const lookups = vi.spyOn(db, 'from');

    const result = await addCalendarFeed({ name: 'School', url: ofLength(2049) });

    expect(result).toEqual({
      ok: false,
      error: 'That link is longer than 2048 characters, which is more than a calendar link needs. Check that you copied only the calendar’s ICS or webcal:// link.',
    });
    expect(lookups).not.toHaveBeenCalled();
    expect(subscriptions()).toEqual([]);
    expect(mocks.fetchPublicCalendarText).not.toHaveBeenCalled();
  });

  it('is still accepted at exactly the limit', async () => {
    mocks.fetchPublicCalendarText.mockResolvedValueOnce(reachable());

    const result = await addCalendarFeed({ name: 'School', url: ofLength(2048) });

    expect(result).toEqual({ ok: true, imported: 2 });
    expect(feedAddedMessage(result.ok ? result : {}, await getTranslations())).toBe('Added — 2 events imported');
    expect(subscriptions().map((f) => f.url)).toEqual([ofLength(2048)]);
  });
});
