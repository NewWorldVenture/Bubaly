import { describe, expect, it } from 'vitest';
import { AI_CATEGORIES, AI_CATEGORY_BY_DOMAIN, unknownFeatureKeys, visibleCategories } from '@/lib/ai/categories';
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';
import { TRUST_DOMAINS } from '@/lib/trust/engine';
import { listTools } from '@/lib/ai/tools/registry';

describe('AI autonomy categories', () => {
  it('names only real trust domains, so a setting reaches the gate unchanged', () => {
    for (const category of AI_CATEGORIES) {
      expect(TRUST_DOMAINS, category.domain).toContain(category.domain);
    }
    expect(new Set(AI_CATEGORIES.map((c) => c.domain)).size).toBe(AI_CATEGORIES.length);
  });

  it('names only real catalog features, so no family is offered a dial for a page it cannot open', () => {
    expect(unknownFeatureKeys()).toEqual([]);
    for (const category of AI_CATEGORIES) expect(FEATURE_CATALOG_BY_KEY[category.featureKey], category.featureKey).toBeTruthy();
  });

  it('covers every domain the registry can actually write in', () => {
    // A tool whose domain has no dial is a tool the family cannot govern.
    const writable = new Set(listTools({ readOnly: false }).map((tool) => tool.domain));
    const missing = [...writable].filter((domain) => !AI_CATEGORY_BY_DOMAIN[domain]);
    expect(missing).toEqual([]);
  });

  it('hides a category whose feature is switched off', () => {
    const on = (key: string) => key === 'meals';
    expect(visibleCategories(on).map((c) => c.domain)).toEqual(['meal_planning']);
  });
});
