import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('app/(app)/marketplace/community/page.tsx', 'utf8');
const module = readFileSync('components/marketplace/community-module.tsx', 'utf8');

describe('marketplace community read boundary', () => {
  it('distinguishes a missing migration from a transient read failure', () => {
    expect(page).toContain('isMissingRelationError(cErr)');
    expect(page).toContain('reportRead(\'Circle members\', mErr);');
    expect(page).toContain('reportRead(\'Listing shares\', sErr);');
    expect(page).toContain('reportRead(\'Your listings\', mineError);');
  });

  it('renders circle read warnings accessibly', () => {
    expect(page).toContain('readWarnings={Array.from(new Set(readWarnings))}');
    expect(module).toContain('readWarnings?: string[]');
    expect(module).toContain('role="status"');
    expect(module).toContain('Community data health');
  });
});
