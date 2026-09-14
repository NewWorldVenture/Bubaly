// The `family-media` bucket is PUBLIC on purpose. 0216_family_media_bucket.sql
// says why: consumers resolve attachments with getPublicUrl and existing rows
// already store public URLs, so flipping it to private breaks every stored link,
// and hardening reads to signed URLs is tracked separately.
//
// That decision has a consequence the migration does not spell out: while the
// bucket is public, the OBJECT PATH is the entire access control. Supabase
// serves /storage/v1/object/public/family-media/<path> to anyone — no session,
// no RLS. The family-scoped SELECT policy in that migration governs the
// authenticated Storage API only.
//
// Four of the six upload sites built `${familyId}/<kind>/${Date.now()}.${ext}`.
// A millisecond timestamp is not a secret. A family id is known to every current
// and FORMER member, a day holds 86.4M timestamps over three or four plausible
// extensions, and real uploads cluster into narrow windows. So removing someone
// from a family did not stop them reading its closet, inventory, message and
// reminder attachments — or finding new ones as they were added.
//
// Photos and Create-Memory already used crypto.randomUUID(). This pins that for
// all six, in one place.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { familyMediaPath } from '@/lib/storage/family-media';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'supabase', 'mobile']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('familyMediaPath', () => {
  it('never returns the same path twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => familyMediaPath('fam-1', 'closet', 'a.jpg')));
    expect(seen.size, 'a collision means one upload can overwrite another').toBe(500);
  });

  it('keeps the family folder first, which the write policy matches on', () => {
    // 0216's INSERT policy is is_family_member((storage.foldername(name))[1]),
    // so the family id has to stay the first segment or every upload is refused.
    const path = familyMediaPath('11111111-2222-4333-8444-555555555555', 'messages', 'note.png');
    expect(path.startsWith('11111111-2222-4333-8444-555555555555/messages/')).toBe(true);
  });

  it('keeps the extension, and survives a file that has none', () => {
    expect(familyMediaPath('f', 'closet', 'shirt.webp').endsWith('.webp')).toBe(true);
    expect(familyMediaPath('f', 'closet', 'noextension')).toMatch(/^f\/closet\/[0-9a-f-]+$/);
  });

  it('embeds no timestamp', () => {
    // The specific defect: a path an attacker can walk. Nothing in the unique
    // segment may look like a current epoch millisecond value.
    const unique = familyMediaPath('f', 'closet', 'a.jpg').split('/')[2].replace(/\.[a-z0-9]+$/i, '');
    expect(unique).not.toMatch(/1[0-9]{12}/);
    expect(unique.length, 'too short to be unguessable').toBeGreaterThanOrEqual(32);
  });
});

describe('no upload site builds its own family-media path', () => {
  const sources = walk(join(ROOT, 'components'))
    .concat(walk(join(ROOT, 'app')), walk(join(ROOT, 'lib')))
    .map((file) => [file.replace(`${ROOT}/`, ''), readFileSync(file, 'utf8')] as const);

  it('finds the upload sites it is policing', () => {
    const uploaders = sources.filter(([, text]) => /from\('family-media'\)/.test(text));
    expect(uploaders.length, 'the walk found no family-media consumers, so it proves nothing')
      .toBeGreaterThanOrEqual(5);
  });

  it('every family-media path comes from the helper', () => {
    const offenders: string[] = [];
    for (const [file, text] of sources) {
      if (!/from\('family-media'\)/.test(text)) continue;
      text.split('\n').forEach((line, i) => {
        // A path built inline from a template literal rather than the helper.
        if (/\$\{familyId\}\/[a-zA-Z$}{]+\/\$\{/.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'build it with familyMediaPath() — while the bucket is public the path is the only access control',
    ).toEqual([]);
  });

  it('no family-media uploader reaches for Date.now() as a name', () => {
    const offenders: string[] = [];
    for (const [file, text] of sources) {
      if (!/from\('family-media'\)/.test(text)) continue;
      text.split('\n').forEach((line, i) => {
        if (/\/\$\{Date\.now\(\)\}/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders, 'a millisecond timestamp is enumerable').toEqual([]);
  });

  it('recognises the shape it is policing', () => {
    // A guard whose pattern never matches passes for every file forever.
    const bad = 'const path = `${familyId}/closet/${Date.now()}.${ext}`;';
    const good = "const path = familyMediaPath(familyId, 'closet', file.name);";
    const offends = (line: string) => /\$\{familyId\}\/[a-zA-Z$}{]+\/\$\{/.test(line);
    expect(offends(bad)).toBe(true);
    expect(offends(good)).toBe(false);
  });
});
