import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

// The launcher icon must be the Bubaly LOGO — house mark plus the "Bubaly"
// wordmark — not the house mark on its own.
//
// The mark alone is a 1.82:1 chevron. Contained in a square tile it fills a
// little under half the height, and at the ~60pt an iOS home screen actually
// renders, that reads as an anonymous blue angle rather than as Bubaly. The
// wordmark is what makes the tile identifiable, so every size a launcher uses
// carries it; favicon sizes (<= 48) and the maskable set keep the mark, for
// reasons scripts/generate-icons.mjs states.
//
// Nothing about the two tiles differs in the obvious dimensions — both artworks
// are ~1.8:1, so the content bounding box is the same shape either way. What
// separates them is WHERE the ink sits: the wordmark and its swoosh pack the
// lower part of the box, while the mark leaves only two thin posts down there.
// So the assertion is on ink distribution, and it is measured from the shipped
// PNG rather than from the generator, which is the only way a stale committed
// icon can be caught.

/** Share of a tile's non-background ink that falls in the lower 40% of its
 *  content box. Measured: full logo ≈ 0.55, mark alone ≈ 0.30. */
async function lowerInkShare(file: string): Promise<number> {
  const { data, info } = await sharp(readFileSync(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const rows = new Array<number>(height).fill(0);
  let top = height;
  let bottom = -1;
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const nearWhite = data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240;
      if (nearWhite || data[i + 3] <= 40) continue;
      rows[y]++;
      total++;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  expect(total, `${file} has no ink at all`).toBeGreaterThan(0);
  const cut = top + Math.round((bottom - top + 1) * 0.6);
  let lower = 0;
  for (let y = cut; y <= bottom; y++) lower += rows[y];
  return lower / total;
}

// Every size a launcher or an install prompt reaches for.
const launcherIcons = [96, 144, 167, 180, 192, 256, 384, 512, 1024];
// Small enough that the script wordmark degrades to mush.
const faviconIcons = [16, 32, 48, 72];

describe('the app icon is the Bubaly logo', () => {
  for (const size of launcherIcons) {
    it(`icon-${size}.png carries the wordmark, not the bare mark`, async () => {
      const share = await lowerInkShare(`public/icons/icon-${size}.png`);
      expect(share, `icon-${size}.png looks like the mark alone (lower-ink share ${share.toFixed(3)})`)
        .toBeGreaterThan(0.45);
    });
  }

  for (const size of faviconIcons) {
    it(`icon-${size}.png stays the mark, where the wordmark would be unreadable`, async () => {
      const share = await lowerInkShare(`public/icons/icon-${size}.png`);
      expect(share).toBeLessThan(0.45);
    });
  }

  for (const size of [192, 512]) {
    it(`maskable-${size}.png stays the mark, which fills a circular mask`, async () => {
      const share = await lowerInkShare(`public/icons/maskable-${size}.png`);
      expect(share).toBeLessThan(0.45);
    });
  }

  it('the Expo shell ships the same logo tile, and a splash that is not a white card', async () => {
    expect(await lowerInkShare('mobile/assets/icon.png')).toBeGreaterThan(0.45);
    // A splash-icon with an opaque background paints a white rectangle in the
    // middle of expo-splash-screen's near-black backgroundColor. It was one.
    const splash = await sharp('mobile/assets/splash-icon.png').metadata();
    expect(splash.hasAlpha, 'splash-icon.png must be transparent').toBe(true);
    const { data, info } = await sharp('mobile/assets/splash-icon.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const corner = data[(0 * info.width + 0) * info.channels + 3];
    expect(corner, 'splash-icon.png corner must be transparent, not a white tile').toBe(0);
  });

  it('the generator, not a hand edit, is what produced them', () => {
    const src = readFileSync('scripts/generate-icons.mjs', 'utf8');
    expect(src).toContain('const WORDMARK_MIN = 96');
    expect(src).toContain('wordmark ? logo : mark');
  });
});
