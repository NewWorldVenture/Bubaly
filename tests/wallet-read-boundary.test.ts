import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';

const pages = {
  send: readFileSync('app/(app)/wallet/send/page.tsx', 'utf8'),
  activity: readFileSync('app/(app)/wallet/activity/page.tsx', 'utf8'),
  treasury: readFileSync('app/(app)/wallet/treasury/page.tsx', 'utf8'),
  goals: readFileSync('app/(app)/wallet/goals/page.tsx', 'utf8'),
  allowance: readFileSync('app/(app)/wallet/allowance/page.tsx', 'utf8'),
  cards: readFileSync('app/(app)/wallet/cards/page.tsx', 'utf8'),
  invest: readFileSync('app/(app)/wallet/invest/page.tsx', 'utf8'),
  babysitters: readFileSync('app/(app)/wallet/babysitters/page.tsx', 'utf8'),
  gift: readFileSync('app/(app)/wallet/gift/page.tsx', 'utf8'),
  settings: readFileSync('app/(app)/wallet/settings/page.tsx', 'utf8'),
  child: readFileSync('app/(app)/wallet/children/[childId]/page.tsx', 'utf8'),
  hub: readFileSync('components/wallet/wallet-hub.tsx', 'utf8'),
};

describe('wallet page read boundaries', () => {
  it('distinguishes a failed wallet read from an inactive wallet', () => {
    // Each page names the notice in its own catalogue namespace, so the key is
    // per page and the English it resolves to is the same on all four — which
    // is exactly what a family would see, and what this asserts.
    for (const [ns, source] of [
      ['send', pages.send], ['activity', pages.activity],
      ['treasury', pages.treasury], ['cards', pages.cards],
    ] as const) {
      expect(source, ns).toContain('error: walletError');
      expectSays(source, `${ns}.couldNotLoadTheFamily`, 'Could not load the family wallet. Refresh and try again.');
    }
  });

  it('surfaces dependent ledger and identity failures', () => {
    for (const source of [pages.send, pages.activity, pages.treasury, pages.goals, pages.allowance, pages.cards]) {
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

  it('fails closed on remaining wallet page reads', () => {
    for (const key of ['invest', 'babysitters', 'gift', 'settings', 'child'] as const) {
      expect(pages[key], key).toContain('ErrorState');
      expect(pages[key], key).toContain('error:');
    }
    expect(pages.hub).toContain('accountsError');
    expect(pages.hub).toContain('txnsError');
    expectSays(pages.hub, 'walletHub.couldNotLoadYourWallet', 'Could not load your wallet data. Refresh and try again.');
  });
});
