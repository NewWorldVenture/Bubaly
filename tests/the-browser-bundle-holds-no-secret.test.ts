// A `process.env.X` that a client bundle can reach is INLINED into JavaScript
// the browser downloads. Not read at runtime, not fetched — written into the
// file as a literal. So the question is not "is this module careful with the
// key", it is "can the bundler see this module from a client component at all".
//
// Next answers part of it: `import 'server-only'` throws at build time when a
// client bundle reaches the module. That covers 196 modules here. It does not
// cover a module that holds a secret and never declares it, which is the gap
// this sweep is for.
//
// THREE EDGES ARE NOT BUNDLING EDGES, and a traversal that follows them reports
// nonsense. The first run of this sweep reported **20 leaks** and every single
// one was one of these:
//
//   1. A `'use server'` module is an RPC boundary. A client component importing
//      `searchRecordsAction` gets a stub; none of that module's code, and none
//      of its imports' code, is emitted to the browser. 13 of the 20.
//   2. `import type { InboxRow } from '…/page'` is erased by the compiler.
//      1 of the 20 — a client module apparently importing a page.
//   3. The directive prologue is the first STATEMENT, and a file may put a
//      comment block above it. `app/(app)/dashboard/search/actions.ts` puts
//      `'use server'` on line 17, so a fixed five-line window read it as a
//      plain server module imported by a client component — which is precisely
//      the shape of the defect being looked for. 2 of the 20, and the most
//      dangerous, because it manufactures the finding rather than merely
//      adding noise.
//
// With all three handled the answer is one result, `NODE_ENV` in a client
// component, which Next inlines by design and is not a secret.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'supabase', 'mobile', 'tests', 'scripts', 'e2e']);

/** Environment variables that are public by construction. */
const PUBLIC_ENV = (name: string): boolean => name.startsWith('NEXT_PUBLIC_')
  // Next inlines NODE_ENV into the client bundle itself; it names no secret.
  || name === 'NODE_ENV';

type Module = { isClient: boolean; isServerAction: boolean; serverOnly: boolean; secrets: string[]; imports: string[] };

/** The first STATEMENT, with comments and blank lines stripped. */
export function firstStatement(text: string): string {
  let block = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (block) { if (line.includes('*/')) block = false; continue; }
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('/*')) { if (!line.includes('*/')) block = true; continue; }
    return line;
  }
  return '';
}

/** Value imports only — `import type`, and `{ type X }`-only clauses, are erased. */
export function valueImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]{0,400}?)from\s+['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    if (/^\s*\{\s*(?:type\s+[^,}]+,?\s*)+\}\s*$/.test(m[2])) continue;
    out.push(m[3]);
  }
  return out;
}

export function describeSource(text: string): Omit<Module, 'imports'> & { specifiers: string[] } {
  const head = firstStatement(text);
  return {
    isClient: /^['"]use client['"]/.test(head),
    isServerAction: /^['"]use server['"]/.test(head),
    serverOnly: /import\s+['"]server-only['"]/.test(text),
    secrets: [...new Set([...text.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].filter((n) => !PUBLIC_ENV(n)),
    specifiers: valueImports(text),
  };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const cache = new Map<string, Module>();
function describeFile(file: string): Module {
  const cached = cache.get(file);
  if (cached) return cached;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
  const d = describeSource(text);
  const mod: Module = { ...d, imports: d.specifiers.map((s) => resolveImport(s, file)).filter((x): x is string => x !== null) };
  cache.set(file, mod);
  return mod;
}

const files = ['app', 'lib', 'components', 'shared'].flatMap((d) => walk(join(ROOT, d)));
const clientRoots = files.filter((f) => describeFile(f).isClient);

const reachable = (() => {
  const seen = new Set(clientRoots);
  const via = new Map<string, string>();
  const queue = [...clientRoots];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = describeFile(cur);
    // Do not descend THROUGH an RPC or server-only boundary: neither emits its
    // dependencies into the browser bundle.
    if (!d.isClient && (d.isServerAction || d.serverOnly)) continue;
    for (const next of d.imports) {
      if (seen.has(next)) continue;
      seen.add(next); via.set(next, cur); queue.push(next);
    }
  }
  return { seen, via };
})();

describe('nothing the browser downloads reads a server secret', () => {
  it('is actually walking the app', () => {
    // A traversal that reaches nothing reports no leaks, forever.
    expect(clientRoots.length).toBeGreaterThan(100);
    expect(reachable.seen.size).toBeGreaterThan(100);
  });

  it('reaches no module that reads a non-public environment variable', () => {
    const offenders = [...reachable.seen]
      .filter((f) => { const d = describeFile(f); return d.secrets.length > 0 && !d.serverOnly && !d.isServerAction; })
      .map((f) => {
        const chain: string[] = [];
        for (let c: string | undefined = f; c && chain.length < 5; c = reachable.via.get(c)) chain.push(relative(ROOT, c));
        return `${relative(ROOT, f)} reads ${describeFile(f).secrets.join(', ')} — reached via ${chain.slice(1).join(' <- ') || 'itself, a client module'}`;
      });
    expect(offenders).toEqual([]);
  });
});

describe('the three edges that are not bundling edges', () => {
  // Each of these produced part of the 20 false positives. They are fixtures
  // rather than files so that the shapes stay pinned even if the real modules
  // that exhibited them are refactored away.
  const SECRET = "const k = process.env.SUPABASE_SERVICE_ROLE_KEY;";

  it('sees a client module that reads a secret itself', () => {
    const d = describeSource(`'use client';\n${SECRET}`);
    expect(d.isClient).toBe(true);
    expect(d.secrets).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
  });

  it('does not count NEXT_PUBLIC_ or NODE_ENV as a secret', () => {
    const d = describeSource(`'use client';\nconst a = process.env.NEXT_PUBLIC_SUPABASE_URL; const b = process.env.NODE_ENV;`);
    expect(d.secrets).toEqual([]);
  });

  it('recognises a directive that sits below a comment block', () => {
    // The real shape: app/(app)/dashboard/search/actions.ts, directive on line 17.
    const text = `${'// explanation\n'.repeat(16)}'use server';\n\nimport { createServer } from '@/lib/supabase/server';`;
    expect(describeSource(text).isServerAction).toBe(true);
    // …and a five-line window would not have.
    expect(/^\s*['"]use server['"]/m.test(text.split('\n').slice(0, 5).join('\n'))).toBe(false);
  });

  it('recognises a directive below a block comment too', () => {
    expect(describeSource(`/**\n * why\n */\n'use client';\nconst x = 1;`).isClient).toBe(true);
  });

  it('drops an erased type-only import', () => {
    expect(valueImports(`import type { InboxRow } from '@/app/(app)/dashboard/contact-center/page';`)).toEqual([]);
    expect(valueImports(`import { type A, type B } from './x';`)).toEqual([]);
  });

  it('keeps a value import that merely mentions a type', () => {
    expect(valueImports(`import { runThing, type Opts } from './x';`)).toEqual(['./x']);
    expect(valueImports(`import { createServer } from '@/lib/supabase/server';`)).toEqual(['@/lib/supabase/server']);
  });

  // The one module in the tree that names the service-role key. If the sweep
  // can reach it, everything above is decoration.
  it('the service-role module is not reachable from any client bundle', () => {
    const target = join(ROOT, 'lib/supabase/server.ts');
    expect(existsSync(target), 'lib/supabase/server.ts moved').toBe(true);
    expect(describeFile(target).secrets).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(reachable.seen.has(target)).toBe(false);
  });
});
