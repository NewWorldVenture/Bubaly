import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// admin-writers N19-S1. Billing resolves its Stripe key from Super Admin →
// Stripe Setup first and the environment second (effectiveSecretKey), and the
// health check now probes that key (N19). Three sibling consoles did not:
//  - /admin/subscriptions' Billing tab listed invoices with getStripe(), the
//    environment alone, so a key saved only in Stripe Setup read "Stripe is
//    not configured" while checkout worked, and a stale environment key listed
//    invoices from an account billing no longer uses;
//  - /admin/settings and /admin/marketing/settings showed Stripe ready as
//    !!process.env.STRIPE_SECRET_KEY.
// The real pages and the real settings read against the in-memory database;
// Stripe is a fake that answers per key and records which key it was asked with.

const h = vi.hoisted(() => ({
  db: null as unknown,
  listedWith: [] as string[],
  invoicesByKey: {} as Record<string, Record<string, unknown>[]>,
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, describeConfiguredServiceKey: () => null }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});
vi.mock('@/lib/stripe', () => {
  const client = (key: string) => ({
    invoices: {
      list: async () => {
        h.listedWith.push(key);
        const data = h.invoicesByKey[key];
        if (!data) throw Object.assign(new Error(`Invalid API Key provided: ${key}`), { type: 'StripeAuthenticationError' });
        return { data };
      },
    },
  });
  return {
    getStripe: () => {
      if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
      return client(process.env.STRIPE_SECRET_KEY);
    },
    stripeFromKey: (key?: string | null) => {
      const trimmed = key?.trim();
      if (trimmed) return client(trimmed);
      if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
      return client(process.env.STRIPE_SECRET_KEY);
    },
  };
});
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: () => {}, success: () => {}, error: () => {} }) }));
vi.mock('@/app/(app)/admin/marketing/actions', () => ({ saveSetting: async () => {} }));

const m = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;

const invoice = (id: string, customer: string) => ({
  id, number: id.toUpperCase(), amount_paid: 1299, status: 'paid', created: 1_790_000_000, customer, hosted_invoice_url: null,
});
const stored = (secretKey: string) => db.seed('stripe_settings', [{ id: 'singleton', secret_key: secretKey, enabled: true }]);
const unreadableSettings = () => {
  h.db = withFaults(db, (table) => (table === 'stripe_settings' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));
};

