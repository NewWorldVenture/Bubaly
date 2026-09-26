// "Post now" puts a message on a real brand account. Publishing the same
// occurrence twice is public and cannot be taken back.
//
// The action already writes a compare-and-set — `.eq('occurrences', ad.occurrences)`
// on the row it just read — but for a while it never read the ANSWER:
//
//     const { error: claimError } = await supabase
//       .from('marketing_recurring_ads')
//       .update({ occurrences: ad.occurrences + 1, … })
//       .eq('id', id).eq('occurrences', ad.occurrences);
//     if (claimError) return { ok: false, … };
//
// PostgREST answers an UPDATE that matched NOTHING with 204 and no body, so a
// lost race arrives as `{ data: null, error: null }` — byte for byte what a won
// race looks like when no representation was asked for. The action could not
// tell "I claimed this occurrence" from "the cron claimed it while I was
// reading", and published either way.
//
// lib/marketing/recurring-ads-runner.ts:101-119 (claimOccurrence) already does
// this correctly: `.select('id')` and then `(data?.length ?? 0) > 0`, because
// `select` is what makes PostgREST return the rows actually updated. This file
// holds the admin action to the same standard.
//
// Judged on CONNECTOR CALLS, not on row counts. The run ledger's unique index
// on (ad_id, occurrence, platform) swallows the duplicate record — so the
// admin who goes looking finds ONE clean row while TWO tweets are live. The
// provider call is the harm, so the provider call is what is counted.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  published: [] as string[],
  client: undefined as unknown as SupabaseClient<Database>,
}));

vi.mock('@/lib/social/connectors', () => ({
  getConnector: (platform: string) => ({
    publish: async ({ body }: { body: string }) => {
      state.published.push(`${platform}:${body}`);
      return { ok: true, providerObjectId: 'synthetic-object', permalinkUrl: 'https://example.test/1' };
    },
  }),
}));
vi.mock('@/lib/supabase/auth', () => ({
  isSuperAdmin: async () => true,
  getUser: async () => ({ id: ADMIN }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.client }));
vi.mock('next/cache', () => ({ revalidatePath() {} }));

import { runRecurringAdNowAction } from '@/app/(app)/admin/marketing/social/recurring/actions';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const AD = '22222222-2222-4222-8222-222222222222';
const MESSAGE = 'Bubaly keeps the whole family on the same day.';

let db: InMemorySupabase;

function seedCampaign(): void {
  db.seed('marketing_recurring_ads', [{
    id: AD, name: 'Weekly spotlight', status: 'active',
    body_variants: [MESSAGE], link: null, media_urls: [], platforms: ['x'],
    cadence: 'daily', times_of_day: [540], days_of_week: [], day_of_month: null,
    timezone: 'UTC', starts_at: '2026-03-01T00:00:00.000Z', ends_at: null,
    max_occurrences: null, next_run_at: '2026-03-15T09:00:00.000Z',
    last_run_at: null, occurrences: 0, deleted_at: null,
  }]);
}

/**
 * The production window, made deterministic: the cron tick claims the
 * occurrence BETWEEN the action's read and its compare-and-set.
 *
 * The action touches `marketing_recurring_ads` exactly twice — the read, then
 * the claim — so moving the row on just before the second one reproduces the
 * race without depending on how two promises happen to interleave.
 */
function cronClaimsBetweenReadAndWrite(inner: InMemorySupabase): InMemorySupabase {
  let touches = 0;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        touches += 1;
        if (table === 'marketing_recurring_ads' && touches === 2) {
          const row = target.table('marketing_recurring_ads')[0];
          row.occurrences = 1;
          row.last_run_at = '2026-03-15T09:00:00.000Z';
          row.next_run_at = '2026-03-16T09:00:00.000Z';
        }
        return target.from(table);
      };
    },
  }) as InMemorySupabase;
}

beforeEach(() => {
  state.published.length = 0;
  db = createInMemorySupabase({
    // The ledger's real idempotency index, so the duplicate record loses here
    // exactly as it loses in Postgres — which is why the duplicate post is
    // invisible in Run history.
    uniques: { marketing_recurring_ad_runs: [['ad_id', 'occurrence', 'platform']] },
  });
  state.client = db as unknown as SupabaseClient<Database>;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('post now publishes an occurrence once', () => {
  it('refuses instead of posting when the cron claimed the occurrence first', async () => {
    seedCampaign();
    state.client = cronClaimsBetweenReadAndWrite(db) as unknown as SupabaseClient<Database>;

    const result = await runRecurringAdNowAction(AD);

    expect(
      state.published,
      'the provider was called for an occurrence this action did not claim — the tweet went out twice',
    ).toEqual([]);
    expect(result.ok).toBe(false);
    // And it must SAY so. A green "Posted to 1 platform." over a post this
    // action never made is the part nobody would ever go looking behind.
    expect(result.ok === false && result.error).toMatch(/already/i);
  });

  it('leaves the winning claim intact when it loses the race', async () => {
    seedCampaign();
    state.client = cronClaimsBetweenReadAndWrite(db) as unknown as SupabaseClient<Database>;

    await runRecurringAdNowAction(AD);

    // The cron's claim stands: one occurrence consumed, not two, and no run
    // ledger row invented for an occurrence this action never published.
    expect(db.table('marketing_recurring_ads')[0].occurrences).toBe(1);
    expect(db.table('marketing_recurring_ad_runs')).toEqual([]);
    expect(db.table('marketing_social_posts')).toEqual([]);
  });

  it('still posts normally when nothing is racing it', async () => {
    // The positive control. A claim that refused everything would pass the
    // cases above and be worse than the bug.
    seedCampaign();

    const result = await runRecurringAdNowAction(AD);

    expect(state.published).toEqual([`x:${MESSAGE}`]);
    expect(result).toEqual({ ok: true, message: 'Posted to 1 platform.' });
    expect(db.table('marketing_recurring_ads')[0].occurrences).toBe(1);
    expect(db.table('marketing_recurring_ad_runs')).toHaveLength(1);
  });

  it('lets the NEXT occurrence be posted, so the claim is not a one-way door', async () => {
    // The other control: after a won claim the row has moved on, and a second
    // deliberate press is a different occurrence and must be allowed.
    seedCampaign();

    await runRecurringAdNowAction(AD);
    const second = await runRecurringAdNowAction(AD);

    expect(second.ok).toBe(true);
    expect(state.published).toHaveLength(2);
    expect(db.table('marketing_recurring_ad_runs').map((r) => r.occurrence)).toEqual([0, 1]);
  });
});
