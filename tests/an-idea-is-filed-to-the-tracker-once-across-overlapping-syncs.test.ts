// An idea is filed to the tracker once, whichever two syncs overlap on it.
//
// runGithubFeedbackSync's backfill read the ideas with no issue number and
// created an issue for each, writing the link only afterwards. Nothing was
// written between the read and the create, so a backfill overlapping itself
// (both schedulers fire the route in the same minute; the dispatcher re-calls
// it on every catch-up tick) or the on-submit sync beside a backfill that read
// the just-inserted row both filed an issue: the later link overwrote the
// earlier, the first issue carried the marker label but was never linked, and
// both were reported as created. `github_synced_at` on an unlinked idea is now
// the claim (lib/feedback/notify.ts syncIdeaToGithub), taken before the create
// and cleared when the create fails.
//
// And the backfill read dropped its error: a failed read was an empty
// backfill, `errors` stayed 0 and the route answered 200 with no notice. It is
// the run's error now, like the linked-idea read beside it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  created: [] as string[],
  hold: false,
  release: [] as (() => void)[],
  fail: false,
}));

vi.mock('@/lib/integrations/github', () => ({
  isGithubConfigured: () => true,
  createIssue: async (input: { title: string; body: string }) => {
    const number = h.created.push(input.body);
    if (h.hold) await new Promise<void>((resolve) => { h.release.push(resolve); });
    if (h.fail) throw new Error('Synthetic tracker outage');
    return { number, html_url: `https://tracker.invalid/${number}`, title: input.title, state: 'open', state_reason: null, body: input.body, labels: [], updated_at: new Date().toISOString() };
  },
  listIssuesByLabels: async () => [],
}));
vi.mock('@/lib/server/email', () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock('@/lib/constants/super-admins', () => ({ superAdminEmails: () => ['synthetic-admin@example.test'], isSuperAdminEmail: () => false }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));

const { runGithubFeedbackSync } = await import('@/lib/feedback/github-sync');
const { onFeedbackSubmitted } = await import('@/lib/feedback/notify');
const { GET } = await import('@/app/api/cron/feedback-github-sync/route');

type Admin = Parameters<typeof runGithubFeedbackSync>[0];
let db: InMemorySupabase;
const IDEA = {
  id: '30000000-0000-4000-8000-000000000001', author_id: null, author_name: 'Sam', family_id: null, title: 'A synthetic idea',
  problem: null, body: 'Please', category: 'general', impact: 'medium', audience: 'all', kind: 'idea', image_url: null, status: 'open',
  admin_note: null, vote_count: 0, comment_count: 0, pinned: false,
  github_issue_number: null, github_issue_url: null, github_state: null, github_synced_at: null, created_at: '2026-10-19T10:00:00.000Z',
};
const idea = () => db.table('feedback_ideas').find((r) => r.id === IDEA.id)!;
const releaseAll = () => { for (const r of h.release.splice(0)) r(); };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.created = []; h.hold = false; h.release = []; h.fail = false;
  db = createInMemorySupabase();
  h.db = db;
  db.seed('feedback_ideas', [{ ...IDEA }]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('two backfills overlapping on one unsynced idea', () => {
  it('file one issue, link it, and report one created', async () => {
    h.hold = true;
    const first = runGithubFeedbackSync(db as unknown as Admin);
    await vi.waitFor(() => expect(h.created).toHaveLength(1));
    const second = await runGithubFeedbackSync(db as unknown as Admin);
    releaseAll();
    const firstResult = await first;

    expect(h.created, 'the second sync filed a second issue for the same idea').toHaveLength(1);
    expect(firstResult.created + second.created).toBe(1);
    expect(firstResult.errors + second.errors).toBe(0);
    expect(idea()).toMatchObject({ github_issue_number: 1, github_issue_url: 'https://tracker.invalid/1' });
  });
});

describe('the on-submit sync beside a backfill that read the same idea', () => {
  it('files one issue', async () => {
    h.hold = true;
    const submit = onFeedbackSubmitted(db as unknown as Admin, IDEA);
    await vi.waitFor(() => expect(h.created).toHaveLength(1));
    const backfill = await runGithubFeedbackSync(db as unknown as Admin);
    releaseAll();
    await submit;

    expect(h.created).toHaveLength(1);
    expect(backfill).toMatchObject({ created: 0, errors: 0 });
    expect(idea().github_issue_number).toBe(1);
  });
});

describe('a create that fails', () => {
  it('releases the claim, so the next pass files the issue instead of waiting out the claim', async () => {
    h.fail = true;
    expect(await runGithubFeedbackSync(db as unknown as Admin)).toMatchObject({ created: 0, errors: 1 });
    expect(idea()).toMatchObject({ github_issue_number: null, github_synced_at: null });

    h.fail = false;
    expect(await runGithubFeedbackSync(db as unknown as Admin)).toMatchObject({ created: 1, errors: 0 });
    expect(idea().github_issue_number).toBe(2);
  });
});

describe('a backfill read that fails', () => {
  it('is the run\'s error: the route answers 502 and raises the tracker-error notice, instead of a clean 200 with an empty backfill', async () => {
    // Only the backfill read: `.is('github_issue_number', null)` ordered by
    // created_at. The linked-idea read uses `.not(...)`, the claim has no order.
    h.db = withFaults(db, (table, calls) => (
      table === 'feedback_ideas' && calls.some((c) => c.method === 'is') && calls.some((c) => c.method === 'order')
        ? { code: '57014', message: 'canceling statement due to statement timeout' }
        : null
    ));
    const res = await GET(new Request('https://bubaly.test/api/cron/feedback-github-sync') as never);
    expect(res.status, 'a failed backfill read answered a clean 200').toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, created: 0, errors: 1 });
    expect(h.created).toEqual([]);
    expect(db.table('admin_notifications').map((n) => n.kind)).toEqual(['github_error']);
  });
});
