// scripts/generate-icons.mjs
// Rasterizes the Bubaly house mark into the PNG icon set required by
// PWA install, iOS home screen, Android adaptive icons, and the native app
// launchers. Run with: node scripts/generate-icons.mjs
//
// Maskable icons get extra padding (safe zone) so Android's adaptive mask never
// clips the house mark. The neutral tile keeps the gradient legible everywhere.
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mark = readFileSync(join(root, 'public/brand/bubaly-mark.png'));
const outDir = join(root, 'public/icons');
const launchDir = join(root, 'public/launch');
mkdirSync(outDir, { recursive: true });
mkdirSync(launchDir, { recursive: true });

const BG = '#ffffff';

async function composeIcon(size, inset = 0.08) {
  const width = Math.round(size * (1 - inset * 2));
  const height = Math.round(size * (1 - inset * 2));
  const resizedMark = await sharp(mark)
    .resize(width, height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: resizedMark, gravity: 'center' }])
    .png()
    .toBuffer();
}

// Standard "any" purpose icons — compact mark on a neutral tile.
const standard = [16, 32, 48, 72, 96, 144, 167, 180, 192, 256, 384, 512, 1024];
// Maskable icons — mark inset to ~80% within an Android safe zone.
const maskable = [192, 512];

async function renderStandard(size) {
  const png = await composeIcon(size, 0.06);
  await sharp(png).toFile(join(outDir, `icon-${size}.png`));
}

async function renderMaskable(size) {
  const png = await composeIcon(size, 0.12);
  await sharp(png).toFile(join(outDir, `maskable-${size}.png`));
}

// iOS "Add to Home Screen" launch screens. Without an apple-touch-startup-image
// matching the exact device, Safari launches an installed PWA on a blank white
// screen until the first paint — which reads as a broken app on a dark-themed
// product. iOS only accepts an EXACT device-pixel match, so every current iPhone
// needs its own file; the media queries that select them live in app/layout.tsx
// and are kept in sync by tests/mobile-ios-launch-screens.test.ts.
//
// Portrait only: iOS uses the portrait image to launch in either orientation,
// and doubling the set for landscape adds weight for no visible gain.
export const LAUNCH_SCREENS = [
  { width: 375, height: 667, ratio: 2 },  // SE (2nd/3rd gen), 8
  { width: 414, height: 736, ratio: 3 },  // 8 Plus
  { width: 375, height: 812, ratio: 3 },  // X, XS, 11 Pro, 12/13 mini
  { width: 414, height: 896, ratio: 2 },  // XR, 11
  { width: 414, height: 896, ratio: 3 },  // XS Max, 11 Pro Max
  { width: 390, height: 844, ratio: 3 },  // 12, 12 Pro, 13, 13 Pro, 14
  { width: 428, height: 926, ratio: 3 },  // 12/13 Pro Max, 14 Plus
  { width: 393, height: 852, ratio: 3 },  // 14 Pro, 15, 15 Pro, 16
  { width: 430, height: 932, ratio: 3 },  // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  { width: 402, height: 874, ratio: 3 },  // 16 Pro
  { width: 440, height: 956, ratio: 3 },  // 16 Pro Max
];

// Matches manifest.background_color / theme_color so the launch screen is
// continuous with the app's own first paint instead of flashing against it.
const LAUNCH_BG = { r: 9, g: 12, b: 20, alpha: 1 };

async function renderLaunchScreen({ width, height, ratio }) {
  const pixelWidth = width * ratio;
  const pixelHeight = height * ratio;
  // The mark sits at ~38% of the short edge — large enough to read on an SE,
  // small enough not to crop on a tall Pro Max.
  const markSize = Math.round(Math.min(pixelWidth, pixelHeight) * 0.38);
  const resizedMark = await sharp(mark)
    .resize(markSize, markSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({ create: { width: pixelWidth, height: pixelHeight, channels: 4, background: LAUNCH_BG } })
    .composite([{ input: resizedMark, gravity: 'center' }])
    .png()
    .toFile(join(launchDir, `launch-${pixelWidth}x${pixelHeight}.png`));
}

const run = async () => {
  await Promise.all(standard.map(renderStandard));
  await Promise.all(maskable.map(renderMaskable));
  // iOS falls back to scanning /apple-touch-icon.png at the document root when a
  // page ships no <link rel="apple-touch-icon">; keep one there so a bare route
  // still gets the real mark rather than a screenshot of the page.
  await sharp(await composeIcon(180, 0.06)).toFile(join(root, 'public/apple-touch-icon.png'));
  await Promise.all(LAUNCH_SCREENS.map(renderLaunchScreen));
  console.log(`Generated ${standard.length + maskable.length} unique icons in public/icons`);
  console.log(`Generated ${LAUNCH_SCREENS.length} iOS launch screens in public/launch`);
  console.log('Generated public/apple-touch-icon.png');
};

run().catch((e) => { console.error(e); process.exit(1); });
