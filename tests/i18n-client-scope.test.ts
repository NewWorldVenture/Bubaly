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

/**
 * The literal keys those modules pass to their translator.
 *
 * The binding is READ FROM THE FILE rather than assumed to be `t`. That
 * assumption was a real hole: `components/marketing/contact-form.tsx` writes
 * `const tr = useTranslations()` and calls `tr('contact.sendMessage')`, so this
 * scan never saw a single one of its keys, and MARKETING_SCOPE fell behind
 * without failing here. Nothing noticed, because `translate` used to fall back
 * to the whole English catalogue — the same fallback that shipped 244 KB gzip
 * to every visitor. Remove the fallback and the raw key renders at a visitor;
 * `contact.whatsThisAbout` is one unbreakable token, which is why the overflow
 * suite went red on eleven public routes at once.
 *
 * So: find every `const <name> = useTranslations()` and scan for calls on those
 * names. A component that renames its translator tomorrow is covered by
 * construction rather than by someone remembering to extend a list.
 */
function translationKeys(modules: Set<string>): Map<string, string> {
  const keys = new Map<string, string>(); // key → the file that asked for it
  for (const file of modules) {
    const source = readFileSync(file, 'utf8');
    if (!/useTranslations/.test(source)) continue;
    const bindings = [...source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*useTranslations\s*\(/g)]
      .map((m) => m[1]);
    // A file that calls useTranslations() without binding it (inline, or
    // destructured in a way this does not model) is still scanned for `t(`,
    // because that is the convention everywhere else.
    for (const name of bindings.length ? bindings : ['t']) {
      const call = new RegExp(`\\b${name}\\(\\s*['"]([A-Za-z0-9_.]+)['"]`, 'g');
      for (const m of source.matchAll(call)) {
        if (!keys.has(m[1])) keys.set(m[1], file.replace(`${ROOT}/`, ''));
      }
    }
  }
  return keys;
}

/**
 * The files matching each pattern, with `**` ALSO matching zero directories.
 *
 * git's `**` requires at least one path segment, so `app/(marketing)/**​/layout.tsx`
 * matched NOTHING — `app/(marketing)/layout.tsx` is the only marketing layout
 * there is. The same held for every route group: each group's ROOT layout and
 * ROOT page were invisible to this scan, and those are precisely the files that
 * install `ScopedLocaleProvider` and render the chrome around everything else.
 * That is how MARKETING_SCOPE came to be missing `skipLink`, `marketing` and
 * `consentManager` while this test reported the surface clean.
 *
 * The aggregate `entries.length > 0` assertion below could not see it either: a
 * pattern that matches nothing is invisible when a sibling pattern matches 28
 * files. So each pattern is now required to match on its own.
 */
const files = (patterns: string[]): string[] =>
  patterns.flatMap((p) => {
    // `git ls-files` is spawned WITHOUT a shell, so the glob reaches git as a
    // pathspec rather than being expanded by sh. Git's default pathspec lets
    // `*` cross a `/`, which means `.../**/page.tsx` still requires the extra
    // directory separator and never matches a page at the surface's own root —
    // so each pattern is also tried with `/**/` collapsed to `/`.
    const both = [p, p.replace('/**/', '/')];
    const found = both
      .flatMap((g) => execFileSync('git', ['ls-files', '--', g], { encoding: 'utf8' }).split(/\r?\n/))
      .filter(Boolean);
    expect(found.length, `no file matches ${p} — the pattern has gone stale`).toBeGreaterThan(0);
    return [...new Set(found)];
  });

const messages = enUS as Record<string, string>;

const SURFACES: { name: string; entries: string[]; scope: readonly string[] }[] = [
  {
    name: 'the root layout and its error boundaries',
    entries: ['app/layout.tsx', 'app/error.tsx', 'app/not-found.tsx', 'app/global-error.tsx'],
    scope: ROOT_CHROME_SCOPE,
  },
  {
    name: 'the marketing site',
    entries: files(['app/(marketing)/**/page.tsx', 'app/(marketing)/**/layout.tsx']),
    scope: MARKETING_SCOPE,
  },
  {
    name: 'sign-in and sign-up',
    entries: files(['app/(auth)/**/page.tsx', 'app/(auth)/**/layout.tsx']),
    scope: AUTH_SCOPE,
  },
  {
    name: 'the public link surfaces (gift, join, pay, reviews, offline)',
    entries: files(['app/gift/**/page.tsx', 'app/join/**/page.tsx', 'app/pay/**/page.tsx', 'app/reviews/**/page.tsx', 'app/offline/**/page.tsx']),
    scope: PUBLIC_LINK_SCOPE,
  },
];

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
    // The ratio was /50, against a marketing scope of about 2 KB. That number
    // was never honest: the scope was missing the entire marketing LAYOUT —
    // skip link, header, nav, consent manager — because the entry glob matched
    // no file at all, and the surface rendered correctly only because
    // `translate` fell back to the whole English catalogue. A complete scope is
    // ~27 KB, still a 30x reduction on ~814 KB, and it is the size the page
    // actually needs rather than the size it appeared to need while something
    // else was quietly paying.
    //
    // Assert the order of magnitude, not an exact number, so adding marketing
    // strings is allowed — but keep it tight enough that pulling in an
    // authenticated-app namespace by accident still fails here.
    expect(marketing).toBeLessThan(full / 25);
  });

  it('leaves the authenticated app whole', () => {
    // Not a scope: 'all' must stay the escape hatch, because 96 non-literal
    // t() call sites in that surface cannot be resolved statically.
    expect(scopeMessages(messages, ['login'])).not.toEqual(messages);
    expect(Object.keys(messages).length).toBeGreaterThan(10_000);
  });
});
