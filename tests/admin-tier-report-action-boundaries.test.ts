import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tierActions = readFileSync('app/(app)/admin/tier-features/actions.ts', 'utf8');
const tierStore = readFileSync('lib/server/feature-tiers.ts', 'utf8');
const reportActions = readFileSync('app/(app)/admin/marketplace/reports/actions.ts', 'utf8');

describe('privileged tier and report action boundaries', () => {
  it('fails closed for tier settings authorization and validation', () => {
    expect(tierActions).toContain('describeActionError');
    expect(tierActions).toContain("if (!('supabase' in guarded)) return guarded;");
    expect(tierActions).toContain('FEATURE_CATALOG_BY_KEY[key]');
    expect(tierActions).toContain("if (!isFeatureTier(tier)) return { ok: false, error: 'Choose a valid tier.' }");
    expect(tierActions).toContain('try {');
  });

  it('checks tier reads and writes before reporting success', () => {
    expect(tierStore).toContain("if (error) {");
    expect(tierStore).toContain("console.error('[feature-tiers] override read failed'");
    expect(tierStore).toContain('if (error) throw error;');
    expect(tierStore).toContain('const { error } = await supabase.from(\'app_settings\').upsert');
  });

  it('checks report reads, target rows, and listing withdrawal writes', () => {
    expect(reportActions).toContain('reportError');
    expect(reportActions).toContain("if (!updated) return { ok: false, error: 'Report not found or already resolved.' }");
    expect(reportActions).toContain('listingError');
    expect(reportActions).toContain('withdrawalError');
    expect(reportActions).toContain("if (!withdrawn) return { ok: false, error: 'The reported listing changed before it could be withdrawn.' }");
  });

  it('prevents stale report claims from being reported as successful', () => {
    expect(reportActions).toContain(".eq('status', 'open')");
    expect(reportActions).toContain("if (!data) return { ok: false, error: 'Report not found or already claimed.' }");
    expect(reportActions).toContain("if (!('admin' in guarded)) return guarded;");
  });
});
