import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const customers = readFileSync('app/(app)/admin/marketing/customers/page.tsx', 'utf8');
const leads = readFileSync('app/(app)/admin/marketing/leads/page.tsx', 'utf8');
const segments = readFileSync('app/(app)/admin/marketing/segments/page.tsx', 'utf8');
const crm = readFileSync('app/(app)/admin/marketing/crm/page.tsx', 'utf8');
const pipeline = readFileSync('app/(app)/admin/marketing/pipeline/page.tsx', 'utf8');

describe('admin marketing CRM read boundaries', () => {
  it('preserves customer loader failures on the customer and segment pages', () => {
    expect(customers).toContain('getMarketingCustomersWithError');
    expect(customers).toContain('customersError');
    expect(customers).toContain('Could not load marketing customers from Supabase. Refresh and try again.');
    expect(segments).toContain('segmentsResult.error ?? customersResult.error');
    expect(segments).toContain('Could not load marketing segments from Supabase. Refresh and try again.');
  });

  it('does not score leads from partial or failed support and customer reads', () => {
    expect(leads).toContain('ticketsResult.error ?? customersResult.error');
    expect(leads).toContain("console.error('[admin-marketing-leads] lead read failed'");
    expect(leads).toContain('Could not load lead scoring data from Supabase. Refresh and try again.');
  });

  it('preserves CRM contact and pipeline read failures', () => {
    expect(crm).toContain('contactsError');
    expect(crm).toContain('Could not load CRM contacts from Supabase. Refresh and try again.');
    expect(pipeline).toContain('dealsResult.error ?? contactsResult.error');
    expect(pipeline).toContain('Could not load the sales pipeline from Supabase. Refresh and try again.');
  });
});
