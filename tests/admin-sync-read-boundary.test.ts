import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/admin/sync/page.tsx', 'utf8');

describe('admin sync read boundary', () => {
  it('does not render zero-valued provider operations after a required read failure', () => {
    expect(source).toContain('conns.error');
    expect(source).toContain('errors.error');
    expect(source).toContain('deadJobs.error');
    expect(source).toContain('webhookFails.error');
    expect(source).toContain('providers.error');
    expect(source).toContain('Could not load sync platform data from Supabase. Refresh and try again.');
    expect(source).toContain('Refresh sync overview');
  });
});
