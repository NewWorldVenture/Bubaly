import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const capabilities = readFileSync('lib/stripe/capabilities.ts', 'utf8');
const page = readFileSync('app/(app)/admin/stripe/page.tsx', 'utf8');

describe('admin Stripe read boundary', () => {
  it('keeps consumer fallback while exposing feature-flag query errors to diagnostics', () => {
    expect(capabilities).toContain('readMoneyFlagsWithError');
    expect(capabilities).toContain('return { flags: out, error }');
    expect(capabilities).toContain('const { flags } = await readMoneyFlagsWithError(supabase);');
  });

  it('does not turn Stripe configuration or financial reads into zero-valued status', () => {
    expect(page).toContain('moneyFlagsError');
    expect(page).toContain('stripeCfgResult.error');
    expect(page).toContain('webhooksResult.error');
    expectSays(page, 'stripe.couldNotLoadStripeFinancial', 'Could not load Stripe financial data from Supabase. Refresh and try again.');
  });
});
