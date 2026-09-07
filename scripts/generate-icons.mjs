// scripts/generate-icons.mjs
// Rasterizes the Bubaly brand art into the PNG icon set required by
// PWA install, iOS home screen, Android adaptive icons, and the native app
// launchers. Run with: node scripts/generate-icons.mjs
//
// WHICH ARTWORK, AND WHY IT DIFFERS BY SIZE
//
// The launcher icon is the full Bubaly logo — the house mark AND the "Bubaly"
// wordmark — because that is the thing a person recognises. The house alone is
// a wide, thin chevron: contained in a square tile it fills barely half the
// height, and at the ~60pt an iOS home screen actually renders it reads as an
// anonymous blue angle rather than as Bubaly. The wordmark is what makes the
// tile identifiable at a glance, so every size a launcher uses now carries it.
//
// Two sets deliberately keep the mark on its own:
//
//   - Favicon sizes (<= 48px). The script wordmark is illegible below about a
//     96px tile, so it degrades to grey mush and takes the mark's legibility
//     down with it. Reducing to the mark alone at small sizes is the ordinary
//     favicon practice, and the mark is still the logo's own glyph.
//   - Maskable. Android crops an adaptive icon to a circle (or a squircle, or
//     a teardrop — the launcher chooses). A 1.85:1 lockup inscribed in the
//     safe circle would have to shrink to ~70% of the tile width and would
//     still lose its ends on the narrower masks, so maskable stays the mark,
//     which fills a circle properly.
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mark = readFileSync(join(root, 'public/brand/bubaly-mark.png'));
const logo = readFileSync(join(root, 'public/brand/bubaly-logo.png'));
const outDir = join(root, 'public/icons');
const launchDir = join(root, 'public/launch');
const mobileDir = join(root, 'mobile/assets');
mkdirSync(outDir, { recursive: true });
mkdirSync(launchDir, { recursive: true });
mkdirSync(mobileDir, { recursive: true });

const BG = '#ffffff';

// Every output is written through this. The artwork is a flat background plus a
// two-hue gradient — a handful of ramps, not photographic colour — so a 256
// entry palette reproduces it with no visible banding (checked at 1:1 on the
// logo itself) while cutting each file by roughly 80%. Adding the wordmark
// costs pixels; palette encoding more than pays for them, and every shipped
// asset now lands SMALLER than the mark-only version it replaces. Without this
// the launch-screen set alone doubled, from 1.3MB to 2.8MB.
const ENCODE = { palette: true, compressionLevel: 9 };

// Below this tile size the wordmark stops being readable and starts being
// noise, so the artwork falls back to the mark. 96 is the smallest tile in the
// set that any launcher uses; 72 and under are favicon/shortcut territory.
const WORDMARK_MIN = 96;

/** Compose one square tile: art scaled to fit `1 - inset*2` of the edge,
 *  centred on the neutral background. `fit: 'contain'` preserves the aspect
 *  ratio, so a wide lockup keeps its proportions and simply leaves air above
 *  and below rather than being stretched into the square. */
async function composeIcon(size, inset, art) {
  const box = Math.round(size * (1 - inset * 2));
  const resized = await sharp(art)
    .resize(box, box, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: resized, gravity: 'center' }])
    .png(ENCODE)
    .toBuffer();
}

// Standard "any" purpose icons — the full logo on a neutral tile, or the mark
// alone at favicon sizes.
const standard = [16, 32, 48, 72, 96, 144, 167, 180, 192, 256, 384, 512, 1024];
// Maskable icons — mark inset to ~80% within an Android safe zone.
const maskable = [192, 512];

async function renderStandard(size) {
  // The lockup is wide, so it is the tile's WIDTH that binds: a 6% inset would
  // run the wordmark's tail into the rounded corner iOS masks on. 8% keeps a
  // real optical margin at the ends while the (much shorter) vertical extent
  // has room to spare either way.
  const wordmark = size >= WORDMARK_MIN;
  const png = await composeIcon(size, wordmark ? 0.08 : 0.06, wordmark ? logo : mark);
  await sharp(png).png(ENCODE).toFile(join(outDir, `icon-${size}.png`));
}

async function renderMaskable(size) {
  const png = await composeIcon(size, 0.12, mark);
  await sharp(png).png(ENCODE).toFile(join(outDir, `maskable-${size}.png`));
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
  // The full logo sits at ~62% of the short edge. A splash screen has room the
  // home-screen tile does not, so this is where the wordmark earns its place:
  // the app opens on something that says Bubaly rather than on a bare glyph.
  // 62% of the SHORT edge is the binding constraint in portrait and still
  // leaves a wide margin on an SE.
  const logoWidth = Math.round(Math.min(pixelWidth, pixelHeight) * 0.62);
  const resizedLogo = await sharp(logo)
    .resize(logoWidth, logoWidth, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({ create: { width: pixelWidth, height: pixelHeight, channels: 4, background: LAUNCH_BG } })
    .composite([{ input: resizedLogo, gravity: 'center' }])
    .png(ENCODE)
    .toFile(join(launchDir, `launch-${pixelWidth}x${pixelHeight}.png`));
}

// The Expo shell (mobile/) keeps its own copies because `app.json` resolves
// them relative to itself and Metro will not reach up into public/. They were
// hand-copied once and had already drifted: `splash-icon.png` was the white
// PWA tile, so the native splash painted a white square in the middle of the
// near-black launch background. Deriving all three here means the native app
// and the web app can never again disagree about what Bubaly looks like.
async function renderMobileAssets() {
  // iOS app icon: the same full-logo tile the web install gets.
  await sharp(await composeIcon(1024, 0.08, logo)).png(ENCODE).toFile(join(mobileDir, 'icon.png'));
  // Android adaptive foreground: the mark, inset into the mask's safe zone, to
  // match `maskable-*.png` for the same reason — the launcher may crop this to
  // a circle, and a 1.85:1 lockup loses its ends to one. app.json paints
  // `backgroundColor` behind it, so the foreground stays transparent rather
  // than carrying the white tile.
  const foreground = await sharp(mark)
    .resize(Math.round(1024 * 0.62), Math.round(1024 * 0.62), {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: foreground, gravity: 'center' }])
    .png(ENCODE)
    .toFile(join(mobileDir, 'adaptive-icon.png'));
  // Splash: transparent, so expo-splash-screen's own `backgroundColor` shows
  // through instead of a white card sitting on it.
  await sharp(logo).resize(1024, null, { fit: 'inside' }).png(ENCODE).toFile(join(mobileDir, 'splash-icon.png'));
}

const run = async () => {
  await Promise.all(standard.map(renderStandard));
  await Promise.all(maskable.map(renderMaskable));
  await renderMobileAssets();
  // No root /apple-touch-icon.png is written: it would be a byte-identical copy of
  // icons/icon-180.png, and scripts/audit-marketing-assets.mjs fails the build on
  // duplicate shipped image content. iOS only scans the document root when a page
  // ships no <link rel="apple-touch-icon"> — app/layout.tsx emits that link on
  // every route via metadata.icons.apple, so the root file would never be read.
  await Promise.all(LAUNCH_SCREENS.map(renderLaunchScreen));
  console.log(`Generated ${standard.length + maskable.length} unique icons in public/icons`);
  console.log(`Generated ${LAUNCH_SCREENS.length} iOS launch screens in public/launch`);
  console.log('Generated 3 Expo shell assets in mobile/assets');
};

run().catch((e) => { console.error(e); process.exit(1); });
