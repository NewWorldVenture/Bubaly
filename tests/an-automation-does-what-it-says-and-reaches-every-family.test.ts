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

// Marketing automation, end to end (admin-writers N7/N15, N9, N13/N16): the
// real console actions and pages, the real customer view, the real scheduled
// runner and the real cron route, against the in-memory database. Only the
// email provider is fake.
//
//  - The console offered seven actions no runner executes, `joins_segment`
//    (nothing fires it) and `customer_inactive`. A workflow with one of those
//    steps failed every matching family on every daily sweep: re-claimed,
//    failed again, counted as a run each time, and the cron answered 502 for
//    good.
//  - `customer_inactive` and a segment's `inactiveForDays` read
//    families.updated_at — the family row's last edit — as last activity, so a
//    paying family that uses the app daily got "We miss your family".
//  - The 200-subject cap was applied before completed subjects were set aside,
//    so the newest 200 matching families filled it every day and nobody past
//    them was ever served, while the run reported unserved: 0.
//  - A workflow switched on BEFORE the console refused unrunnable ones still
//    failed every NEW subject: each first run that recorded an unsupported
//    step was counted a failure, so the cron answered 502 on every day a family
//    joined (hiding the prune failures that share its status), and one with no
//    step a runner executes added a failed run per family to run_count while
//    sending nothing. It is reported as `unrunnable` and never fails the pass;
//    one with nothing to run is not run.

const h = vi.hoisted(() => ({ db: null as unknown, sent: [] as { to: string; subject: string }[], refuse: 0 }));
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
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), redirect: () => {} }));
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://bubaly.test',
  FROM_EMAIL: 'Bubaly <hello@bubaly.test>',
  emailEnabled: () => true,
  getResend: () => ({
    emails: {
      send: async (message: { to: string; subject: string }) => {
        // The next `refuse` sends are refused by the provider and deliver nothing.
        if (h.refuse > 0) { h.refuse--; return { data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } }; }
        h.sent.push({ to: message.to, subject: message.subject });
        return { data: { id: `re_${h.sent.length}` }, error: null };
      },
    },
  }),
}));
// The pages render forms bound to these; the cases below call the real ones.
vi.mock('@/app/(app)/admin/marketing/actions', () => ({
  createAutomation: async () => {}, setAutomationStatus: async () => {}, createSegment: async () => {}, archiveSegment: async () => {},
}));

const actions = await vi.importActual<typeof import('@/app/(app)/admin/marketing/actions')>('@/app/(app)/admin/marketing/actions');
const { runAutomations } = await import('@/lib/marketing/automation-runner');
const { resolveRecipients } = await import('@/lib/marketing/send');
const { GET: cron } = await import('@/app/api/cron/automations/route');
const { GET: checkoutAbandoned } = await import('@/app/api/cron/checkout-abandoned/route');
const { fireAutomationEvent } = await import('@/lib/marketing/automation-events');
type DB = SupabaseClient<Database>;

const NOW = new Date('2026-10-12T10:00:00.000Z');
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const pad = (i: number) => String(i).padStart(4, '0');
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

let db: InMemorySupabase;

