import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pages = {
  send: readFileSync('app/(app)/wallet/send/page.tsx', 'utf8'),
  activity: readFileSync('app/(app)/wallet/activity/page.tsx', 'utf8'),
  treasury: readFileSync('app/(app)/wallet/treasury/page.tsx', 'utf8'),
  goals: readFileSync('app/(app)/wallet/goals/page.tsx', 'utf8'),
  allowance: readFileSync('app/(app)/wallet/allowance/page.tsx', 'utf8'),
  cards: readFileSync('app/(app)/wallet/cards/page.tsx', 'utf8'),
};

describe('wallet page read boundaries', () => {
  it('distinguishes a failed wallet read from an inactive wallet', () => {
    for (const source of [pages.send, pages.activity, pages.treasury, pages.cards]) {
      expect(source).toContain('error: walletError');
      expect(source).toContain('Could not load the family wallet. Refresh and try again.');
    }
  });

  it('surfaces dependent ledger and identity failures', () => {
    for (const source of Object.values(pages)) {
      expect(source).toContain('role="status"');
      expect(source).toContain('dataWarnings');
    }
    for (const label of ['Child wallets', 'Wallet transactions', 'Family members']) {
      expect(pages.send, label).toContain(`dataWarnings.push('${label}')`);
    }
    for (const label of ['Wallet buckets', 'Wallet goals', 'Wallet rules']) {
      expect(pages.treasury, label).toContain(`dataWarnings.push('${label}')`);
    }
    for (const label of ['Wallet buckets', 'Recent transactions']) {
      expect(pages.goals, label).toContain(`dataWarnings.push('${label}')`);
    }
    for (const label of ['Family members', 'Allowance rules']) {
      expect(pages.allowance, label).toContain(`dataWarnings.push('${label}')`);
    }
    for (const label of ['Connected account', 'Connected account sync', 'Connected account status', 'Issued cards']) {
      expect(pages.cards, label).toContain(`dataWarnings.push('${label}')`);
    }
  });
});
