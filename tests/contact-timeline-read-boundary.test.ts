import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/contacts/[id]/page.tsx', 'utf8');

describe('contact timeline read boundary', () => {
  it('fails visibly when contact, interaction, or communication reads fail', () => {
    expect(page).toContain('const { data: contact, error: contactError }');
    expect(page).toContain('if (contactError)');
    expect(page).toContain('const { data, error } = await supabase');
    expect(page).toContain('if (interactionsError)');
    expect(page).toContain('if (communicationsError)');
    expectSays(page, 'contacts.couldNotLoadThisContact', 'Could not load this contact timeline from Supabase. Refresh and try again.');
  });
});
