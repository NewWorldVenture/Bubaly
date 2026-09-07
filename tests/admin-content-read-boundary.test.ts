import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/admin/content/page.tsx', 'utf8');

describe('admin content read boundary', () => {
  it('surfaces any content, family, or uploader read failure instead of rendering empty content', () => {
    expect(source).toContain('error: documentsError');
    expect(source).toContain('error: familiesError');
    expect(source).toContain('error: profilesError');
    expect(source).toContain('const readError = documentsError ?? familiesError ?? profilesError');
    expectSays(source, 'content.couldNotLoadContentFrom', 'Could not load content from Supabase. Refresh and try again.');
  });
});
