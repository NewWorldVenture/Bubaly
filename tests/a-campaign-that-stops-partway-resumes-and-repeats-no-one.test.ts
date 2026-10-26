import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { NextRequest } from 'next/server';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// An email campaign that stops partway (admin-writers N2/N4/N5). The sender
// posts one Resend batch per hundred addresses, in order, and used to record
// nothing until the last one was accepted:
//
//  - a later batch the provider refused (a 429 after two accepted) set the
//    whole campaign `failed` with recipients 0, the console offered Send again,
//    and the retry mailed everyone from the first batch a second time;
//  - a batch whose request threw (the 15-second deadline, a dropped
//    connection) escaped the loop and left the row `sending` for good — no
//    count, no Send, no audit entry — while earlier batches had gone.
//
// Driven through the real send route, the real sender and the real email
// console page against the in-memory database. The provider is a fake that
// keeps a ledger of what it DELIVERED and folds a repeated Idempotency-Key the
// way Resend does, so "mailed twice" is read off the inbox, not inferred.

type Message = { to: string };
// 'accept-then-kill': the provider takes the batch and the function is killed
// before it can write anything again (every later campaign write is refused).
type Answer = 'ok' | 'reject' | 'accept-then-throw' | 'accept-then-kill';
const h = vi.hoisted(() => ({
  db: null as unknown,
  answers: [] as Answer[],
  delivered: [] as string[],
  keys: [] as string[],
  acceptedKeys: new Set<string>(),
  killed: false,
}));
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
vi.mock('@/lib/email', () => ({ FROM_EMAIL: 'Bubaly <hello@bubaly.test>', emailEnabled: () => true, APP_URL: 'https://bubaly.test' }));
vi.mock('@/lib/server/fetch-with-deadline', () => ({
  fetchWithDeadline: async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const key = init.headers['idempotency-key'];
    h.keys.push(key);
    const batch = JSON.parse(init.body) as Message[];
    const answer = h.answers.shift() ?? 'ok';
    if (answer === 'reject') return new Response('{"name":"rate_limit_exceeded"}', { status: 429 });
    // A repeated key is folded: the provider answers as before and delivers nothing.
    if (!h.acceptedKeys.has(key)) {
      h.acceptedKeys.add(key);
      h.delivered.push(...batch.map((message) => message.to));
    }
    if (answer === 'accept-then-throw') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (answer === 'accept-then-kill') {
      h.killed = true;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    return new Response(JSON.stringify({ data: batch.map((_, i) => ({ id: `re_${i}` })) }), { status: 200 });
  },
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: () => {}, success: () => {}, error: () => {} }) }));
vi.mock('@/app/(app)/admin/marketing/actions', () => ({ createEmailDraft: async () => {} }));

const route = await import('@/app/api/admin/marketing/email/send/route');

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const pad = (i: number) => String(i).padStart(4, '0');
const AUDIENCE = 250;

