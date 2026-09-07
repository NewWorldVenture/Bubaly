import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/exit-intent/page.tsx', 'utf8');

describe('exit-intent read boundary', () => {
  it('fails visibly when offers cannot be read', () => {
    expect(page).toContain('const { data, error } = await supabase');
    expect(page).toContain('if (error) {');
    expectSays(page, 'exitIntent.couldNotLoadExitIntent', 'Could not load exit-intent offers from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
