import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

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
