import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const marketing = readFileSync('app/(app)/admin/marketing/actions.ts', 'utf8');
const referralsAdmin = readFileSync('app/(app)/admin/marketing/referrals/actions.ts', 'utf8');
const referrals = readFileSync('lib/referrals/server.ts', 'utf8');
const leadScores = readFileSync('app/(app)/admin/marketing/lead-scores/actions.ts', 'utf8');
const scoreCompute = readFileSync('lib/marketing/contact-score-compute.ts', 'utf8');

describe('marketing core and referral action boundaries', () => {
  it('requires returned rows for shared marketing writes', () => {
    expect(marketing).toContain(".select('id').maybeSingle()");
    expect(marketing).toContain(".select('key').maybeSingle()");
    expect(marketing).not.toContain("const { error } = await supabase.from('marketing_settings').upsert");
    expect(marketing).not.toContain(".eq('id', id);\n  if (error) marketingActionFailure");
  });

  it('sanitizes referral configuration and public referral failures', () => {
    expect(referralsAdmin).toContain('marketingActionFailure');
    expect(referrals).toContain(".select('key').maybeSingle()");
    expect(referrals).toContain('We could not apply that referral code right now.');
    expect(referrals).not.toContain('reason: error.message');
  });

  it('fails closed and audits lead-score recomputation', () => {
    expect(leadScores).toContain('requireMarketingAdmin');
    expect(leadScores).toContain('marketingActionFailure');
    expect(leadScores).toContain('logMarketingAudit');
    expect(scoreCompute).toContain('if (contactError) throw contactError');
    expect(scoreCompute).toContain('if (contactsError) throw contactsError');
    expect(scoreCompute).toContain('if (error) throw error');
  });
});
