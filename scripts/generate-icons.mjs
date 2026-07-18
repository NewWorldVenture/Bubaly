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
mkdirSync(outDir, { recursive: true });

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

const run = async () => {
  await Promise.all(standard.map(renderStandard));
  await Promise.all(maskable.map(renderMaskable));
  console.log(`Generated ${standard.length + maskable.length} unique icons in public/icons`);
};

run().catch((e) => { console.error(e); process.exit(1); });
