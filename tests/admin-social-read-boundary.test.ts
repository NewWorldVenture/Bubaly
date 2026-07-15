import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/admin/social/page.tsx', 'utf8');

describe('admin social read boundary', () => {
  it('does not render zero-valued social operations after a required read failure', () => {
    expect(source).toContain('accounts.error');
    expect(source).toContain('posts.error');
    expect(source).toContain('published.error');
    expect(source).toContain('failedResults.error');
    expect(source).toContain('generations.error');
    expect(source).toContain('errors.error');
    expect(source).toContain('Could not load social platform data from Supabase. Refresh and try again.');
    expect(source).toContain('Refresh social overview');
  });
});
