// scripts/i18n-wire.mjs — put `t` in scope wherever the lift left a call to it.
//
// `i18n-lift.mjs` rewrites copy into `t('key')` but deliberately never decides
// where `t` comes from, because getting that wrong turns a page into a runtime
// error. This does decide it, from whether the file is a client component:
//
//   client  ->  const t = useTranslations();      (a hook)
//   server  ->  const t = await getTranslations(); (and the function goes async)
//
// "Client" is NOT the same as "has 'use client' at the top". Next marks a module
// client if anything that imports it is client, so `components/ai/cards/*.tsx`
// carry no directive and are still browser modules — their dispatcher,
// `cards/index.tsx`, is `'use client'`. Reading only the directive wired those
// files to `getTranslations()` and the build failed on `next/headers` reaching
// the browser, which is exactly the failure this tool exists to prevent. So the
// question is asked of the IMPORT GRAPH: a file is client if it declares it, or
// if any file that imports it — at any depth — declares it.
//
// It only touches functions TypeScript has already named. Run:
//
//   node scripts/i18n-lift.mjs <file> --apply
//   npx tsc --noEmit 2>&1 | node scripts/i18n-wire.mjs
//
// tsc is exhaustive about "Cannot find name 't'", so between the two nothing is
// missed and nothing is invented. Anything it cannot place — a `t` inside a
// callback with no enclosing named function, say — it reports and leaves for a
// person, because a wrong `await` in the wrong scope is worse than a red build.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks'];

