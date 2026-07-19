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
});
