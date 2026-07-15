import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const customers = readFileSync('lib/marketing/customers.ts', 'utf8');
const dashboard = readFileSync('app/(app)/admin/marketing/page.tsx', 'utf8');
const analytics = readFileSync('app/(app)/admin/marketing/analytics/page.tsx', 'utf8');

describe('admin marketing dashboard read boundaries', () => {
  it('preserves customer loader errors for diagnostic pages without breaking consumer fallback', () => {
    expect(customers).toContain('getMarketingCustomersWithError');
    expect(customers).toContain('familiesResult.error');
    expect(customers).toContain('const { data: families } = familiesResult;');
    expect(customers).toContain('return (await getMarketingCustomersWithError(supabase)).customers;');
  });

  it('does not turn dashboard metrics into zero-valued data after a read failure', () => {
    expect(dashboard).toContain('customersError');
    expect(dashboard).toContain('activeSegmentsResult.error');
    expect(dashboard).toContain('Could not load marketing dashboard data from Supabase. Refresh and try again.');
  });

  it('does not turn analytics metrics into empty charts after a read failure', () => {
    expect(analytics).toContain('customersResult.error');
    expect(analytics).toContain('campaignsResult.error');
    expect(analytics).toContain('Could not load marketing analytics from Supabase. Refresh and try again.');
  });
});
