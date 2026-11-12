// GET (preview) and POST (send) /api/admin/marketing/email/send through the
// REAL marketing gate (requireMarketingAdmin → lib/supabase/auth →
// super_admins, then lib/auth/super-admin-assurance) and the REAL resolver and
// sender over two households. Only the provider's HTTP endpoint is fake.
//
// Already proven elsewhere, with the gate mocked to "yes": who the audience
// is (closed families, suppressions, the 1,000 cap —
// tests/a-campaign-reaches-only-open-consenting-inboxes.test.ts), partial
// sends and resumes (tests/a-campaign-that-stops-partway-resumes-and-repeats-no-one.test.ts),
// the console's preflight (tests/a-campaign-send-preflight-that-failed-is-not-no-recipients.test.ts),
// the 401/403 status travelling on the error
// (tests/marketing-refusal-is-not-an-outage.test.ts, tests/a-refusal-is-not-an-outage.test.ts),
// the body bound (tests/provider-request-body-boundaries.test.ts). Added
// here: every family role and the other household's parent refused with no
// provider call and the campaign untouched; step-up; a valid preview and send
// end to end with the rows they wrote; an unknown or archived campaign; and a
// failed read / refused batch answered without leaking.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import {
  FAMILY_ROLES, MEMBERS_A, NO_FACTOR, PARENT_B, PASSWORD_ONLY, SITE_ADMIN, STEPPED_UP,
  seedTwoHouseholds, type SessionState,
} from './helpers/super-admin-cookie-session';

const h = vi.hoisted(() => ({
  db: null as unknown,
  session: { user: null, assurance: null } as unknown,
  batches: [] as { to: string; subject: string; tags: { name: string; value: string }[] }[][],
  provider: 'accept' as 'accept' | 'reject',
}));
vi.mock('@/lib/supabase/server', async () => {
  const { cookieSession } = await import('./helpers/super-admin-cookie-session');
  return {
    createServer: async () => cookieSession(h.db as InMemorySupabase, h.session as SessionState),
    createServiceClient: () => h.db,
  };
});
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));
vi.mock('@/lib/email', () => ({
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  APP_URL: 'https://bubaly.test',
}));
vi.mock('@/lib/server/fetch-with-deadline', () => ({
  fetchWithDeadline: async (_url: string, init: { body: string }) => {
    const batch = JSON.parse(init.body) as { to: string; subject: string; tags: { name: string; value: string }[] }[];
    h.batches.push(batch);
    if (h.provider === 'reject') return new Response('{"name":"internal_server_error","message":"shard re-eu-7 failed for key test-fake-key"}', { status: 500 });
    return new Response(JSON.stringify({ data: batch.map((_, i) => ({ id: `re_${i}` })) }), { status: 200 });
  },
}));

const route = await import('@/app/api/admin/marketing/email/send/route');

const CAMPAIGN = 'cccccccc-0000-4000-8000-000000000001';
const ARCHIVED = 'cccccccc-0000-4000-8000-000000000002';

let base: InMemorySupabase;
const signIn = (state: SessionState) => { h.session = state; };
const preview = (id: string = CAMPAIGN) => route.GET(new NextRequest(`https://bubaly.test/api/admin/marketing/email/send?id=${id}`));
const send = (id: string = CAMPAIGN) => route.POST(new NextRequest('https://bubaly.test/api/admin/marketing/email/send', {
  method: 'POST', body: JSON.stringify({ id }), headers: { 'content-type': 'application/json' },
}));
const campaign = (id: string = CAMPAIGN) => base.table('marketing_email_campaigns').find((row) => row.id === id);
const untouched = () => {
  expect(h.batches, 'the provider was reached').toEqual([]);
  expect(campaign()).toMatchObject({ status: 'draft', recipients: 0, metadata: {} });
  expect(base.table('marketing_audit_logs')).toEqual([]);
};

