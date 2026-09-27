// Page audit, signed-in sweep — a super admin previewing a feature the family
// does not have gets a preview, not an error.
//
// requireFeature lets a super admin open any feature page, to preview it; the
// feature's API routes (rightly) do not let them run it for a family without
// the plan. /dashboard/autopilot scanned and /dashboard/briefing generated on
// open anyway, so every admin preview opened on a 403 in the console and an
// error card. The page now asks isFeaturePreviewOnly and the module skips the
// automatic call and says why.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ entitlement: null as unknown, throws: false }));
vi.mock('@/lib/server/plan', () => ({
  resolveFamilyPlanLevel: async () => { if (h.throws) throw new Error('plan read failed'); return 0; },
}));
vi.mock('@/lib/server/feature-tiers', () => ({
  getFeatureTiersByHref: async () => ({ '/dashboard/autopilot': 'plus', '/dashboard/briefing': 'plus', '/dashboard/off': 'off' }),
}));

const { isFeaturePreviewOnly } = await import('@/lib/server/feature-entitlement');

beforeEach(() => { h.throws = false; vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('isFeaturePreviewOnly', () => {
  it('is a preview when the family\'s plan is below the feature', async () => {
    expect(await isFeaturePreviewOnly({} as never, 'fam-1', '/dashboard/autopilot')).toBe(true);
  });

  it('is not a preview for a feature outside the catalog', async () => {
    expect(await isFeaturePreviewOnly({} as never, 'fam-1', '/dashboard/not-gated')).toBe(false);
  });

  it('is not a preview when the plan cannot be read: the route answers that itself', async () => {
    h.throws = true;
    expect(await isFeaturePreviewOnly({} as never, 'fam-1', '/dashboard/autopilot')).toBe(false);
  });
});

describe('the two pages that worked on open', () => {
  const src = (p: string) => readFileSync(p, 'utf8');

  it('autopilot does not scan on open in a preview', () => {
    expect(src('app/(app)/dashboard/autopilot/page.tsx')).toContain("<AutopilotModule preview={preview} />");
    expect(src('components/modules/autopilot-module.tsx')).toMatch(/if \(!preview && !scannedOnce && familyId\)/);
  });

  it('briefing does not generate on open in a preview', () => {
    expect(src('app/(app)/dashboard/briefing/page.tsx')).toMatch(/preview=\{await isFeaturePreviewOnly\(supabase, ctx\.active\.familyId, '\/dashboard\/briefing'\)\}/);
    expect(src('components/modules/briefing-module.tsx')).toMatch(/if \(preview \|\| tab === 'kitchen' \|\| state\[tab\]\.attempted\) return;/);
  });
});
