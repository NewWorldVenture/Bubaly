import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-036: the emulated device matrix must cover rotation and color-scheme, not
// just portrait/light — landscape is where overflow bugs hide and theme CSS can
// shift layout. Locks the landscape projects (both engine branches) and the
// dark-mode variant into playwright.config.ts.
const config = readFileSync('playwright.config.ts', 'utf8');

describe('mobile e2e matrix covers landscape + dark (M-036)', () => {
  it('has landscape projects in both engine branches', () => {
    expect((config.match(/name: 'iphone-landscape'/g) ?? []).length).toBe(2); // webkit + chromium-pinned
    expect((config.match(/name: 'ipad-landscape'/g) ?? []).length).toBe(2);
    expect(config).toContain("devices['iPhone 14 Pro landscape']");
    expect(config).toContain("devices['iPad (gen 7) landscape']");
  });

  it('has a dark-mode variant', () => {
    expect(config).toContain("name: 'pixel-dark'");
    expect(config).toContain("colorScheme: 'dark' as const");
  });

  it('keeps the original portrait matrix intact', () => {
    for (const name of ['iphone-se', 'iphone', 'ipad', 'pixel']) {
      expect(config, `project ${name}`).toContain(`name: '${name}'`);
    }
  });

  // M-042: the matrix used to run only public marketing routes, so the SIGNED-IN
  // app — bottom tab bar, safe areas, full-height panels, the Quick-capture FAB —
  // had no runtime coverage at phone width at all. The `iphone` project carries
  // authenticated.spec.ts for that. Dropping it back out would silently return the
  // authed app to desktop-only verification, which is exactly how the gap arose.
  it('runs the authenticated journey at phone viewport, in both engine branches', () => {
    const iphoneProjects = [...config.matchAll(/name: 'iphone',\s*testMatch:\s*([^,]+),/g)];
    expect(iphoneProjects.length, 'webkit + chromium-pinned iphone projects').toBe(2);
    for (const [, testMatch] of iphoneProjects) {
      expect(testMatch, 'iphone testMatch must include authenticated').toContain('authenticated');
    }
  });

  it('does not spend the slow authed journey on every device', () => {
    // One phone is the point: the journey signs up, onboards and writes a record.
    const authedProjects = (config.match(/authenticated\)\\\.spec\\\.ts/g) ?? []).length;
    expect(authedProjects, 'only the two iphone project declarations').toBe(2);
  });
});
