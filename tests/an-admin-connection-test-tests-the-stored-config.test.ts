import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

// The admin console's two "Test connection" buttons read the settings they
// test through getAIConfig and getStripeSettings, which drop their read's
// error (review R9-2-ADMIN-TEST-CONNECTION-FAILED-READ-IS-NO-KEY). With a key
// saved in the console and the read failing:
//  - /admin/ai said "No OpenAI key configured. Add one above and save", and
//    with OPENAI_API_KEY set it tested the environment's key and model and
//    called the stored config OK;
//  - /admin/stripe said "No Stripe secret key configured.", and with
//    STRIPE_SECRET_KEY set it tested that key and reported connected.
// Each now says the settings could not be read, and tests nothing. The REAL
// actions over the in-memory database; the model's HTTP endpoint and the
// Stripe client are the only stand-ins, and each records the key it was given.
const h = vi.hoisted(() => ({
  db: null as unknown,
  openai: [] as { authorization: string; model: string }[],
  stripeKeys: [] as string[],
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
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/stripe', () => ({
  stripeFromKey: (key: string) => {
    h.stripeKeys.push(key);
    return { balance: { retrieve: async () => ({ livemode: key.startsWith('sk_live'), available: [{ currency: 'usd' }] }) } };
  },
}));

const { testAIConnectionAction } = await import('@/app/(app)/admin/ai/actions');
const { testStripeConnectionAction } = await import('@/app/(app)/admin/actions');

let db: InMemorySupabase;
let faulted = 0;

/** Only `table`'s reads fail; each one is counted, so a fault that never fires cannot pass. */
function fail(table: string) {
  h.db = withFaults(db, (name) => {
    if (name !== table) return null;
    faulted += 1;
    return { code: '42501', message: `permission denied for table ${table}` };
  });
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.openai = [];
  h.stripeKeys = [];
  faulted = 0;
  db.seed('app_settings', [{ key: 'ai_provider', value: { provider: 'openai', model: 'gpt-4.1', openaiKey: 'sk-stored' } }]);
  db.seed('stripe_settings', [{ id: 'singleton', enabled: true, secret_key: 'sk_live_stored', webhook_secret: null, publishable_key: null }]);
  for (const name of ['OPENAI_API_KEY', 'AI_MODEL', 'AI_PROVIDER_STUB', 'E2E_PROVIDER_STUB', 'STRIPE_SECRET_KEY']) vi.stubEnv(name, undefined);
  // The model's HTTP endpoint: answers "OK" and records the key and model it was called with.
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    h.openai.push({ authorization: new Headers(init.headers).get('authorization') ?? '', model: body.model });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/admin/ai Test connection: a failed settings read is not "no key"', () => {
  it('says the settings could not be read, and calls no model', async () => {
    fail('app_settings');
    const result = await testAIConnectionAction();
    expect(faulted).toBe(1);
    expect(result).toEqual({ ok: false, code: 'unavailable', message: SOURCE_MESSAGES['adminAi.couldNotLoadAiEngineSettings'], detail: '' });
    expect(h.openai).toEqual([]);
  });

  it('does not test the environment\'s key and model in place of the stored ones', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env');
    vi.stubEnv('AI_MODEL', 'gpt-4o-mini');
    fail('app_settings');
    const result = await testAIConnectionAction();
    expect(faulted).toBe(1);
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    expect(h.openai).toEqual([]);
  });

  it('the control: a read that answers tests the stored key and the stored model', async () => {
    const result = await testAIConnectionAction();
    expect(result).toMatchObject({ ok: true, model: 'gpt-4.1', reply: 'OK' });
    expect(h.openai).toEqual([{ authorization: 'Bearer sk-stored', model: 'gpt-4.1' }]);
  });

  it('the control: a stored key wins over the environment\'s', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env');
    vi.stubEnv('AI_MODEL', 'gpt-4o-mini');
    await testAIConnectionAction();
    expect(h.openai).toEqual([{ authorization: 'Bearer sk-stored', model: 'gpt-4.1' }]);
  });

  it('the control: nothing stored and no environment key, from a read that answered, is "no key configured"', async () => {
    db.replace('app_settings', []);
    const result = await testAIConnectionAction();
    expect(result).toMatchObject({ ok: false, code: 'unconfigured' });
    expect(h.openai).toEqual([]);
  });
});

describe('/admin/stripe Test connection: a failed settings read is not "no key"', () => {
  const readError = SOURCE_MESSAGES['stripe.couldNotLoadStripeFinancial'];

  it('says the settings could not be read, and makes no Stripe client', async () => {
    fail('stripe_settings');
    const result = await testStripeConnectionAction();
    expect(faulted).toBe(1);
    expect(result).toEqual({ ok: false, error: readError });
    expect(h.stripeKeys).toEqual([]);
  });

  it('does not test STRIPE_SECRET_KEY in place of the stored key', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    fail('stripe_settings');
    const result = await testStripeConnectionAction();
    expect(faulted).toBe(1);
    expect(result).toEqual({ ok: false, error: readError });
    expect(h.stripeKeys).toEqual([]);
  });

  it('the control: a read that answers tests the stored key, over the environment\'s', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    const result = await testStripeConnectionAction();
    expect(result).toEqual({ ok: true, data: { livemode: true, currencies: 1 } });
    expect(h.stripeKeys).toEqual(['sk_live_stored']);
  });

  it('the control: nothing saved, from a read that answered, falls back to the environment, and then to "no key"', async () => {
    db.replace('stripe_settings', []);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_env');
    expect(await testStripeConnectionAction()).toEqual({ ok: true, data: { livemode: false, currencies: 1 } });
    expect(h.stripeKeys).toEqual(['sk_test_env']);
    vi.stubEnv('STRIPE_SECRET_KEY', undefined);
    expect(await testStripeConnectionAction()).toEqual({ ok: false, error: SOURCE_MESSAGES['actions.noStripeSecretKeyConfigured'] });
  });
});
