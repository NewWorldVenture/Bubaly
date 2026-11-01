import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// admin-writers N19. The Integrations and System pages probed Stripe with
// STRIPE_SECRET_KEY alone, while billing resolves its key from Super Admin →
// Stripe Setup first and the environment second (effectiveSecretKey). A
// deployment configured in Stripe Setup read "STRIPE_SECRET_KEY not
// configured" while checkout worked, and one whose stored key replaced the
// environment's was reported on through a key billing no longer uses. The real
// health check and the real Integrations page; Stripe itself is a fake that
// records which key it was asked with.

const h = vi.hoisted(() => ({ db: null as unknown, probed: [] as string[], badKeys: new Set<string>() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});
vi.mock('@/lib/stripe', () => {
  const client = (key: string) => ({
    balance: {
      retrieve: async () => {
        h.probed.push(key);
        if (h.badKeys.has(key)) throw new Error('Invalid API Key provided');
        return { livemode: false, available: [] };
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

const { checkStripe } = await import('@/lib/server/health');

let db: InMemorySupabase;
const m = (key: string) => translate(SOURCE_MESSAGES, key);
const stored = (secretKey: string | null) => db.seed('stripe_settings', [{ id: 'singleton', secret_key: secretKey, enabled: true }]);

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  h.probed = [];
  h.badKeys = new Set();
  db.seed('stripe_settings', []);
  vi.stubEnv('STRIPE_SECRET_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the Stripe health check', () => {
  it('a key saved only in Stripe Setup is the one probed, and it reads connected', async () => {
    stored('sk_test_setup');
    const check = await checkStripe();
    expect(check.ok, 'billing works on the stored key and the console said "not configured"').toBe(true);
    expect(h.probed).toEqual(['sk_test_setup']);
    expect(check.detail).toBe(m('adminIntegrations.stripeKeyFromSetup'));
  });

  it('a stored key that replaced the environment\'s is the one probed', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_stale_env');
    stored('sk_test_setup');
    h.badKeys.add('sk_test_setup');
    const check = await checkStripe();
    // The stale environment key would have answered "connected".
    expect(h.probed).toEqual(['sk_test_setup']);
    expect(check.ok).toBe(false);
  });

  it('settings that cannot be read are a failed check, not the environment\'s answer', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    h.db = withFaults(db, (table) => (table === 'stripe_settings' ? { message: 'stripe_settings unavailable' } : null));
    const check = await checkStripe();
    expect(check).toMatchObject({ ok: false, detail: m('adminIntegrations.stripeSetupUnreadable') });
    expect(h.probed).toEqual([]);
  });

  it('no key anywhere says so', async () => {
    const check = await checkStripe();
    expect(check).toMatchObject({ ok: false, detail: m('adminIntegrations.stripeNoKey') });
    expect(h.probed).toEqual([]);
  });

  it('the environment key is still probed when nothing is saved (control)', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    const check = await checkStripe();
    expect(check).toMatchObject({ ok: true, detail: m('adminIntegrations.stripeKeyFromEnvironment') });
    expect(h.probed).toEqual(['sk_test_env']);
  });

  it('the Integrations page reports Stripe connected on a Stripe Setup key', async () => {
    stored('sk_test_setup');
    db.seed('user_preferences', []);
    const { default: AdminIntegrationsPage } = await import('@/app/(app)/admin/integrations/page');
    const text = textOf(await renderServerPage(await AdminIntegrationsPage()));
    expect(text).toMatch(new RegExp(`Stripe Payments [^]*?${m('adminIntegrations.liveBalanceCheckInMs').split('{ms}')[0]}\\d+ms ${m('integrations.connected')}`));
    expect(h.probed).toEqual(['sk_test_setup']);
  });
});
