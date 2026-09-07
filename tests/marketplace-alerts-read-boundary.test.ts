import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/marketplace/alerts/page.tsx', 'utf8');

describe('marketplace alerts read boundary', () => {
  it('fails clearly when saved searches cannot be read', () => {
    expect(source).toContain('error: searchesError');
    expect(source).toContain("return <ErrorState message={");
    expectSays(source, 'alerts.couldNotLoadYourMarketplace', "Could not load your marketplace alerts. Refresh and try again.");
  });

  it('surfaces matching-listing and saved-state failures', () => {
    expect(source).toContain('const dataWarnings: string[] = [];');
    expect(source).toContain('role="status"');
    expect(source).toContain("dataWarnings.push('Matching listings')");
    expect(source).toContain("dataWarnings.push('Saved listings')");
  });
});
