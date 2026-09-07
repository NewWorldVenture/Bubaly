// scripts/i18n-wire.mjs — put `t` in scope wherever the lift left a call to it.
//
// `i18n-lift.mjs` rewrites copy into `t('key')` but deliberately never decides
// where `t` comes from, because getting that wrong turns a page into a runtime
// error. This does decide it, from one fact that is not a guess: whether the
// file is a client component.
//
//   'use client' at the top  ->  const t = useTranslations();      (a hook)
//   otherwise                ->  const t = await getTranslations(); (server)
//
// and it only touches functions TypeScript has already named. Run:
//
//   node scripts/i18n-lift.mjs <file> --apply
//   npx tsc --noEmit 2>&1 | node scripts/i18n-wire.mjs
//
// tsc is exhaustive about "Cannot find name 't'", so between the two nothing is
// missed and nothing is invented. Anything it cannot place — a `t` inside a
// callback with no enclosing named function, say — it reports and leaves for a
// person, because a wrong `await` in the wrong scope is worse than a red build.
import { readFileSync, writeFileSync } from 'node:fs';

const SERVER_IMPORT = "import { getTranslations } from '@/lib/i18n/server';\n";
const CLIENT_IMPORT = "import { useTranslations } from '@/components/i18n/locale-provider';\n";

const input = readFileSync(0, 'utf8');
const wanted = new Map(); // file -> Set(line)
for (const line of input.split('\n')) {
  const m = /^(.+?)\((\d+),\d+\): error TS2304: Cannot find name 't'\./.exec(line);
  if (!m) continue;
  if (!wanted.has(m[1])) wanted.set(m[1], new Set());
  wanted.get(m[1]).add(Number(m[2]));
}

if (!wanted.size) {
  console.log('nothing to wire');
  process.exit(0);
}

let unplaced = 0;
for (const [path, lines] of wanted) {
  let src = readFileSync(path, 'utf8');
  const isClient = /^['"]use client['"]/.test(src.trimStart());

  // If the file already has a translator under another name, adding a second
  // one called `t` is how you get a duplicate declaration, or a shadow when the
  // file also binds `t` for something else. The lift reuses that name; there is
  // nothing here to wire.
  if (/const\s+(?!t\b)[A-Za-z_$][\w$]*\s*=\s*(?:await\s+getTranslations\(\)|useTranslations\(\))/.test(src)) {
    console.log(`  skip    ${path}  (already has a translator under another name)`);
    continue;
  }

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
    const open = src.indexOf('{', src.indexOf(')', at));
    if (src.slice(open, open + 140).includes('const t =')) continue;
    const decl = isClient || text.includes('async') ? text : text.replace('function', 'async function');
    const stmt = isClient ? '\n  const t = useTranslations();' : '\n  const t = await getTranslations();';
    src = src.slice(0, open + 1) + stmt + src.slice(open + 1);
    src = src.slice(0, at) + decl + src.slice(at + text.length);
  }

  const need = isClient ? CLIENT_IMPORT : SERVER_IMPORT;
  if (!src.includes(need.trim())) {
    const first = /^import .*?;\n/m.exec(src);
    src = first ? src.slice(0, first.index + first[0].length) + need + src.slice(first.index + first[0].length) : need + src;
  }

  writeFileSync(path, src);
  console.log(`  ${isClient ? 'client' : 'server'}  ${path}  (${targets.size} component(s))`);
}

if (unplaced) {
  console.error(`\n${unplaced} call(s) could not be placed — see above.`);
  process.exitCode = 1;
}
