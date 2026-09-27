import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `/missions` is the parent approval queue — the page a parent opens most —
// and it signed proof photos in a loop inside a loop: one `await
// createSignedUrl` per photo, in series, up to four per submission across the
// whole queue. A busy Saturday cost a few hundred sequential round trips
// before the page could render (F-F03).
//
// The batch form was already in the codebase and used correctly
// (app/(app)/admin/marketing/assets/page.tsx). Nothing stopped the singular
// one being used in a loop, which is what this file is for.
const SIGN_ONE = /\bcreateSignedUrl\s*\(/;
const LOOP = /\b(for|while)\s*\(|\.\s*(map|forEach|flatMap)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const blankComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * Singular `createSignedUrl` calls that sit inside a loop.
 *
 * "Inside a loop" is read as: a loop opens above it, at a shallower or equal
 * indent, within fifteen lines, and the call is indented further than that
 * loop. Crude, and it is the shape that actually went wrong — a signing call
 * whose surrounding code will run it once per item.
 */
export function signingInALoop(source: string): number[] {
  const lines = blankComments(source).split('\n');
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (!SIGN_ONE.test(line)) return;
    const indent = line.length - line.trimStart().length;
    for (let k = i - 1; k >= Math.max(0, i - 15); k--) {
      const prev = lines[k];
      if (!LOOP.test(prev)) continue;
      const loopIndent = prev.length - prev.trimStart().length;
      if (loopIndent < indent) { out.push(i + 1); return; }
    }
  });
  return out;
}

describe('signing a page\'s media is one round trip, not one per file', () => {
  const files = [...walk('app'), ...walk('lib'), ...walk('components')];

  it('finds the signing surface (non-vacuity)', () => {
    const withSigning = files.filter((f) => /createSignedUrls?\s*\(/.test(blankComments(readFileSync(f, 'utf8'))));
    expect(withSigning.length).toBeGreaterThan(3);
  });

  it('reads the shape it claims to (sanity: the matcher works)', () => {
    expect(signingInALoop(
      'for (const p of paths) {\n  const { data } = await sb.storage.from(B).createSignedUrl(p, 600);\n}')).toEqual([2]);
    expect(signingInALoop(
      'const urls = paths.map((p) => sb.storage.from(B).createSignedUrl(p, 600));')).toEqual([]);
    // One object, not in a loop: the correct use of the singular call.
    expect(signingInALoop('const { data } = await sb.storage.from(B).createSignedUrl(path, 120);')).toEqual([]);
    // The batch form is never reported, loop or not.
    expect(signingInALoop(
      'for (const chunk of chunks) {\n  const { data } = await sb.storage.from(B).createSignedUrls(chunk, 600);\n}')).toEqual([]);
    // Prose about it is not it.
    expect(signingInALoop(
      'for (const p of paths) {\n  // await createSignedUrl(p, 600) used to live here\n  keep(p);\n}')).toEqual([]);
  });

  it('has no signing call inside a loop', () => {
    const offenders = files.flatMap((f) => signingInALoop(readFileSync(f, 'utf8')).map((n) => `${f}:${n}`));
    expect(
      offenders,
      'One signed URL per round trip, in series. Collect the paths and use createSignedUrls once\n'
      + '(see app/(app)/missions/page.tsx or app/(app)/admin/marketing/assets/page.tsx):\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the approval queue signs in a batch and drops what it could not sign', () => {
    const src = blankComments(readFileSync('app/(app)/missions/page.tsx', 'utf8'));
    expect(src).toMatch(/createSignedUrls\(/);
    expect(src).not.toMatch(/createSignedUrl\(/);
    // A per-entry error means that object was not signed; using its empty
    // signedUrl would render an <img> with no src rather than no <img>.
    expect(src).toMatch(/!u\.error/);
    // And a signing outage costs the photos, not the queue.
    expect(src).toMatch(/\[missions\] proof media could not be signed/);
  });
});
