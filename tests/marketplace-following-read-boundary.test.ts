import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/marketplace/following/page.tsx', 'utf8');

describe('marketplace following read boundary', () => {
  it('fails clearly when follows cannot be read', () => {
    expect(source).toContain('error: followsError');
    expect(source).toContain("return <ErrorState message={");
    expectSays(source, 'following.couldNotLoadTheCreators', "Could not load the creators you follow. Refresh and try again.");
  });

  it('surfaces saved, store, and listing failures', () => {
    expect(source).toContain('const dataWarnings: string[] = [];');
    expect(source).toContain('role="status"');
    for (const label of ['Saved listings', 'Stores', 'Listings']) {
      expect(source, label).toContain(`dataWarnings.push('${label}')`);
    }
  });
});
