// W-04: /dashboard/experience can only ever be empty — nothing in the product
// writes `experience_audits` — yet it sat in every household's sidebar at
// minLevel 0. On the owner's instruction (2026-09-29) it is taken out of the
// sidebar and the service catalogue. The page stays reachable by URL, and a
// saved custom sidebar that still lists it drops the unknown href rather than
// breaking (`free-tier-sidebar.tsx` and `navigation-choices.tsx` filter
// through ALL_SERVICES_BY_HREF).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  APP_NAV_GROUPS, ALL_SERVICES_BY_HREF, NAV_CATALOG_KEYS, DEFAULT_SIDEBAR_NAV_KEYS,
} from '@/lib/constants/navigation';

const HREF = '/dashboard/experience';

describe('the Experience Scorecard is not offered in the sidebar', () => {
  it('is in no sidebar group, catalogue or default', () => {
    expect(APP_NAV_GROUPS.flatMap((g) => g.items).map((i) => i.href)).not.toContain(HREF);
    expect(ALL_SERVICES_BY_HREF.has(HREF)).toBe(false);
    expect(NAV_CATALOG_KEYS).not.toContain(HREF);
    expect(DEFAULT_SIDEBAR_NAV_KEYS).not.toContain(HREF);
  });

  it('still has nothing that writes its table, which is why it left the sidebar', () => {
    const page = 'app/(app)/dashboard/experience/page.tsx';
    expect(existsSync(page)).toBe(true);
    expect(readFileSync(page, 'utf8')).not.toMatch(/from\('experience_audits'\)\s*\.(insert|upsert|update)/);
  });
});
