import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A feedback idea becomes ONE GitHub issue, however many workers reach it.
 *
 * Three paths file an issue for an idea whose `github_issue_number` is still
 * null: the submit action (onFeedbackSubmitted), the hourly backfill
 * (/api/cron/feedback-github-sync, fired by Vercel AND the GitHub dispatcher at
 * 06:15) and the admin's "Sync now". Each used to READ the idea as unsynced,
 * call GitHub, and only then write the issue number back — a select, a side
 * effect, an unconditional update, with no claim between them. Two of them
 * overlapping both read null, both opened an issue, and the later link
 * overwrote the earlier one, leaving a duplicate on the tracker that nothing
 * pointed at any more.
 *
 * What is real: lib/feedback/github-sync.ts, lib/feedback/notify.ts and the
 * PostgREST filter semantics of tests/helpers/in-memory-supabase.ts. What is
 * fake: GitHub (a recorder whose create call takes a moment, as a network call
 * does — that moment is the overlap). Nothing leaves the process.
 */

const gh = vi.hoisted(() => ({
  created: [] as { title: string }[],
  failNext: 0,
  next: 100,
}));

vi.mock('@/lib/integrations/github', () => ({
  isGithubConfigured: () => true,
  listIssuesByLabels: async () => [],
  createIssue: async (input: { title: string; body: string; labels: string[] }) => {
    // The round trip to GitHub: long enough for another worker to read the
    // idea while this one is still waiting for its issue number.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (gh.failNext > 0) { gh.failNext -= 1; throw new Error('Synthetic GitHub outage'); }
    gh.created.push({ title: input.title });
    const number = gh.next++;
    return {
      number, html_url: `https://github.invalid/synthetic/issues/${number}`, title: input.title,
      state: 'open', state_reason: null, body: input.body, labels: input.labels, updated_at: new Date().toISOString(),
    };
  },
}));

import { runGithubFeedbackSync } from '@/lib/feedback/github-sync';
import { syncIdeaToGithub } from '@/lib/feedback/notify';

const IDEA = '00000000-0000-4000-8000-feedbac00001';
let db: InMemorySupabase;
const client = () => db as unknown as Parameters<typeof runGithubFeedbackSync>[0];

function seedIdea(overrides: Record<string, unknown> = {}) {
  db.seed('feedback_ideas', [{
    id: IDEA, title: 'Synthetic idea', kind: 'idea', category: 'other', problem: null, body: 'Synthetic body',
    impact: null, vote_count: 0, author_name: 'Synthetic author', status: 'open',
    github_issue_number: null, github_issue_url: null, github_state: null, github_synced_at: null,
    created_at: '2026-10-09T06:00:00.000Z', ...overrides,
  }]);
}
const idea = () => db.table('feedback_ideas').find((row) => row.id === IDEA)!;

beforeEach(() => {
  gh.created = []; gh.failNext = 0; gh.next = 100;
  db = createInMemorySupabase();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a feedback idea is filed on GitHub once', () => {
  it('two overlapping backfill runs open one issue, not two', async () => {
    seedIdea();
    const [first, second] = await Promise.all([runGithubFeedbackSync(client()), runGithubFeedbackSync(client())]);

    expect(gh.created).toHaveLength(1);
    expect(first.created + second.created).toBe(1);
    // The loser held back; it did not fail.
    expect(first.errors + second.errors).toBe(0);
    expect(idea().github_issue_number).toBe(100);
  });

  it('the submit path and a backfill run that overlap it open one issue', async () => {
    seedIdea();
    const row = { id: IDEA, title: 'Synthetic idea', kind: 'idea' };
    const [submitted, swept] = await Promise.all([syncIdeaToGithub(client(), row), runGithubFeedbackSync(client())]);

    expect(gh.created).toHaveLength(1);
    expect(submitted.ok).toBe(true);
    expect(swept.created).toBe(0);
    expect(swept.errors).toBe(0);
    expect(idea().github_issue_number).toBe(100);
  });

  it('an idea already linked is never filed again', async () => {
    seedIdea({ github_issue_number: 7, github_issue_url: 'https://github.invalid/synthetic/issues/7' });
    const result = await syncIdeaToGithub(client(), { id: IDEA, title: 'Synthetic idea' });

    expect(result.ok).toBe(false);
    expect(gh.created).toHaveLength(0);
    expect(idea().github_issue_number).toBe(7);
  });

  it('a failed create gives the idea back at once, so the next run files it', async () => {
    seedIdea();
    gh.failNext = 1;
    const failed = await runGithubFeedbackSync(client());
    expect(failed.errors).toBe(1);
    expect(gh.created).toHaveLength(0);
    expect(idea().github_synced_at).toBeNull();

    const retried = await runGithubFeedbackSync(client());
    expect(retried.created).toBe(1);
    expect(gh.created).toHaveLength(1);
    expect(idea().github_issue_number).toBe(100);
  });

  it('a claim whose worker died is taken over once its lease has run out', async () => {
    // Claimed an hour ago by a worker that never linked an issue or let go.
    seedIdea({ github_synced_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    const result = await runGithubFeedbackSync(client());

    expect(result.created).toBe(1);
    expect(gh.created).toHaveLength(1);
  });

  it('a live claim is respected', async () => {
    // Another worker claimed it a moment ago and is waiting on GitHub.
    seedIdea({ github_synced_at: new Date(Date.now() - 30_000).toISOString() });
    const result = await runGithubFeedbackSync(client());

    expect(result.created).toBe(0);
    expect(result.errors).toBe(0);
    expect(gh.created).toHaveLength(0);
  });
});
