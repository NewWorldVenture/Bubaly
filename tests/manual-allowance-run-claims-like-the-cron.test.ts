// The manual "run due allowances" button must claim each rule, not just advance
// it — the same exclusivity the nightly cron has.
//
// tests/allowance-cron-idempotency.test.ts locks the cron's claim so it "can't
// regress to a blind (double-crediting) update". The button is the sibling path
// that test does not cover, and it WAS that blind update:
//
//   .update({ next_run_on: next, last_run_on: today })
//   .eq('id', rule.id).eq('family_id', familyId).select('id').single()
//
// No `.lte('next_run_on', today)` predicate, so the update always matched. Two
// overlapping runs — a double-click, or a click racing the cron — both read the
// rule as due, both advanced it, and both credited. The child was paid twice.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const ACTION = readFileSync('app/(app)/wallet/actions.ts', 'utf8');
const CRON = readFileSync('app/api/cron/wallet-allowance/route.ts', 'utf8');

function runDueAllowancesBody(): string {
  const start = ACTION.indexOf('export async function runDueAllowancesAction');
  expect(start).toBeGreaterThan(-1);
  const next = ACTION.indexOf('export async function ', start + 1);
  return ACTION.slice(start, next === -1 ? ACTION.length : next);
}

describe('the manual allowance run claims each rule', () => {
  const body = runDueAllowancesBody();

  it('predicates the schedule advance on the rule still being due', () => {
    // The claim and the predicate must be in the same statement, so a rule the
    // cron already advanced cannot be advanced again here.
    expect(body).toMatch(
      /\.update\(\{\s*next_run_on: next[\s\S]{0,240}?\.lte\('next_run_on',\s*today\)/,
    );
  });

  it('reads the claim with maybeSingle, because matching no row is expected', () => {
    // `.single()` would turn the ordinary "someone else claimed it" case into an
    // error, which is how a correct guard gets reverted for looking broken.
    expect(body).toMatch(/\.select\('id'\)\.maybeSingle\(\)/);
    expect(body).not.toMatch(/\.select\('id'\)\.single\(\)/);
  });

  it('skips the credit when the claim matched no row rather than failing', () => {
    expect(body).toMatch(/if\s*\(!advancedRule\)\s*continue;/);
    // and the credit must come after the claim, not before it
    const claim = body.indexOf(".lte('next_run_on', today)");
    const credit = body.indexOf('creditChildWallet');
    expect(claim).toBeGreaterThan(-1);
    expect(credit).toBeGreaterThan(claim);
  });

  it('uses the same exclusivity predicate the cron does', () => {
    // Both paths credit the same wallets from the same rules; if they ever
    // disagree about what "due" means, one of them double-pays.
    expect(CRON).toContain(".lte('next_run_on', today)");
    expect(body).toContain(".lte('next_run_on', today)");
  });
});