function seed() {
  db.seed('families', Array.from({ length: AUDIENCE }, (_, i) => ({ id: `fam-${pad(i)}`, name: `F${i}`, created_at: `2026-01-01T00:${pad(i).slice(2)}:00Z`, updated_at: null, closed_at: null })));
  db.seed('family_members', Array.from({ length: AUDIENCE }, (_, i) => ({ id: `m-${pad(i)}`, family_id: `fam-${pad(i)}`, user_id: `u-${pad(i)}`, role: 'parent', is_active: true })));
  db.seed('profiles', Array.from({ length: AUDIENCE }, (_, i) => ({ id: `u-${pad(i)}`, email: `parent${pad(i)}@example.com` })));
  for (const table of ['subscriptions', 'marketing_suppressions', 'marketing_segments', 'marketing_audit_logs']) db.seed(table, []);
  db.seed('marketing_email_campaigns', [{ id: 'cmp-1', subject: 'Autumn news', body_html: '<p>News</p>', status: 'draft', segment_id: null, deleted_at: null, metadata: {}, recipients: 0, opens: 0, clicks: 0, created_at: '2026-10-01T00:00:00Z' }]);
}
const campaign = () => db.table('marketing_email_campaigns')[0];
const preview = () => route.GET(new NextRequest('https://bubaly.test/api/admin/marketing/email/send?id=cmp-1'));
const send = () => route.POST(new NextRequest('https://bubaly.test/api/admin/marketing/email/send', {
  method: 'POST', body: JSON.stringify({ id: 'cmp-1' }), headers: { 'content-type': 'application/json' },
}));
/** Every address the provider delivered to more than once. */
const twice = () => h.delivered.filter((to, i) => h.delivered.indexOf(to) !== i);
async function emailPage(): Promise<string> {
  const { default: EmailPage } = await import('@/app/(app)/admin/marketing/email/page');
  return textOf(await renderServerPage(await EmailPage()));
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.killed = false;
  // Once the function is "killed" no campaign write lands; reads still answer.
  h.db = withFaults(db, (table, calls) => (h.killed && table === 'marketing_email_campaigns' && calls.some((call) => call.method === 'update')
    ? { message: 'the function was killed' } : null));
  h.answers = [];
  h.delivered = [];
  h.keys = [];
  h.acceptedKeys = new Set();
  seed();
  vi.stubEnv('INTERNAL_SECRET', 'partial-campaign-fixture');
  vi.stubEnv('RESEND_API_KEY', 're_fixture');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a later batch the provider refuses', () => {
  it('records what went out, and sending again reaches only the rest', async () => {
    h.answers = ['ok', 'reject'];

    const first = await send();
    expect(first.status).toBe(502);
    expect((await first.json()).error).toBe(m('send.stoppedPartway', { sent: 100, total: AUDIENCE }));
    expect(campaign()).toMatchObject({ status: 'failed', recipients: 100 });
    expect(h.delivered).toHaveLength(100);
    // The stopped send is on the audit log with what it delivered.
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      action: 'send', resource_id: 'cmp-1', metadata: expect.objectContaining({ sent: 100, outcome: 'provider_rejected' }),
    })]);
    // The console says how much went out, and Send now resumes it.
    expect(await emailPage()).toContain(m('adminMarketingEmail.sentBeforeItStopped', { n: 100 }));
    expect(await (await preview()).json()).toMatchObject({ recipients: AUDIENCE - 100, alreadySent: 100 });

    const again = await send();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ sent: AUDIENCE - 100, remaining: 0 });
    expect(twice(), 'a family mailed twice').toEqual([]);
    expect(new Set(h.delivered).size).toBe(AUDIENCE);
    expect(campaign()).toMatchObject({ status: 'sent', recipients: AUDIENCE });
  });

  it('a refused first batch leaves nothing delivered and is sent whole on retry (control)', async () => {
    h.answers = ['reject'];
    expect((await send()).status).toBe(502);
    expect(campaign()).toMatchObject({ status: 'failed', recipients: 0 });
    expect((await send()).status).toBe(200);
    expect(twice()).toEqual([]);
    expect(new Set(h.delivered).size).toBe(AUDIENCE);
  });
});

describe('a batch whose request throws', () => {
  it('is not left `sending`: the row records what went out and the retry folds the unknown batch', async () => {
    // The second batch reached the provider, and the answer never came back.
    h.answers = ['ok', 'accept-then-throw'];

    const first = await send();
    expect(first.status).toBe(502);
    expect(campaign().status, 'a thrown batch left the campaign sending for good').toBe('failed');
    expect(campaign().recipients).toBe(100);
    expect(db.table('marketing_audit_logs')).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ sent: 100, outcome: 'provider_unreachable' }),
    })]);
    expect(await emailPage()).toContain(m('adminMarketingEmail.sentBeforeItStopped', { n: 100 }));
    const unknownKey = h.keys[1];

    const again = await send();
    expect(again.status).toBe(200);
    // The unknown batch goes first, under the key it was first sent with, so
    // the provider folds it instead of delivering it a second time.
    expect(h.keys[2]).toBe(unknownKey);
    expect(twice(), 'a family mailed twice').toEqual([]);
    expect(new Set(h.delivered).size).toBe(AUDIENCE);
    expect(campaign()).toMatchObject({ status: 'sent', recipients: AUDIENCE });
  });
});