async function billingTab(): Promise<string> {
  const { default: AdminSubscriptionsPage } = await import('@/app/(app)/admin/subscriptions/page');
  return renderServerPage(await AdminSubscriptionsPage({ searchParams: Promise.resolve({ tab: 'billing' }) }));
}
async function settingsPage(path: 'settings' | 'marketing/settings'): Promise<string> {
  const page = path === 'settings'
    ? await import('@/app/(app)/admin/settings/page')
    : await import('@/app/(app)/admin/marketing/settings/page');
  return renderServerPage(await page.default());
}
/** The words of the list row that names `name`. */
function row(html: string, name: string): string {
  const found = (html.match(/<li[^>]*>.*?<\/li>/g) ?? []).map(textOf).find((text) => text.startsWith(`${name} `));
  if (!found) throw new Error(`no "${name}" row on the page`);
  return found;
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.listedWith = [];
  h.invoicesByKey = {};
  db.seed('stripe_settings', []);
  db.seed('families', [{ id: 'fam-1', name: 'The Riveras' }, { id: 'fam-old', name: 'Old account family' }]);
  db.seed('billing_customers', [
    { id: 'bc-1', family_id: 'fam-1', provider: 'stripe', customer_ref: 'cus_live' },
    { id: 'bc-old', family_id: 'fam-old', provider: 'stripe', customer_ref: 'cus_old' },
  ]);
  db.seed('super_admins', [{ id: 'sa-1', email: 'root@example.com' }]);
  db.seed('marketing_settings', [{ id: 'ms-1', key: 'from_name', value: { text: 'Bubaly' } }]);
  vi.stubEnv('STRIPE_SECRET_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/admin/subscriptions Billing tab lists invoices through the key billing uses', () => {
  it('a key saved only in Stripe Setup lists its invoices', async () => {
    stored('sk_test_setup');
    h.invoicesByKey = { sk_test_setup: [invoice('in_live', 'cus_live')] };
    const html = await billingTab();
    expect(h.listedWith, 'the tab read only STRIPE_SECRET_KEY and said "Stripe is not configured"').toEqual(['sk_test_setup']);
    expect(textOf(html)).toContain('The Riveras IN_LIVE paid');
    expect(textOf(html)).not.toContain(m('adminSubscriptions.stripeIsntConnected'));
  });

  it('a stored key that replaced a stale environment key is the one listed through', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_stale_env');
    stored('sk_test_setup');
    h.invoicesByKey = { sk_test_setup: [invoice('in_live', 'cus_live')], sk_test_stale_env: [invoice('in_old', 'cus_old')] };
    const text = textOf(await billingTab());
    expect(h.listedWith).toEqual(['sk_test_setup']);
    expect(text).toContain('IN_LIVE');
    expect(text, 'invoices from an account billing no longer uses').not.toContain('Old account family');
  });

  it('settings that cannot be read say so, and nothing is listed through the environment\'s key', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    h.invoicesByKey = { sk_test_env: [invoice('in_old', 'cus_old')] };
    unreadableSettings();
    const text = textOf(await billingTab());
    expect(h.listedWith).toEqual([]);
    expect(text).toContain(`${m('adminSubscriptions.stripeIsntConnected')} ${m('adminIntegrations.stripeSetupUnreadable')}`);
  });

  it('no key anywhere says where a key would come from', async () => {
    const text = textOf(await billingTab());
    expect(h.listedWith).toEqual([]);
    expect(text).toContain(`${m('adminSubscriptions.stripeIsntConnected')} ${m('adminIntegrations.stripeNoKey')}`);
  });

  it('a key Stripe refuses is not shown as its raw provider message', async () => {
    stored('sk_test_revoked');
    const text = textOf(await billingTab());
    expect(h.listedWith).toEqual(['sk_test_revoked']);
    expect(text).toContain(m('adminSubscriptions.stripeInvoicesUnavailable'));
    expect(text).not.toContain('Invalid API Key');
  });

  it('control: the environment key is listed through when nothing is saved', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    h.invoicesByKey = { sk_test_env: [invoice('in_live', 'cus_live')] };
    const text = textOf(await billingTab());
    expect(h.listedWith).toEqual(['sk_test_env']);
    expect(text).toContain('The Riveras IN_LIVE paid');
  });
});

describe('/admin/settings and /admin/marketing/settings report Stripe on the key billing uses', () => {
  it('a key saved only in Stripe Setup is Connected, and says it came from there', async () => {
    stored('sk_test_setup');
    expect(row(await settingsPage('settings'), 'Stripe (payments)'), 'the console read Not set over a working Stripe Setup key')
      .toBe(`Stripe (payments) ${m('adminSettings.stripeKeyFromSetup')} ${m('settings.connected')}`);
    expect(row(await settingsPage('marketing/settings'), 'Payments (Stripe)'))
      .toBe(`Payments (Stripe) ${m('adminSettings.stripeKeyFromSetup')} ${m('settings.connected')}`);
  });

  it('the environment key is named as the source when nothing is saved', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    expect(row(await settingsPage('settings'), 'Stripe (payments)'))
      .toBe(`Stripe (payments) ${m('adminSettings.stripeKeyFromEnvironment')} ${m('settings.connected')}`);
    expect(row(await settingsPage('marketing/settings'), 'Payments (Stripe)'))
      .toBe(`Payments (Stripe) ${m('adminSettings.stripeKeyFromEnvironment')} ${m('settings.connected')}`);
  });

  it('settings that cannot be read are Unavailable, not the environment\'s Connected', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    unreadableSettings();
    const unavailable = m('strategyMetrics.unavailable');
    expect(row(await settingsPage('settings'), 'Stripe (payments)')).toBe(`Stripe (payments) — ${unavailable}`);
    expect(row(await settingsPage('marketing/settings'), 'Payments (Stripe)')).toBe(`Payments (Stripe) ${unavailable}`);
  });

  it('control: no key anywhere is Not set', async () => {
    expect(row(await settingsPage('settings'), 'Stripe (payments)')).toBe(`Stripe (payments) STRIPE_SECRET_KEY ${m('settings.notSet')}`);
    expect(row(await settingsPage('marketing/settings'), 'Payments (Stripe)')).toBe('Payments (Stripe) Set STRIPE_SECRET_KEY');
  });
});
