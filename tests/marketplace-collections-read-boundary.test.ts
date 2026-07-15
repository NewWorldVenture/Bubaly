import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/marketplace/collections/page.tsx', 'utf8');

describe('marketplace collections read boundary', () => {
  it('fails clearly when collections cannot be read', () => {
    expect(source).toContain('error: collectionsError');
    expect(source).toContain("return <ErrorState message=\"Could not load your marketplace collections. Refresh and try again.\" />;");
  });

  it('surfaces item and listing failures in both collection views', () => {
    expect(source).toContain('const dataWarnings: string[] = [];');
    expect(source).toContain('role="status"');
    expect(source).toContain("dataWarnings.push('Collection items')");
    expect(source).toContain("dataWarnings.push('Collection listings')");
  });
});
