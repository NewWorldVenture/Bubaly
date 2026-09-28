// CALLBACK-0FC95B4182A0: the money webhook verified signatures through
// getStripe(), which throws when STRIPE_SECRET_KEY is unset, and its catch
// answered "signature invalid". A deployment with the signing secret but not
// the API key refused every genuine event as forged. Verification needs only
// the secret, as the billing webhook already does.
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }));

const SECRET = 'whsec_synthetic_money_secret';
function signed(payload: object, secret = SECRET) {
  const body = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  return new NextRequest('https://app.example.test/api/webhooks/money', { method: 'POST', body, headers: { 'stripe-signature': header } });
}
const unhandled = { id: 'evt_money_fixture', object: 'event', type: 'customer.created', data: { object: {} } };

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('the money webhook verifies with the signing secret alone', () => {
  it('accepts a genuine event when the API key is not configured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', SECRET);
    const { POST } = await import('@/app/api/webhooks/money/route');
    const response = await POST(signed(unhandled));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, handled: false });
  });

  it('still refuses a forged signature', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', SECRET);
    const { POST } = await import('@/app/api/webhooks/money/route');
    const response = await POST(signed(unhandled, 'whsec_someone_else'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'money.webhookSignatureInvalid' });
  });
});
