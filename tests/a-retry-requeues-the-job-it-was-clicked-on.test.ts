// The Retry button on /admin/marketing/platform's Generation queue card.
//
// It used to CLONE the job: mint `${job.id}:manual:${Date.now()}` as a fresh
// idempotency key, insert a brand-new row, and leave the original exactly where
// it was. Both halves of that are load-bearing.
//
// Nothing else in the system moves a row out of 'failed'/'dead_letter' —
// `finishJob` and `failJob` both carry `.eq('status','running')`, and
// `claim_marketing_generation_jobs` (0237) only recovers stale *running* leases.
// So the failed row stayed failed forever: the "Jobs needing review" tile
// (page.tsx counts failed + dead_letter) could never return to healthy, and
// page.tsx renders Retry for exactly those two statuses, so the button never went
// away either. Which is what invites the second and third click.
//
// And a fresh key defeats the ON CONFLICT dedup in
// `enqueueMarketingGenerationJob` on purpose, so each of those clicks queued
// ANOTHER full `regenerate_page` job. Every one of those is a separate model
// completion (platform.ts `generateWithAI`) that overwrites the live, published
// marketing page's title/summary/body/content/seo — `runRegeneration` has no
// draft/published filter — and upserts `marketing_page_versions` on
// (page_id, version), clobbering the snapshot that version could be rolled back
// to. Three impatient clicks meant three rewrites of public marketing copy and
// three model calls for work the operator asked for once.
//
// These cases drive the REAL server action and the REAL queue worker against one
// in-memory Postgres stand-in, and assert what the operator sees on the queue
// card and what a visitor reads on the page — not that a particular query ran.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  db: null as unknown,
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  /** Every prompt the marketing generator sent, in order. */
  prompts: [] as string[],
}));

