// A campaign the scheduler has already closed must not post because someone
// pressed a button.
//
// The recurring-ads subsystem opens by naming the one mistake it cannot undo:
// "a duplicated post is a visible mistake on a public account that cannot be
// taken back" (lib/marketing/recurring-ads-runner.ts). The cron path honours
// that — runDueRecurringAds hands every row to decideRun, which refuses
// `window_closed` past ends_at and then RETIRES the row: status 'paused',
// next_run_at null.
//
// The admin "Post now" button did not. runRecurringAdNowAction checked the
// occurrence cap and nothing else, while its own docstring promised "'Run now'
// cannot be used to sneak past an occurrence cap OR AN END DATE — the same
// accounting the cron runner uses". And because a window-closed campaign is
// stored exactly like a hand-paused one, the admin list badged it "Paused",
// which is an invitation to start it again. One click and last December's
// holiday promo went out to the live X / LinkedIn / Instagram accounts in
// September, with a marketing_social_posts row recording it as intended.
//
// So these tests are written at the only level where that is visible: the
// connector's publish call. `getConnector(...).publish` is the moment the post
// leaves Bubaly. The assertion is that it is never reached for a closed
// campaign — not that some flag was set — and the open-window cases are here so
// a fix that simply stops posting altogether cannot pass either.
//
// Nothing here is family-scoped: marketing_* tables are service-role-only by
// design (0282), and the gate is isSuperAdmin, which is correct and untouched.
// The loser of this bug is Bubaly's own brand accounts.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  publish: vi.fn(),
  ad: null as Row | null,
  updates: [] as Row[],
  inserts: [] as { table: string; row: Row }[],
}));

/**
 * A PostgREST-shaped stub: every builder call returns something that is both
 * chainable and awaitable, because this module terminates a chain three
 * different ways — `.maybeSingle()`, `.select('id')`, and awaiting `.eq()`
 * directly.
 */
function chain(result: () => Promise<{ data: unknown; error: unknown }>) {
  const node = {
    select: () => chain(result),
    eq: () => chain(result),
    is: () => chain(result),
    maybeSingle: () => result(),
    single: () => result(),
    then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => result().then(onOk, onErr),
  };
  return node as unknown as never;
}

function fakeClient() {
  return {
    from(table: string) {
      return {
        select: () => chain(async () => ({
          data: table === 'marketing_recurring_ads' ? state.ad : [],
          error: null,
        })),
        // Recorded when the action DECIDES to write, which is what "nothing was
        // written" has to mean: an early refusal never gets this far.
        update: (patch: Row) => {
          state.updates.push(patch);
          return chain(async () => ({ data: [{ id: 'ad-1' }], error: null }));
        },
        insert: (row: Row) => {
          state.inserts.push({ table, row });
          return chain(async () => ({ data: { id: 'post-1' }, error: null }));
        },
      };
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// '@/lib/i18n/server' is deliberately NOT mocked: the refusal is read through
// the real translator and the real en-US catalogue (outside a request it
// resolves the default locale), so a key missing from the catalogue fails here
// instead of reaching the operator as 'adminMarketingSocial.endDateHasPassed'.
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => fakeClient() }));
vi.mock('@/lib/supabase/auth', () => ({
  isSuperAdmin: async () => true,
  getUser: async () => ({ id: 'admin-1' }),
}));
vi.mock('@/lib/social/connectors', () => ({ getConnector: () => ({ publish: state.publish }) }));

import {
  runRecurringAdNowAction, setRecurringAdStatusAction,
} from '@/app/(app)/admin/marketing/social/recurring/actions';
import { campaignFinished, runDueRecurringAds, type AdRow } from '@/lib/marketing/recurring-ads-runner';

// The English the operator reads. RED until the central catalogue merge adds
// adminMarketingSocial.endDateHasPassed to lib/i18n/messages/en-US.json (asked
// for in the i18n-asks file for this fix); translate() hands back the bare key
// until then, and this is the assertion that notices.
const END_DATE_HAS_PASSED =
  "This campaign's end date has already passed, so it will not be posted. Change the end date first if you want it to run again.";

const NOW = '2026-09-21T12:00:00.000Z';

/** Last December's daily 09:00 promo, 25 posts in, cap nowhere near. */
function holidayPromo(over: Row = {}): Row {
  return {
    id: 'ad-1', name: 'Holiday promo', status: 'paused',
    body_variants: ['Happy holidays from Bubaly!'], link: null, media_urls: [],
    platforms: ['x'],
    cadence: 'daily', times_of_day: [9 * 60], days_of_week: [], day_of_month: null, timezone: 'UTC',
    starts_at: '2025-12-01T00:00:00Z',
    ends_at: '2025-12-26T23:59:00Z',
    max_occurrences: 100, occurrences: 25,
    next_run_at: null, last_run_at: '2025-12-26T09:00:00Z',
    deleted_at: null,
    ...over,
  };
}

