// Call-level tests for app/s/[slug]/actions.ts (audit Register B, group 8).
//
// The survey page is public and anonymous by design (the action's own
// comment): there is no session, no household and no role in it, so a
// signed-out visitor and any member are the same caller. What it must hold:
// the response lands on the survey the slug names and no other, only while
// that survey is active and not deleted, and only with a score inside that
// survey's own scale. Surveys belong to no household; the "other family"
// check is that a slug cannot write to a different survey.
//
// The action never reads the cookie session: createServer throws if called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, epoch: 0 }));
vi.mock('@/lib/server/rate-limit', async (original) => {
  const real = await original<typeof import('@/lib/server/rate-limit')>();
  return { ...real, rateLimit: (key: string, opts?: Parameters<typeof real.rateLimit>[1]) => real.rateLimit(`${h.epoch}:${key}`, opts) };
});
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  createServer: async () => { throw new Error('the survey action must not read the session'); },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.40', 'user-agent': 'FixtureBrowser/1.0' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { submitResponseAction } = await import('@/app/s/[slug]/actions');

const NPS = 'f0000000-0000-4000-8000-0000000000a1';
const CSAT = 'f0000000-0000-4000-8000-0000000000a2';
let db: InMemorySupabase;
const responses = () => db.table('survey_responses');

beforeEach(() => {
  h.epoch++;
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  db.seed('surveys', [
    { id: NPS, slug: 'nps-fixture', status: 'active', scale_min: 0, scale_max: 10, deleted_at: null },
    { id: CSAT, slug: 'csat-fixture', status: 'active', scale_min: 1, scale_max: 5, deleted_at: null },
    { id: 'f0000000-0000-4000-8000-0000000000a3', slug: 'closed-fixture', status: 'closed', scale_min: 0, scale_max: 10, deleted_at: null },
    { id: 'f0000000-0000-4000-8000-0000000000a4', slug: 'deleted-fixture', status: 'active', scale_min: 0, scale_max: 10, deleted_at: '2026-10-01T00:00:00Z' },
  ]);
  h.db = db;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('submitResponseAction', () => {
  it('ACTION-5B3957A71DC5 any visitor records one response on the survey the slug names', async () => {
    await expect(submitResponseAction({ slug: 'nps-fixture', score: 9, comment: '  Helpful  ', email: 'visitor@example.com' })).resolves.toEqual({ ok: true });
    expect(responses()).toEqual([expect.objectContaining({
      survey_id: NPS, score: 9, comment: 'Helpful', respondent_email: 'visitor@example.com', channel: 'link', user_agent: 'FixtureBrowser/1.0',
    })]);
  });

  it("ACTION-5B3957A71DC5 a score is judged against the named survey's own scale, not another survey's", async () => {
    // 9 is valid for the NPS survey but not for the 1-5 CSAT survey.
    await expect(submitResponseAction({ slug: 'csat-fixture', score: 9 })).resolves.toEqual({ ok: false, error: 'actions.pleaseChooseAValidRating' });
    await expect(submitResponseAction({ slug: 'csat-fixture', score: 0 })).resolves.toEqual({ ok: false, error: 'actions.pleaseChooseAValidRating' });
    expect(responses()).toEqual([]);
    await expect(submitResponseAction({ slug: 'csat-fixture', score: 4 })).resolves.toEqual({ ok: true });
    expect(responses()).toEqual([expect.objectContaining({ survey_id: CSAT, score: 4 })]);
  });

  it('ACTION-5B3957A71DC5 a closed survey takes no response', async () => {
    await expect(submitResponseAction({ slug: 'closed-fixture', score: 5 })).resolves.toEqual({ ok: false, error: 'actions.thisSurveyIsNoLonger' });
    expect(responses()).toEqual([]);
  });

  it('ACTION-5B3957A71DC5 a deleted survey and an unknown slug are not found', async () => {
    await expect(submitResponseAction({ slug: 'deleted-fixture', score: 5 })).resolves.toEqual({ ok: false, error: 'actions.surveyNotFound' });
    await expect(submitResponseAction({ slug: 'no-such-fixture', score: 5 })).resolves.toEqual({ ok: false, error: 'actions.surveyNotFound' });
    expect(responses()).toEqual([]);
  });

  it('ACTION-5B3957A71DC5 the eleventh response from one address in a minute is refused', async () => {
    for (let i = 0; i < 10; i += 1) expect(await submitResponseAction({ slug: 'nps-fixture', score: 7 })).toEqual({ ok: true });
    await expect(submitResponseAction({ slug: 'nps-fixture', score: 7 })).resolves.toEqual({ ok: false, error: 'actions.tooManySurveyResponsesPlease' });
    expect(responses()).toHaveLength(10);
  });
});