/** Every source file, its 'use client' flag, and what it imports. */
function indexSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  for (const d of SOURCE_DIRS) {
    try { walk(join(ROOT, d)); } catch { /* a directory this repo does not have */ }
  }

  const index = new Map();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // `import type … from` is ERASED at compile time, so it says nothing about
    // whether a module reaches the browser. Counting it made
    // `app/(app)/dashboard/contact-center/page.tsx` look like a client module,
    // because `contact-center-module.tsx` — which IS one — imports a ROW TYPE
    // from it. The page then got `useTranslations()` inside an async server
    // component, which only `next build` catches, and only at the very end.
    const specifiers = [...src.matchAll(/(?:^|\n)\s*(?:export|import)\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g)]
      .filter((m) => !m[1])
      .map((m) => m[2]);
    index.set(file, { declaresClient: /^['"]use client['"]/.test(src.trimStart()), specifiers });
  }
  return index;
}

/** `@/a/b` and `./a/b` to a real file, or null for a package. */
function resolveSpecifier(fromFile, spec) {
  let base;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** file -> the files that import it. */
function buildImporters(index) {
  const importers = new Map();
  for (const [file, { specifiers }] of index) {
    for (const spec of specifiers) {
      const target = resolveSpecifier(file, spec);
      if (!target) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  return importers;
}

const SOURCES = indexSources();
const IMPORTERS = buildImporters(SOURCES);
const clientCache = new Map();

function isClientModule(file, seen = new Set()) {
  const abs = resolve(ROOT, file);
  if (clientCache.has(abs)) return clientCache.get(abs);
  if (seen.has(abs)) return false;          // an import cycle proves nothing
  seen.add(abs);

  const entry = SOURCES.get(abs);
  let answer = Boolean(entry?.declaresClient);
  if (!answer) {
    for (const importer of IMPORTERS.get(abs) ?? []) {
      if (isClientModule(importer, seen)) { answer = true; break; }
    }
  }
  // Only cache a settled answer: one reached while a cycle was being unwound
  // could be "false" merely because we had already visited the file.
  if (seen.size === 1 || answer) clientCache.set(abs, answer);
  return answer;
}

/**
 * A module imported from BOTH sides can use neither translator: the hook throws
 * where a server component renders it, and `getTranslations()` drags
 * `next/headers` into the browser. `components/ui/states.tsx` is the example —
 * 285 files import it, some client, some server pages. There is no automatic
 * answer, so this reports and leaves it: the fix is a prop with an English
 * default, or splitting the module, and either is a decision for a person.
 */
function isSharedModule(file) {
  const abs = resolve(ROOT, file);
  if (!isClientModule(abs)) return false;
  if (SOURCES.get(abs)?.declaresClient) return false;   // it IS a client module
  return [...(IMPORTERS.get(abs) ?? [])].some((importer) => !isClientModule(importer));
}

const SERVER_IMPORT = "import { getTranslations } from '@/lib/i18n/server';\n";
const CLIENT_IMPORT = "import { useTranslations } from '@/components/i18n/locale-provider';\n";

const input = readFileSync(0, 'utf8');
// The translator is not always called `t`. `i18n-lift` reuses whatever name a
// file already had — `tr` in several dashboard pages — and picks a different one
// when `t` is taken, so the name has to be READ from tsc rather than assumed.
// Only short, translator-shaped names are accepted: an unrelated missing symbol
// is a real error for a person, not something to declare a translator for.
const TRANSLATOR_NAMES = new Set(['t', 'tr', 'tx', 'translate_']);

/** Names this file already uses for a translator, whatever they are. */
function declaredTranslators(src) {
  return new Set(
    [...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+getTranslations\(\)|useTranslations\(\))/g)]
      .map((m) => m[1]),
  );
}

const wanted = new Map(); // file -> Map(name -> Set(line))
for (const line of input.split('\n')) {
  const m = /^(.+?)\((\d+),\d+\): error TS2304: Cannot find name '([A-Za-z_$][\w$]*)'\./.exec(line);
  if (!m) continue;
  // A name is a translator if it is one of the shortlist, or if this file
  // already declares a translator under it — `app/(app)/home/page.tsx` calls
  // its `i18nT`, and its failure component needed one of the same name.
  let accepted;
  try { accepted = declaredTranslators(readFileSync(m[1], 'utf8')); } catch { accepted = new Set(); }
  if (!TRANSLATOR_NAMES.has(m[3]) && !accepted.has(m[3])) continue;
  if (!wanted.has(m[1])) wanted.set(m[1], new Map());
  const byName = wanted.get(m[1]);
  if (!byName.has(m[3])) byName.set(m[3], new Set());
  byName.get(m[3]).add(Number(m[2]));
}

if (!wanted.size) {
  console.log('nothing to wire');
  process.exit(0);
}

let unplaced = 0;
/**
 * The offset of the `{` that opens a function's BODY, from the offset of its
 * `function` keyword.
 *
 * Not `indexOf('{', indexOf(')'))`: a signature can contain both. In
 * `components/wallet/wallet-hub.tsx` the parameter's own type is
 *
 *   action: (i: Record<string, unknown>) => Promise<{ ok: boolean; … }>
 *
 * so the first `)` closes the INNER arrow's parameters and the first `{` after
 * it opens the return TYPE. The declaration landed inside
 * `Promise<{ … }>` and left an unparseable file. Balance instead: walk from the
 * name, track ( ) < > depth, and take the first `{` seen at depth zero.
 */
function bodyBrace(src, at) {
  let paren = 0;
  let angle = 0;
  for (let i = src.indexOf('(', at); i !== -1 && i < src.length; i += 1) {
    const c = src[i];
    if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    else if (c === '<') angle += 1;
    else if (c === '>' && src[i - 1] !== '=') angle -= 1;   // `=>` is not a close
    else if (c === '{' && paren === 0 && angle === 0) return i;
    else if (c === ';' && paren === 0 && angle === 0) return -1;  // an overload
  }
  return -1;
}

for (const [path, byName] of wanted) {
  let src = readFileSync(path, 'utf8');
  if (isSharedModule(path)) {
    unplaced += 1;
    console.error(
      `  ${relative(ROOT, resolve(ROOT, path))} — imported from BOTH server and client;`
      + ' neither translator is safe here. Take the text as a prop, or split the module.',
    );
    continue;
  }
  const isClient = isClientModule(path);
  let wired = 0;

  for (const [name, lines] of byName) {
    // Byte offset of the start of every line, so a tsc line number can be
    // compared against a declaration's position.
    const lineStart = [0];
    for (const l of src.split('\n')) lineStart.push(lineStart.at(-1) + l.length + 1);

    const decls = [...src.matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z0-9_]+/gm)]
      .map((m) => ({ at: m.index, text: m[0] }));

    const targets = new Map();
    for (const ln of lines) {
      const off = lineStart[ln - 1];
      const owner = decls.filter((d) => d.at <= off).at(-1);
      if (!owner) { unplaced += 1; console.error(`  ${path}:${ln} — no enclosing named function; wire by hand`); continue; }
      targets.set(owner.at, owner);
    }

    // Rewrite from the bottom so earlier offsets stay valid.
    for (const { at, text } of [...targets.values()].sort((a, b) => b.at - a.at)) {
      const open = bodyBrace(src, at);
      if (open === -1) { unplaced += 1; console.error(`  ${path} — could not find the body of ${text}; wire by hand`); continue; }
      // Per FUNCTION, not per file: a page can declare `tr` in its default
      // export and still need one in the failure component above it.
      if (src.slice(open, open + 140).includes(`const ${name} =`)) continue;
      const decl = isClient || text.includes('async') ? text : text.replace('function', 'async function');
      const stmt = isClient
        ? `\n  const ${name} = useTranslations();`
        : `\n  const ${name} = await getTranslations();`;
      src = src.slice(0, open + 1) + stmt + src.slice(open + 1);
      src = src.slice(0, at) + decl + src.slice(at + text.length);
      wired += 1;
    }
  }

  const need = isClient ? CLIENT_IMPORT : SERVER_IMPORT;
  if (!src.includes(need.trim())) {
    const first = /^import .*?;\n/m.exec(src);
    src = first ? src.slice(0, first.index + first[0].length) + need + src.slice(first.index + first[0].length) : need + src;
  }

  writeFileSync(path, src);
  const why = /^['"]use client['"]/.test(src.trimStart()) ? '' : ' (via an importer)';
  console.log(`  ${isClient ? `client${why}` : 'server'}  ${relative(ROOT, resolve(ROOT, path))}  (${wired} component(s))`);
}

if (unplaced) {
  console.error(`\n${unplaced} call(s) could not be placed — see above.`);
  process.exitCode = 1;
}
