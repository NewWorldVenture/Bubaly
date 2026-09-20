import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

/**
 * Audit C1-S9-19 — a refused read must not render as "you have nothing".
 *
 * `components/ui/partial-read-banner.tsx` already states the rule in its own
 * header: *"a zero that means 'we could not check' must never be mistaken for
 * an all-clear."* It was adopted on six pages out of the 185 that read from the
 * database. A scan of every `page.tsx` found 26 reads that destructure `data`
 * and drop `error`, then fall back to `?? []`.
 *
 * These two are the ones where the empty state is a dangerous lie rather than a
 * cosmetic one, so they are fixed and pinned here. The rest are recorded as
 * triaged in finalaudit.md, not silently counted as clean.
 */
const PAGES = [
  {
    file: 'app/(app)/guardian/rules/page.tsx',
    table: 'guardian_routing_rules',
    // An empty call-screening list reads as "this family has configured no
    // protection", which is indistinguishable from a family that truly hasn't.
    why: 'call routing rules',
  },
  {
    file: 'app/(app)/family/permissions/page.tsx',
    table: 'permissions',
    // An empty permission matrix reads as "no role can do anything", which is
    // not a state the product can be in — so the only safe conclusion is wrong.
    why: 'the role permission matrix',
  },
] as const;

describe('a refused read is declared, not rendered as empty (C1-S9-19)', () => {
  it.each(PAGES)('$file captures the error for $why', ({ file, table }) => {
    const src = readFileSync(file, 'utf8');
    // The destructure must take `error`, not just `data`. Dropping it is the
    // whole defect: `?? []` then makes a refusal indistinguishable from none.
    expect(src).toMatch(/const \{ data: \w+, error: \w+Error \}/);
    expect(src).toContain(`${table}: \${describeReadError(`);
  });

  it.each(PAGES)('$file renders the banner before the data it qualifies', ({ file }) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('<PartialReadBanner');
    expect(src).toContain('failures={readFailures}');
    // The banner must be computed from the read, and appear in the tree — a
    // `readFailures` that is built and never rendered is the same silence.
    expect(at(src, 'const readFailures')).toBeLessThan(at(src, '<PartialReadBanner'));
  });

  it.each(PAGES)('$file titles the banner through the translator', ({ file }) => {
    // These are family-facing pages, translated throughout. The six pages that
    // adopted this banner first are admin screens and pass an English literal;
    // copying that here would have put untranslated copy in front of families
    // in eleven locales.
    const src = readFileSync(file, 'utf8');
    expect(src).toContain("title={t('shared.someInformationCouldNotBeLoaded')}");
  });

  it('the shared title exists in every base catalogue', () => {
    // A key present only in en-US still renders (the chain falls back to
    // English), so a missing translation would not fail anything else here.
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['shared.someInformationCouldNotBeLoaded'], `${locale} is missing the banner title`).toBeTruthy();
    }
  });
});