/** A family with an owner and a subscription. `subscribedDaysAgo` under 30 is a new customer. */
function family(id: string, opts: { subscribedDaysAgo: number; editedDaysAgo?: number; createdIndex?: number }) {
  db.seed('families', [{ id, name: id, created_at: iso(400 - (opts.createdIndex ?? 0) / 1000), updated_at: iso(opts.editedDaysAgo ?? 1), closed_at: null }]);
  db.seed('family_members', [{ id: `m-${id}`, family_id: id, user_id: `u-${id}`, role: 'parent', is_active: true }]);
  db.seed('profiles', [{ id: `u-${id}`, email: `${id}@example.com` }]);
  db.seed('subscriptions', [{ id: `s-${id}`, family_id: id, plan: 'plus', status: 'active', created_at: iso(opts.subscribedDaysAgo), current_period_end: null }]);
}
function workflow(trigger: string, steps: { action: string; subject?: string }[], status = 'active') {
  db.seed('marketing_automation_workflows', [{ id: 'wf-1', name: 'Flow', trigger, status, deleted_at: null, run_count: 0, steps }]);
}
const runs = () => db.table('marketing_automation_runs');
const flow = () => db.table('marketing_automation_workflows')[0];
const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) data.append(key, v);
  return data;
};
const cronRequest = () => cron(new NextRequest('https://bubaly.test/api/cron/automations', { headers: { authorization: 'Bearer cron-fixture-secret' } }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ maxRows: 1000, rpc: { rate_limit_prune: () => null } });
  h.db = db;
  h.sent = [];
  h.refuse = 0;
  for (const table of ['marketing_suppressions', 'marketing_automation_runs', 'marketing_audit_logs', 'marketing_segments', 'child_login_throttle']) db.seed(table, []);
  vi.stubEnv('INTERNAL_SECRET', 'automation-fixture');
  vi.stubEnv('CRON_SECRET', 'cron-fixture-secret');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the console builds only workflows a runner runs', () => {
  it.each([
    ['an action that is never executed', { trigger: 'customer_created', actions: ['send_email', 'send_sms'] }],
    ['a tag step', { trigger: 'customer_created', actions: ['apply_tag'] }],
    ['a trigger nothing fires', { trigger: 'joins_segment', actions: ['send_email'] }],
    ['an inactivity trigger with no activity signal', { trigger: 'customer_inactive', actions: ['send_email'] }],
  ])('refuses %s', async (_label, fields) => {
    await expect(actions.createAutomation(form({ name: 'Flow', ...fields }))).rejects.toThrow();
    expect(db.table('marketing_automation_workflows')).toEqual([]);
  });

  it('creates an email workflow on a trigger that fires (control)', async () => {
    await actions.createAutomation(form({ name: 'Welcome', trigger: 'customer_created', actions: ['send_email'] }));
    expect(db.table('marketing_automation_workflows')).toEqual([expect.objectContaining({
      trigger: 'customer_created', status: 'draft', steps: [{ order: 1, action: 'send_email' }],
    })]);
  });

  it.each([
    ['a step no runner executes', 'customer_created', [{ action: 'send_email' }, { action: 'apply_tag' }]],
    ['a trigger nothing fires', 'joins_segment', [{ action: 'send_email' }]],
    ['the inactivity trigger', 'customer_inactive', [{ action: 'send_email' }]],
  ])('will not switch on a workflow made earlier with %s', async (_label, trigger, steps) => {
    workflow(trigger, steps, 'draft');
    await expect(actions.setAutomationStatus(form({ id: 'wf-1', status: 'active' }))).rejects.toThrow();
    expect(flow().status).toBe('draft');
    // Pausing or drafting it stays possible.
    await actions.setAutomationStatus(form({ id: 'wf-1', status: 'paused' }));
    expect(flow().status).toBe('paused');
  });

  it('switches on a runnable workflow (control)', async () => {
    workflow('customer_created', [{ action: 'send_email' }], 'draft');
    await actions.setAutomationStatus(form({ id: 'wf-1', status: 'active' }));
    expect(flow().status).toBe('active');
  });

  it('the builder offers only what runs, and a workflow that cannot run says so', async () => {
    // Not active: the "cannot be turned on" note is for a workflow that is not
    // on. An active one says what the runners do with it (the case below).
    workflow('customer_created', [{ action: 'send_email' }, { action: 'send_sms' }], 'draft');
    const { default: AutomationPage } = await import('@/app/(app)/admin/marketing/automation/page');
    const html = await renderServerPage(await AutomationPage());
    for (const offered of ['value="send_sms"', 'value="apply_tag"', 'value="notify_admin"', 'value="joins_segment"', 'value="customer_inactive"']) {
      expect(html, `${offered} is still offered`).not.toContain(offered);
    }
    expect(html).toContain('value="send_email"');
    expect(html).toContain('value="customer_created"');
    expect(textOf(html)).toContain(m('adminMarketingAutomation.notRunnable'));
  });

  it('an ACTIVE workflow that cannot fully run says what the runners do with it, not that it cannot be turned on', async () => {
    db.seed('marketing_automation_workflows', [
      { id: 'wf-mixed', name: 'Mixed', trigger: 'customer_created', status: 'active', deleted_at: null, run_count: 0, created_at: iso(1), steps: [{ action: 'send_email' }, { action: 'apply_tag' }, { action: 'send_sms' }] },
      { id: 'wf-sms', name: 'Sms', trigger: 'customer_created', status: 'active', deleted_at: null, run_count: 0, created_at: iso(2), steps: [{ action: 'send_sms' }] },
      { id: 'wf-never', name: 'Never', trigger: 'joins_segment', status: 'active', deleted_at: null, run_count: 0, created_at: iso(3), steps: [{ action: 'send_email' }] },
    ]);
    const { default: AutomationPage } = await import('@/app/(app)/admin/marketing/automation/page');
    // Newest first: Mixed, Sms, Never.
    const text = textOf(await renderServerPage(await AutomationPage()));
    const start = (name: string) => {
      const index = text.indexOf(`${name} active`);
      if (index < 0) throw new Error(`no card for ${name}`);
      return index;
    };
    const card = (name: string, next?: string) => text.slice(start(name), next ? start(next) : undefined);
    // Its email still goes to every new family; the other two steps are recorded unsupported.
    expect(card('Mixed', 'Sms')).toContain(m('adminMarketingAutomation.activeOnlyEmailRuns', { steps: 'apply tag, send sms' }));
    // Nothing in it runs: the runners skip it whole.
    expect(card('Sms', 'Never')).toContain(m('adminMarketingAutomation.activeNothingRuns'));
    // A trigger nothing fires: nothing runs, whatever its steps.
    expect(card('Never')).toContain(m('adminMarketingAutomation.activeNothingRuns'));
    expect(text, 'an Active workflow told the admin it cannot be turned on').not.toContain(m('adminMarketingAutomation.notRunnable'));
  });
});

