// The Idea Board's two outbound costs and its one badge of authority.
//
//   N15 — every submitted idea opens a GitHub issue with the bot token and
//         emails every super admin, and the action had no limit: a member
//         looping it spent GitHub's content-creation allowance (blocking the
//         sync bot too), the shared mail quota and the admins' inboxes.
//   N3  — a reply from a super admin carries the "Bubaly Team" badge to every
//         family's board. The action handed it out on the email allowlist
//         alone, where moving the roadmap also asks for the step-up, so a
//         password-only admin session could speak as the team. (A member's
//         direct PostgREST insert of `is_team` is the database's to refuse: the
//         migration is the owner's.)
//
// Driven through the real server actions and the real two-layer rate limiter
// against an in-memory database.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

const h = vi.hoisted(() => ({
  db: null as unknown, service: null as unknown, user: 'user-1', admin: false, steppedUp: false, notified: 0,
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.user, email: `${h.user}@example.invalid` },
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1', display_name: 'Pat' }, family: { name: 'Rivera' } },
  }),
  isSuperAdmin: async () => h.admin,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: h.steppedUp }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.service }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/feedback/notify', () => ({ onFeedbackSubmitted: async () => { h.notified++; } }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});

const { submitIdeaAction, addCommentAction } = await import('@/app/(app)/feedback/actions');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

let db: InMemorySupabase;
let service: InMemorySupabase;
let user = 0;

/** rate_limit_hit (0179) over fixed windows, every hit counted. */
function limiter() {
  const hits = new Map<string, number>();
  return ({ p_key, p_limit }: Record<string, unknown>) => {
    const n = (hits.get(String(p_key)) ?? 0) + 1;
    hits.set(String(p_key), n);
    return [{ allowed: n <= Number(p_limit), retry_after: n <= Number(p_limit) ? 0 : 30 }];
  };
}

beforeEach(() => {
  db = createInMemorySupabase({ rpc: { rate_limit_hit: limiter() } });
  service = createInMemorySupabase();
  h.db = db; h.service = service; h.notified = 0; h.admin = false; h.steppedUp = false;
  // The in-process half of the limiter is keyed by the caller too, so each case is its own member.
  h.user = `00000000-0000-4000-8000-${String(++user).padStart(12, '0')}`;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('posting ideas is limited before anything goes out (N15)', () => {
  it('a burst of six submissions posts five, and the sixth opens no issue and sends no mail', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await submitIdeaAction({ title: `Idea ${i}` }));
    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(results[5]).toEqual({ ok: false, error: t('feedback.tooManyIdeasAtOnce') });
    expect(db.table('feedback_ideas')).toHaveLength(5);
    expect(h.notified).toBe(5);
  });

  it('a member who has posted twenty ideas today posts no more today', async () => {
    db.seed('feedback_ideas', Array.from({ length: 20 }, (_, i) => ({
      id: `idea-${i}`, author_id: h.user, title: `Earlier ${i}`, created_at: new Date(Date.now() - i * 60_000).toISOString(),
    })));
    const res = await submitIdeaAction({ title: 'One more' });
    expect(res).toEqual({ ok: false, error: t('feedback.dailyIdeaLimitReached', { limit: 20 }) });
    expect(db.table('feedback_ideas')).toHaveLength(20);
    expect(h.notified).toBe(0);
  });

  it('ideas from yesterday do not count toward today', async () => {
    db.seed('feedback_ideas', Array.from({ length: 20 }, (_, i) => ({
      id: `old-${i}`, author_id: h.user, title: `Old ${i}`, created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    })));
    expect(await submitIdeaAction({ title: 'Today' })).toMatchObject({ ok: true });
  });
});

describe('the team badge takes the step-up (N3)', () => {
  it('a super admin without the step-up comments as themselves', async () => {
    h.admin = true; h.steppedUp = false;
    expect(await addCommentAction({ ideaId: 'idea-1', body: 'Thanks!' })).toEqual({ ok: true });
    expect(db.table('feedback_comments')).toEqual([expect.objectContaining({ author_name: 'Pat', is_team: false, author_id: h.user })]);
    expect(service.table('feedback_comments')).toEqual([]);
  });

  it('a stepped-up super admin replies as the team, on the service client', async () => {
    h.admin = true; h.steppedUp = true;
    expect(await addCommentAction({ ideaId: 'idea-1', body: 'Shipping next week.' })).toEqual({ ok: true });
    expect(service.table('feedback_comments')).toEqual([expect.objectContaining({ author_name: 'Bubaly Team', is_team: true })]);
    expect(db.table('feedback_comments')).toEqual([]);
  });

  it('a member is never the team', async () => {
    expect(await addCommentAction({ ideaId: 'idea-1', body: '+1' })).toEqual({ ok: true });
    expect(db.table('feedback_comments')).toEqual([expect.objectContaining({ is_team: false })]);
  });
});
