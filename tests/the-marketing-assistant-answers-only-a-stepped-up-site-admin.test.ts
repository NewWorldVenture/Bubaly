// POST /api/admin/marketing/ai through the REAL marketing gate
// (requireMarketingAdmin → lib/supabase/auth → super_admins, then
// lib/auth/super-admin-assurance), the REAL rate limiter over the fake
// rate_limit_hit, and the REAL grounding reads over two households. Only the
// model is fake.
//
// Already proven elsewhere: the 401/403 bodies with getUser/isSuperAdmin
// mocked (tests/marketing-refusal-is-not-an-outage.test.ts), a failed
// grounding read answering 503 and the ceiling/prefix wording
// (tests/the-marketing-assistant-is-not-grounded-on-a-failed-read.test.ts),
// the body-size boundaries (tests/provider-request-body-boundaries.test.ts),
// the limiter being wired (tests/ai-route-rate-limit-contract.test.ts, by
// source). Added here: every family role and the other household's parent
// refused with no model call, no limiter hit and no audit row; step-up; the
// limiter's 429 at request level; "not configured"; a valid request's prompt,
// answer and audit row; a model failure that writes no audit row and leaks
// nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import {
  FAMILY_ROLES, HOUSEHOLD_A, HOUSEHOLD_B, MEMBERS_A, NO_FACTOR, PARENT_B, PASSWORD_ONLY, SITE_ADMIN, STEPPED_UP,
  seedTwoHouseholds, type SessionState,
} from './helpers/super-admin-cookie-session';

const h = vi.hoisted(() => ({
  db: null as unknown,
  session: { user: null, assurance: null } as unknown,
  configured: true,
  complete: null as unknown as (input: { system: string; messages: { content: string }[] }) => Promise<{ text: string }>,
  calls: [] as { system: string; messages: { content: string }[] }[],
  limiterRefuses: false,
}));
vi.mock('@/lib/supabase/server', async () => {
  const { cookieSession } = await import('./helpers/super-admin-cookie-session');
  return {
    createServer: async () => cookieSession(h.db as InMemorySupabase, h.session as SessionState),
    createServiceClient: () => h.db,
  };
});
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => h.configured,
  resolveProvider: async () => ({
    complete: async (input: { system: string; messages: { content: string }[] }) => {
      h.calls.push(input);
      return h.complete(input);
    },
  }),
}));

const { POST } = await import('@/app/api/admin/marketing/ai/route');

let db: InMemorySupabase;
const signIn = (state: SessionState) => { h.session = state; };
const ask = (body: unknown) => POST(new NextRequest('https://bubaly.test/api/admin/marketing/ai', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}));
const nothingHappened = () => {
  expect(h.calls, 'the model was asked').toEqual([]);
  expect(db.table('marketing_audit_logs')).toEqual([]);
  expect(db.table('rate_limits')).toEqual([]);
};

