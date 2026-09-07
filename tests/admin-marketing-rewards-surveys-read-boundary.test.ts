import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const affiliates = readFileSync('app/(app)/admin/marketing/affiliates/page.tsx', 'utf8');
const loyalty = readFileSync('app/(app)/admin/marketing/loyalty/page.tsx', 'utf8');
const proposals = readFileSync('app/(app)/admin/marketing/proposals/page.tsx', 'utf8');
const surveys = readFileSync('app/(app)/admin/marketing/surveys/page.tsx', 'utf8');
const surveyDetail = readFileSync('app/(app)/admin/marketing/surveys/[id]/page.tsx', 'utf8');

describe('admin marketing rewards and survey read boundaries', () => {
  it('preserves affiliate and loyalty payout/read failures', () => {
    expect(affiliates).toContain('affiliatesResult.error ?? referralsResult.error');
    expectSays(affiliates, 'affiliates.couldNotLoadAffiliatePayout', 'Could not load affiliate payout data from Supabase. Refresh and try again.');
    expect(loyalty).toContain('settingsResult.error ?? rewardsResult.error ?? accountsResult.error ?? redemptionsResult.error ?? familiesResult.error');
    expectSays(loyalty, 'loyalty.couldNotLoadLoyaltyData', 'Could not load loyalty data from Supabase. Refresh and try again.');
  });

  it('preserves proposal and survey list failures before write actions', () => {
    expect(proposals).toContain('quotesResult.error ?? contactsResult.error');
    expectSays(proposals, 'proposals.couldNotLoadProposalsFrom', 'Could not load proposals from Supabase. Refresh and try again.');
    expect(surveys).toContain('surveysResult.error ?? responsesResult.error');
    expectSays(surveys, 'surveys.couldNotLoadSurveyData', 'Could not load survey data from Supabase. Refresh and try again.');
  });

  it('preserves survey detail and response read failures separately from not-found', () => {
    expect(surveyDetail).toContain('surveyError');
    expect(surveyDetail).toContain('responsesError');
    expectSays(surveyDetail, 'surveys.couldNotLoadThisSurvey', 'Could not load this survey from Supabase. Refresh and try again.');
  });
});
