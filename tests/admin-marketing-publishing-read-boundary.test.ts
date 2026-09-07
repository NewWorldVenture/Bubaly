import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const experiments = readFileSync('app/(app)/admin/marketing/experiments/page.tsx', 'utf8');
const reputation = readFileSync('app/(app)/admin/marketing/reputation/page.tsx', 'utf8');
const reviews = readFileSync('app/(app)/admin/marketing/reviews/page.tsx', 'utf8');
const video = readFileSync('app/(app)/admin/marketing/video/page.tsx', 'utf8');
const push = readFileSync('app/(app)/admin/marketing/push/page.tsx', 'utf8');

describe('admin marketing publishing read boundaries', () => {
  it('preserves experiment and event read failures before calculating results', () => {
    expect(experiments).toContain('experimentsError || eventResult.error');
    expectSays(experiments, 'experiments.couldNotLoadExperimentResults', 'Could not load experiment results from Supabase. Refresh and try again.');
  });

  it('preserves reputation and review read failures before publishing social proof', () => {
    expect(reputation).toContain('testimonialsResult.error ?? caseStudiesResult.error');
    expectSays(reputation, 'reputation.couldNotLoadReputationContent', 'Could not load reputation content from Supabase. Refresh and try again.');
    expect(reviews).toContain('reviewsResult.error ?? settingsResult.error');
    expectSays(reviews, 'reviews.couldNotLoadReviewsFrom', 'Could not load reviews from Supabase. Refresh and try again.');
  });

  it('preserves video asset and push device read failures', () => {
    expect(video).toContain('videosResult.error ?? assetsResult.error');
    expectSays(video, 'video.couldNotLoadMarketingVideos', 'Could not load marketing videos from Supabase. Refresh and try again.');
    expect(push).toContain('campaignsResult.error ?? devicesResult.error');
    expectSays(push, 'push.couldNotLoadPushCampaigns', 'Could not load push campaigns from Supabase. Refresh and try again.');
  });
});
