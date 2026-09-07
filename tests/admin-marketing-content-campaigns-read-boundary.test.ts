import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const content = readFileSync('app/(app)/admin/marketing/content/page.tsx', 'utf8');
const campaigns = readFileSync('app/(app)/admin/marketing/campaigns/page.tsx', 'utf8');
const detail = readFileSync('app/(app)/admin/marketing/campaigns/[id]/page.tsx', 'utf8');

describe('admin marketing content and campaign read boundaries', () => {
  it('does not turn content or published blog read failures into empty lists', () => {
    expect(content).toContain('itemsResult.error ?? postsResult.error');
    expect(content).toContain("console.error('[admin-marketing-content] content read failed'");
    expectSays(content, 'content.couldNotLoadMarketingContent', 'Could not load marketing content from Supabase. Refresh and try again.');
  });

  it('does not turn campaign list failures into an empty campaign state', () => {
    expect(campaigns).toContain('campaignsError');
    expect(campaigns).toContain("console.error('[admin-marketing-campaigns] campaign read failed'");
    expectSays(campaigns, 'campaigns.couldNotLoadMarketingCampaigns', 'Could not load marketing campaigns from Supabase. Refresh and try again.');
  });

  it('preserves campaign, segment, and audience read failures on the detail page', () => {
    expect(detail).toContain('campaignError');
    expect(detail).toContain('getMarketingCustomersWithError');
    expect(detail).toContain('segmentResult.error ?? customersResult.error');
    expect(detail).toContain("console.error('[admin-marketing-campaign-detail] audience read failed'");
    expectSays(detail, 'campaigns.couldNotLoadThisMarketing', 'Could not load this marketing campaign from Supabase. Refresh and try again.');
  });
});
