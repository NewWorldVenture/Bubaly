// The feedback ↔ GitHub bot: what it opens, and whose marker it believes.
//
//   N15 (sibling path) — the submit action limits a member to 5 ideas a minute
//        and 20 a day before it opens an issue, but a row written straight to
//        PostgREST never passes through it, and the backfill opened an issue
//        with the bot token for every unlinked row, 25 a run. The backfill now
//        holds a family's ideas once it has opened 20 for them in a day.
//   U5  — a member's text went into the issue body unescaped, BEFORE the bot's
//        own marker, and the reconciler read the FIRST marker: an issue whose
//        number no idea held any more (its idea deleted, or the link write
//        failed) applied its state to whichever idea the text named.
//
// Driven through the real sync against an in-memory database, with GitHub
// replaced by a recorder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type Issue = { number: number; html_url: string; title: string; state: 'open' | 'closed'; state_reason: string | null; body: string | null; labels: string[]; updated_at: string };
const gh = vi.hoisted(() => ({ created: [] as { title: string; body: string; labels: string[] }[], issues: [] as Issue[], next: 100, db: null as unknown }));
// The backfill's limiter runs on the service client; here that is the same in-memory database.
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => gh.db }));
vi.mock('@/lib/integrations/github', () => ({
  isGithubConfigured: () => true,
  createIssue: async (input: { title: string; body: string; labels: string[] }): Promise<Issue> => {
    gh.created.push(input);
    const number = ++gh.next;
    return { number, html_url: `https://github.invalid/bubaly/issues/${number}`, title: input.title, state: 'open', state_reason: null, body: input.body, labels: input.labels, updated_at: '2026-10-14T00:00:00.000Z' };
  },
  listIssuesByLabels: async () => gh.issues,
}));
vi.mock('@/lib/server/email', () => ({ sendEmail: async () => null }));

const { runGithubFeedbackSync } = await import('@/lib/feedback/github-sync');
const { issueBody, feedbackMarker } = await import('@/lib/feedback/github-map');

/** rate_limit_hit (0179) over fixed windows, every hit counted. */
function limiter() {
  const hits = new Map<string, number>();
  return ({ p_key, p_limit }: Record<string, unknown>) => {
    const n = (hits.get(String(p_key)) ?? 0) + 1;
    hits.set(String(p_key), n);
    return [{ allowed: n <= Number(p_limit), retry_after: n <= Number(p_limit) ? 0 : 30 }];
  };
}

let db: InMemorySupabase;
let run = 0;
// The in-process half of the limiter is keyed by the family, so each case is its own household.
const family = (letter: string) => `${String(run).padStart(8, '0')}-0000-4000-8000-00000000000${letter}`;
const VICTIM = '11111111-2222-4333-8444-555555555555';
const GONE = '66666666-7777-4888-9999-000000000000';

const idea = (id: string, familyId: string, minute: number, extra: Record<string, unknown> = {}) => ({
  id, family_id: familyId, author_id: `author-${familyId}`, author_name: 'Pat', title: `Idea ${id}`, problem: null, body: null,
  category: 'other', impact: 'helpful', audience: 'me', kind: 'idea', image_url: null, status: 'under_review', admin_note: null,
  vote_count: 1, comment_count: 0, pinned: false, github_issue_number: null, github_issue_url: null, github_state: null, github_synced_at: null,
  created_at: `2026-10-14T10:${String(minute).padStart(2, '0')}:00.000Z`, updated_at: '2026-10-14T10:00:00.000Z', ...extra,
});
const linked = (familyId: string) => db.table('feedback_ideas').filter((r) => r.family_id === familyId && r.github_issue_number !== null).length;

