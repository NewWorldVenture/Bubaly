import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/marketplace/orders/page.tsx', 'utf8');

describe('marketplace orders read boundary', () => {
  it('fails clearly when the primary order list cannot be read', () => {
    expect(source).toContain('const { data: orders, error: ordersError }');
    expect(source).toContain("return <ErrorState message={");
    expectSays(source, 'orders.couldNotLoadYourMarketplace', "Could not load your marketplace orders. Refresh and try again.");
  });

  it('surfaces dependent order read failures without hiding the order list', () => {
    expect(source).toContain('const dataWarnings: string[] = [];');
    expect(source).toContain('role="status"');
    for (const label of ['Service fee settings', 'Listing titles', 'Family members', 'Review history', 'Handoff coordination']) {
      expect(source, label).toContain(`'${label}'`);
    }
  });
});
