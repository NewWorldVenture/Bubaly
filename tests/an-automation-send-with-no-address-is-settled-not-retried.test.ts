import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// admin-writers N7-S2. A send_email step whose recipient has no address it may
// be mailed at — an owner who signed in by SMS and has no profile email, or a
// family whose only login is a kid login's synthetic address — is recorded
// `send_email:skipped(no-recipient)` / `skipped(kid-login)`. Every `:skipped`
// was treated as retryable, so the daily sweep re-claimed that run on every
// pass, skipped it again, counted a failure and answered the cron 502 for
// good; and since the per-pass cap is taken from the subjects still owed a
// run, enough such families at the newest end held every cap slot ahead of
// families never served. Such a run is now settled until the subject's address
// changes; a skip for a missing provider key stays retryable.
//
// The real cron route, scheduled runner, event dispatcher and customer view
// against the in-memory database; only the email provider is fake.

const h = vi.hoisted(() => ({ db: null as unknown, sent: [] as { to: string; subject: string }[], emailOn: true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate } = await import('@/lib/i18n/translate');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://bubaly.test',
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => h.emailOn,
  getResend: () => ({
    emails: {
      send: async (message: { to: string; subject: string }) => {
        h.sent.push({ to: message.to, subject: message.subject });
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
}));

const { runAutomations } = await import('@/lib/marketing/automation-runner');
const { fireAutomationEvent } = await import('@/lib/marketing/automation-events');
const { GET: cron } = await import('@/app/api/cron/automations/route');
type DB = SupabaseClient<Database>;

const NOW = new Date('2026-10-12T10:00:00.000Z');
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

let db: InMemorySupabase;

/** A new customer (subscribed days ago) whose owner's profile holds `email`. `order` sorts newest first. */
function family(id: string, email: string | null, order = 0) {
  db.seed('families', [{ id, name: id, created_at: iso(10 - order / 100), updated_at: iso(1), closed_at: null }]);
  db.seed('family_members', [{ id: `m-${id}`, family_id: id, user_id: `u-${id}`, role: 'parent', is_active: true }]);
  db.seed('profiles', [{ id: `u-${id}`, email }]);
  db.seed('subscriptions', [{ id: `s-${id}`, family_id: id, plan: 'plus', status: 'active', created_at: iso(5), current_period_end: null }]);
}
function welcome() {
  db.seed('marketing_automation_workflows', [{
    id: 'wf-1', name: 'Welcome', trigger: 'customer_created', status: 'active', deleted_at: null, run_count: 0,
    steps: [{ action: 'send_email', subject: 'Welcome' }],
  }]);
}
const runs = () => db.table('marketing_automation_runs');
const runFor = (subject: string) => runs().find((r) => r.subject_key === subject);
const flow = () => db.table('marketing_automation_workflows')[0];
const cronRequest = () => cron(new NextRequest('https://bubaly.test/api/cron/automations', { headers: { authorization: 'Bearer cron-fixture-secret' } }));
const snapshot = (row: Record<string, unknown> | undefined) => JSON.parse(JSON.stringify(row ?? null));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ maxRows: 1000, rpc: { rate_limit_prune: () => null } });
  h.db = db;
  h.sent = [];
  h.emailOn = true;
  for (const table of ['marketing_suppressions', 'marketing_automation_runs', 'child_login_throttle']) db.seed(table, []);
  vi.stubEnv('INTERNAL_SECRET', 'automation-fixture');
  vi.stubEnv('CRON_SECRET', 'cron-fixture-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a scheduled send with no address to go to', () => {
  it.each([
    ['an owner with no profile email', null, 'send_email:skipped(no-recipient)'],
    ['a family whose only login is a kid login', 'ava.kid@kids.bubaly.app', 'send_email:skipped(kid-login)'],
  ])('%s: recorded once, not re-claimed, and the cron answers 200 every day', async (_label, email, receipt) => {
    family('fam-1', email);
    welcome();

    const first = await cronRequest();
    expect(first.status, 'a send that cannot be addressed failed the cron').toBe(200);
    expect(await first.json()).toMatchObject({ runs: 1, emails: 0, failures: 0, ok: true });
    expect(runFor('fam-1')).toMatchObject({ status: 'failed', metadata: expect.objectContaining({ actions: [receipt] }) });
    const recorded = snapshot(runFor('fam-1'));

    for (let day = 1; day <= 2; day++) {
      vi.setSystemTime(new Date(NOW.getTime() + day * DAY));
      const again = await cronRequest();
      expect(again.status, `day ${day + 1}: the skipped run was re-claimed and failed again`).toBe(200);
      expect(await again.json()).toMatchObject({ runs: 0, failures: 0, unserved: 0, ok: true });
    }
    expect(snapshot(runFor('fam-1')), 'the settled run was claimed and rewritten').toEqual(recorded);
    expect(runs()).toHaveLength(1);
    expect(flow().run_count).toBe(1);
    expect(h.sent).toEqual([]);
  });

  it('is retried, and sent once, after the owner adds an email', async () => {
    family('fam-1', null);
    welcome();
    expect(await runAutomations(db as unknown as DB)).toMatchObject({ runs: 1, emails: 0, failures: 0 });
    expect(await runAutomations(db as unknown as DB)).toMatchObject({ runs: 0, emails: 0 });

    db.table('profiles').find((p) => p.id === 'u-fam-1')!.email = 'owner@example.com';
    expect(await runAutomations(db as unknown as DB)).toMatchObject({ runs: 1, emails: 1, failures: 0 });
    expect(runFor('fam-1')).toMatchObject({ status: 'completed', metadata: expect.objectContaining({ actions: ['send_email'] }) });
    expect(await runAutomations(db as unknown as DB)).toMatchObject({ runs: 0, emails: 0 });
    expect(h.sent).toEqual([{ to: 'owner@example.com', subject: 'Welcome' }]);
    // A retry is not another subject run.
    expect(flow().run_count).toBe(1);
  });

  it('does not hold the per-pass cap ahead of a family never served', async () => {
    // The two newest families cannot be mailed; the third, older, can.
    family('fam-new-a', null, 3);
    family('fam-new-b', 'kid.b@kids.bubaly.app', 2);
    family('fam-older', 'older@example.com', 1);
    welcome();

    expect(await runAutomations(db as unknown as DB, { maxPerWorkflow: 2 })).toMatchObject({ runs: 2, emails: 0, unserved: 1 });
    const second = await runAutomations(db as unknown as DB, { maxPerWorkflow: 2 });
    expect(second, 'the unaddressable families took the cap again and the older one was never served')
      .toMatchObject({ runs: 1, emails: 1, failures: 0, unserved: 0 });
    expect(h.sent).toEqual([{ to: 'older@example.com', subject: 'Welcome' }]);
  });

  it('control: a send skipped for a missing provider key is still a failure, and is retried once the key is set', async () => {
    family('fam-1', 'owner@example.com');
    welcome();
    h.emailOn = false;
    const first = await cronRequest();
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ runs: 1, failures: 1 });
    expect(runFor('fam-1')).toMatchObject({ status: 'failed', metadata: expect.objectContaining({ actions: ['send_email:skipped(no-key)'] }) });

    h.emailOn = true;
    const second = await cronRequest();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ runs: 1, emails: 1, failures: 0 });
    expect(h.sent).toEqual([{ to: 'owner@example.com', subject: 'Welcome' }]);
  });
});