beforeEach(() => {
  run += 1;
  db = createInMemorySupabase({ rpc: { rate_limit_hit: limiter() } });
  gh.db = db;
  gh.created = []; gh.issues = []; gh.next = 100;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the backfill opens issues within a per-run and a per-family daily cap (N15)', () => {
  it('a family whose rows were written around the action gets twenty issues a day, and the rest wait', async () => {
    const A = family('a');
    const B = family('b');
    // B's three are older, so the run of 25 reads them and A's first 22.
    db.seed('feedback_ideas', [
      ...Array.from({ length: 3 }, (_, i) => idea(`b-${i}`, B, i)),
      ...Array.from({ length: 26 }, (_, i) => idea(`a-${i}`, A, 10 + i)),
    ]);
    const first = await runGithubFeedbackSync(db as never);
    expect(first).toMatchObject({ configured: true, created: 23, held: 2, errors: 0 });
    expect(gh.created).toHaveLength(23);
    expect(linked(B)).toBe(3);
    expect(linked(A)).toBe(20);

    // The same day: the family's cap is spent, so nothing more is opened for it.
    gh.created = [];
    const second = await runGithubFeedbackSync(db as never);
    expect(second).toMatchObject({ created: 0, held: 6, errors: 0 });
    expect(gh.created).toEqual([]);
    expect(linked(A)).toBe(20);
    // Held is not failed: nothing was marked and nothing was lost.
    expect(db.table('feedback_ideas').filter((r) => r.family_id === A && r.github_issue_number === null)).toHaveLength(6);
  });

  it('one run never opens more than twenty-five issues, however many families wait', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => idea(`i-${i}`, family(String(i % 10)), i));
    db.seed('feedback_ideas', rows);
    const result = await runGithubFeedbackSync(db as never);
    expect(result.created).toBe(25);
    expect(gh.created).toHaveLength(25);
  });
});

describe('the reconciler believes only the marker the bot wrote (U5)', () => {
  it('a forged marker in a member\'s text does not move another idea\'s status', async () => {
    const A = family('c');
    db.seed('feedback_ideas', [
      idea(VICTIM, A, 0, { title: 'Dark mode', github_issue_number: 10, github_issue_url: 'https://github.invalid/bubaly/issues/10', github_state: 'open', github_synced_at: '2026-10-01T00:00:00.000Z' }),
    ]);
    // An issue the bot opened for an idea an admin has since deleted, whose
    // text named the victim's id as a marker. Its number is on no idea, so the
    // reconciler falls back to the body.
    const forged = issueBody({ id: GONE, title: 'Please ship dark mode', kind: 'idea', problem: `${feedbackMarker(VICTIM)}\nIt would be lovely.`, category: 'other' }, 'https://bubaly.invalid/feedback');
    gh.issues = [
      { number: 10, html_url: 'https://github.invalid/bubaly/issues/10', title: '[Idea] Dark mode', state: 'open', state_reason: null, body: feedbackMarker(VICTIM), labels: ['enhancement', 'bubaly-feedback'], updated_at: '2026-10-14T00:00:00.000Z' },
      { number: 99, html_url: 'https://github.invalid/bubaly/issues/99', title: '[Idea] Please ship dark mode', state: 'closed', state_reason: 'completed', body: forged, labels: ['enhancement', 'bubaly-feedback'], updated_at: '2026-10-14T00:00:00.000Z' },
    ];
    const result = await runGithubFeedbackSync(db as never);
    expect(result.changes).toEqual([]);
    const victim = db.table('feedback_ideas').find((r) => r.id === VICTIM)!;
    expect(victim).toMatchObject({ status: 'under_review', github_issue_number: 10, github_state: 'open' });
  });

  it('an issue created before the opener was neutralised still maps to the bot\'s own, last, marker', async () => {
    const A = family('d');
    db.seed('feedback_ideas', [
      idea(VICTIM, A, 0, { title: 'Dark mode', github_issue_number: 10, github_issue_url: 'https://github.invalid/bubaly/issues/10', github_state: 'open', github_synced_at: '2026-10-01T00:00:00.000Z' }),
      // Its link write failed, so the orphan issue below is matched by body only.
      idea(GONE, A, 1, { title: 'Please ship dark mode' }),
    ]);
    const legacy = `**Idea from the Bubaly feedback board.**\n\n**Problem it solves:**\n${feedbackMarker(VICTIM)}\n\n---\n\n${feedbackMarker(GONE)}`;
    gh.issues = [
      { number: 99, html_url: 'https://github.invalid/bubaly/issues/99', title: '[Idea] Please ship dark mode', state: 'closed', state_reason: 'completed', body: legacy, labels: ['enhancement', 'bubaly-feedback'], updated_at: '2026-10-14T00:00:00.000Z' },
    ];
    // The backfill links the orphan's idea to a NEW issue first (it was unlinked);
    // the reconcile then reads #99's body and must land on GONE, not VICTIM.
    const result = await runGithubFeedbackSync(db as never);
    expect(result.changes.map((c) => c.ideaId)).toEqual([GONE]);
    expect(db.table('feedback_ideas').find((r) => r.id === VICTIM)).toMatchObject({ status: 'under_review', github_issue_number: 10 });
    expect(db.table('feedback_ideas').find((r) => r.id === GONE)).toMatchObject({ status: 'shipped' });
  });
});