describe('a send whose function is killed partway', () => {
  it('has already recorded every batch accepted before the kill', async () => {
    // Batch one accepted, batch two accepted, and then nothing more is written:
    // no failed state, no final state. What the row says is what the per-batch
    // progress write left it.
    h.answers = ['ok', 'accept-then-kill'];
    const first = await send();
    expect(first.status).toBe(502);
    // The provider took the mail: not "rejected", which invites a resend.
    expect((await first.json()).error).toBe(m('send.sentButNotRecorded'));
    expect(campaign().status, 'left `sending`, so the console offers no Send').toBe('sending');
    expect(campaign().recipients, 'a batch accepted before the kill was not on record').toBe(100);
    const delivery = (campaign().metadata as { delivery: { delivered: string[] } }).delivery;
    expect(new Set(delivery.delivered)).toEqual(new Set(h.delivered.slice(0, 100)));
  });

  it('a send the provider accepted whose final record is refused is not reported as rejected', async () => {
    // Every batch goes, and only the write that marks the campaign sent is refused.
    h.db = withFaults(db, (table, calls) => (table === 'marketing_email_campaigns'
      && calls.some((call) => call.method === 'update' && (call.args[0] as { status?: string })?.status === 'sent')
      ? { message: 'claim lost' } : null));
    const res = await send();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe(m('send.sentButNotRecorded'));
    expect(body.error).not.toBe(m('send.providerRejectedCampaign'));
    expect(new Set(h.delivered).size).toBe(AUDIENCE);
    expect(campaign()).toMatchObject({ status: 'sending', recipients: AUDIENCE });
  });
});

describe('a resume whose audience no longer starts with the unknown batch', () => {
  it('still sends the unknown batch first and whole, under its key, and mails no one twice', async () => {
    h.answers = ['ok', 'accept-then-throw'];
    expect((await send()).status).toBe(502);
    const unknownKey = h.keys[1];
    // A family joins before the resume. The audience is newest first, so it
    // now sits AHEAD of the unknown batch: cut in hundreds from the top, the
    // batch would be a different set under a different key, and the provider
    // would deliver its 99 others a second time.
    db.seed('families', [{ id: 'fam-new', name: 'New', created_at: '2026-02-01T00:00:00Z', updated_at: null, closed_at: null }]);
    db.seed('family_members', [{ id: 'm-new', family_id: 'fam-new', user_id: 'u-new', role: 'parent', is_active: true }]);
    db.seed('profiles', [{ id: 'u-new', email: 'newcomer@example.com' }]);

    const again = await send();
    expect(again.status).toBe(200);
    expect(h.keys[2], 'the unknown batch was not retried first under its own key').toBe(unknownKey);
    expect(twice(), 'a family mailed twice').toEqual([]);
    expect(new Set(h.delivered)).toEqual(new Set([...db.table('profiles').map((p) => p.email as string)]));
    expect(campaign()).toMatchObject({ status: 'sent', recipients: AUDIENCE + 1 });
  });
});

describe('a send that goes through (control)', () => {
  it('mails everyone once, in batches of a hundred, and records the total', async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: AUDIENCE, remaining: 0 });
    expect(h.keys).toHaveLength(3);
    expect(new Set(h.keys).size).toBe(3);
    expect(twice()).toEqual([]);
    expect(campaign()).toMatchObject({ status: 'sent', recipients: AUDIENCE });
    expect((await send()).status, 'a sent campaign cannot be sent again').toBe(400);
  });
});
