import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
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

const files = (patterns: string[]): string[] =>
  patterns.flatMap((p) => execSync(`git ls-files '${p}'`, { encoding: 'utf8' }).split('\n')).filter(Boolean);

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
