import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const ads = readFileSync('app/(app)/admin/marketing/ads/page.tsx', 'utf8');
const automation = readFileSync('app/(app)/admin/marketing/automation/page.tsx', 'utf8');

describe('admin marketing read boundaries', () => {
  it('does not turn ad campaign read failures into an empty campaign list', () => {
    expect(ads).toContain('error: adsError');
    expect(ads).toContain("console.error('[admin-marketing-ads] campaign read failed'");
    expectSays(ads, 'ads.couldNotLoadAdvertisingCampaigns', 'Could not load advertising campaigns from Supabase. Refresh and try again.');
  });

  it('does not turn automation workflow read failures into an empty workflow list', () => {
    expect(automation).toContain('error: flowsError');
    expect(automation).toContain("console.error('[admin-marketing-automation] workflow read failed'");
    expectSays(automation, 'automation.couldNotLoadMarketingWorkflows', 'Could not load marketing workflows from Supabase. Refresh and try again.');
  });
});
