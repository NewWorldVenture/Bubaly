import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { familyMediaPath } from '../lib/storage/family-media';
import { unguessableObjectName } from '../lib/storage/object-name';

/**
 * `family-media` is the ONE bucket created with `public = true` (0216: reads stay
 * public so the stored getPublicUrl links keep working; hardening them to signed
 * URLs needs a data migration, tracked as the LB-009 follow-up).
 *
 * Until that lands, the only thing between an object and the internet is that
 * nobody can guess its URL — and the first path segment, the family id, is not
 * secret: it is in every public URL the family already shares. So the object
 * NAME has to carry the entropy.
 *
 * Four modules named objects `${Date.now()}.${ext}`. messages and reminders are
 * the pointed cases: those attachments are private conversations.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const sources = [...walk('components'), ...walk('app'), ...walk('lib')];

/** Buckets whose SELECT policy is `bucket_id = '<id>'` with no scoping. */
const PUBLIC_READ_BUCKETS = ['family-media', 'avatars', 'feedback-attachments', 'marketplace-photos'];

describe('objects in the public buckets cannot be guessed', () => {
  it('no storage path takes its only variable part from the clock', () => {
    // The rule is CLOCK-ONLY, not "mentions Date.now": the shared namer's own
    // fallback references the clock alongside randomness. A name whose sole
    // varying component is the millisecond is enumerable outright.
    //
    // This rule used to be the ONLY one, and its comment said a name mixing in
    // Math.random "still has real entropy (feedback-attachments does this)".
    // That was wrong and it is why the weak path survived: `Math.random()
    // .toString(36).slice(2, 8)` is SIX base36 characters — 31 bits, a 2.2e9
    // keyspace, measured — from a generator that is explicitly not a CSPRNG.
    // The rule below is what actually holds the line.
    const offenders: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        if (!/const path\s*=/.test(line) || !/Date\.now\(\)/.test(line)) continue;
        const hasOtherEntropy = /Math\.random|randomUUID|randomBytes|nanoid|unguessableObjectName/.test(line);
        if (!hasOtherEntropy) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every upload into a publicly-readable bucket names its object with the shared helper', () => {
    // Not "has some entropy" — the helper, which is crypto.randomUUID (122 bits).
    // A private copy is how escapeLike reached four call sites with two of them
    // still wrong, so the requirement is the helper itself.
    const offenders: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      if (!/\.upload\(/.test(src)) continue;
      const bucket = PUBLIC_READ_BUCKETS.find((b) => src.includes(`'${b}'`) || src.includes(`_BUCKET`) && src.includes(b));
      if (!bucket) continue;
      // family-media goes through familyMediaPath, which calls the helper.
      if (src.includes('unguessableObjectName') || src.includes('familyMediaPath')) continue;
      offenders.push(`${file} uploads to a public bucket without unguessableObjectName`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no public-bucket path takes its entropy from Math.random', () => {
    // Math.random is not a CSPRNG. The helper's fallback is the one permitted
    // use, and it lives in lib/storage/object-name.ts alone.
    const offenders: string[] = [];
    for (const file of sources) {
      if (file.replace(/\\/g, '/').endsWith('lib/storage/object-name.ts')) continue;
      const src = readFileSync(file, 'utf8');
      if (!/\.upload\(/.test(src)) continue;
      for (const line of src.split('\n')) {
        if (/const path\s*=/.test(line) && /Math\.random/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the shared namer is what the storage modules use', () => {
    for (const file of ['lib/storage/avatars.ts', 'lib/storage/family-media.ts']) {
      expect(readFileSync(file, 'utf8')).toContain('unguessableObjectName');
    }
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(unguessableObjectName('a.png'));
    expect(seen.size).toBe(2000);
  });

  it('every family-media upload builds its path through the helper', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes("from('family-media')")) continue;
      // A module that uploads must not assemble the path itself.
      if (/\.upload\(/.test(src) && !src.includes('familyMediaPath')) {
        offenders.push(file);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the helper produces a distinct, high-entropy name every call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(familyMediaPath('fam-1', 'photos', 'a.jpg'));
    expect(seen.size).toBe(2000);
  });

  it('keeps the family folder first and the extension last', () => {
    // The write policies gate on storage.foldername(name)[1], so the family id
    // must stay the first segment or RLS stops matching.
    const p = familyMediaPath('fam-1', 'messages', 'holiday photo.HEIC');
    expect(p.startsWith('fam-1/messages/')).toBe(true);
    expect(p.endsWith('.HEIC')).toBe(true);
    expect(p.split('/')).toHaveLength(3);
  });

  it('falls back to a plausible extension when the file has none', () => {
    expect(familyMediaPath('fam-1', 'inventory', 'receipt')).toMatch(/\.jpg$/);
  });
});
