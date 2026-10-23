import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// Who an email campaign reaches (admin-writers N1/N3, N11, N6/N12). Driven
// through the real customer view, the real resolver, the real send route and
// the real console pages against the in-memory database; only the provider's
// HTTP endpoint is fake.
//
//  - A family that closed its account was still mailed: closing writes no
//    suppression, and the resolver never looked at closed_at (the scheduled
//    automation runner did). The preview, the segment count and the campaign's
//    audience figure counted it too.
//  - An opt-out counted only under the exact spelling mailed. The account's
//    `jane.doe@gmail.com` kept getting campaigns after the same inbox
//    unsubscribed as `janedoe@gmail.com`, and a legacy row stored only as
//    `kim+news@gmail.com` did not stop `kim+bubaly@gmail.com`.
//  - An audience past 1,000 was cut to its newest thousand, previewed as 1,000
//    and recorded `sent` for good; the oldest families could never get it.

const h = vi.hoisted(() => ({ db: null as unknown, batches: [] as { to: string }[][] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'admin-1', email: 'root@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});
vi.mock('@/lib/email', () => ({
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  APP_URL: 'https://bubaly.test',
}));
vi.mock('@/lib/server/fetch-with-deadline', () => ({
  fetchWithDeadline: async (_url: string, init: { body: string }) => {
    h.batches.push(JSON.parse(init.body) as { to: string }[]);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  },
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock('@/app/(app)/admin/marketing/actions', () => ({
  createSegment: async () => {}, archiveSegment: async () => {}, setCampaignStatus: async () => {},
}));

const { resolveRecipients } = await import('@/lib/marketing/send');
const route = await import('@/app/api/admin/marketing/email/send/route');
type DB = SupabaseClient<Database>;

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const pad = (i: number) => String(i).padStart(5, '0');

function family(id: string, email: string, extra: Record<string, unknown> = {}) {
  db.seed('families', [{ id, name: id, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null, ...extra }]);
  db.seed('family_members', [{ id: `m-${id}`, family_id: id, user_id: `u-${id}`, role: 'parent', is_active: true }]);
  db.seed('profiles', [{ id: `u-${id}`, email }]);
}
function draft(segmentId: string | null = null) {
  db.seed('marketing_email_campaigns', [{ id: 'cmp-1', subject: 'Autumn news', body_html: '<p>News</p>', status: 'draft', segment_id: segmentId, deleted_at: null, metadata: {} }]);
}
const preview = () => route.GET(new NextRequest('https://bubaly.test/api/admin/marketing/email/send?id=cmp-1'));
const send = () => route.POST(new NextRequest('https://bubaly.test/api/admin/marketing/email/send', {
  method: 'POST', body: JSON.stringify({ id: 'cmp-1' }), headers: { 'content-type': 'application/json' },
}));
const mailed = () => h.batches.flat().map((message) => message.to).sort();

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.batches = [];
  for (const table of ['subscriptions', 'marketing_suppressions', 'marketing_segments', 'marketing_audit_logs']) db.seed(table, []);
  vi.stubEnv('INTERNAL_SECRET', 'campaign-audience-fixture');
  vi.stubEnv('RESEND_API_KEY', 're_fixture');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a family that closed its account is not in a campaign', () => {
  beforeEach(() => {
    family('fam-open', 'open@example.com');
    family('fam-closed', 'closed@example.com', { closed_at: '2026-09-01T00:00:00Z' });
  });

  it('is not resolved, previewed or sent to, with or without a segment', async () => {
    expect(await resolveRecipients(db as unknown as DB, { segment_id: null })).toEqual(['open@example.com']);
    db.seed('marketing_segments', [{ id: 'seg-free', name: 'Free families', rules: { lifecycle: ['free'] }, deleted_at: null }]);
    expect(await resolveRecipients(db as unknown as DB, { segment_id: 'seg-free' })).toEqual(['open@example.com']);

    draft();
    expect(await (await preview()).json()).toMatchObject({ recipients: 1 });
    expect((await send()).status).toBe(200);
    expect(mailed()).toEqual(['open@example.com']);
  });

  it('is not counted in a segment\'s audience or a campaign\'s', async () => {
    db.seed('marketing_segments', [{ id: 'seg-free', name: 'Free families', rules: { lifecycle: ['free'] }, deleted_at: null, created_at: '2026-01-01T00:00:00Z' }]);
    db.seed('marketing_campaigns', [{ id: 'mc-1', name: 'Win back', channel: 'email', type: 'win_back', status: 'draft', segment_id: 'seg-free', budget_cents: 0, deleted_at: null }]);

    const { default: SegmentsPage } = await import('@/app/(app)/admin/marketing/segments/page');
    expect(textOf(await renderServerPage(await SegmentsPage()))).toContain('Free families 1 matching');

    const { default: CampaignPage } = await import('@/app/(app)/admin/marketing/campaigns/[id]/page');
    const html = await renderServerPage(await CampaignPage({ params: Promise.resolve({ id: 'mc-1' }) }));
    expect(textOf(html)).toContain(`${m('adminMarketingCampaigns.audience')} 1 ${m('adminMarketingCampaigns.segment')} Free families`);
  });
});

describe('an opt-out holds for the whole inbox', () => {
  it('under the inbox it was recorded for, and under a legacy +tag spelling', async () => {
    family('fam-jane', 'jane.doe@gmail.com');
    family('fam-kim', 'kim+bubaly@gmail.com');
    family('fam-lee', 'lee@example.com');
    db.seed('marketing_suppressions', [
      // An automation mail to the spelling a form was given, unsubscribed there.
      { email: 'janedoe@gmail.com', reason: 'unsubscribe' },
      // A row written before the unsubscribe route recorded the inbox too.
      { email: 'kim+news@gmail.com', reason: 'unsubscribe' },
    ]);

    expect(await resolveRecipients(db as unknown as DB, { segment_id: null })).toEqual(['lee@example.com']);
    draft();
    expect(await (await preview()).json()).toMatchObject({ recipients: 1 });
    expect((await send()).status).toBe(200);
    expect(mailed()).toEqual(['lee@example.com']);
  });

  it('still mails an address no opt-out names (control)', async () => {
    family('fam-jane', 'jane.doe@gmail.com');
    db.seed('marketing_suppressions', [{ email: 'janet@gmail.com', reason: 'unsubscribe' }]);
    expect(await resolveRecipients(db as unknown as DB, { segment_id: null })).toEqual(['jane.doe@gmail.com']);
  });
});

describe('an audience past the cap is refused, not cut', () => {
  beforeEach(() => {
    db.seed('families', Array.from({ length: 1001 }, (_, i) => ({ id: `fam-${pad(i)}`, name: `F${i}`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null })));
    db.seed('family_members', Array.from({ length: 1001 }, (_, i) => ({ id: `m-${pad(i)}`, family_id: `fam-${pad(i)}`, user_id: `u-${pad(i)}`, role: 'parent', is_active: true })));
    db.seed('profiles', Array.from({ length: 1001 }, (_, i) => ({ id: `u-${pad(i)}`, email: `parent${pad(i)}@example.com` })));
    draft();
  });

  it('the preview says the audience is too large instead of answering 1,000', async () => {
    const res = await preview();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(m('send.audienceOverCap', { n: 1001, cap: 1000 }));
  });

  it('the send refuses, mails no one and leaves the campaign a draft that can still reach everyone', async () => {
    const res = await send();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(m('send.audienceOverCap', { n: 1001, cap: 1000 }));
    expect(h.batches).toEqual([]);
    const [campaign] = db.table('marketing_email_campaigns');
    expect(campaign.status).toBe('draft');
    expect(campaign.recipients ?? 0).toBe(0);
  });

  it('an audience of exactly the cap is sent whole (control)', async () => {
    db.replace('families', db.table('families').slice(1));
    expect((await send()).status).toBe(200);
    expect(mailed()).toHaveLength(1000);
    expect(db.table('marketing_email_campaigns')[0]).toMatchObject({ status: 'sent', recipients: 1000 });
  });
});