vi.mock('next/cache', () => ({
  revalidatePath: state.revalidatePath,
  revalidateTag: state.revalidateTag,
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => state.db }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: state.db, actorId: 'admin-1', actorEmail: 'admin@example.test' }),
  logMarketingAudit: state.audit,
  marketingActionFailure: (operation: string, error: unknown) => {
    throw new Error(`Could not ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  },
}));
// A configured provider that writes visibly different copy on every call, so
// "how many times was the live page rewritten" is a question the page body
// answers by itself.
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({
    complete: async ({ messages }: { messages: { content: string }[] }) => {
      state.prompts.push(messages.map((message) => message.content).join('\n'));
      const draft = state.prompts.length;
      return {
        text: JSON.stringify({
          title: 'Meal planning',
          summary: `Draft ${draft}: Bubaly builds the week from what your family already eats.`,
          body: `Draft ${draft} body.`,
          content: { sections: [{ type: 'prose', body: `Draft ${draft} body.` }] },
          seo: { title: 'Meal planning | Bubaly', description: `Draft ${draft}`, keywords: ['meal planning'], canonical: '/features/meal-planning' },
          aeo: { questions: [{ question: 'How does Bubaly plan meals?', answer: `Draft ${draft} answer.` }] },
        }),
      };
    },
  }),
}));

import { retryMarketingJob } from '@/app/(app)/admin/marketing/platform/actions';
import { processMarketingGenerationJobs } from '@/lib/marketing/platform';

const DEFAULTS = {
  marketing_generation_jobs: {
    job_type: 'regenerate_page', target_type: 'marketing_page', target_id: null, target_path: null,
    status: 'queued', priority: 50, attempts: 0, max_attempts: 5,
    run_after: new Date(0).toISOString(), locked_at: null, started_at: null, completed_at: null,
    payload: {}, result: {}, error: null, created_by: null,
  },
  marketing_pages: {
    page_type: 'feature', status: 'published', version: 1, summary: null, body: null,
    content: {}, seo: {}, aeo: {}, deleted_at: null, created_by: null, updated_by: null,
  },
};

/**
 * `claim_marketing_generation_jobs` (0237:326) as the worker sees it: queued and
 * due, highest priority first, stamped running with attempts + 1.
 *
 * It hands out only the page regenerations. The real function claims every queued
 * job, and `runRegeneration` enqueues a questions job and an embedding job as
 * follow-ups; the embedding one needs a live OpenAI key, and its failure would
 * add noise to the very tile these cases measure. Narrowing the fixture keeps the
 * subject of the test the regenerations themselves.
 */
function claimRegenerations(args: Record<string, unknown>, db: InMemorySupabase): Row[] {
  const limit = Math.max(1, Math.min(Number(args.p_limit ?? 10), 50));
  const now = Date.now();
  const due = db.table('marketing_generation_jobs')
    .filter((row) => row.status === 'queued' && row.job_type === 'regenerate_page'
      && new Date(String(row.run_after)).getTime() <= now)
    .sort((a, b) => Number(b.priority) - Number(a.priority))
    .slice(0, limit);
  const stamp = new Date().toISOString();
  for (const row of due) {
    row.status = 'running';
    row.attempts = Number(row.attempts) + 1;
    row.locked_at = stamp;
    row.started_at = stamp;
  }
  return due.map((row) => ({ ...row }));
}

function fresh(): InMemorySupabase {
  const fake = createInMemorySupabase({
    uniques: { marketing_generation_jobs: [['idempotency_key']] },
    defaults: DEFAULTS,
    rpc: { claim_marketing_generation_jobs: claimRegenerations },
  });
  state.db = fake;
  fake.seed('marketing_pages', [{
    id: 'page-1', slug: 'meal-planning', path: '/features/meal-planning', title: 'Meal planning',
    summary: 'The copy marketing approved.', body: 'The body marketing approved.',
  }]);
  fake.seed('marketing_generation_jobs', [{
    id: 'job-1', job_type: 'regenerate_page', target_id: 'page-1', target_path: '/features/meal-planning',
    idempotency_key: 'marketing-page:page-1:v:1:regenerate', status: 'dead_letter', attempts: 5,
    error: 'The AI provider timed out.',
  }]);
  return fake;
}

/** The number the queue card's badge and the "Jobs needing review" tile show. */
function jobsNeedingReview(fake: InMemorySupabase): number {
  return fake.table('marketing_generation_jobs')
    .filter((row) => row.status === 'failed' || row.status === 'dead_letter').length;
}

/** page.tsx renders a Retry button for exactly these rows. */
function rowsOfferingRetry(fake: InMemorySupabase): string[] {
  return fake.table('marketing_generation_jobs')
    .filter((row) => row.status === 'failed' || row.status === 'dead_letter')
    .map((row) => String(row.id));
}

async function clickRetry(id: string): Promise<void> {
  const form = new FormData();
  form.set('id', id);
  await retryMarketingJob(form);
}

/** Two clicks a person could make cannot share a millisecond. */
const humanPause = () => new Promise((resolve) => { setTimeout(resolve, 2); });

beforeEach(() => {
  state.audit.mockReset().mockResolvedValue(undefined);
  state.revalidatePath.mockReset();
  state.revalidateTag.mockReset();
  state.prompts.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Retry requeues the job the operator clicked on', () => {
  it('clears the job out of the review pile instead of leaving it there beside a copy', async () => {
    const fake = fresh();
    expect(jobsNeedingReview(fake)).toBe(1);

    await clickRetry('job-1');

    // What the operator came to the page to achieve.
    expect(jobsNeedingReview(fake)).toBe(0);
    expect(rowsOfferingRetry(fake)).toEqual([]);
    // One row per unit of work: the retry is the same job, not a second one.
    expect(fake.table('marketing_generation_jobs')).toHaveLength(1);
    expect(fake.table('marketing_generation_jobs')[0]).toMatchObject({
      id: 'job-1', status: 'queued', attempts: 0, priority: 90, error: null, locked_at: null,
    });
  });

  it('rewrites the live page once when an impatient operator clicks three times', async () => {
    const fake = fresh();

    await clickRetry('job-1');
    await humanPause();
    await clickRetry('job-1');
    await humanPause();
    await clickRetry('job-1');

    const summary = await processMarketingGenerationJobs(fake as never);

    // One model call, billed once, for the one regeneration that was asked for.
    expect(state.prompts).toHaveLength(1);
    expect(summary.succeeded).toBe(1);
    expect(fake.table('marketing_generation_jobs').filter((row) => row.job_type === 'regenerate_page')).toHaveLength(1);

    // What a visitor to /features/meal-planning now reads: the first draft, once.
    const page = fake.table('marketing_pages').find((row) => row.id === 'page-1');
    expect(page?.summary).toBe('Draft 1: Bubaly builds the week from what your family already eats.');
    expect(page?.body).toBe('Draft 1 body.');

    // And the snapshot this version could be rolled back to is that same draft,
    // not the last of three rewrites that overwrote each other at one version.
    const versions = fake.table('marketing_page_versions').filter((row) => row.page_id === 'page-1');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, body: 'Draft 1 body.' });

    // The queue card is healthy again, which is the whole point of the button.
    expect(jobsNeedingReview(fake)).toBe(0);
  });

  it('refuses to re-run a job that is already in flight', async () => {
    const fake = fresh();
    fake.table('marketing_generation_jobs')[0].status = 'running';
    fake.table('marketing_generation_jobs')[0].locked_at = new Date().toISOString();

    await clickRetry('job-1');

    // No second generation of a page a worker is generating right now.
    expect(fake.table('marketing_generation_jobs')).toHaveLength(1);
    expect(fake.table('marketing_generation_jobs')[0]).toMatchObject({ id: 'job-1', status: 'running' });

    await processMarketingGenerationJobs(fake as never);
    expect(state.prompts).toHaveLength(0);
  });

  it('still says so plainly when the job id is not there at all', async () => {
    fresh();
    const form = new FormData();
    form.set('id', 'job-does-not-exist');
    await expect(retryMarketingJob(form)).rejects.toThrow(/retry the marketing job/);
  });
});
