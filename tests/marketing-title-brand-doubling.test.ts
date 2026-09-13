import { describe, expect, it } from 'vitest';
import { titleWithoutDoubledBrand } from '@/lib/marketing/seo';

/**
 * The root layout formats titles with `template: '%s · Bubaly'`. A title that
 * already ends in the brand therefore ships doubled.
 *
 * Both "doubled" cases below are verbatim from production on 2026-09-13:
 *   <title>Security &amp; Privacy — Bubaly · Bubaly</title>
 *   <title>Contact Bubaly · Bubaly</title>
 */
describe('marketing titles do not double the brand', () => {
  it('opts a trailing-brand title out of the template', () => {
    // `absolute` is Next.js's own mechanism for "do not apply the template".
    expect(titleWithoutDoubledBrand('Security & Privacy — Bubaly')).toEqual({
      absolute: 'Security & Privacy — Bubaly',
    });
    expect(titleWithoutDoubledBrand('Contact Bubaly')).toEqual({ absolute: 'Contact Bubaly' });
  });

  it('leaves a title that does not end in the brand to the template', () => {
    // This one LEADS with the brand and still wants the suffix — suppressing it
    // would strip the brand from the end of the tab title.
    expect(titleWithoutDoubledBrand('Bubaly — The AI Family Operating System'))
      .toBe('Bubaly — The AI Family Operating System');
    expect(titleWithoutDoubledBrand('Pricing — The AI Family Operating System'))
      .toBe('Pricing — The AI Family Operating System');
    expect(titleWithoutDoubledBrand('How Bubaly Works — Your AI Family Operating System'))
      .toBe('How Bubaly Works — Your AI Family Operating System');
  });

  it('handles the separators the SEO store actually uses', () => {
    for (const title of ['Security — Bubaly', 'Security – Bubaly', 'Security - Bubaly', 'Security | Bubaly', 'Security · Bubaly', 'Security: Bubaly']) {
      expect(titleWithoutDoubledBrand(title)).toEqual({ absolute: title });
    }
  });

  it('is case-insensitive and tolerates trailing whitespace', () => {
    expect(titleWithoutDoubledBrand('Security — BUBALY  ')).toEqual({ absolute: 'Security — BUBALY  ' });
  });

  it('does not fire on a word that merely contains the brand', () => {
    // Guards the regex boundary: a suffix match alone would wrongly opt these out.
    expect(titleWithoutDoubledBrand('Meet the Bubalys')).toBe('Meet the Bubalys');
    expect(titleWithoutDoubledBrand('Introducing SuperBubaly')).toBe('Introducing SuperBubaly');
  });

  it('treats a bare brand title as already branded', () => {
    expect(titleWithoutDoubledBrand('Bubaly')).toEqual({ absolute: 'Bubaly' });
  });
});