// The app fires three event triggers the builder does not offer:
// onboarding_completed (app/onboarding/actions.ts), onboarding_abandoned and
// demo_abandoned (app/api/cron/journey-recovery). An active workflow on one of
// them sends (docs/onboarding-supabase.md tells operators to switch the
// onboarding welcome on). Their runnability was decided on the builder's list,
// so such a workflow, once paused, could not be switched back on, and its card
// said nothing in it runs while it emailed every family. demo_started has no
// caller: nothing fires it, so nothing in a workflow on it runs.
describe('an event trigger the app fires, though the builder does not offer it', () => {
  const welcome = (trigger: 'onboarding_completed' | 'onboarding_abandoned' | 'demo_abandoned', who: string) =>
    fireAutomationEvent(db as unknown as DB, { trigger, email: `${who}@example.com`, subjectKey: `${trigger}:${who}` });

  it.each(['onboarding_completed', 'onboarding_abandoned', 'demo_abandoned'] as const)(
    'a paused %s email workflow can be switched back on, and the next event sends again',
    async (trigger) => {
      workflow(trigger, [{ action: 'send_email', subject: 'Welcome' }]);
      expect(await welcome(trigger, 'first')).toMatchObject({ workflows: 1, emails: 1 });

      await actions.setAutomationStatus(form({ id: 'wf-1', status: 'paused' }));
      expect(flow().status).toBe('paused');
      expect(await welcome(trigger, 'while-paused'), 'a paused workflow sent').toMatchObject({ workflows: 0, emails: 0 });

      await expect(actions.setAutomationStatus(form({ id: 'wf-1', status: 'active' })), 'resuming it was refused').resolves.toBeUndefined();
      expect(flow().status, 'the workflow stayed paused for good').toBe('active');
      expect(await welcome(trigger, 'after-resume')).toMatchObject({ workflows: 1, emails: 1, failures: 0, unrunnable: 0 });
      expect(h.sent).toEqual([
        { to: 'first@example.com', subject: 'Welcome' },
        { to: 'after-resume@example.com', subject: 'Welcome' },
      ]);
    },
  );

  it('control: a draft on demo_started, which nothing fires, is still not switched on', async () => {
    workflow('demo_started', [{ action: 'send_email' }], 'draft');
    await expect(actions.setAutomationStatus(form({ id: 'wf-1', status: 'active' }))).rejects.toThrow();
    expect(flow().status).toBe('draft');
  });

  it('the cards say what the runners do: a fired trigger runs, demo_started does not', async () => {
    db.seed('marketing_automation_workflows', [
      { id: 'wf-welcome', name: 'Welcome', trigger: 'onboarding_completed', status: 'active', deleted_at: null, run_count: 0, created_at: iso(1), steps: [{ action: 'send_email' }] },
      { id: 'wf-recover', name: 'Recover', trigger: 'onboarding_abandoned', status: 'active', deleted_at: null, run_count: 0, created_at: iso(2), steps: [{ action: 'send_email' }, { action: 'apply_tag' }] },
      { id: 'wf-paused', name: 'Resting', trigger: 'demo_abandoned', status: 'paused', deleted_at: null, run_count: 0, created_at: iso(3), steps: [{ action: 'send_email' }] },
      { id: 'wf-demo', name: 'Demo', trigger: 'demo_started', status: 'active', deleted_at: null, run_count: 0, created_at: iso(4), steps: [{ action: 'send_email' }] },
    ]);
    const { default: AutomationPage } = await import('@/app/(app)/admin/marketing/automation/page');
    // Newest first: Welcome, Recover, Resting, Demo.
    const text = textOf(await renderServerPage(await AutomationPage()));
    const start = (name: string, status: string) => {
      const index = text.indexOf(`${name} ${status}`);
      if (index < 0) throw new Error(`no card for ${name}`);
      return index;
    };
    const welcomeCard = text.slice(start('Welcome', 'active'), start('Recover', 'active'));
    const recoverCard = text.slice(start('Recover', 'active'), start('Resting', 'paused'));
    const restingCard = text.slice(start('Resting', 'paused'), start('Demo', 'active'));
    const demoCard = text.slice(start('Demo', 'active'));
    // It emails every family that finishes onboarding: no warning at all.
    for (const key of ['activeNothingRuns', 'notRunnable']) {
      expect(welcomeCard, `the welcome card says ${key}`).not.toContain(m(`adminMarketingAutomation.${key}`));
    }
    expect(welcomeCard).not.toContain(m('adminMarketingAutomation.activeOnlyEmailRuns', { steps: '' }).split(':')[0]);
    // Its email runs; only the tag is skipped.
    expect(recoverCard).toContain(m('adminMarketingAutomation.activeOnlyEmailRuns', { steps: 'apply tag' }));
    expect(recoverCard).not.toContain(m('adminMarketingAutomation.activeNothingRuns'));
    // Paused, it can be switched back on: not "cannot be turned on".
    expect(restingCard).not.toContain(m('adminMarketingAutomation.notRunnable'));
    // Control: nothing fires demo_started, so nothing in it runs.
    expect(demoCard).toContain(m('adminMarketingAutomation.activeNothingRuns'));
  });
});

