import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const conflicts = readFileSync('app/(app)/dashboard/sync/conflicts/page.tsx', 'utf8');
const accounts = readFileSync('app/(app)/dashboard/sync/accounts/page.tsx', 'utf8');
const provider = readFileSync('app/(app)/dashboard/sync/accounts/[provider]/page.tsx', 'utf8');

describe('family sync route read boundaries', () => {
  it('does not turn sync read failures into empty conflicts or disconnected accounts', () => {
    expect(conflicts).toContain("if (error) {");
    expect(conflicts).toContain('Could not load your sync conflicts from Supabase');
    expect(conflicts).toContain('Refresh conflicts');
    expect(accounts).toContain("if (error) {");
    expect(accounts).toContain('Could not load your connected accounts from Supabase');
    expect(accounts).toContain('Refresh connected accounts');
    expect(provider).toContain("if (error) {");
    expect(provider).toContain('Could not load this provider account from Supabase');
    expect(provider).toContain('Refresh provider account');
  });
});
