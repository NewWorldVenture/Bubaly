import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/vacations/trip-emergency.tsx', 'utf8');

describe('trip emergency read boundary', () => {
  it('tracks both emergency summary reads', () => {
    expect(source).toContain('contactsLoading');
    expect(source).toContain('medicalLoading');
    expect(source).toContain('contactsError');
    expect(source).toContain('medicalError');
  });

  it('does not hide emergency read failures as an absent summary', () => {
    expect(source).toContain('Could not load the emergency summary. Refresh and try again.');
    expect(source).toContain('refreshContacts()');
    expect(source).toContain('refreshMedical()');
  });
});

