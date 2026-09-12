import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const stripeRoute = readFileSync(resolve(root, 'app/api/webhooks/stripe/route.ts'), 'utf8');
const moneyRoute = readFileSync(resolve(root, 'app/api/webhooks/money/route.ts'), 'utf8');
const helper = readFileSync(resolve(root, 'lib/stripe/webhook.ts'), 'utf8');
const migration = readFileSync(resolve(root, 'supabase/migrations/0182_stripe_webhook_claims.sql'), 'utf8');

describe('Stripe webhook replay contract', () => {
  it('bounds payloads and fails closed when the billing webhook is not configured', () => {
    expect(stripeRoute).toContain('MAX_WEBHOOK_BODY_BYTES = 256_000');
    expectTranslates(stripeRoute, 'stripe.webhookNotConfigured', "Webhook not configured");
    expectTranslates(stripeRoute, 'stripe.webhookStorageUnavailable', "Webhook storage unavailable");
    expect(moneyRoute).toContain('MAX_WEBHOOK_BODY_BYTES = 256_000');
  });

  it('serializes concurrent claims and only reclaims stale processing rows', () => {
    expect(helper).toContain("error.code !== '23505'");
    expect(helper).toContain("prior.status === 'processing'");
    expect(helper).toContain('STALE_EVENT_MS');
    expect(helper).toContain(".eq('status', 'processing')");
    expect(helper).toContain(".eq('processing_started_at', prior.processing_started_at)");
    expect(helper).toContain(".eq('claim_token', claimToken)");
    expect(helper).toContain(".eq('claim_token', prior.claim_token)");
    expect(helper).toContain("return { outcome: 'duplicate' };");
  });

  it('stores the claim timestamp in an additive protected migration', () => {
    expect(migration).toContain('add column if not exists processing_started_at timestamptz');
    expect(migration).toContain('add column if not exists claim_token text');
    expect(migration).toContain('idx_stripe_webhook_events_processing');
  });

  it('claims before subscription and money side effects', () => {
    expect(stripeRoute.indexOf('await recordEvent')).toBeLessThan(stripeRoute.indexOf('await persistSubscription'));
    expect(moneyRoute.indexOf('await recordEvent')).toBeLessThan(moneyRoute.indexOf('await handleTransactionCreated'));
  });

  it('does not acknowledge failed card money effects or unknown billing prices', () => {
    expect(helper).toContain("throw new Error('Stripe authorization response failed');");
    expect(helper).toContain("if (!debit.ok) throw new Error(debit.error ?? 'Card spend persistence failed');");
    expect(helper).toContain("if (error) throw new Error('Stripe card mapping lookup failed');");
    expect(stripeRoute).toContain("if (!priceId) throw new Error('Subscription price is missing');");
    expect(stripeRoute).toContain("if (!plan) throw new Error('Unknown Stripe subscription price');");
  });
});
