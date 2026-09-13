import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import enUS from '@/lib/i18n/messages/en-US.json';

// The message catalogue is for text a translator can translate. A CSS margin
// is not that.
//
// `tableOfContents.80px0px600px` held '-80px 0px -60% 0px' — the rootMargin of
// the blog table of contents' IntersectionObserver — and every one of the
// eleven catalogues carried an identical copy. A translator adjusting the
// spacing, or a tool normalising the minus signs, produces a value
// IntersectionObserver rejects; it throws at construction, and the whole
// table of contents disappears for that language, on every article.
//
// Nothing about that value belongs to a language, so it belongs in the code.

const messages = enUS as Record<string, string>;

/** Values that are configuration rather than prose. */
const NOT_LANGUAGE: { name: string; pattern: RegExp; allow?: RegExp }[] = [
  { name: 'a CSS length or margin', pattern: /^-?\d+(\.\d+)?(px|rem|em|vh|vw)(\s|$)/ },
  { name: 'a hex colour', pattern: /^#[0-9a-fA-F]{3,8}$/ },
  { name: 'a URL', pattern: /^https?:\/\// },
  { name: 'a CSS keyword', pattern: /^(inherit|initial|unset|flex|grid|nowrap|ellipsis)$/ },
];

describe('the catalogue holds language, not configuration', () => {
  for (const { name, pattern } of NOT_LANGUAGE) {
    it(`has no value that is ${name}`, () => {
      const offenders = Object.entries(messages)
        .filter(([, value]) => typeof value === 'string' && pattern.test(value.trim()))
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
      // If this fails: the value belongs in the component as a constant, and
      // the key should be deleted from every catalogue under lib/i18n/messages.
      expect(offenders).toEqual([]);
    });
  }

  it('keeps the scroll-spy margin in the component that uses it', () => {
    const source = readFileSync('app/(marketing)/blog/[slug]/table-of-contents.tsx', 'utf8');
    expect(source).toContain("const SCROLL_SPY_MARGIN = '-80px 0px -60% 0px'");
    expect(source).toContain('rootMargin: SCROLL_SPY_MARGIN');
    expect(source).not.toContain('tableOfContents.80px0px600px');
  });

  it('leaves genuinely translatable short values alone', () => {
    // Numerals can differ by script, and 'none' as a band label is a word.
    // The rule above must not sweep these up.
    expect(messages['profileQuestions.householdThree']).toBe('3');
    expect(messages['network.bandNone']).toBe('none');
  });
});
