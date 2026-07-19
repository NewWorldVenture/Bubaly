import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-035 (M-008 slice): the six family-hub pages pair equivalent list cards in a
// two-column grid that previously only split at lg (1024px) — so iPad portrait
// (768–834px) rendered a single stacked column, wasting half the screen. The
// pairs split at md now. (Sidebar layouts like lg:grid-cols-[1fr_340px] stay
// lg-gated on purpose: a 340px rail doesn't fit beside content at 768px.)
const HUBS: Array<[string, number]> = [
  ['app/(app)/dashboard/family-health/page.tsx', 1],
  ['app/(app)/dashboard/family-emergency/page.tsx', 1],
  ['app/(app)/dashboard/family-school/page.tsx', 1],
  ['app/(app)/dashboard/family-sports/page.tsx', 1],
  ['app/(app)/dashboard/family-coo/page.tsx', 2],
  ['app/(app)/dashboard/family-cfo/page.tsx', 1],
];

describe('family-hub card pairs split at md for tablets (M-035)', () => {
  it('every hub two-card grid uses md:grid-cols-2 (not lg-gated)', () => {
    for (const [file, count] of HUBS) {
      const src = readFileSync(file, 'utf8');
      const md = (src.match(/grid gap-5 md:grid-cols-2/g) ?? []).length;
      expect(md, `${file} md-split grids`).toBe(count);
      expect(src, `${file} should have no lg-gated pair grid left`).not.toContain('grid gap-5 lg:grid-cols-2');
    }
  });
});
