import { describe, it, expect } from 'vitest';
import {
  APP_NAV_GROUPS, NAV_CATALOG, NAV_CATALOG_KEYS, DEFAULT_SIDEBAR_NAV_KEYS,
} from '@/lib/constants/navigation';
import { FIXED_NAV_ROUTES } from '@/lib/navigation/customize';

describe('APP_NAV_GROUPS', () => {
  // Guards against a recurring cross-merge bug: the same item (e.g. Family
  // Wallet) being added to a single sidebar group twice.
  it('has no duplicate hrefs within any group', () => {
    for (const group of APP_NAV_GROUPS) {
      const hrefs = group.items.map((i) => i.href);
      const dupes = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
      expect(dupes, `duplicate href(s) in "${group.title}": ${[...new Set(dupes)].join(', ')}`).toEqual([]);
    }
  });

  it('lists Family Wallet exactly once in the Suggested group', () => {
    const suggested = APP_NAV_GROUPS.find((g) => g.title === 'Suggested');
    expect(suggested).toBeTruthy();
    const wallets = (suggested!.items).filter((i) => i.href === '/wallet');
    expect(wallets).toHaveLength(1);
  });
});

describe('NAV_CATALOG (customizable sidebar)', () => {
  it('has unique hrefs', () => {
    const dupes = NAV_CATALOG_KEYS.filter((h, i) => NAV_CATALOG_KEYS.indexOf(h) !== i);
    expect([...new Set(dupes)]).toEqual([]);
  });

  it('never includes the fixed chrome routes (AI Assistant / Settings / Help)', () => {
    for (const route of FIXED_NAV_ROUTES) {
      expect(NAV_CATALOG_KEYS).not.toContain(route);
    }
  });

  it('every catalog item carries a label + icon', () => {
    for (const item of NAV_CATALOG) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.icon).toBeTruthy();
    }
  });

  it('the default layout is a non-empty subset of the catalog', () => {
    expect(DEFAULT_SIDEBAR_NAV_KEYS.length).toBeGreaterThan(0);
    for (const key of DEFAULT_SIDEBAR_NAV_KEYS) {
      expect(NAV_CATALOG_KEYS).toContain(key);
    }
  });
});
