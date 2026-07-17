import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// PLA-0680 idempotency guard for the recurring allowance payout cron. The cron
// advances allowance_rules.next_run_on and credits the child's wallet. If two
// invocations overlap (Vercel cron re-fire / manual trigger / >maxDuration run),
// both must NOT credit the same period. The exclusivity comes from claiming the
// schedule with an `.lte('next_run_on', today)` predicate — only one overlapping
// run matches a row; the loser matches none and must skip the credit. This test
// locks that so the claim can't regress to a blind (double-crediting) update.
const SRC = readFileSync('app/api/cron/wallet-allowance/route.ts', 'utf8');

describe('allowance cron claims each rule atomically (no double-pay)', () => {
  it('the schedule-claim update is predicated on next_run_on <= today', () => {
    expect(SRC).toMatch(/\.update\(\{\s*next_run_on[\s\S]{0,160}?\.lte\('next_run_on',\s*today\)/);
  });

  it('skips the credit when the claim matched no row (another run won)', () => {
    expect(SRC).toMatch(/if\s*\(!claimed\)\s*continue/);
    // and it reads the claimed row rather than blindly .single()
    expect(SRC).toMatch(/const\s*\{\s*data:\s*claimed[\s\S]{0,320}\.maybeSingle\(\)/);
  });

  it('still credits via the service-role ledger helper after a successful claim', () => {
    expect(SRC).toMatch(/creditChildWallet\(/);
  });
});
