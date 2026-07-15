import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/admin/wallet/reconciliation/page.tsx', 'utf8');

describe('admin wallet reconciliation read boundary', () => {
  it('does not turn ledger bucket or transaction failures into an empty healthy report', () => {
    expect(source).toContain('bucketsResult.error');
    expect(source).toContain('txnsResult.error');
    expect(source).toContain('Could not load wallet ledger data from Supabase. Refresh and try again.');
    expect(source).toContain('Refresh reconciliation');
  });
});