beforeEach(() => {
  base = createInMemorySupabase();
  h.db = base;
  h.batches = [];
  h.provider = 'accept';
  seedTwoHouseholds(base);
  for (const table of ['subscriptions', 'marketing_suppressions', 'marketing_segments', 'marketing_audit_logs']) base.seed(table, []);
  base.seed('marketing_email_campaigns', [
    { id: CAMPAIGN, subject: 'Autumn news', body_html: '<p>News</p>', status: 'draft', segment_id: null, deleted_at: null, metadata: {}, recipients: 0, created_at: '2026-10-01T00:00:00Z' },
    { id: ARCHIVED, subject: 'Old news', body_html: '<p>Old</p>', status: 'draft', segment_id: null, deleted_at: '2026-10-05T00:00:00Z', metadata: {}, recipients: 0, created_at: '2026-09-01T00:00:00Z' },
  ]);
  vi.stubEnv('SUPER_ADMIN_EMAILS', '');
  vi.stubEnv('INTERNAL_SECRET', 'test-fake-unsubscribe-secret');
  vi.stubEnv('RESEND_API_KEY', 'test-fake-key');
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

describe('API-77A1BDDE52B2 GET: who may preview a campaign\'s recipients', () => {
  it('API-77A1BDDE52B2 signed-out caller is refused 401 with no count, provider untouched', async () => {
    signIn({ user: null, assurance: null });
    const res = await preview();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Please sign in to continue.' });
    untouched();
  });

  it.each(refusedCallers)('API-77A1BDDE52B2 %s, stepped up, is refused 403 with no count', async (_who, user) => {
    signIn({ user, assurance: STEPPED_UP });
    const res = await preview();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    untouched();
  });

  it('API-77A1BDDE52B2 a site admin on a password-only session with an enrolled authenticator is refused 403', async () => {
    signIn({ user: SITE_ADMIN, assurance: PASSWORD_ONLY });
    const res = await preview();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    untouched();
  });

  it('API-77A1BDDE52B2 a stepped-up site admin gets the count a send would mail now (one owner per household), and nothing is written', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    const res = await preview();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recipients: 2, audience: 2, alreadySent: 0 });
    untouched();
  });

  it('API-77A1BDDE52B2 an archived or unknown campaign is 404 for a site admin', async () => {
    signIn({ user: SITE_ADMIN, assurance: NO_FACTOR });
    for (const id of [ARCHIVED, 'cccccccc-0000-4000-8000-0000000000ff']) {
      const res = await preview(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'send.notFound' });
    }
  });

  it('API-77A1BDDE52B2 a campaign read that fails is 500 "could not load", never "not found", and leaks nothing', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    h.db = withFaults(base, (table) => (table === 'marketing_email_campaigns' ? { code: '08006', message: 'connection to pooler 10.0.0.9 lost' } : null));
    const res = await preview();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'send.couldNotLoadCampaignRecipients' });
    expect(body).not.toContain('10.0.0.9');
    untouched();
  });

  it('API-77A1BDDE52B2 a suppression read that fails is 502 "could not load", never a count, and leaks nothing', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    h.db = withFaults(base, (table) => (table === 'marketing_suppressions' ? { code: '57014', message: 'canceling statement due to statement timeout on marketing_suppressions' } : null));
    const res = await preview();
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'send.couldNotLoadCampaignRecipients' });
    expect(body).not.toContain('statement timeout');
    untouched();
  });
});

describe('API-68728C68AD8D POST: who may send a campaign', () => {
  it('API-68728C68AD8D signed-out caller is refused 401, nothing sent, campaign untouched', async () => {
    signIn({ user: null, assurance: null });
    const res = await send();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Please sign in to continue.' });
    untouched();
  });

  it.each(refusedCallers)('API-68728C68AD8D %s, stepped up, is refused 403, nothing sent, campaign untouched', async (_who, user) => {
    signIn({ user, assurance: STEPPED_UP });
    const res = await send();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    untouched();
  });

  it('API-68728C68AD8D a site admin on a password-only session with an enrolled authenticator is refused 403, nothing sent', async () => {
    signIn({ user: SITE_ADMIN, assurance: PASSWORD_ONLY });
    const res = await send();
    expect(res.status).toBe(403);
    untouched();
  });

  it('API-68728C68AD8D a stepped-up site admin sends once to each household\'s owner; the row records it sent and the audit log names the send', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, remaining: 0 });

    expect(h.batches).toHaveLength(1);
    expect(h.batches[0].map((message) => message.to).sort()).toEqual([MEMBERS_A.parent.email, PARENT_B.email]);
    expect(h.batches[0].every((message) => message.subject === 'Autumn news')).toBe(true);
    expect(h.batches[0].every((message) => message.tags.some((tag) => tag.name === 'campaign' && tag.value === CAMPAIGN))).toBe(true);

    const row = campaign();
    expect(row).toMatchObject({ status: 'sent', recipients: 2 });
    expect(typeof row?.sent_at).toBe('string');
    const delivery = (row?.metadata as { delivery: { delivered: string[]; pending: unknown; outcome: string } }).delivery;
    expect([...delivery.delivered].sort()).toEqual([MEMBERS_A.parent.email, PARENT_B.email]);
    expect(delivery).toMatchObject({ pending: null, outcome: 'complete' });

    expect(base.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      actor_id: SITE_ADMIN.id, actor_email: SITE_ADMIN.email, action: 'send', resource: 'marketing_email_campaign',
      resource_id: CAMPAIGN, metadata: { sent: 2, remaining: 0, outcome: 'complete' },
    })]);
    expect(campaign(ARCHIVED)).toMatchObject({ status: 'draft', recipients: 0 });
  });

  it('API-68728C68AD8D an archived or unknown campaign is refused 400 for a site admin, nothing sent, nothing recorded', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    for (const id of [ARCHIVED, 'cccccccc-0000-4000-8000-0000000000ff']) {
      const res = await send(id);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'send.couldNotSendCampaign' });
    }
    expect(campaign(ARCHIVED)).toMatchObject({ status: 'draft', recipients: 0, metadata: {} });
    untouched();
  });

  it('API-68728C68AD8D a batch the provider refuses is 502 "provider rejected" with none of its text; the row is failed and the stop audited', async () => {
    signIn({ user: SITE_ADMIN, assurance: STEPPED_UP });
    h.provider = 'reject';
    const res = await send();
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: 'send.providerRejectedCampaign' });
    expect(body).not.toContain('re-eu-7');
    expect(body).not.toContain('test-fake-key');
    expect(campaign()).toMatchObject({ status: 'failed', recipients: 0 });
    expect(base.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      actor_id: SITE_ADMIN.id, action: 'send', resource_id: CAMPAIGN, metadata: { sent: 0, delivered: 0, outcome: 'provider_rejected' },
    })]);
  });
});