describe('a workflow with a step no runner executes', () => {
  it('mails the family once, records the step honestly, and is not re-failed every day', async () => {
    family('fam-new', { subscribedDaysAgo: 5 });
    workflow('customer_created', [{ action: 'send_email', subject: 'Welcome' }, { action: 'apply_tag' }]);

    const first = await runAutomations(db as unknown as DB);
    // A step no runner executes is reported, not this pass's failure: counted
    // one, the first run of every new family answered the cron 502 (below).
    expect(first).toMatchObject({ runs: 1, emails: 1, failures: 0, unrunnable: 1 });
    expect(runs()[0].status).toBe('failed');
    expect((runs()[0].metadata as { actions: string[] }).actions).toEqual(['send_email', 'apply_tag:unsupported']);

    // The next days: nothing to retry, so nothing is retried, counted or failed.
    const second = await cronRequest();
    expect(second.status, 'the cron answered 502 every day for a step it can never run').toBe(200);
    expect(await second.json()).toMatchObject({ runs: 0, failures: 0 });
    const third = await runAutomations(db as unknown as DB);
    expect(third).toMatchObject({ runs: 0, failures: 0 });
    expect(h.sent.map((s) => s.subject)).toEqual(['Welcome']);
    expect(flow().run_count, 'each daily retry was counted as another run').toBe(1);
  });
});

describe('run_count counts subjects run, not attempts', () => {
  // A failed send is retried on the next pass (or the next delivery of the
  // event) under the same run row. Counting every attempt made "N runs" read
  // the number of tries, not the number of families the workflow reached.
  it('a scheduled run that failed and is retried still counts once', async () => {
    family('fam-new', { subscribedDaysAgo: 5 });
    workflow('customer_created', [{ action: 'send_email', subject: 'Welcome' }]);
    h.refuse = 1;
    expect(await runAutomations(db as unknown as DB)).toMatchObject({ runs: 1, emails: 0, failures: 1 });
    expect(runs()[0].status).toBe('failed');
    expect(flow().run_count).toBe(1);

    expect(await runAutomations(db as unknown as DB)).toMatchObject({ runs: 1, emails: 1, failures: 0 });
    expect(runs()).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(flow().run_count, 'the retry of one family\'s run was counted as a second run').toBe(1);
    expect(h.sent).toEqual([{ to: 'fam-new@example.com', subject: 'Welcome' }]);
  });

  it('an event-driven run that failed and is retried still counts once', async () => {
    workflow('form_submitted', [{ action: 'send_email', subject: 'Thanks' }]);
    const fire = () => fireAutomationEvent(db as unknown as DB, {
      trigger: 'form_submitted', email: 'lead@example.com', name: 'Lead', subjectKey: 'form_submitted:submission-1',
    });
    h.refuse = 1;
    expect(await fire()).toMatchObject({ workflows: 1, emails: 0, failures: 1 });
    expect(flow().run_count).toBe(1);
    expect(await fire()).toMatchObject({ workflows: 1, emails: 1, failures: 0 });
    expect(runs()).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(flow().run_count, 'the retried event was counted as a second run').toBe(1);
  });
});

