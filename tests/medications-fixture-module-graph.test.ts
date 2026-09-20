// The controlled E2E fixtures load the real module graph inside the page, from
// a hand-written list of files. Their loader throws `Unexpected fixture module`
// on anything missing, and because that happens while the harness is still
// building its probe, the whole spec file fails with `mount is not a function` —
// 43 tests red, and nothing in the message names the import that caused it.
//
// That is what a new import costs: `lib/medications/adherence.ts` started
// resolving dose slots in the family's zone, picked up `lib/time/zoned.ts`, and
// took both medications spec files down. tests/e2e/voice-capture-boundaries.spec.ts
// carries the same guard for its own fixture. This one runs in the fast suite, so
// the answer arrives in seconds rather than after a sixteen-minute E2E job.
//
// It used to name EIGHT spec files by hand, and that hand list is the second way
// this went blind. `components/i18n/use-format.ts` was added to eleven components
// at once; the specs in the list were repaired, and four that were not in it —
// voice-capture-boundaries, display-ownership, finance-read-states and
// medications-ledger — stayed broken through a green unit suite and a red E2E
// job. So the spec list is no longer written down. Every spec under tests/e2e
// whose fixture loader throws on an unknown id is DISCOVERED below and covered,
// which means a fixture added tomorrow is guarded the day it lands.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

const E2E = 'tests/e2e';

/** The loader's own refusal, in each of the four ways these fixtures spell it. */
const LOADER_THROW = /throw new Error\(\s*'Unexpected [^']*(?:module|import)/;

/**
 * Fixtures that build their source map by FOLLOWING the import graph, with a
 * recursive `collect()` over `require(...)` in the transpiled output.
 *
 * These cannot drift — a new import is picked up by the collector on the next
 * run — so there is no list to fall out of date and nothing here to check. They
 * are named rather than merely detected so that a fixture which stops being
 * self-maintaining fails the case below instead of quietly leaving coverage.
 */
const SELF_MAINTAINING = [
  'auth-cache-partition.spec.ts', 'auth-initiation-order.spec.ts', 'auth-recovery-ui.spec.ts',
  'browser-session-storage.spec.ts', 'callback-completion-ui.spec.ts', 'kid-login-boundaries.spec.ts',
  'kid-login-readiness.spec.ts', 'login-readiness.spec.ts', 'logout-refresh-storage.spec.ts',
  'oauth-initiation.spec.ts', 'password-login-boundaries.spec.ts', 'password-session-ownership.spec.ts',
  'session-storage-reconcile.spec.ts', 'signup-boundaries.spec.ts', 'weekly-meal-planner.spec.ts',
];

function specFiles(): string[] {
  return readdirSync(E2E).filter((name) => name.endsWith('.spec.ts'))
    .filter((name) => LOADER_THROW.test(readFileSync(join(E2E, name), 'utf8'))).sort();
}

/** The repo's `@/` alias and relative specifiers, to a real file or null. */
function resolveAlias(specifier: string, importer: string): string | null {
  const base = specifier.startsWith('./') || specifier.startsWith('../')
    ? normalize(join(dirname(importer), specifier))
    : specifier.startsWith('@/') ? specifier.slice(2) : null;
  if (base === null) return null;
  for (const extension of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(`${base}${extension}`)) return `${base}${extension}`.replaceAll('\\', '/');
  }
  return null;
}

const idFor = (file: string) => `@/${file.replace(/\.tsx?$/, '')}`;

/** Value imports only, with the bound names. `import type ... from` is erased by
 * transpilation and never reaches the loader, so demanding it would ask the
 * fixture for modules that are not there at runtime. */
function valueImports(file: string): Array<{ specifier: string; names: string[] }> {
  const out: Array<{ specifier: string; names: string[] }> = [];
  for (const match of readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\s)([^;]*?)from '([^']+)'/gms)) {
    const clause = match[1], braces = /\{([\s\S]*?)\}/.exec(clause);
    const names = braces === null ? [] : braces[1].split(',').map((part) => part.trim())
      .filter((part) => part.length > 0 && !part.startsWith('type '))
      .map((part) => part.split(/\s+as\s+/)[0].trim());
    out.push({ specifier: match[2], names });
  }
  return out;
}

