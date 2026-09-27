import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSeederText, realTextOr } from '@/lib/marketing/reputation';

// On 2026-09-27 the public review page on bubaly.com greeted every visitor with
// the database seeder's placeholder text, read from the reputation_settings
// singleton: "Important task #1" over "Sample reputation settings content
// generated for testing purposes. Row 1." A settings row has no slug for
// isSyntheticSeedSlug to recognise, so the text itself is the signal.
describe('seeder text in a settings row is not shown to the public', () => {
  it('recognises the two shapes the seeder writes', () => {
    expect(isSeederText('Important task #1')).toBe(true);
    expect(isSeederText('Sample reputation settings content generated for testing purposes. Row 1.')).toBe(true);
    expect(isSeederText('  important TASK #27 ')).toBe(true);
  });

  it('leaves ordinary copy alone', () => {
    for (const copy of [
      'How was your experience with Bubaly?',
      'An important task for every family: plan the week together.',
      'We tested this with 40 families before launch.',
      'Task #1 on the list: breakfast.',
    ]) expect(isSeederText(copy), copy).toBe(false);
  });

  it('falls back field by field', () => {
    expect(realTextOr('Important task #1', 'Default headline')).toBe('Default headline');
    expect(realTextOr('', 'Default')).toBe('Default');
    expect(realTextOr(null, 'Default')).toBe('Default');
    expect(realTextOr('A real headline', 'Default')).toBe('A real headline');
  });

  it('the public review page routes every text field through the fallback', () => {
    const page = readFileSync('app/reviews/new/page.tsx', 'utf8');
    // The fallback is now translated; every potentially seeded field must
    // still pass through the real seeder filter before reaching the form.
    for (const [field, key] of [
      ['request_headline', 'defaultHeadline'],
      ['request_message', 'defaultMessage'],
      ['thank_you_high', 'defaultThankYouHigh'],
      ['thank_you_low', 'defaultThankYouLow'],
    ]) {
      expect(page, field).toContain(`realTextOr(s?.${field}, t('reviewsNew.${key}'))`);
    }
  });
});
