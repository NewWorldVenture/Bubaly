import type { SupabaseClient } from '@supabase/supabase-js';
import type { OwnedAccount } from './durable-session';

type Step = readonly [name: string, step: () => Promise<unknown>];

/**
 * Runs every step, whatever the steps before it did, then reports each one
 * that failed. A fixture's cleanup is a list of independent obligations: a
 * context that would not close must not keep its rows, objects, grant or
 * account alive.
 *
 * What it reports is the step names and nothing else: not the original
 * errors, not their messages, not a cause. A failure here lands in the test
 * report and in CI's uploaded evidence, and a provider's or browser's error
 * text can carry what the fixture signed in with.
 */
export async function runEveryStep(steps: readonly Step[]): Promise<void> {
  const failed: string[] = [];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch {
      failed.push(name);
    }
  }
  if (failed.length) {
    throw new AggregateError(failed.map((name) => new Error(`${name} failed`)), `Fixture cleanup failed: ${failed.join(', ')}.`);
  }
}

/** Supabase answers a failure rather than throwing it. */
async function answered(request: PromiseLike<{ error: unknown }>) {
  const { error } = await request;
  if (error) throw new Error('answered with an error');
}

/**
 * The SEC-007 suite's teardown: close the context without a snapshot, then
 * delete the run's ideas, the account's attachments and its super-admin grant,
 * then dispose of the account. `db` is a factory so that even building the
 * client is one step's failure, not all of them.
 */
export function cleanUpFeedbackFixture(input: {
  close: () => Promise<void>;
  db: () => SupabaseClient;
  bucket: string;
  run: string;
  account: OwnedAccount | null;
}): Promise<void> {
  const { close, db, bucket, run, account } = input;
  const steps: Step[] = [
    ['close the context', close],
    ['delete the run’s ideas', () => answered(db().from('feedback_ideas').delete().like('title', `%${run}%`))],
  ];
  if (account) {
    steps.push(
      ['remove the account’s attachments', async () => {
        const { data, error } = await db().storage.from(bucket).list(account.userId);
        if (error) throw new Error('answered with an error');
        if (data?.length) await answered(db().storage.from(bucket).remove(data.map((o) => `${account.userId}/${o.name}`)));
      }],
      ['revoke the super-admin grant', () => answered(db().from('super_admins').delete().eq('email', account.email.toLowerCase()))],
      ['dispose of the account', () => account.dispose()],
    );
  }
  return runEveryStep(steps);
}
