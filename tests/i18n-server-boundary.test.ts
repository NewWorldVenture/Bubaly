import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

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
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks', 'shared'];
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

/**
 * `useTranslations()` inside a JSDoc block or a `//` note is prose, not a call.
 * `components/ui/states.tsx` explains in its header comment why it can use
 * neither translator, and an unmasked search reads that as a hook.
 */
function withoutComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/**
 * The `'use client'` / `'use server'` directive, or null.
 *
 * A directive may sit BELOW a leading comment — 14 action files in this repo
 * open with a header explaining what the write path is for — so a plain
 * `startsWith` reads them as having no directive at all, and the import-graph
 * rule below then calls every one of them a client module.
 */
function directive(source: string): string | null {
  const body = withoutComments(source).trimStart();
  const m = /^['"](use (?:client|server))['"]/.exec(body);
  return m ? m[1] : null;
}

type Entry = { declaresClient: boolean; declaresServer: boolean; callsHook: boolean; imports: string[] };

const files = sourceFiles();
const sources = new Map<string, Entry>();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  sources.set(file, {
    declaresClient: directive(src) === 'use client',
    callsHook: /\buseTranslations\s*\(/.test(withoutComments(src)),
    // A `'use server'` file is SERVER code however it is imported. Importing a
    // server action from a client component is the normal shape — that is what
    // a server action is for — and reading it as client made 81 action files
    // look like browser modules the moment they carried their own failure copy.
    declaresServer: directive(src) === 'use server',
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

function sourceEntry(file: string): Entry {
  const entry = sources.get(file);
  if (!entry) {
    throw new Error(
      `The i18n module graph has no indexed source for ${relative(ROOT, file)}. `
        + 'Add its directory to SOURCE_DIRS so the server/client audit can inspect it.',
    );
  }
  return entry;
}

const clientCache = new Map<string, boolean>();
function isClientModule(file: string, seen = new Set<string>()): boolean {
  const abs = resolve(ROOT, file);
  if (clientCache.has(abs)) return clientCache.get(abs)!;
  if (seen.has(abs)) return false;          // an import cycle proves nothing
  seen.add(abs);

  const entry = sourceEntry(abs);
  if (entry.declaresServer) { clientCache.set(abs, false); return false; }
  let answer = entry.declaresClient;
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

  it("does not read a 'use server' file as client just because a client imports it", () => {
    // `account/actions.ts` is imported by the client component that renders the
    // Close Account button. It is still server code, and it reads the request's
    // locale to word its own refusal.
    const action = resolve(ROOT, 'app/(app)/account/actions.ts');
    expect(sources.get(action)?.declaresServer, "it declares 'use server'").toBe(true);
    expect(isClientModule(action), 'so it is not a client module').toBe(false);
    expect(
      readFileSync(action, 'utf8'),
      'and it may therefore use the server translator',
    ).toContain("from '@/lib/i18n/server'");
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

/**
 * The mirror image of the block above, and the one that actually shipped a red
 * CI: a SERVER component that calls `useTranslations()`. Nothing static catches
 * it — the module graph is legal, tsc is happy, and `next build` compiles it —
 * so it only appears at RENDER time, as a 500 with
 *
 *   Attempted to call useTranslations() from the server but useTranslations is
 *   on the client.
 *
 * `components/a11y/skip-link.tsx` is rendered directly by
 * `app/(marketing)/layout.tsx`, so every marketing route 500'd: 230 Playwright
 * failures from one missing directive.
 *
 * The rule this encodes is React's own: the server renders down from each route
 * entry and STOPS at the first `'use client'`. A module the server can still
 * reach when it stops may not call a hook.
 */
const ROUTE_ENTRY = /^(page|layout|template|default|not-found|loading|route)\.tsx?$/;

function serverRenderedModules(): Set<string> {
  const roots = files.filter(
    (file) =>
      file.startsWith(join(ROOT, 'app'))
      && ROUTE_ENTRY.test(basename(file))
      && !sourceEntry(file).declaresClient,
  );
  const reached = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    for (const target of sourceEntry(queue.shift()!).imports) {
      // `'use client'` is where the server stops; everything under it is the
      // browser's problem and may hold as many hooks as it likes.
      if (reached.has(target) || sourceEntry(target).declaresClient) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  return reached;
}

describe('useTranslations never runs on the server', () => {
  it('indexes every resolved local import instead of silently excluding another source root', () => {
    const missing = [...sources].flatMap(([file, entry]) => entry.imports
      .filter((target) => !sources.has(target))
      .map((target) => `${relative(ROOT, file)} imports ${relative(ROOT, target)}`));
    expect(missing, 'add these source directories to SOURCE_DIRS so their module boundaries are audited').toEqual([]);
  });

  it('inspects the shared auth transport through both server and browser import paths', () => {
    const transport = resolve(ROOT, 'shared/auth/refresh-fetch.ts');
    expect(sourceEntry(resolve(ROOT, 'lib/supabase/server.ts')).imports).toContain(transport);
    expect(sourceEntry(resolve(ROOT, 'lib/supabase/client.ts')).imports).toContain(transport);
    expect(sourceEntry(transport).declaresClient).toBe(false);
    expect(isClientModule(transport)).toBe(true);
    expect(serverRenderedModules().has(transport)).toBe(true);
  });

  it('explains an unindexed graph node instead of skipping its server/client audit', () => {
    const missing = resolve(ROOT, 'unindexed-fixture', 'module.ts');
    expect(() => sourceEntry(missing)).toThrow(
      `The i18n module graph has no indexed source for ${relative(ROOT, missing)}. `
        + 'Add its directory to SOURCE_DIRS so the server/client audit can inspect it.',
    );
  });

  it('is called only from modules the server render cannot reach', () => {
    const offenders = [...serverRenderedModules()]
      .filter((file) => sourceEntry(file).callsHook)
      .map((file) => relative(ROOT, file))
      .sort();

    expect(
      offenders,
      "these render on the server, so they need `await getTranslations()` from "
        + "@/lib/i18n/server — or a 'use client' directive of their own",
    ).toEqual([]);
  });

  it('reads a route entry as a server root and stops at the first client module', () => {
    const layout = resolve(ROOT, 'app/(marketing)/layout.tsx');
    const skipLink = resolve(ROOT, 'components/a11y/skip-link.tsx');
    const rendered = serverRenderedModules();
    expect(rendered.has(layout), 'the marketing layout is a server root').toBe(true);
    expect(sources.get(skipLink)?.declaresClient, 'the skip link declares client').toBe(true);
    expect(rendered.has(skipLink), 'so the server render stops before it').toBe(false);
  });

  it('does not read a hook named in a comment as a call', () => {
    // `components/ui/states.tsx` is server-reachable AND says the words
    // "useTranslations() is a hook a server component cannot run" in its header.
    const states = resolve(ROOT, 'components/ui/states.tsx');
    expect(serverRenderedModules().has(states), 'the module is server-reachable').toBe(true);
    expect(readFileSync(states, 'utf8'), 'and names the hook in prose').toContain('useTranslations()');
    expect(sources.get(states)?.callsHook, 'but does not call it').toBe(false);
  });
});