describe('inactivity is not read from the family row', () => {
  beforeEach(() => {
    // Pays, uses the app — and has not renamed itself in sixty days.
    family('fam-daily', { subscribedDaysAgo: 200, editedDaysAgo: 60 });
  });

  it('an inactivity workflow made earlier sends no "we miss you" to a family whose activity is unknown', async () => {
    workflow('customer_inactive', [{ action: 'send_email' }]);
    const summary = await runAutomations(db as unknown as DB);
    expect(h.sent).toEqual([]);
    expect(summary).toMatchObject({ runs: 0, emails: 0 });
  });

  it('a segment made earlier with an inactivity rule holds no one, and the console says why', async () => {
    db.seed('marketing_segments', [{ id: 'seg-1', name: 'Dormant', rules: { inactiveForDays: 30 }, deleted_at: null, created_at: iso(10) }]);
    expect(await resolveRecipients(db as unknown as DB, { segment_id: 'seg-1' })).toEqual([]);
    const { default: SegmentsPage } = await import('@/app/(app)/admin/marketing/segments/page');
    const text = textOf(await renderServerPage(await SegmentsPage()));
    expect(text).toContain('Dormant 0 matching');
    expect(text).toContain(m('adminMarketingSegments.inactiveRuleNoSignal', { n: 30 }));
  });

  it('a new segment cannot be made on inactivity', async () => {
    await expect(actions.createSegment(form({ name: 'Dormant', inactiveForDays: '30' }))).rejects.toThrow();
    expect(db.table('marketing_segments')).toEqual([]);
  });

  it('a segment on a rule the view can decide still holds the family (control)', async () => {
    await actions.createSegment(form({ name: 'Plus', plans: 'plus' }));
    const [segment] = db.table('marketing_segments');
    expect(segment.rules).toEqual({ plans: ['plus'] });
    expect(await resolveRecipients(db as unknown as DB, { segment_id: segment.id as string })).toEqual(['fam-daily@example.com']);
  });
});

describe('the per-pass cap counts the families still owed a run', () => {
  it('serves the newest 200 on the first pass, says 50 are owed, and reaches them on the next', async () => {
    for (let i = 0; i < 250; i++) family(`fam-${pad(i)}`, { subscribedDaysAgo: 3, createdIndex: i });
    workflow('customer_created', [{ action: 'send_email', subject: 'Welcome' }]);

    const first = await runAutomations(db as unknown as DB);
    expect(first).toMatchObject({ runs: 200, emails: 200, unserved: 50 });

    const second = await runAutomations(db as unknown as DB);
    expect(second, 'the families past the newest 200 were never served').toMatchObject({ runs: 50, emails: 50, unserved: 0 });
    expect(new Set(h.sent.map((s) => s.to)).size).toBe(250);
    expect(h.sent).toHaveLength(250);

    const third = await runAutomations(db as unknown as DB);
    expect(third).toMatchObject({ runs: 0, emails: 0, unserved: 0 });
    expect(flow().run_count).toBe(250);
  });
});

