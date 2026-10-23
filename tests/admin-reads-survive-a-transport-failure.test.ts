import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';
import { withTransportFailure } from './helpers/transport-failure';

// A Supabase query RESOLVES with { data, error } for anything the database
// answers and REJECTS only when the request never completed: DNS, TCP, TLS, a
// timed-out fetch. Each page below awaited one read bare, outside settle(), so
// that rejection escaped the page and the route's error boundary rendered in
// place of the page's own read-error state, or, on /admin, in place of a
// dashboard whose only loss should have been the names beside its activity
// rows (review R5-SIBLING-BARE-READS). Each case drives the real page with that
// one read rejecting and every other table answering from the in-memory
// database, and each has a control with every table reachable.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
const up = (name: string) => ({ name, ok: true, latencyMs: 1, detail: 'Operational' });
vi.mock('@/lib/server/health', () => ({
  checkDatabase: async () => up('Database'),
  checkStorage: async () => up('Storage'),
  checkEmail: () => up('Email'),
  checkAI: () => up('AI'),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: () => {}, success: () => {}, error: () => {} }) }));
// Controls that reach for the router or a server action; none reads a table.
vi.mock('@/components/admin/user-security-actions', () => ({ UserSecurityActions: () => null }));
vi.mock('@/components/admin/stripe-setup-form', () => ({ StripeSetupForm: () => null }));
vi.mock('@/app/(app)/admin/marketing/experiments/actions', () => ({
  createExperiment: async () => {}, setExperimentStatus: async () => {}, setExperimentWinner: async () => {},
}));
vi.mock('@/app/(app)/admin/marketing/surveys/actions', () => ({
  createSurveyAction: async () => {}, setSurveyStatusAction: async () => ({ ok: true }), deleteSurveyAction: async () => ({ ok: true }),
}));

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  (db as unknown as { auth: unknown }).auth = {
    admin: {
      listUsers: async (params?: { page?: number }) => ({
        data: { users: (params?.page ?? 1) === 1 ? [{ id: 'auth-1', email: 'a@example.com', email_confirmed_at: null, last_sign_in_at: null, banned_until: null, created_at: '2026-01-01T00:00:00Z' }] : [] },
        error: null,
      }),
    },
  };
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The actor read: the profiles named by the listed audit rows. */
const actorRead = (table: string, calls: { method: string }[]) => table === 'profiles' && calls.some((c) => c.method === 'in');

function seedAuditTrail() {
  db.seed('families', [{ id: 'fam-1', name: 'The Rivera family', created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('profiles', [{ id: 'actor-1', full_name: 'Avery Admin', email: 'avery@example.com', created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('audit_logs', [{
    id: 'log-1', family_id: 'fam-1', actor_id: 'actor-1', action: 'document.view', resource: 'Passport scan',
    metadata: null, created_at: '2026-10-22T11:00:00Z',
  }]);
}

describe('/admin: an unreachable actor lookup costs the names, not the dashboard', () => {
  async function render() {
    const { default: AdminDashboardPage } = await import('@/app/(app)/admin/page');
    const page = AdminDashboardPage();
    await expect(page).resolves.toBeDefined();
    return renderServerPage(await page);
  }

  it('renders the dashboard and the activity row without its actor', async () => {
    seedAuditTrail();
    h.db = withTransportFailure(db, actorRead);
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['admin.adminDashboard']);
    expect(html).toContain('· document.view Passport scan');
    expect(html).not.toContain('Avery Admin');
  });

  it('the control: with every table reachable the row names its actor', async () => {
    seedAuditTrail();
    h.db = withTransportFailure(db, 'no_such_table');
    const html = await render();
    expect(html).toContain('<span class="font-medium">Avery Admin</span>');
  });
});

describe('/admin/security: an unreachable actor lookup is the activity read-error state', () => {
  async function render() {
    const { default: AdminSecurityPage } = await import('@/app/(app)/admin/security/page');
    const page = AdminSecurityPage();
    await expect(page).resolves.toBeDefined();
    return renderServerPage(await page);
  }

  it('renders its own error state, not the route error boundary', async () => {
    seedAuditTrail();
    h.db = withTransportFailure(db, actorRead);
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['security.couldNotLoadSecurityActivity']);
  });

  it('the control: with every table reachable the audit row names its actor', async () => {
    seedAuditTrail();
    h.db = withTransportFailure(db, 'no_such_table');
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['security.couldNotLoadSecurityActivity']);
    expect(html).toContain('Avery Admin');
  });
});

describe('/admin/stripe: an unreachable Stripe settings read is the read-error state', () => {
  async function render() {
    const { default: AdminStripeMoneyPage } = await import('@/app/(app)/admin/stripe/page');
    const page = AdminStripeMoneyPage();
    await expect(page).resolves.toBeDefined();
    return renderServerPage(await page);
  }

  it('renders its own error state, not the route error boundary', async () => {
    db.seed('stripe_settings', [{ id: 'singleton' }]);
    h.db = withTransportFailure(db, 'stripe_settings');
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['stripe.couldNotLoadStripeFinancial']);
  });

  it('the control: with every table reachable the console renders', async () => {
    db.seed('stripe_settings', [{ id: 'singleton' }]);
    h.db = withTransportFailure(db, 'no_such_table');
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['stripe.couldNotLoadStripeFinancial']);
  });
});

describe('/admin/marketing/surveys/[id]: an unreachable survey read is the read-error state', () => {
  function seedSurvey() {
    db.seed('surveys', [{ id: 'srv-a', name: 'Onboarding', type: 'nps', status: 'active', slug: 'onboarding', question: 'Recommend us?', scale_min: 0, scale_max: 10, deleted_at: null }]);
    db.seed('survey_responses', [{ id: 'resp-1', survey_id: 'srv-a', score: 9, comment: 'Lovely', respondent_email: null, submitted_at: '2026-10-21T10:00:00Z' }]);
  }
  async function render() {
    const { default: SurveyDetailPage } = await import('@/app/(app)/admin/marketing/surveys/[id]/page');
    const page = SurveyDetailPage({ params: Promise.resolve({ id: 'srv-a' }) });
    await expect(page).resolves.toBeDefined();
    return renderServerPage(await page);
  }

  it('renders its own error state, not the route error boundary', async () => {
    seedSurvey();
    h.db = withTransportFailure(db, 'surveys');
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['surveys.couldNotLoadThisSurvey']);
  });

  it('the control: with every table reachable the survey renders', async () => {
    seedSurvey();
    h.db = withTransportFailure(db, 'no_such_table');
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['surveys.couldNotLoadThisSurvey']);
    expect(html).toContain('Lovely');
  });
});