describe('an event-driven send with no address to go to', () => {
  const fire = (email: string | null) => fireAutomationEvent(db as unknown as DB, {
    trigger: 'form_submitted', email, name: 'Lead', subjectKey: 'form_submitted:submission-1',
  });
  beforeEach(() => {
    db.seed('marketing_automation_workflows', [{
      id: 'wf-1', name: 'Thanks', trigger: 'form_submitted', status: 'active', deleted_at: null, run_count: 0,
      steps: [{ action: 'send_email', subject: 'Thanks' }],
    }]);
  });

  it('is not a failure, is not re-claimed by a redelivery, and is retried once the event carries an address', async () => {
    expect(await fire(null)).toMatchObject({ workflows: 1, emails: 0, failures: 0, errors: 0 });
    const recorded = snapshot(runs()[0]);
    expect(recorded).toMatchObject({ status: 'failed', metadata: expect.objectContaining({ actions: ['send_email:skipped(no-recipient)'] }) });

    // Redelivered with still no address: nothing claimed, nothing rewritten.
    expect(await fire(null)).toMatchObject({ workflows: 0, emails: 0, failures: 0, errors: 0 });
    expect(snapshot(runs()[0])).toEqual(recorded);

    expect(await fire('lead@example.com')).toMatchObject({ workflows: 1, emails: 1, failures: 0 });
    expect(runs()[0]).toMatchObject({ status: 'completed' });
    expect(h.sent).toEqual([{ to: 'lead@example.com', subject: 'Thanks' }]);
    expect(flow().run_count).toBe(1);
  });
});
