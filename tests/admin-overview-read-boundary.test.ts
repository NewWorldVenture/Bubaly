import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';

const source = readUiSource('app/(app)/admin/page.tsx');

describe('admin overview read boundary', () => {
  it('does not render the command center from empty fallbacks after required reads fail', () => {
    expect(source).toContain('familyCountResult.error');
    expect(source).toContain('familiesResult.error');
    expect(source).toContain('subscriptionsResult.error');
    expect(source).toContain('adminNotesResult.error');
    expect(source).toContain('unreadNoteCountResult.error');
    expect(source).toContain("'error' in actorsResult");
    expect(source).toContain('Could not load the admin dashboard from Supabase. Refresh and try again.');
    expect(source).toContain('Refresh admin dashboard');
  });
});
