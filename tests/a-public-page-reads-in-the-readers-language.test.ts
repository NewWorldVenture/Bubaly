import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Audit C1-S9-108 — found by rendering the public pages in German
// (scripts/page-audit-crawl.mjs --locale de-DE) rather than by scanning
// source: the i18n gate called these surfaces clean, and a German reader still
// met English, because the copy sat where the gate does not look.
const read = (f: string) => readFileSync(f, 'utf8');

describe('a public page reads in the reader\'s language (C1-S9-108)', () => {
  it('the closing call to action has no English default', () => {
    const src = read('components/marketing/cta.tsx');
    expect(src).not.toMatch(/title\s*=\s*'/);
    expect(src).not.toMatch(/subtitle\s*=\s*'/);
    expect(src).toContain("subtitle ??= t('cta.setUpYourFamilyInMinutes')");
  });

  it('/ai passes its call-to-action subtitle through the catalogue', () => {
    expect(read('app/(marketing)/ai/page.tsx')).not.toContain('subtitle="Set up your family');
  });

  it('every string in the privacy policy body is a catalogue key', () => {
    const src = read('app/(marketing)/privacy/page.tsx');
    const bodies = [...src.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]);
    expect(bodies.length).toBeGreaterThan(10);
    expect(bodies.filter((b) => !/^privacy\.[A-Za-z0-9]+$/.test(b))).toEqual([]);
  });

  it('the review request falls back to translated defaults', () => {
    const src = read('app/reviews/new/page.tsx');
    expect(src).not.toMatch(/DEFAULT_REPUTATION\.(request_headline|request_message|thank_you_high|thank_you_low)/);
  });

  it('a legal page title can break where a long word would run off a phone', () => {
    expect(read('components/marketing/legal.tsx')).toMatch(/<h1 className="[^"]*\[overflow-wrap:anywhere\][^"]*hyphens-auto/);
  });
});
