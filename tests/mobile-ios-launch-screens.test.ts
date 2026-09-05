import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAUNCH_SCREENS, launchScreenHref, launchScreenMedia } from '@/lib/pwa/launch-screens';

// iOS shows a launch image only when a media query matches the device exactly, so
// three things have to agree: the device list the PNGs are generated from, the
// list the <link> tags are rendered from, and the files actually on disk. Any one
// of them drifting turns the install back into a white flash — silently, because
// nothing errors. These guards fail instead.
//
// The generator is parsed as text rather than imported: scripts/generate-icons.mjs
// runs itself on import and would rewrite the icon set as a side effect.

const root = process.cwd();
const generator = readFileSync(resolve(root, 'scripts/generate-icons.mjs'), 'utf8');
const layout = readFileSync(resolve(root, 'app/layout.tsx'), 'utf8');

function generatorScreens(): { width: number; height: number; ratio: number }[] {
  const start = generator.indexOf('export const LAUNCH_SCREENS');
  expect(start, 'generate-icons.mjs must export LAUNCH_SCREENS').toBeGreaterThanOrEqual(0);
  const block = generator.slice(start, generator.indexOf('];', start));
  return [...block.matchAll(/\{\s*width:\s*(\d+),\s*height:\s*(\d+),\s*ratio:\s*(\d+)\s*\}/g)].map(
    ([, width, height, ratio]) => ({ width: +width, height: +height, ratio: +ratio }),
  );
}

describe('iOS PWA launch screens', () => {
  it('generates from exactly the device list the markup renders', () => {
    expect(generatorScreens()).toEqual(LAUNCH_SCREENS);
  });

  it('has a real PNG on disk for every declared device', () => {
    for (const screen of LAUNCH_SCREENS) {
      const href = launchScreenHref(screen);
      expect(existsSync(resolve(root, `public${href}`)), `${href} is missing`).toBe(true);
    }
  });

  it('declares no duplicate device signatures', () => {
    const seen = LAUNCH_SCREENS.map((s) => `${s.width}x${s.height}@${s.ratio}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('renders the startup-image links and the legacy iOS standalone meta', () => {
    expect(layout).toContain('apple-touch-startup-image');
    expect(layout).toContain('LAUNCH_SCREENS.map');
    // Pre-15.4 iOS opens the home-screen icon in a browser tab without this.
    expect(layout).toContain('apple-mobile-web-app-capable');
  });

  it('builds a media query pinning width, height, ratio and orientation', () => {
    const media = launchScreenMedia({ width: 393, height: 852, ratio: 3 });
    expect(media).toBe(
      '(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
    );
  });
});
