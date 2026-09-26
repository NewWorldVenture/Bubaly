import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SEC-001, the consumer half. The `family-media` bucket is public, and every
 * photo, message attachment, reminder image, closet and inventory photo used
 * to reach the browser as the URL stored in its row. The bucket cannot be made
 * private until nothing renders that URL directly — otherwise the flip breaks
 * every image at once — so this file holds the line the flip depends on:
 *
 *   1. No element renders a stored family-media field raw. It goes through
 *      <FamilyMediaImg> or the `media(...)` lookup from useFamilyMediaUrls,
 *      both of which sign with the viewer's session and never fall back.
 *   2. `getPublicUrl` on this bucket survives only where a writer builds the
 *      reference it STORES — never where something is rendered.
 *
 * Calibrated: putting one raw `<img src={photo.url}>` back in photos-module,
 * or the closet `photoUrl` helper back, fails here and names the file.
 */

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e)) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]
  .map((p) => ({ path: p.slice(ROOT.length + 1).split(sep).join('/'), src: readFileSync(p, 'utf8') }));

/**
 * Files that render family-media references. Derived, not typed: anything that
 * reads one of the tables whose rows hold them, or names the bucket.
 */
const consumers = files.filter((f) =>
  f.path.endsWith('.tsx')
  && /family_photos|family_messages|family_reminders|family_albums|'family-media'|photo_path|attachment_url|cover_url/.test(f.src),
);

/** Writers that call getPublicUrl to build the reference they insert — not to render. */
const REFERENCE_WRITERS: Record<string, string> = {
  'components/modules/photos-module.tsx': 'family_photos.url on upload',
  'components/memories/create-memory.tsx': 'family_photos.url on upload',
  'components/modules/messages-module.tsx': 'family_messages.attachment_url on send',
  'components/modules/reminders-module.tsx': 'family_reminders.image_url in the editor',
};

// An element attribute whose expression names a stored family-media field and
// does not pass through the signer.
const RAW_RENDER = /<(img|video|audio|source|a|Image)\b[^>]*?\b(src|href)=\{(?![^}]*\b(?:media|safeWebLink)\()([^}]*?\b(url|thumbnail_url|attachment_url|image_url|cover_url|photo_path|photoPath|imageUrl|coverUrl)\b[^}]*)\}/gs;

describe('a family-media reference is never rendered raw', () => {
  it('finds the consumers it claims to guard', () => {
    // Non-vacuity: an over-narrow filter would pass over nothing.
    const paths = consumers.map((c) => c.path);
    for (const expected of [
      'components/modules/photos-module.tsx',
      'components/modules/messages-module.tsx',
      'components/modules/reminders-module.tsx',
      'components/modules/closet-module.tsx',
      'components/modules/inventory-module.tsx',
      'components/memories/on-this-day-card.tsx',
      'app/(app)/home/page.tsx',
      'app/(app)/dashboard/memories/page.tsx',
    ]) expect(paths, `${expected} is no longer recognised as a consumer`).toContain(expected);
  });

  it('no consumer puts a stored family-media field straight into src or href', () => {
    const raw: string[] = [];
    for (const { path, src } of consumers) {
      for (const m of src.matchAll(RAW_RENDER)) {
        // A local upload preview is a blob: URL, not a stored reference.
        if (/createObjectURL|\.preview\b/.test(m[3])) continue;
        raw.push(`${path}: <${m[1]} ${m[2]}={${m[3].trim()}}>`);
      }
    }
    expect(raw, 'render these through <FamilyMediaImg> or media(...) from useFamilyMediaUrls:\n' + raw.join('\n')).toEqual([]);
  });

  it("getPublicUrl on 'family-media' survives only in the writers that store the reference", () => {
    const users = files
      .filter((f) => /from\('family-media'\)\s*\.getPublicUrl|from\('family-media'\)\.getPublicUrl/.test(f.src))
      .map((f) => f.path);
    const unexpected = users.filter((p) => !(p in REFERENCE_WRITERS));
    expect(unexpected, 'a render-time getPublicUrl on family-media is the public read SEC-001 removes').toEqual([]);
    // And each named writer still exists and still writes, or its entry is stale.
    for (const p of Object.keys(REFERENCE_WRITERS)) expect(users, `${p} no longer builds a reference — drop it from REFERENCE_WRITERS`).toContain(p);
  });

  it('the signer never falls back to the stored URL', () => {
    const ref = readFileSync(join(ROOT, 'lib/storage/family-media-ref.ts'), 'utf8');
    const img = readFileSync(join(ROOT, 'components/media/family-media-img.tsx'), 'utf8');
    // The only place the component sets src is from the signed lookup.
    expect(img).toMatch(/const url = useFamilyMediaUrl\(src\)/);
    expect(img).toMatch(/<img src=\{url\}/);
    expect(img).not.toMatch(/<img src=\{src\}/);
    expect(ref).toMatch(/out\.set\(ref, null\); \/\/ until signing proves otherwise/);
  });
});
