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
    expect(stripeRoute).toContain("Webhook not configured");
    expect(stripeRoute).toContain("Webhook storage unavailable");
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
    expect(stripeRoute.indexOf('await recordEvent')).toBeLessThan(stripeRoute.indexOf('await upsertSubscription'));
    expect(moneyRoute.indexOf('await recordEvent')).toBeLessThan(moneyRoute.indexOf('await handleTransactionCreated'));
  });
});
