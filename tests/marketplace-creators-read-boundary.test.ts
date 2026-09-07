import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/marketplace/creators/page.tsx', 'utf8');

describe('marketplace creators read boundary', () => {
  it('fails clearly when storefronts cannot be read', () => {
    expect(source).toContain('error: storesError');
    expect(source).toContain("return <ErrorState message={");
    expectSays(source, 'creators.couldNotLoadMarketplaceStorefronts', "Could not load marketplace storefronts. Refresh and try again.");
  });

  it('surfaces follower, review, and open-listing failures', () => {
    expect(source).toContain('const dataWarnings: string[] = [];');
    expect(source).toContain('role="status"');
    for (const label of ['Follows', 'Reviews', 'Open listings']) {
      expect(source, label).toContain(`dataWarnings.push('${label}')`);
    }
  });
});
