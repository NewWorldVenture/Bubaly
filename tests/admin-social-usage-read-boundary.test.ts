import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/social/usage/page.tsx', 'utf8');

describe('social usage read boundary', () => {
  it('fails visibly when usage events cannot be read', () => {
    // The read is paged (`readAll`), so it answers `{ rows, error }` — what the
    // boundary pins is that the error is BOUND and acted on, not the shape.
    expect(page).toMatch(/const \{ rows: events, error \} = await readAll\(/);
    expect(page).toContain('if (error) {');
    expectSays(page, 'usage.couldNotLoadSocialUsage', 'Could not load social usage events from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
