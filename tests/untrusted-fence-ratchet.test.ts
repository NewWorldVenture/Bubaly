import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fenceUntrustedBlock, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';

// §44's fence is genuinely well built — nonce markers, a rule the model is told
// to obey, thirteen context slices using it. What it lacked was a way to know
// where it had NOT been applied. The audit found the sharpest gap by reading
// forty call sites by hand: Magic Import sent a pasted school email to a model
// with WRITE TOOLS ATTACHED as a bare user message, with no rule saying the
// text was data.
//
// This turns that from an invisible set into a reviewed list: any module that
// hands a model a non-empty tool set must reach the untrusted-content module —
// itself, or through a prompt module it imports. A new tool-calling surface
// either fences its inputs or fails here.
const ROOTS = ['app', 'lib'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { walk(path, out); continue; }
    if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** Local `@/…` imports, one level — enough to see a prompt module's rule. */
function localImports(src: string): string[] {
  return [...src.matchAll(/from '(@\/[^']+)'/g)]
    .map((m) => m[1].replace('@/', ''))
    .flatMap((base) => ['.ts', '.tsx', '/index.ts'].map((ext) => `${base}${ext}`))
    .filter((path) => { try { return statSync(path).isFile(); } catch { return false; } });
}

function reachesFence(path: string): boolean {
  const src = readFileSync(path, 'utf8');
  if (src.includes('lib/ai/safety/untrusted')) return true;
  return localImports(src).some((dep) => readFileSync(dep, 'utf8').includes('lib/ai/safety/untrusted'));
}

/** Files that hand a model a tool set that is not literally empty. */
function toolCallingModules(): string[] {
  return ROOTS.flatMap((root) => walk(root))
    .filter((path) => {
      const src = readFileSync(path, 'utf8');
      if (!/resolveProvider|provider\.(complete|runTools)/.test(src)) return false;
      return /tools:\s*(?!\[\s*\])[A-Za-z_[]/.test(src);
    })
    .map((path) => path.split(sep).join('/'));
}

describe('the untrusted-content fence reaches every tool-calling prompt', () => {
  it('finds the tool-calling surfaces at all', () => {
    // A scan that matched nothing would pass the assertion below for the worst
    // possible reason.
    const found = toolCallingModules();
    expect(found).toContain('app/api/ai/import/route.ts');
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  it('every one of them reaches lib/ai/safety/untrusted', () => {
    const bare = toolCallingModules().filter((path) => !reachesFence(path));
    expect(bare, `these hand a model write tools without reaching the fence: ${bare.join(', ')}`).toEqual([]);
  });
});

describe('a fence budget never cuts a scalar in half (C1-S9-10)', () => {
  // Both fences bounded with a plain `.slice(max)`. When the budget lands
  // between the two halves of a surrogate pair, the prompt carries a LONE
  // surrogate — the same defect `safeContactText` exists to prevent on the
  // storage side, reached from the prompt side. Only the Contact Center caller
  // pre-bounded scalar-safely; the other seven call sites did not, so the cut
  // is fixed in the helper rather than at each of them.
  const lone = (s: string) => [...s].some((c) => {
    const p = c.codePointAt(0)!;
    return p >= 0xd800 && p <= 0xdfff;
  });

  it('fenceUntrustedBlock drops a half-pair rather than emitting it', () => {
    // 'a'.repeat(9) + '😀' is 11 UTF-16 units; a budget of 10 lands mid-emoji.
    const fenced = fenceUntrustedBlock('t', 'a'.repeat(9) + '😀', 10);
    expect(lone(fenced), 'a lone surrogate reached the prompt').toBe(false);
    expect(fenced).toContain('a'.repeat(9));
    expect(fenced).not.toContain('😀');
  });

  it('keeps a pair that fits whole', () => {
    const fenced = fenceUntrustedBlock('t', 'a'.repeat(9) + '😀', 11);
    expect(fenced).toContain('😀');
    expect(lone(fenced)).toBe(false);
  });

  it('sanitizeUntrusted bounds the same way', () => {
    // Long enough that the cut actually happens: sanitizeUntrusted returns
    // early when the text already fits, so a same-length input would have
    // exercised nothing and passed against the naive slice too.
    const cut = sanitizeUntrusted('b'.repeat(9) + '😀' + 'tail', 11);
    expect(lone(cut), 'a lone surrogate survived sanitisation').toBe(false);
  });

  it('is unchanged for text inside the budget', () => {
    expect(fenceUntrustedBlock('t', 'plain text', 100)).toContain('plain text');
  });
});
