// W-03 said a Basic family is SHOWN a Home & Maintenance link that bounces them
// to billing, because lib/constants/navigation.ts lists it at `minLevel: 1`.
//
// The sidebar does not read `minLevel` to decide that. `resolveItems` locks an
// item from the catalogue tier keyed by its href (getFeatureTiersByHref →
// tiersByHref), and the catalogue says `plus` for /dashboard/home. So a Basic
// family sees the entry LOCKED, and clicking it opens the upgrade prompt for
// Family+ (level 2), the same level the segment layout enforces. There is no
// dead link. `minLevel: 1` still disagrees on paper, but nothing that renders
// or gates reads it for this route; the Free sidebar shows only minLevel 0.
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));

const { resolveItems } = await import('@/components/app/nav-shared');
const { APP_NAV_GROUPS } = await import('@/lib/constants/navigation');
const { resolveFeatureTiers, tiersByHref } = await import('@/lib/features/tiers');

const HREF = '/dashboard/home';
const tiers = tiersByHref(resolveFeatureTiers({}));
const item = APP_NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === HREF)!;

function entryFor(planLevel: number) {
  return resolveItems([item], tiers, planLevel, false, true)[0];
}

describe('Home & Maintenance in the sidebar, by plan', () => {
  it('is in the sidebar and in the catalogue at Family+', () => {
    expect(item).toBeDefined();
    expect(tiers[HREF]).toBe('plus');
  });

  it('a Basic family sees it locked, asking for Family+', () => {
    expect(entryFor(1)).toMatchObject({ locked: true, requiredLevel: 2 });
  });

  it('a Family+ family can open it (control)', () => {
    expect(entryFor(2)).toMatchObject({ locked: false });
  });
});
