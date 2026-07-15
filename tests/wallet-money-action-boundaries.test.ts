import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const walletActions = readFileSync('app/(app)/wallet/hub-actions.ts', 'utf8');
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
});
