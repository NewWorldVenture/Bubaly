import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/referrals/page.tsx', 'utf8');
const server = fs.readFileSync('lib/referrals/server.ts', 'utf8');

describe('admin referrals read boundary', () => {
  it('preserves both config and referral activity failures', () => {
    expect(server).toContain('export async function getReferralConfigResult');
    expect(page).toContain('const [configResult, referralsResult] = await Promise.all([');
    expect(page).toContain('if (configResult.error || referralsResult.error) {');
    expectSays(page, 'referrals.couldNotLoadReferralSettings', 'Could not load referral settings and activity from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
