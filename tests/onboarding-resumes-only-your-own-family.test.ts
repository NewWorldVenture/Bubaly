import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// SEC-018. `onboarding_claim_family` resumes from onboarding_progress.family_id
// — a row the user could write — and the onboarding action then upserts the
// caller into the resumed family as a PARENT with the service role. Reproduced
// with real sessions: a fresh account named another family in its own row, ran
// onboarding, became that family's parent and read its password vault.
//
// Three layers now. docs/audit/onboarding-claim-ownership-check.sql holds the
// two in the database (0331). This holds the one that ships with the code and
// so protects production before 0331 is applied: the action refuses a resumed
// claim it did not create, BEFORE it writes the membership.

const action = readFileSync('app/onboarding/actions.ts', 'utf8');
const calendar = readFileSync('lib/services/onboarding-calendar/setup.ts', 'utf8');

describe('onboarding resumes only your own family (SEC-018)', () => {
  it('checks the owner of a resumed claim before writing the parent membership', () => {
    const claimAt = action.indexOf("admin.rpc('onboarding_claim_family'");
    const checkAt = action.indexOf("from('families').select('created_by').eq('id', familyId)", claimAt);
    const upsertAt = action.indexOf("admin.from('family_members').upsert(", claimAt);
    expect(claimAt, 'the claim').toBeGreaterThan(-1);
    expect(checkAt, 'the owner check after the claim').toBeGreaterThan(claimAt);
    expect(upsertAt, 'the parent membership upsert').toBeGreaterThan(-1);
    expect(checkAt, 'the check must come before the membership is written').toBeLessThan(upsertAt);
    const between = action.slice(checkAt, upsertAt);
    expect(between).toMatch(/if \(claimed\?\.created_by !== auth\.user\.id\) return \{ ok: false/);
    expect(between).toMatch(/if \(!newFamily\)|claimedError/);
  });

  it('the reset action records only a family the user belongs to', () => {
    // It used to copy the user's own active_family_id — which they can set to
    // any family — into onboarding_progress.family_id with the service role.
    const start = action.indexOf('export async function resetOnboardingAction(');
    const body = action.slice(start, action.indexOf('\nexport ', start + 10));
    expect(body).toMatch(/from\('family_members'\)\.select\('family_id'\)[\s\S]*?\.eq\('is_active', true\)/);
    expect(body).toContain('familyId: ownFamilyId,');
    expect(body).not.toMatch(/familyId: \(prefRow\?\.active_family_id/);
  });

  it('agrees with the calendar path, which always had this check', () => {
    expect(calendar).toMatch(/family\.data\?\.created_by !== scope\.userId\) throw new Error\('Family owner changed'\)/);
  });

  it('the migration fixes the function and the row, and checks itself', () => {
    const sql = readFileSync('supabase/migrations/0331_onboarding_resumes_only_your_own_family.sql', 'utf8');
    expect(sql).toContain('and f.created_by = p_user_id');
    expect(sql).toMatch(/fm\.user_id is not null\s+and fm\.user_id <> p_user_id/);
    expect(sql).toContain('set family_id = excluded.family_id');
    expect(sql).toContain('revoke insert on public.onboarding_progress from anon, authenticated');
    expect(sql).toContain("a.attname not in ('id', 'user_id', 'family_id', 'created_at')");
    expect(sql).toContain("0331: a client can still choose its onboarding family");
  });

  it('the probe holds the takeover, the removed creator and the legitimate resume', () => {
    const probe = readFileSync('docs/audit/onboarding-claim-ownership-check.sql', 'utf8');
    for (const phrase of [
      'BREACH: onboarding_claim_family resumed another family for a stranger',
      'BREACH: a creator removed from their family was resumed into it',
      'BREACH: a user rewrote their onboarding row to name another family',
      'CONTROL FAILED: an interrupted wizard was not resumed onto its own family',
      'CONTROL FAILED: the calendar setup path lost the columns it updates',
    ]) {
      expect(probe, phrase).toContain(phrase);
    }
  });
});
