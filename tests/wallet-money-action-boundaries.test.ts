import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const walletActions = readFileSync('app/(app)/wallet/hub-actions.ts', 'utf8');
const walletMoneyActions = readFileSync('app/(app)/wallet/actions.ts', 'utf8');
const moneyActions = readFileSync('app/(app)/money/actions.ts', 'utf8');

describe('wallet and Stripe money action boundaries', () => {
  it('sanitizes unexpected database and provider failures', () => {
    for (const source of [walletActions, moneyActions]) {
      expect(source).toContain('describeActionError');
      expect(source).not.toMatch(/return\s+\{\s*ok:\s*false,\s*error:\s*[^\n}]*\.message/);
    }
  });

  it('checks required reads and keeps audit loss best-effort', () => {
    expect(moneyActions).toContain("if (acctError) return actionFailure('load the connected account', acctError);");
    expect(moneyActions).toContain("if (cardError) return actionFailure('load the card', cardError);");
    expect(moneyActions).toContain('logAuditFailure');
  });

  it('keeps wallet hub deletion allowlisted and family-scoped', () => {
    expect(walletActions).toContain("const DELETABLE = new Set(['wallet_cards', 'wallet_passes', 'wallet_rewards', 'financial_accounts', 'transactions']);");
    expect(walletActions).toContain(".eq('family_id', ctx.active.familyId)");
    expect(walletActions).not.toContain('supabase.from(input.table as never)');
  });

  it('fails wallet activation when a provisioning step fails', () => {
    expect(walletMoneyActions).toContain('const { error: disclosureError } = await supabase.from(\'compliance_disclosures\').insert');
    expect(walletMoneyActions).toContain('if (childrenError) return actionFailure(childrenError');
    expect(walletMoneyActions).toContain('if (bucketError) return actionFailure(bucketError');
    expect(walletMoneyActions).toContain('if (ruleError) return actionFailure(ruleError');
    expect(walletMoneyActions).not.toContain('if (!cw) continue;');
  });

  it('rolls back a held spend when its approval row cannot be created', () => {
    expect(walletMoneyActions).toContain('const { error: approvalError } = await supabase.from(\'parent_approvals\').insert');
    expect(walletMoneyActions).toContain(".eq('status', 'requires_parent_approval');");
    expect(walletMoneyActions).toContain("return actionFailure(approvalError, 'Could not create the spend approval request.')");
  });

  it('does not silently downgrade entitlement when subscription reads fail', () => {
    const planSource = readFileSync('lib/server/plan.ts', 'utf8');
    expect(planSource).toContain('error: subscriptionsError');
    expect(planSource).toContain('error: familyError');
    expect(planSource).toContain('if (subscriptionsError || familyError || !fam)');
    expect(planSource).toContain("throw new Error('Family subscription state is unavailable.')");
  });
});
