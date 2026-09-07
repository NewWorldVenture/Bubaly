import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

const source = readUiSource('app/(app)/admin/wallet/page.tsx');

describe('admin wallet overview read boundary', () => {
  it('does not convert any required wallet read failure into zero-valued oversight', () => {
    expect(source).toContain('activeWalletsResult.error');
    expect(source).toContain('creditAggResult.error');
    expect(source).toContain('flagsResult.error');
    expect(source).toContain('auditResult.error');
    expect(source).toContain('Could not load wallet oversight from Supabase. Refresh and try again.');
    expect(source).toContain('Refresh wallet overview');
  });
});
