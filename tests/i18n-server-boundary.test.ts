import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// `lib/i18n/server.ts` imports `next/headers`. A CLIENT module that reaches it
// fails `next build` with "You're importing a component that needs next/headers"
// — and nothing else notices: tsc is happy, lint is happy, and the 7,300 tests
// were happy the two times this actually shipped a red build during the i18n
// migration (`pricing-content.tsx`, then `components/ai/cards/vacation-prep.tsx`).
// A production build takes about a hundred seconds; this takes about one.
//
// The subtlety the first fix missed: a module is client if ANY module that
// imports it is client, at any depth. `components/ai/cards/vacation-prep.tsx`
// carries no `'use client'` of its own — its dispatcher, `cards/index.tsx`,
// does — and it is a browser module all the same.
const ROOT = process.cwd();
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks'];
const SERVER_I18N = resolve(ROOT, 'lib/i18n/server.ts');

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) {
    try { walk(join(ROOT, dir)); } catch { /* a directory this repo does not have */ }
  }
  return out;
}

/** `@/a/b` and `./a/b` to a real file; null for a package. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

type Entry = { declaresClient: boolean; imports: string[] };

const files = sourceFiles();
const sources = new Map<string, Entry>();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  sources.set(file, {
    declaresClient: /^['"]use client['"]/.test(src.trimStart()),
    // `import type … from` is ERASED at compile time and says nothing about
    // whether a module reaches the browser. Counting it made
    // `app/(app)/dashboard/contact-center/page.tsx` look client, because the
    // client module `contact-center-module.tsx` imports a ROW TYPE from it.
    imports: [...src.matchAll(/(?:^|\n)\s*(?:export|import)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g)]
      .filter((m) => !m[1])
      .map((m) => resolveSpecifier(file, m[2]))
      .filter((x): x is string => Boolean(x)),
  });
}

const importers = new Map<string, Set<string>>();
for (const [file, { imports }] of sources) {
  for (const target of imports) {
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target)!.add(file);
  }
}

const clientCache = new Map<string, boolean>();
function isClientModule(file: string, seen = new Set<string>()): boolean {
  const abs = resolve(ROOT, file);
  if (clientCache.has(abs)) return clientCache.get(abs)!;
  if (seen.has(abs)) return false;          // an import cycle proves nothing
  seen.add(abs);

  let answer = Boolean(sources.get(abs)?.declaresClient);
  if (!answer) {
    for (const importer of importers.get(abs) ?? []) {
      if (isClientModule(importer, seen)) { answer = true; break; }
    }
  }
  if (seen.size === 1 || answer) clientCache.set(abs, answer);
  return answer;
}

describe('lib/i18n/server never reaches the browser', () => {
  it('is imported only from modules that are server-only', () => {
    const offenders = (importers.get(SERVER_I18N) ?? new Set<string>());
    const clientOffenders = [...offenders]
      .filter((file) => isClientModule(file))
      .map((file) => relative(ROOT, file))
      .sort();

    expect(
      clientOffenders,
      'these are client modules and must use useTranslations() from '
        + '@/components/i18n/locale-provider instead',
    ).toEqual([]);
  });

  it('does not count a type-only import as making a module client', () => {
    // `contact-center-module.tsx` is a client component and imports the `InboxRow`
    // TYPE from the page. That import disappears at compile time; the page is a
    // server component and must stay one.
    const page = resolve(ROOT, 'app/(app)/dashboard/contact-center/page.tsx');
    const clientModule = resolve(ROOT, 'components/modules/contact-center-module.tsx');
    expect(sources.get(clientModule)?.declaresClient, 'the module is client').toBe(true);
    expect(sources.get(clientModule)?.imports, 'and the type import is not counted').not.toContain(page);
    expect(isClientModule(page), 'so the page stays a server component').toBe(false);
  });

  it('knows what a client module is, transitively', () => {
    // The guard is only worth anything if it agrees that a file with no
    // directive of its own, imported by one that has it, is client.
    const card = resolve(ROOT, 'components/ai/cards/vacation-prep.tsx');
    const dispatcher = resolve(ROOT, 'components/ai/cards/index.tsx');
    expect(sources.get(card)?.declaresClient, 'the card declares nothing itself').toBe(false);
    expect(sources.get(dispatcher)?.declaresClient, 'its dispatcher declares it').toBe(true);
    expect(isClientModule(card)).toBe(true);
  });
});
