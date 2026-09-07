import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/admin/subscriptions/page.tsx', 'utf8');

describe('admin subscription read boundary', () => {
  it('does not turn subscription, family, or billing-customer failures into empty metrics', () => {
    expect(source).toContain('subscriptionsResult.error');
    expect(source).toContain('familiesResult.error');
    expect(source).toContain('billingCustomersResult.error');
    expectSays(source, 'subscriptions.couldNotLoadSubscriptionData', 'Could not load subscription data from Supabase. Refresh and try again.');
  });
});
