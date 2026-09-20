// A post published twice is public and unrecoverable.
//
// `runPublishNow` already claims each target before calling the connector:
//
//     .from('social_post_targets')
//     .update({ status: 'publishing', updated_by: userId })
//     .eq('id', target.id).eq('family_id', familyId)
//     .select('id').single()
//
// but the claim carried no precondition, so it was a claim in shape only. Two
// runs that both read the target list while every target was still 'pending' —
// a double-click, or the UI and a retry — both wrote 'publishing' and both
// called the connector. The family's post goes out twice, to a real audience.
//
// This is the same defect, in a different file, as the allowance rule the cron
// re-credited: the UPDATE that is supposed to be the claim has to carry the
// condition that makes it exclusive, and it has to read 0 rows as "somebody
// else has it" rather than as an error. `.in('status', ['pending','failed'])`
// is exactly the filter the target SELECT above it uses, so the two cannot
// drift apart, and `.maybeSingle()` is load-bearing: 0 rows is now expected.
//
// Judged on CONNECTOR CALLS, not on row counts — the harm is the provider call,
// and a run that records one row while making two calls has still posted twice.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const calls = vi.hoisted(() => ({ published: [] as string[] }));

vi.mock('@/lib/social/connectors', () => ({
  getConnector: (platform: string) => ({
    publish: async ({ body }: { body: string }) => {
      calls.published.push(`${platform}:${body}`);
      return { ok: true, status: 'published', providerObjectId: 'p1', permalinkUrl: 'https://example.test/p1' };
    },
  }),
}));

const { runPublishNow } = await import('@/lib/social/publish');

type DB = SupabaseClient<Database>;
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const POST = '00000000-0000-4000-8000-0000000000e1';
const TARGET = '00000000-0000-4000-8000-0000000000d1';
const ACCOUNT = '00000000-0000-4000-8000-0000000000c1';

let db: ReturnType<typeof createInMemorySupabase<DB>>;

beforeEach(() => {
  calls.published.length = 0;
  db = createInMemorySupabase<DB>();
  db.seed('social_posts', [{ id: POST, family_id: FAMILY, status: 'scheduled', body: 'Sports day photos!', link: null, kind: 'text', approval_status: 'not_required', metadata: {}, deleted_at: null }]);
  db.seed('social_accounts', [{ id: ACCOUNT, family_id: FAMILY, platform: 'facebook', provider_account_id: 'synthetic-provider-account', deleted_at: null }]);
  db.seed('social_post_targets', [{ id: TARGET, post_id: POST, family_id: FAMILY, platform: 'facebook', account_id: ACCOUNT, status: 'pending', metadata: {} }]);
  db.seed('social_post_variants', []);
});

describe('a social post is published to each target once', () => {
  it('publishes once when two runs race for the same target', async () => {
    // Both runs start before either has claimed anything — the production
    // race, reproduced by letting them interleave on their own awaits.
    const results = await Promise.allSettled([
      runPublishNow(db as unknown as DB, FAMILY, POST, 'user-1'),
      runPublishNow(db as unknown as DB, FAMILY, POST, 'user-1'),
    ]);

    expect(
      calls.published,
      'the connector was called more than once for one target — the post went out twice',
    ).toHaveLength(1);

    // Exactly one run does the work; the other is refused, not crashed into a
    // half-published state.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    // And the loser must not roll its empty outcome over the winner's result.
    // Returning a "successful" publish of no targets was the first shape of
    // this fix, and it clobbered the post back out of 'published'.
    expect((db.table('social_posts')[0] as { status: string }).status).toBe('published');
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toContain('already being published');
  });

  it('still publishes normally when nothing is racing it', async () => {
    // The positive control. A claim that refused everything would pass the
    // case above and be useless.
    const outcome = await runPublishNow(db as unknown as DB, FAMILY, POST, 'user-1');
    expect(calls.published).toEqual(['facebook:Sports day photos!']);
    expect(outcome.targets).toHaveLength(1);
    expect(outcome.targets[0].status).toBe('published');
    expect((db.table('social_posts')[0] as { status: string }).status).toBe('published');
  });

  it('lets a failed target be retried', async () => {
    // The other control: the claim's filter must match the SELECT above it, or
    // a genuine retry of a failed target stops working.
    db.replace('social_post_targets', [
      { id: TARGET, post_id: POST, family_id: FAMILY, platform: 'facebook', account_id: ACCOUNT, status: 'failed', metadata: {} },
    ]);
    await runPublishNow(db as unknown as DB, FAMILY, POST, 'user-1');
    expect(calls.published).toEqual(['facebook:Sports day photos!']);
  });
});