const adsUpdates = () => state.updates.filter((u) => 'occurrences' in u || 'next_run_at' in u);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  state.publish.mockReset();
  state.publish.mockResolvedValue({ ok: true, providerObjectId: 'p1', permalinkUrl: 'https://example.invalid/p1' });
  state.updates = [];
  state.inserts = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('post now honours the end date, not only the occurrence cap', () => {
  it('sends nothing to the brand accounts for a campaign whose window has closed', async () => {
    state.ad = holidayPromo();

    const result = await runRecurringAdNowAction('ad-1');

    // The thing that cannot be taken back: no post left Bubaly.
    expect(state.publish).not.toHaveBeenCalled();
    // And no record claims one did.
    expect(state.inserts).toEqual([]);
    expect(result).toEqual({ ok: false, error: END_DATE_HAS_PASSED });
  });

  it('does not consume an occurrence or re-arm a schedule it refused', async () => {
    state.ad = holidayPromo();

    await runRecurringAdNowAction('ad-1');

    // Before the fix this row came back as occurrences 26 with next_run_at
    // 2026-09-22T09:00Z — nine months past a window that shut in December, and
    // the admin list's "Next post" column read it out as a real date.
    expect(adsUpdates()).toEqual([]);
  });

  it('still refuses when the campaign was left active rather than retired', async () => {
    // The cron retires a closed campaign, but only on its next tick. Between
    // the end date and that tick the row is still 'active', and the refusal
    // must not depend on someone else having tidied up first.
    state.ad = holidayPromo({ status: 'active', next_run_at: '2025-12-27T09:00:00Z' });

    const result = await runRecurringAdNowAction('ad-1');

    expect(state.publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });

  it('refuses a stored end date it cannot read, instead of treating it as absent', async () => {
    // `now > NaN` is false, so the obvious comparison waves an unreadable
    // window through as though none had been set. Fail closed.
    state.ad = holidayPromo({ ends_at: 'not-a-date' });

    expect(await runRecurringAdNowAction('ad-1')).toMatchObject({ ok: false });
    expect(state.publish).not.toHaveBeenCalled();
  });
});

describe('a campaign still inside its window posts exactly as before', () => {
  it('posts on demand and counts it as an occurrence', async () => {
    state.ad = holidayPromo({ ends_at: '2027-01-01T00:00:00Z' });

    const result = await runRecurringAdNowAction('ad-1');

    expect(state.publish).toHaveBeenCalledTimes(1);
    expect(state.publish.mock.calls[0][0]).toMatchObject({ platform: 'x', body: 'Happy holidays from Bubaly!' });
    expect(result).toMatchObject({ ok: true });
    expect(adsUpdates()[0]).toMatchObject({ occurrences: 26, next_run_at: '2026-09-22T09:00:00.000Z' });
  });

  it('posts with no end date set at all', async () => {
    state.ad = holidayPromo({ ends_at: null });

    expect(await runRecurringAdNowAction('ad-1')).toMatchObject({ ok: true });
    expect(state.publish).toHaveBeenCalledTimes(1);
  });

  it('never advertises a next post beyond the end date', async () => {
    // Window shuts tonight; the next daily slot is tomorrow at 09:00. The post
    // itself is legitimate — the schedule it leaves behind must not be.
    state.ad = holidayPromo({ status: 'active', ends_at: '2026-09-22T00:00:00Z' });

    expect(await runRecurringAdNowAction('ad-1')).toMatchObject({ ok: true });
    expect(state.publish).toHaveBeenCalledTimes(1);
    // Retired in the same write, as the cron's claim retires it. A null
    // next_run_at on a row left 'active' would sit outside the due index with
    // nothing ever coming back to retire it.
    expect(adsUpdates()[0]).toMatchObject({ occurrences: 26, next_run_at: null, status: 'paused' });
  });

  it('arms nothing after the post that uses the last occurrence the cap allows', async () => {
    state.ad = holidayPromo({ status: 'active', ends_at: '2027-01-01T00:00:00Z', max_occurrences: 26 });

    expect(await runRecurringAdNowAction('ad-1')).toMatchObject({ ok: true });
    expect(adsUpdates()[0]).toMatchObject({ occurrences: 26, next_run_at: null, status: 'paused' });
  });

  it('leaves the status alone while a run is still left to arm', async () => {
    state.ad = holidayPromo({ status: 'active', ends_at: '2027-01-01T00:00:00Z' });

    await runRecurringAdNowAction('ad-1');

    expect(adsUpdates()[0]).not.toHaveProperty('status');
  });
});

describe('resuming a campaign cannot reopen a closed window', () => {
  it('refuses to resume a campaign whose end date has passed', async () => {
    state.ad = holidayPromo();

    const result = await setRecurringAdStatusAction('ad-1', 'active');

    expect(result).toEqual({
      ok: false,
      error: 'This campaign has no future run left. Edit its schedule or end date.',
    });
    // Not merely a message: the row is not flipped back to active with a
    // next_run_at past its own window.
    expect(state.updates).toEqual([]);
  });

  it('resumes one that is still inside its window', async () => {
    state.ad = holidayPromo({ ends_at: '2027-01-01T00:00:00Z' });

    expect(await setRecurringAdStatusAction('ad-1', 'active')).toMatchObject({ ok: true });
    expect(state.updates[0]).toMatchObject({ status: 'active', next_run_at: '2026-09-22T09:00:00.000Z' });
  });
});

describe('the cron leaves no next post past the window either', () => {
  // The same re-arm on the automated path. decideRun used to hand the claim the
  // raw next slot, so after a campaign's last in-window post the admin list
  // showed a "Next post" the window would refuse, until that slot came due and
  // the runner retired the row.
  function seedCampaign(endsAt: string) {
    const db = createInMemorySupabase();
    db.seed('marketing_recurring_ads', [holidayPromo({
      status: 'active', starts_at: '2026-09-01T00:00:00.000Z', ends_at: endsAt,
      next_run_at: '2026-09-21T09:00:00.000Z', occurrences: 20,
    })]);
    return db;
  }

  it('retires the campaign in the claim that posts its last in-window slot', async () => {
    // Window shuts at midnight; the next daily slot is tomorrow at 09:00.
    const db = seedCampaign('2026-09-22T00:00:00.000Z');

    await runDueRecurringAds(db as unknown as SupabaseClient<Database>, new Date(NOW));

    expect(state.publish).toHaveBeenCalledTimes(1);
    expect(db.table('marketing_recurring_ads')[0]).toMatchObject({
      occurrences: 21, next_run_at: null, status: 'paused',
    });
  });

  it('re-arms the next slot, still active, while the window is open', async () => {
    const db = seedCampaign('2027-01-01T00:00:00.000Z');

    await runDueRecurringAds(db as unknown as SupabaseClient<Database>, new Date(NOW));

    expect(state.publish).toHaveBeenCalledTimes(1);
    expect(db.table('marketing_recurring_ads')[0]).toMatchObject({
      occurrences: 21, next_run_at: '2026-09-22T09:00:00.000Z', status: 'active',
    });
  });
});

describe('the admin list badges a finished campaign "Finished", not "Paused"', () => {
  // campaignFinished is what page.tsx badges and what hides Pause/Resume in
  // RecurringAdControls. "Paused" on a campaign that cannot run again invites
  // Resume or Post now; "Finished" does not.
  const at = new Date(NOW);
  const finished = (over: Row) => campaignFinished(holidayPromo(over) as unknown as AdRow, at);

  it('calls a campaign past its end date finished, whether or not the cron has retired it yet', () => {
    expect(finished({ status: 'paused' })).toBe(true);
    expect(finished({ status: 'active' })).toBe(true);
  });

  it('calls a campaign finished once its cap is reached', () => {
    expect(finished({ status: 'active', ends_at: '2027-01-01T00:00:00Z', max_occurrences: 25 })).toBe(true);
  });

  it('calls a retired campaign finished before its end date when no slot is left inside it', () => {
    // What the claim leaves behind after the last in-window post: stored
    // exactly like a hand-paused campaign, and Resume would be refused.
    expect(finished({ status: 'paused', ends_at: '2026-09-22T00:00:00Z' })).toBe(true);
  });

  it('leaves a hand-paused campaign with runs left as paused, so Resume is still offered', () => {
    expect(finished({ status: 'paused', ends_at: '2027-01-01T00:00:00Z' })).toBe(false);
    expect(finished({ status: 'paused', ends_at: null })).toBe(false);
  });

  it('does not judge a running campaign by slot arithmetic, where a due slot may still be pending', () => {
    expect(finished({ status: 'active', ends_at: '2026-09-22T00:00:00Z' })).toBe(false);
    expect(finished({ status: 'active', ends_at: '2027-01-01T00:00:00Z' })).toBe(false);
  });

  it('is what the page actually badges', () => {
    const page = readFileSync('app/(app)/admin/marketing/social/recurring/page.tsx', 'utf8');
    expect(page).toContain('const finished = campaignFinished(ad, now);');
    expect(page).toContain('finished={finished}');
  });
});
