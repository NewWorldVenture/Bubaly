import type { SupabaseClient } from '@supabase/supabase-js';
import type { OwnedAccount } from './durable-session';

type Step = readonly [name: string, step: () => Promise<unknown>];

/**
 * Runs every step, whatever the steps before it did, then reports each one
 * that failed. A fixture's cleanup is a list of independent obligations: a
 * context that would not close must not keep its rows, objects, grant or
 * account alive. The message names steps only, never a credential.
 */
export async function runEveryStep(steps: readonly Step[]): Promise<void> {
  const failed: string[] = [];
  const errors: unknown[] = [];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      failed.push(name);
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, `Fixture cleanup failed: ${failed.join(', ')}.`);
}

/** Supabase answers a failure rather than throwing it. */
async function answered(what: string, request: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await request;
  if (error) throw new Error(`${what}: ${error.message}`);
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
    ['delete the run’s ideas', () => answered('feedback_ideas', db().from('feedback_ideas').delete().like('title', `%${run}%`))],
  ];
  if (account) {
    steps.push(
      ['remove the account’s attachments', async () => {
        const { data, error } = await db().storage.from(bucket).list(account.userId);
        if (error) throw new Error(`list ${bucket}: ${error.message}`);
        if (data?.length) await answered(`remove from ${bucket}`, db().storage.from(bucket).remove(data.map((o) => `${account.userId}/${o.name}`)));
      }],
      ['revoke the super-admin grant', () => answered('super_admins', db().from('super_admins').delete().eq('email', account.email.toLowerCase()))],
      ['dispose of the account', () => account.dispose()],
    );
  }
  return runEveryStep(steps);
}