beforeEach(() => {
  db = createInMemorySupabase({
    rpc: {
      rate_limit_hit: (args, client) => (h.limiterRefuses ? [{ allowed: false, retry_after: 42 }] : rateLimitHit(args, client)),
      rate_limit_prune: () => null,
    },
  });
  h.db = db;
  h.configured = true;
  h.calls = [];
  h.limiterRefuses = false;
  h.complete = async () => ({ text: '## Plan\nDo the thing.' });
  seedTwoHouseholds(db);
  db.seed('subscriptions', [
    { id: 'aaaaaaaa-0000-4000-8000-0000000000d1', family_id: HOUSEHOLD_A, plan: 'plus', status: 'active', created_at: '2026-01-01T00:00:00Z', current_period_end: '2099-01-01T00:00:00Z' },
  ]);
  db.seed('marketing_segments', [{ id: 'seg-1', name: 'Plus families', deleted_at: null, created_at: '2026-02-01T00:00:00Z' }]);
  db.seed('marketing_campaigns', [{ id: 'mc-1', name: 'Spring', channel: 'email', status: 'draft', deleted_at: null, created_at: '2026-02-01T00:00:00Z' }]);
  db.seed('marketing_audit_logs', []);
  db.seed('rate_limits', []);
  vi.stubEnv('SUPER_ADMIN_EMAILS', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const refusedCallers = [
  ...FAMILY_ROLES.map((role) => [`household A's ${role}`, MEMBERS_A[role]] as const),
  ["household B's parent", PARENT_B] as const,
];

describe('API-192980CC87C1 who may ask the marketing assistant', () => {
  it('API-192980CC87C1 signed-out caller is refused 401 and reaches no model, limiter or audit log', async () => {
    signIn({ user: null, assurance: null });
    const res = await ask({ task: 'analyze' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Please sign in to continue.' });
    nothingHappened();
  });

  it.each(refusedCallers)('API-192980CC87C1 %s, stepped up, is refused 403 and reaches no model, limiter or audit log', async (_who, user) => {
    signIn({ user, assurance: STEPPED_UP });
    const res = await ask({ task: 'campaign_plan', input: 'plan for my family' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    nothingHappened();
  });

  it('API-192980CC87C1 a site admin on a password-only session with an enrolled authenticator is refused 403, nothing happens', async () => {
    signIn({ user: SITE_ADMIN, assurance: PASSWORD_ONLY });
    const res = await ask({ task: 'analyze' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    nothingHappened();
  });

  it('API-192980CC87C1 a site admin over the limiter\'s budget is answered 429 with Retry-After and the model is not asked', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    h.limiterRefuses = true;
    const res = await ask({ task: 'analyze' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await res.json()).toEqual({ error: 'ai.tooManyMarketingAiRequests' });
    expect(h.calls).toEqual([]);
    expect(db.table('marketing_audit_logs')).toEqual([]);
  });

  it('API-192980CC87C1 with no AI key configured a site admin is told so (503 not_configured) before any limiter hit or model call', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    h.configured = false;
    const res = await ask({ task: 'analyze' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai.theAiEngineIsnT', code: 'not_configured' });
    nothingHappened();
  });
});

describe('API-192980CC87C1 a stepped-up site admin', () => {
  it('API-192980CC87C1 gets the model\'s answer, grounded on platform aggregates with no household\'s identity, and one audit row', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    const res = await ask({ task: 'email_draft', input: '  Win back lapsed families  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '## Plan\nDo the thing.' });

    expect(h.calls).toHaveLength(1);
    const [{ system, messages }] = h.calls;
    expect(system).toContain('Draft a marketing email');
    const prompt = messages[0].content;
    expect(prompt).toContain('Customers: 2 total, 1 paying');
    expect(prompt).toContain('Existing segments: Plus families.');
    expect(prompt).toContain('Existing campaigns: Spring (email/draft).');
    expect(prompt).toContain('REQUEST: Win back lapsed families');
    for (const identity of [HOUSEHOLD_A, HOUSEHOLD_B, 'Household A', 'Household B', MEMBERS_A.parent.email, PARENT_B.email, SITE_ADMIN.email]) {
      expect(prompt, 'the model is handed counts, not a household').not.toContain(identity);
    }

    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      actor_id: SITE_ADMIN.id, actor_email: SITE_ADMIN.email, action: 'ai:email_draft', resource: 'marketing_ai',
      resource_id: null, metadata: { input: 'Win back lapsed families' },
    })]);
    expect(db.table('rate_limits')).toHaveLength(1);
    expect(db.table('rate_limits')[0].count).toBe(1);
  });

  it('API-192980CC87C1 a site admin with no authenticator enrolled is not asked for a code (opt-in step-up)', async () => {
    signIn({ user: SITE_ADMIN, assurance: NO_FACTOR });
    const res = await ask({ task: 'next_actions' });
    expect(res.status).toBe(200);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({ action: 'ai:next_actions', metadata: { input: null } })]);
  });

  it('API-192980CC87C1 a model that fails answers 500 with a fixed sentence, leaks none of its text, and writes no audit row', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    h.complete = async () => { throw new Error('upstream 500: org-test-fake-key quota exhausted at 10.0.0.7'); };
    const res = await ask({ task: 'analyze' });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'Could not generate. Check that the OpenAI API key is set.' });
    expect(body).not.toContain('org-test-fake-key');
    expect(body).not.toContain('10.0.0.7');
    expect(db.table('marketing_audit_logs')).toEqual([]);
  });
});
