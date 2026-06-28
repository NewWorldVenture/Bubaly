import { describe, it, expect } from 'vitest';
import { APP_NAV_GROUPS } from '@/lib/constants/navigation';

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
