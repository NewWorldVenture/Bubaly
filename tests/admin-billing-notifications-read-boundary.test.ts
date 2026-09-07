import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const billing = readFileSync('app/(app)/admin/billing/page.tsx', 'utf8');
const notifications = readFileSync('app/(app)/admin/notifications/page.tsx', 'utf8');

describe('admin billing and notification read boundaries', () => {
  it('does not turn billing query failures into empty or zero-valued revenue data', () => {
    expect(billing).toContain('subscriptionsResult.error');
    expect(billing).toContain('billingCustomersResult.error');
    expect(billing).toContain('familiesResult.error');
    expectSays(billing, 'billing.couldNotLoadBillingData', 'Could not load billing data from Supabase. Refresh and try again.');
  });

  it('does not turn notification history read failures into an empty inbox', () => {
    expect(notifications).toContain('error } = await supabase');
    expect(notifications).toContain("console.error('[admin-notifications] notification read failed'");
    expectSays(notifications, 'notifications.couldNotLoadAdminNotifications', 'Could not load admin notifications from Supabase. Refresh and try again.');
  });
});
