// scripts/generate-icons.mjs
// Rasterizes the brand mark (public/icon.svg) into the PNG icon set required by
// PWA install, iOS home screen, Android adaptive icons, and the native app
// launchers. Run with: node scripts/generate-icons.mjs
//
// Maskable icons get extra padding (safe zone) so Android's adaptive mask never
// clips the house mark. The solid background matches the app theme (#090c14).
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public/icon.svg'));
const outDir = join(root, 'public/icons');
mkdirSync(outDir, { recursive: true });

const BG = '#090c14';

// Standard "any" purpose icons — full-bleed mark.
const standard = [16, 32, 48, 72, 96, 144, 167, 180, 192, 256, 384, 512, 1024];
// Maskable icons — mark inset to ~80% within an Android safe zone.
const maskable = [192, 512];

async function renderStandard(size) {
  const png = await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: BG })
    .flatten({ background: BG })
    .png()
    .toBuffer();
  await sharp(png).toFile(join(outDir, `icon-${size}.png`));
}

async function renderMaskable(size) {
  const inner = Math.round(size * 0.8);
  const pad = Math.round((size - inner) / 2);
  const mark = await sharp(svg, { density: 384 }).resize(inner, inner, { fit: 'contain', background: BG }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: mark, top: pad, left: pad }])
    .png()
    .toFile(join(outDir, `maskable-${size}.png`));
}

const run = async () => {
  await Promise.all(standard.map(renderStandard));
  await Promise.all(maskable.map(renderMaskable));
  // Apple touch icon (180) + favicon (32) at conventional public paths.
  await sharp(join(outDir, 'icon-180.png')).toFile(join(root, 'public/apple-touch-icon.png'));
  await sharp(join(outDir, 'icon-32.png')).toFile(join(root, 'public/favicon-32.png'));
  console.log(`Generated ${standard.length + maskable.length + 2} icons in public/icons`);
};

run().catch((e) => { console.error(e); process.exit(1); });
