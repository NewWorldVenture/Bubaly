import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ROOT_CHROME_SCOPE, MARKETING_SCOPE, AUTH_SCOPE, PUBLIC_LINK_SCOPE, scopeMessages,
} from '@/lib/i18n/scopes';
import enUS from '@/lib/i18n/messages/en-US.json';

// Every surface ships only the part of the catalogue its client components use.
//
// That is a real saving — a marketing page went from 246 KB of compressed
// strings to about 2 KB — and a real hazard: a scope that falls behind the code
// renders a raw key like `subscribe.subscribe` at a visitor, and nothing else
// would notice. So this walks the import graph from every page, collects the
// keys the client components it reaches pass to t(), and requires the scope to
// cover them. Adding a key outside your surface's scope fails here instead.

const ROOT = process.cwd();

function resolveSpec(spec: string, from: string): string | null {
  let path: string;
  if (spec.startsWith('@/')) path = resolve(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) path = resolve(dirname(from), spec);
  else return null; // a package, not ours
  for (const candidate of [path, `${path}.tsx`, `${path}.ts`, `${path}/index.tsx`, `${path}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every "use client" module reachable from these entry points. */
function clientModulesFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const client = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let source: string;
    try { source = readFileSync(file, 'utf8'); } catch { return; }
    if (/^\s*['"]use client['"]/m.test(source.slice(0, 400))) client.add(file);
    for (const m of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const r = resolveSpec(m[1], file); if (r) walk(r);
    }
    for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)) {
      const r = resolveSpec(m[1], file); if (r) walk(r);
    }
  };
  for (const entry of entries) walk(resolve(ROOT, entry));
  return client;
}

/** The literal keys those modules pass to t(). */
function translationKeys(modules: Set<string>): Map<string, string> {
  const keys = new Map<string, string>(); // key → the file that asked for it
  for (const file of modules) {
    const source = readFileSync(file, 'utf8');
    if (!/useTranslations/.test(source)) continue;
    for (const m of source.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
      if (!keys.has(m[1])) keys.set(m[1], file.replace(`${ROOT}/`, ''));
    }
  }
  return keys;
}

/**
 * Every page.tsx / layout.tsx under a directory — listed, then filtered by
 * BASENAME rather than matched by a glob.
 *
 * This used to take git pathspecs, and one of them silently matched nothing.
 * In a git pathspec `**\/` requires AT LEAST ONE intervening directory, so
 * `app/(marketing)/**\/layout.tsx` does not match `app/(marketing)/layout.tsx`
 * — and a route group's ROOT layout is exactly where its shared chrome mounts.
 * The header, the cookie banner, the skip link and the logo were therefore
 * never walked by this test, on any of the three scoped surfaces.
 *
 * It passed throughout, because `**\/page.tsx` DID match the nested pages, so
 * `entries.length > 0` below was satisfied and the surface looked covered. A
 * non-empty list is not a complete one, which is why the control underneath
 * now names the root files instead of counting them.
 */
const entryFiles = (dirs: string[]): string[] =>
  dirs.flatMap((d) => execFileSync('git', ['ls-files', '--', d], { encoding: 'utf8' }).split(/\r?\n/))
    .filter(Boolean)
    .filter((f) => /\/(page|layout)\.tsx$/.test(f));

const messages = enUS as Record<string, string>;

const SURFACES: { name: string; entries: string[]; scope: readonly string[] }[] = [
  {
    name: 'the root layout and its error boundaries',
    entries: ['app/layout.tsx', 'app/error.tsx', 'app/not-found.tsx', 'app/global-error.tsx'],
    scope: ROOT_CHROME_SCOPE,
  },
  {
    name: 'the marketing site',
    entries: entryFiles(['app/(marketing)/']),
    scope: MARKETING_SCOPE,
  },
  {
    name: 'sign-in and sign-up',
    entries: entryFiles(['app/(auth)/']),
    scope: AUTH_SCOPE,
  },
  {
    name: 'the public link surfaces (gift, join, pay, reviews, offline)',
    entries: entryFiles(['app/gift/', 'app/join/', 'app/pay/', 'app/reviews/', 'app/offline/']),
    scope: PUBLIC_LINK_SCOPE,
  },
];

// The control that was missing, and the reason this file passed for so long
// while three of its four surfaces were half-walked.
//
// `entries.length > 0` is satisfied by PARTIAL coverage. The old globs matched
// every nested `**\/page.tsx` and no `**\/layout.tsx` at all, so each surface
// reported plenty of entries and none of its route-group ROOT layout — which
// is the one file that mounts the shared chrome. A count cannot tell "walked
// the surface" from "walked most of it", so this names the files instead.
//
// These four are where the header, the cookie banner, the skip link, the logo
// and the join-invite flow live. If a refactor moves them, update this list
// deliberately; do not delete the case.
describe('the scan reaches each surface, named rather than counted', () => {
  it('walks the route-group root layouts, not just the nested pages', () => {
    const walked = new Set(SURFACES.flatMap((s) => s.entries));
    for (const file of [
      'app/(marketing)/layout.tsx',
      'app/(auth)/layout.tsx',
      'app/join/layout.tsx',
      'app/join/page.tsx',
    ]) {
      expect(walked, `${file} mounts shared chrome and must be walked`).toContain(file);
    }
  });
});

describe('a surface ships every string its client components ask for', () => {
  for (const surface of SURFACES) {
    it(`${surface.name} has no key outside its scope`, () => {
      expect(surface.entries.length).toBeGreaterThan(0);
      const scoped = scopeMessages(messages, surface.scope);
      const missing = [...translationKeys(clientModulesFrom(surface.entries))]
        // A key absent from en-US entirely is a different defect, caught by the
        // i18n gate; this test is about the scope, so only judge real keys.
        .filter(([key]) => key in messages && !(key in scoped))
        .map(([key, file]) => `${key}  (${file})`);
      expect(missing).toEqual([]);
    });
  }
});

describe('scopeMessages', () => {
  it('keeps a namespace whole and drops everything else', () => {
    const sample = { 'login.title': 'a', 'login.sub': 'b', 'wallet.title': 'c', bare: 'd' };
    expect(scopeMessages(sample, ['login'])).toEqual({ 'login.title': 'a', 'login.sub': 'b' });
  });

  it('matches a key with no namespace by its whole name', () => {
    expect(scopeMessages({ bare: 'd', 'x.y': 'e' }, ['bare'])).toEqual({ bare: 'd' });
  });

  it('does not match a namespace by prefix alone', () => {
    // 'log' must not pull in 'login.*' — that would quietly re-inflate a scope.
    expect(scopeMessages({ 'login.title': 'a' }, ['log'])).toEqual({});
  });

  it('is dramatically smaller than the catalogue it narrows', () => {
    const full = JSON.stringify(messages).length;
    const marketing = JSON.stringify(scopeMessages(messages, MARKETING_SCOPE)).length;
    // The measured production page was 93% catalogue. Assert the order of
    // magnitude, not an exact number, so adding marketing strings is allowed.
    expect(marketing).toBeLessThan(full / 50);
  });

  it('leaves the authenticated app whole', () => {
    // Not a scope: 'all' must stay the escape hatch, because 96 non-literal
    // t() call sites in that surface cannot be resolved statically.
    expect(scopeMessages(messages, ['login'])).not.toEqual(messages);
    expect(Object.keys(messages).length).toBeGreaterThan(10_000);
  });
});