describe('a workflow switched on before the console refused unrunnable ones', () => {
  /** The clock `day` days after NOW, and a family that subscribed the day before it. */
  function nextDay(day: number) {
    vi.setSystemTime(new Date(NOW.getTime() + day * DAY));
    family(`fam-day-${day}`, { subscribedDaysAgo: 1 - day, createdIndex: day });
  }

  it('an email-and-tag workflow mails each new family once, and the cron answers 200 on every day one joins', async () => {
    workflow('customer_created', [{ action: 'send_email', subject: 'Welcome' }, { action: 'apply_tag' }]);
    for (let day = 0; day < 3; day++) {
      nextDay(day);
      const response = await cronRequest();
      const body = await response.json();
      expect(response.status, `day ${day + 1}: a new family on a legacy workflow answered 502`).toBe(200);
      expect(body).toMatchObject({ runs: 1, emails: 1, failures: 0, unrunnable: 1, ok: true });
    }
    expect(h.sent).toEqual([0, 1, 2].map((day) => ({ to: `fam-day-${day}@example.com`, subject: 'Welcome' })));
    // Each family's row is still honest about the step it could not do, and is not retried.
    expect(runs().map((r) => [r.subject_key, r.status, (r.metadata as { actions: string[] }).actions])).toEqual(
      [0, 1, 2].map((day) => [`fam-day-${day}`, 'failed', ['send_email', 'apply_tag:unsupported']]),
    );
    expect(flow().run_count).toBe(3);
  });

  it.each([
    ['a lone SMS step', [{ action: 'send_sms' }]],
    ['a tag and an admin note', [{ action: 'apply_tag' }, { action: 'notify_admin' }]],
    ['no steps at all', []],
  ])('one with %s is not run: no row, nothing counted, and the cron answers 200', async (_label, steps) => {
    workflow('customer_created', steps);
    for (let day = 0; day < 2; day++) {
      nextDay(day);
      const response = await cronRequest();
      expect(response.status, 'a workflow that sends nothing failed every new family').toBe(200);
      expect(await response.json()).toMatchObject({ workflows: 0, runs: 0, emails: 0, failures: 0, unrunnable: 1, ok: true });
    }
    expect(runs(), 'a failed run was recorded for each family').toEqual([]);
    expect(flow().run_count, 'each family was added to "N runs" while nothing was sent').toBe(0);
    expect(h.sent).toEqual([]);
  });

  it('control: a workflow every step of which runs is not reported', async () => {
    workflow('customer_created', [{ action: 'send_email', subject: 'Welcome' }]);
    nextDay(0);
    const response = await cronRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runs: 1, emails: 1, failures: 0, unrunnable: 0 });
  });

  describe('on the event path', () => {
    const HOUR = 3_600_000;
    const session = () => db.table('checkout_sessions').find((s) => s.session_id === 'cs_1')!;
    beforeEach(() => {
      db.seed('checkout_sessions', [{
        id: 'row-1', session_id: 'cs_1', family_id: null, email: 'parent@example.com', name: 'Sam', status: 'pending',
        created_at: new Date(NOW.getTime() - 3 * HOUR).toISOString(), abandoned_at: null,
      }]);
    });
    const checkoutRequest = () => checkoutAbandoned(new NextRequest('https://bubaly.test/api/cron/checkout-abandoned', { headers: { authorization: 'Bearer cron-fixture-secret' } }));

    it('a checkout nudge with a step no runner executes is fired and keeps its claim, and the cron answers 200', async () => {
      workflow('checkout_abandoned', [{ action: 'send_email', subject: 'Still thinking?' }, { action: 'notify_admin' }]);
      const response = await checkoutRequest();
      expect(response.status, 'the delivered nudge was counted failed and its session handed back').toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, fired: 1, failed: 0 });
      expect(session().status).toBe('abandoned');
      expect(h.sent).toEqual([{ to: 'parent@example.com', subject: 'Still thinking?' }]);
      expect(runs()).toEqual([expect.objectContaining({ status: 'failed', metadata: expect.objectContaining({ actions: ['send_email', 'notify_admin:unsupported'] }) })]);
      expect(flow().run_count).toBe(1);
    });

    it('an event workflow with no step a runner executes is reported and not run', async () => {
      workflow('form_submitted', [{ action: 'send_sms' }]);
      const result = await fireAutomationEvent(db as unknown as DB, {
        trigger: 'form_submitted', email: 'lead@example.com', name: 'Lead', subjectKey: 'form_submitted:lead@example.com',
      });
      expect(result).toEqual({ workflows: 0, emails: 0, failures: 0, errors: 0, unrunnable: 1 });
      expect(runs()).toEqual([]);
      expect(flow().run_count).toBe(0);
    });

    it('control: a send that failed is still a failure', async () => {
      workflow('form_submitted', [{ action: 'send_email' }, { action: 'notify_admin' }]);
      // The provider refuses it. (A send with no address at all is settled,
      // not a failure: tests/an-automation-send-with-no-address-is-settled-not-retried.test.ts.)
      h.refuse = 1;
      const result = await fireAutomationEvent(db as unknown as DB, {
        trigger: 'form_submitted', email: 'lead@example.com', name: 'Lead', subjectKey: 'form_submitted:lead@example.com',
      });
      expect(result).toMatchObject({ workflows: 1, emails: 0, failures: 1, unrunnable: 1 });
    });
  });
});
