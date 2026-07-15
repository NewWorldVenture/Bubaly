import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/marketplace/item/[id]/page.tsx', 'utf8');

describe('marketplace listing detail read boundary', () => {
  it('distinguishes a failed listing read from a missing listing', () => {
    expect(source).toContain('const { data: listing, error: listingError }');
    expect(source).toContain("return <ErrorState message=\"Could not load this listing from the marketplace. Refresh and try again.\" />;");
    expect(source).toContain('if (!listing) notFound();');
  });

  it('surfaces dependent detail read failures without hiding the listing', () => {
    expect(source).toContain('const dataWarnings: string[] = [];');
    expect(source).toContain('const reportRead =');
    expect(source).toContain('role="status"');
    for (const label of ['Auction bids', 'Family members', 'Seller reviews', 'Listing reviews', 'Saved state', 'Open offers', 'Seller listings', 'Seller orders', 'Seller store', 'Price history', 'Comparable listings', 'Negotiations', 'Negotiation rounds']) {
      expect(source, label).toContain(`'${label}'`);
    }
  });
});
