import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const walletActions = readFileSync('app/(app)/wallet/hub-actions.ts', 'utf8');
const walletMoneyActions = readFileSync('app/(app)/wallet/actions.ts', 'utf8');
const moneyActions = readFileSync('app/(app)/money/actions.ts', 'utf8');

describe('wallet and Stripe money action boundaries', () => {
  it('sanitizes unexpected database and provider failures', () => {
    for (const source of [walletActions, moneyActions]) {
      expect(source).toContain('describeActionError(');
      expect(source).not.toMatch(/return\s+\{\s*ok:\s*false,\s*error:\s*[^\n}]*\.message/);
    }
  });

  it('checks required reads and keeps audit loss best-effort', () => {
    expect(moneyActions).toContain("if (acctError) return actionFailure('load the connected account', t('money.couldNotLoadTheConnectedAccount'), acctError);");
    expect(moneyActions).toContain("if (cardError) return actionFailure('load the card', t('money.couldNotLoadTheCard'), cardError);");
    // Audit loss stays best-effort — by the time it runs the money has moved,
    // so refusing the action would turn a bookkeeping problem into a financial
    // one. The local logAuditFailure that used to carry this is now the shared
    // logWalletAudit, which also covers the ten sites that were discarding the
    // error entirely; the invariant is unchanged and the name is not.
    expect(moneyActions).toContain('logWalletAudit(');
    expect(moneyActions, 'a failed audit row must not fail the action')
      .not.toMatch(/if \(auditError\) return/);
    expect(moneyActions, 'and must not be written longhand again')
      .not.toMatch(/from\('wallet_audit_logs'\)\.insert/);
  });

  it('keeps wallet hub deletion allowlisted and family-scoped', () => {
    expect(walletActions).toContain("const DELETABLE = new Set(['wallet_cards', 'wallet_passes', 'wallet_rewards', 'financial_accounts', 'transactions']);");
    expect(walletActions).toContain(".eq('family_id', ctx.active.familyId)");
    expect(walletActions).not.toContain('supabase.from(input.table as never)');
  });

  it('fails wallet activation when a provisioning step fails', () => {
    expect(walletMoneyActions).toContain('const { error: disclosureError } = await supabase.from(\'compliance_disclosures\').insert');
    expect(walletMoneyActions).toContain('if (childrenError) return actionFailure(childrenError, t(\'actions.couldNotLoadFamilyMembers\'));');
    expect(walletMoneyActions).toContain('if (bucketError) return actionFailure(bucketError, t(\'actions.couldNotProvisionWalletBuckets\'));');
    expect(walletMoneyActions).toContain('if (ruleError) return actionFailure(ruleError, t(\'actions.couldNotProvisionWalletRules\'));');
    expect(walletMoneyActions).not.toContain('if (!cw) continue;');
  });

  it('rolls back a held spend when its approval row cannot be created', () => {
    expect(walletMoneyActions).toContain('const { error: approvalError } = await supabase.from(\'parent_approvals\').insert');
    // The trailing semicolon was the whole assertion, and C1-S9-53 appended
    // `.select('id')` after this filter so the statement no longer ends here.
    // What the test is actually about is that the rollback is PREDICATED on the
    // hold still being unresolved — that predicate is what stops it cancelling
    // a debit someone else already approved.
    expect(walletMoneyActions).toContain(".eq('status', 'requires_parent_approval')");
    expect(walletMoneyActions).toContain('wroteNoRows(rolledBack)');
    expect(walletMoneyActions).toContain('a hold may be stranded');
    expect(walletMoneyActions).toContain("return actionFailure(approvalError, t('actions.couldNotCreateTheSpend'))");
  });

  it('does not silently downgrade entitlement when subscription reads fail', () => {
    const planSource = readFileSync('lib/server/plan.ts', 'utf8');
    expect(planSource).toContain('error: subscriptionsError');
    expect(planSource).toContain('error: familyError');
    expect(planSource).toContain('if (subscriptionsError || familyError || !fam)');
    expect(planSource).toContain("throw new Error('Family subscription state is unavailable.')");
  });

  it('fails closed in shared ledger helpers when money reads or hold release fail', () => {
    const serverSource = readFileSync('lib/wallet/server.ts', 'utf8');
    expect(walletMoneyActions).toContain('error: balanceError');
    expect(serverSource).toContain("error: 'The wallet is not fully provisioned.'");
    expect(serverSource).toContain("Could not release the card authorization hold.");
    expect(serverSource).toContain("if (dupeError) return { ok: false");
    expect(serverSource).toContain("if (!bucket?.id) return { ok: false, error: 'The wallet Spend bucket is unavailable.' }");
  });
});
