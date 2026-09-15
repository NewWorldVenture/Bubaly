import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The English catalogue is 13,458 keys and 869 KB on disk. It belongs on the
// server. It reached the BROWSER by one import hop: `locale-provider.tsx` is a
// `'use client'` component in the root layout, it imported `translate` from
// `@/lib/i18n/messages`, and that module statically imports every catalogue
// JSON. Ten shook out; en-US could not, because `translate` fell back to it.
// Measured on a real build: 818,132 bytes raw / 244,556 gzip, inlined as one
// `JSON.parse('…')` blob into a chunk listed for `/layout`,
// `/(marketing)/layout`, `/(auth)/layout` and `/(app)/layout` — 62.4% of the
// marketing home page's first-load JavaScript.
//
// `lib/i18n/scopes.ts` had already fixed the same problem for the RSC payload
// and could not see this one: the catalogue arrived through an import, not
// through the payload. A byte-size assertion on a built chunk would need a
// build to run; the INVARIANT does not. It is a property of the module graph:
//
//   no 'use client' module may reach @/lib/i18n/messages, by any path.
//
// One hop is all it took last time, so the walk is transitive rather than a
// grep for the direct import.

const ROOTS = ['app', 'components', 'lib'];
const CATALOGUE_MODULE = 'lib/i18n/messages';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Strip comments, so a module named in prose is not read as an import. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Local imports only — a package name is not ours to walk into. */
function importsOf(file: string): string[] {
  const source = withoutComments(readFileSync(file, 'utf8'));
  // `import type { X } from '…'` is erased by the compiler and carries nothing
  // into any bundle, so it is not an edge in the graph a bundler walks.
  const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+(type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/g)]
    .filter((m) => !m[1])
    .map((m) => m[2]);
  const resolved: string[] = [];
  for (const spec of specifiers) {
    const base = spec.startsWith('@/') ? spec.slice(2)
      : spec.startsWith('.') ? resolve(dirname(file), spec).replace(`${process.cwd()}/`, '')
      : null;
    if (base === null) continue;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
      try {
        if (statSync(candidate).isFile()) { resolved.push(candidate); break; }
      } catch { /* not this extension */ }
    }
  }
  return resolved;
}

const ALL = ROOTS.flatMap(sourceFiles);
const IS_CLIENT = new Map(ALL.map((f) => [f, /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8'))]));
const IMPORTS = new Map(ALL.map((f) => [f, importsOf(f)]));

/**
 * A module the bundler never follows into the client.
 *
 * This is where the walk has to match how Next actually bundles rather than
 * how the import statement reads. A client component importing a `'use server'`
 * actions file does NOT drag that file's module graph into the browser — the
 * import is replaced by a reference to an RPC endpoint. Same for anything
 * marked `import 'server-only'`, which fails the build if it is ever reached
 * from a client component.
 *
 * Without these two stops the walk reports ~30 paths, every one of them a
 * client component importing its own server action. Those are how the product
 * is meant to be written, and a guard that flagged them would be deleted within
 * a week — which is worse than no guard.
 */
const IS_SERVER_BOUNDARY = new Map(ALL.map((f) => {
  const source = readFileSync(f, 'utf8');
  // The directive may sit under a leading comment block, as most of this
  // repo's action files do — matching only at byte 0 misses every one of them.
  const directive = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*|\s)*['"]use server['"]/.test(source);
  const explicit = /^import\s+['"]server-only['"]/m.test(source);
  // `next/headers` throws if it is ever reached from a client component, so a
  // module importing it is server-only by construction. lib/i18n/server.ts says
  // exactly that in its own header.
  const headers = /from\s+['"]next\/headers['"]/.test(source);
  return [f, directive || explicit || headers];
}));

/** The import path from `file` to the catalogue module, or null. */
function pathToCatalogue(file: string, seen = new Set<string>()): string[] | null {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const dep of IMPORTS.get(file) ?? []) {
    if (dep.startsWith(CATALOGUE_MODULE)) return [file, dep];
    if (IS_SERVER_BOUNDARY.get(dep)) continue;
    const deeper = pathToCatalogue(dep, seen);
    if (deeper) return [file, ...deeper];
  }
  return null;
}

describe('the English catalogue stays out of the browser bundle', () => {
  it('is reachable from no client component, by any import path', () => {
    const offenders = ALL
      .filter((f) => IS_CLIENT.get(f))
      .map((f) => pathToCatalogue(f))
      .filter((p): p is string[] => p !== null)
      .map((p) => p.join(' → '));

    expect(
      offenders,
      'A client module reaches lib/i18n/messages, which statically imports all '
        + 'eleven catalogues. en-US cannot tree-shake out of it, so the whole '
        + '13,458-key catalogue (244 KB gzip) is emitted into a client chunk. '
        + 'Import the primitive from @/lib/i18n/translate instead — it holds no '
        + 'catalogue.',
    ).toEqual([]);
  });

  it('still lets the server hold the catalogue', () => {
    // Guards the guard. If nothing imported the catalogue at all, the test
    // above would pass for the wrong reason.
    const serverImporters = ALL.filter((f) => !IS_CLIENT.get(f) && pathToCatalogue(f) !== null);
    expect(serverImporters.length).toBeGreaterThan(0);
  });

  it('keeps the primitive itself catalogue-free', () => {
    const translate = readFileSync('lib/i18n/translate.ts', 'utf8');
    expect(translate).not.toMatch(/from\s+['"][^'"]*messages\/[^'"]*\.json['"]/);
    expect(withoutComments(translate)).not.toContain('lib/i18n/messages');
  });

  it('gives global-error its four strings without the catalogue', () => {
    // app/global-error.tsx renders its own <html>, so it sits above every
    // provider. Its keys were covered by the English fallback that used to make
    // the catalogue load-bearing in the browser; they are inlined now, and if
    // the file grows a fifth key this fails rather than shipping a raw key at a
    // visitor on the error screen.
    const provider = readFileSync('components/i18n/locale-provider.tsx', 'utf8');
    const used = [...readFileSync('app/global-error.tsx', 'utf8').matchAll(/t\('([^']+)'/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(provider, `global-error uses ${key}`).toContain(`'${key}'`);
  });
});