describe('/admin/marketing/experiments: an unreachable experiment read is the read-error state', () => {
  function seedExperiment() {
    db.seed('ab_experiments', [{
      id: 'exp-1', key: 'hero-copy', name: 'Hero copy', status: 'running', deleted_at: null, winner_variant: null,
      variants: [{ key: 'a', label: 'A', weight: 50 }, { key: 'b', label: 'B', weight: 50 }], created_at: '2026-10-01T00:00:00Z',
    }]);
    db.seed('ab_events', []);
  }
  async function render() {
    const { default: ABTestingPage } = await import('@/app/(app)/admin/marketing/experiments/page');
    const page = ABTestingPage();
    await expect(page).resolves.toBeDefined();
    return renderServerPage(await page);
  }

  it('renders its own error state, not the route error boundary', async () => {
    seedExperiment();
    h.db = withTransportFailure(db, 'ab_experiments');
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['experiments.couldNotLoadExperimentResults']);
  });

  it('the control: with every table reachable the experiment renders', async () => {
    seedExperiment();
    h.db = withTransportFailure(db, 'no_such_table');
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['experiments.couldNotLoadExperimentResults']);
    expect(html).toContain('Hero copy');
  });
});

describe('/admin/backup: one unreachable table count is the read-error state', () => {
  async function render() {
    const { default: AdminDataPage } = await import('@/app/(app)/admin/backup/page');
    const page = AdminDataPage();
    await expect(page).resolves.toBeDefined();
    return renderServerPage(await page);
  }

  it('renders its own error state, not the route error boundary', async () => {
    db.seed('reminders', [{ id: 'rem-1' }]);
    h.db = withTransportFailure(db, 'reminders');
    const html = await render();
    expect(html).toContain(SOURCE_MESSAGES['backup.couldNotLoadDataAnd']);
  });

  it('the control: with every table reachable the counts render', async () => {
    db.seed('reminders', [{ id: 'rem-1' }]);
    h.db = withTransportFailure(db, 'no_such_table');
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['backup.couldNotLoadDataAnd']);
    expect(html).toContain(SOURCE_MESSAGES['adminBackup.totalRowsTrackedTables']);
  });
});

describe('the transport-failure fake', () => {
  it('rejects a derived thenable such as maybeSingle(), not only the builder', async () => {
    db.seed('stripe_settings', [{ id: 'singleton' }]);
    const client = withTransportFailure(db, 'stripe_settings');
    await expect(client.from('stripe_settings').select('*').eq('id', 'singleton').maybeSingle()).rejects.toThrow('CONNECT_TIMEOUT reading stripe_settings');
    await expect(client.from('stripe_settings').select('*')).rejects.toThrow('CONNECT_TIMEOUT reading stripe_settings');
    await expect(client.from('reminders').select('id')).resolves.toMatchObject({ error: null });
  });
});
