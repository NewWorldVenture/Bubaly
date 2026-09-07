import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

const source = readUiSource('app/(app)/marketplace/page.tsx');

describe('marketplace home read boundary', () => {
  it('does not silently convert marketplace read failures into a healthy empty board', () => {
    expect(source).toContain('const dataWarnings: string[] = [];');
    expect(source).toContain('if (result.error)');
    expect(source).toContain("console.error(`[marketplace] ${label} read failed`, result.error);");
    expect(source).toContain('role="status"');
    expect(source).toContain('Marketplace data health');
  });

  it('covers the independent marketplace sources used to derive the overview', () => {
    for (const label of ['Listings', 'Family members', 'Offers', 'Matches', 'Saved listings', 'Stores', 'Store follows', 'Reviews', 'Orders', 'Collections', 'Collection items']) {
      expect(source, label).toContain(`'${label}'`);
    }
  });
});