/** What a fixture spec tells the loader it can serve, read off the spec source. */
function harness(spec: string) {
  const source = readFileSync(spec, 'utf8');
  // Every repo path a fixture quotes is a file it transpiles: there is no other
  // reason for these literals, and all 33 of them resolve on disk today.
  const listed = [...new Set([...source.matchAll(/'((?:lib|components|app)\/[^']+\.tsx?)'/g)].map((m) => m[1]))]
    .filter((file) => existsSync(file));
  // Most fixtures key the loader by `@/<path without extension>`; the template
  // literal that builds those keys is what says so.
  const atKeyed = /`@\/\$\{/.test(source);
  // display-ownership keys its sources by raw path and maps ids in a switch.
  const mapped = new Map([...source.matchAll(/id === '([^']+)'\)\s*return load\('([^']+)'\)/g)]
    .map((m) => [m[1], m[2]] as const));
  // Ids the fixture hands back itself, from a `mocks`/`requires` object literal.
  const mockKeys = new Set([...source.matchAll(/'(@\/[^']+)'\s*:/g)].map((m) => m[1]));
  // Any id the spec mentions at all. A module that gained a brand-new import is
  // named NOWHERE in the harness, which is the drift this guard exists to catch.
  const quoted = new Set([...source.matchAll(/'([^'\n]+)'/g)].map((m) => m[1]));
  return { source, listed: new Set(listed), entries: listed, atKeyed, mapped, mockKeys, quoted };
}

/** The text of a mock's object literal, or null when it is not one we can read. */
function mockBody(source: string, id: string): string | null {
  const at = source.indexOf(`'${id}':`);
  if (at < 0) return null;
  const open = source.indexOf('{', at);
  if (open < 0 || /^[^{]*[\n;]/.test(source.slice(at + id.length + 3, open))) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(open, i + 1); }
  }
  return null;
}

const provides = (body: string, name: string) =>
  new RegExp(String.raw`(?:^|[{,\s])${name}\s*[:(,}]`).test(body);

const FIXTURES = specFiles();
const COVERED = FIXTURES.filter((name) => !SELF_MAINTAINING.includes(name));

describe('every in-page fixture loader is covered', () => {
  it('finds the fixture specs and classifies each one', () => {
    // A discovery that stops matching covers nothing and passes forever.
    expect(FIXTURES.length, 'no fixture spec matched the loader pattern').toBeGreaterThan(25);
    expect(COVERED.length, 'every fixture was classified as self-maintaining').toBeGreaterThan(15);
    // A named self-maintaining fixture that loses its collector needs the walk.
    const collectors = FIXTURES.filter((name) => /function collect\(/.test(readFileSync(join(E2E, name), 'utf8')));
    expect(collectors, 'these follow their own import graph; the named list must match exactly')
      .toEqual(SELF_MAINTAINING);
  });
});

describe.each(COVERED)('%s provides every module its fixture will load', (name) => {
  const spec = join(E2E, name);

  it('lists each value import reachable from the files it names', () => {
    const { listed, entries, atKeyed, mapped, mockKeys, quoted } = harness(spec);
    expect(entries.length, `no source files were parsed out of ${spec}`).toBeGreaterThan(0);

    const seen = new Set(entries);
    const queue = [...entries];
    const missing: string[] = [];
    let examined = 0;
    while (queue.length > 0) {
      const file = queue.pop()!;
      for (const { specifier } of valueImports(file)) {
        const next = resolveAlias(specifier, file);
        if (next === null) continue; // a bare npm specifier; the fixture mocks it or does not reach it
        examined += 1;
        const id = idFor(next);
        // Served from the source list, mocked, or mapped by id — in any of the
        // three id schemes these fixtures use.
        const served = (atKeyed && listed.has(next)) || quoted.has(id) || quoted.has(specifier);
        if (!served) {
          missing.push(`${id}  (imported by ${file}; add '${next}' to the source list, or mock it)`);
          continue;
        }
        if (seen.has(next)) continue;
        // A mocked id replaces the real module wholesale, so the fixture needs
        // neither its source nor anything it would have imported.
        const walks = mapped.get(id) === next || mapped.get(specifier) === next
          || (atKeyed && listed.has(next) && !mockKeys.has(id));
        if (!walks) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    expect(examined, `no imports were examined for ${spec}`).toBeGreaterThan(0);
    expect(missing, `add these to the source list in ${spec} or the fixture cannot mount`).toEqual([]);
  });

  it('mocks every binding the app takes from a module it replaces', () => {
    // The second way a fixture breaks, and the one the id check above cannot
    // see: the id IS mocked, but the mock is missing a name the app imports
    // from it. finance-read-states mocked locale-provider as
    // `{ useTranslations }` while four finance views also import `useLocale`,
    // and every one of them died on `useLocale is not a function` — a module
    // graph that was complete and a mock that was not.
    const { source, listed, entries, atKeyed, mapped, mockKeys, quoted } = harness(spec);
    const seen = new Set(entries);
    const queue = [...entries];
    const missing: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      for (const { specifier, names } of valueImports(file)) {
        const next = resolveAlias(specifier, file);
        if (next === null) continue;
        const id = idFor(next);
        if (mockKeys.has(id)) {
          const body = mockBody(source, id);
          // A Proxy answers every name, and a spread carries in names this
          // reader cannot enumerate. Neither can be checked honestly here.
          if (body !== null && !body.includes('new Proxy') && !body.includes('...')) {
            for (const bound of names) {
              if (!provides(body, bound)) missing.push(`${id} is mocked without ${bound}  (imported by ${file})`);
            }
          }
        }
        if (seen.has(next) || !(quoted.has(id) || quoted.has(specifier) || (atKeyed && listed.has(next)))) continue;
        const walks = mapped.get(id) === next || mapped.get(specifier) === next
          || (atKeyed && listed.has(next) && !mockKeys.has(id));
        if (!walks) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    expect(missing, `the mock in ${spec} is missing a binding the app imports`).toEqual([]);
  });
});
