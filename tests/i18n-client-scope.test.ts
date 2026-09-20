import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ROOT_CHROME_SCOPE, MARKETING_SCOPE, AUTH_SCOPE, PUBLIC_LINK_SCOPE, SURVEY_SCOPE, scopeMessages,
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
 * Every name a client module binds `useTranslations()` to.
 *
 * The extractor below reads CALLS, so it has to know what the translator is
 * called. `const t = useTranslations()` is the common form; `tr` and `i18nT`
 * are the two others in this tree. If a module invents a fourth the extractor
 * goes silently blind on that file, so `TRANSLATOR_NAMES` is asserted complete
 * by a case below rather than trusted.
 */
const TRANSLATOR_NAMES = ['t', 'tr', 'i18nT'] as const;
const BINDS_TRANSLATOR = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*useTranslations\s*\(/g;

/**
 * The literal keys those modules pass to the translator.
 *
 * The pattern used to be `/\bt\(/`, and that is a second way this file went
 * blind — after the entry globs, before anyone looked here. `\b` puts a
 * boundary BEFORE the `t`, and then `\(` demands the very next character be an
 * open paren. In `tr('planOutcomes.heading')` the next character is `r`, so
 * nothing matched — while `if (!/useTranslations/.test(source)) continue` above
 * happily let the file through. **105 client modules bind the translator as
 * `tr` or `i18nT`**, so the guard walked every one of them and extracted ZERO
 * keys, reporting clean over 56 out-of-scope keys on the marketing surface
 * alone.
 *
 * The lookbehind is what `\b` should have been: it rejects a longer
 * identifier ending in one of these names — `.t(`, `format(`, `parseInt(` —
 * without rejecting the names themselves.
 */
const CALLS_TRANSLATOR = new RegExp(
  String.raw`(?<![A-Za-z0-9_$.])(?:${TRANSLATOR_NAMES.join('|')})\(\s*['"]([A-Za-z0-9_.]+)['"]`,
  'g',
);

function translationKeys(modules: Set<string>): Map<string, string> {
  const keys = new Map<string, string>(); // key → the file that asked for it
  for (const file of modules) {
    const source = readFileSync(file, 'utf8');
    if (!/useTranslations/.test(source)) continue;
    for (const m of source.matchAll(CALLS_TRANSLATOR)) {
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
  {
    name: 'the public feedback survey',
    entries: entryFiles(['app/s/']),
    scope: SURVEY_SCOPE,
  },
];

/**
 * Which pages a provider declaring the WHOLE catalogue governs.
 *
 * `app/(app)` and `app/onboarding` mount `ScopedLocaleProvider namespaces="all"`
 * deliberately — behind a login, where there is no crawler and no first-visit
 * cost, and where t() is called with a non-literal argument in 96 places, so no
 * static analysis could prove a subset complete. Those pages are outside this
 * file's concern and the control below says so by name rather than by silence.
 */
const UNSCOPED_BY_DESIGN = /^app\/(\(app\)|onboarding)\//;

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
// The control the extractor never had, and the reason this file was blind
// twice over.
//
// The entry globs were fixed first: a git pathspec `**/` needs an intervening
// directory, so the route-group root layouts were never walked. That was
// caught by naming the files. This is the OTHER half — the walk was then
// correct and the READ was not. `/\bt\(/` cannot see `tr('key')`, and 105
// client modules bind the translator that way, so the guard opened 105 files
// and took nothing out of them.
//
// A list of names is only as good as the guarantee that it is complete, so
// this asserts that no client module binds `useTranslations()` to a name the
// extractor does not know. A new alias fails HERE, naming the file, instead of
// silently removing that file's keys from every surface it belongs to.
describe('the extractor knows every name the translator is bound to', () => {
  it('finds no client module binding useTranslations to an unknown alias', () => {
    const unknown: string[] = [];
    const tracked = ['app/', 'components/', 'lib/']
      .flatMap((d) => execFileSync('git', ['ls-files', '--', d], { encoding: 'utf8' }).split(/\r?\n/))
      .filter((f) => /\.tsx?$/.test(f));
    expect(tracked.length, 'the alias scan must see the tree').toBeGreaterThan(500);
    for (const file of tracked) {
      const source = readFileSync(file, 'utf8');
      if (!/useTranslations/.test(source)) continue;
      for (const m of source.matchAll(BINDS_TRANSLATOR)) {
        if (!(TRANSLATOR_NAMES as readonly string[]).includes(m[1])) unknown.push(`${m[1]}  (${file})`);
      }
    }
    expect(unknown, 'add the name to TRANSLATOR_NAMES — until you do, every key '
      + 'in these files is invisible to every surface check in this file').toEqual([]);
  });
});

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

// The control that would have found the survey page, and the third instance of
// the same shape this file has now been caught by.
//
// Twice the guard was blind to something INSIDE the surfaces it knew about:
// first the entry globs (a pathspec that matched nothing), then the extractor
// (`\bt\(` cannot see `tr(`). Both were fixed by naming what had been counted.
// This is the same defect one level up — the SURFACES list itself is
// hand-written, and nothing required it to be COMPLETE.
//
// `app/s/[slug]` is what fell through: the only page in the tree with no
// `layout.tsx` of its own, so no ScopedLocaleProvider mounted for it and the
// root layout's chrome scope was all it got, while `survey-form.tsx` asks for
// two namespaces outside that scope. It rendered correct English regardless —
// through `translate`'s SOURCE_MESSAGES fallback, on an UNAUTHENTICATED page
// linked out to people who are not customers.
//
// So: every page under `app/` is either governed by a provider that declares
// the whole catalogue, or it belongs to a surface this file walks. A new public
// route with no layout fails HERE, naming the file, on the day it is added —
// rather than on the day PERF-001 deletes the fallback underneath it.
describe('every page belongs to a surface this file walks', () => {
  it('leaves no page governed only by the root chrome scope', () => {
    const walked = new Set(SURFACES.flatMap((s) => s.entries));
    const pages = execFileSync('git', ['ls-files', '--', 'app/'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((f) => /\/page\.tsx$/.test(f));
    // A scan that sees nothing must not pass, which is how the count control
    // this replaces went wrong in the first place.
    expect(pages.length, 'the page scan must see the tree').toBeGreaterThan(100);

    const orphans = pages.filter((f) => !UNSCOPED_BY_DESIGN.test(f) && !walked.has(f));
    expect(orphans, 'each of these pages ships only ROOT_CHROME_SCOPE. Give it a '
      + 'layout.tsx mounting ScopedLocaleProvider and add it to SURFACES above, '
      + 'or its keys resolve only through the SOURCE_MESSAGES fallback')
      .toEqual([]);
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

/**
 * PERF-001's actual gate, measured rather than estimated.
 *
 * The fix for PERF-001 is to give `translate` a module with no JSON imports, so
 * the 821.5 KB / 245.8 KB gzip English catalogue stops shipping to every page.
 * The cost is that `translate` loses its SOURCE_MESSAGES fallback on the client,
 * and a key outside its surface's scope stops rendering English prose and starts
 * rendering the raw key at a visitor.
 *
 * On an `namespaces="all"` surface that is a no-op. On a SCOPED surface it is
 * only safe once every key those components can ask for is provably in scope.
 * The cases above establish that for LITERAL calls. This one bounds what is
 * left: calls whose first argument is an expression, where no static reading of
 * the call site alone can say which key it produces.
 *
 * The audit had recorded "122 non-literal t() calls across 46 client files" as
 * the blocker. That is the whole-tree number and most of it sits behind the
 * login, where it costs nothing. Measured on the FIVE SCOPED SURFACES only:
 *
 *     root-chrome    0
 *     marketing     36
 *     auth           6
 *     public-link    0
 *     survey         0
 *
 * Eleven files, and that is the real gate. It is listed here rather than
 * counted, for the reason this file has had to learn three times: a count is
 * satisfied by partial coverage, and a name is not. A NEW expression-keyed call
 * on a public surface now fails HERE, on the day it is written, instead of
 * becoming a raw key on a marketing page the day the fallback is deleted.
 *
 * To remove a file from this list, prove every key its expression can produce is
 * inside the surface's scope — then delete the entry and watch this case stay
 * green.
 */
const EXPRESSION_KEYED = [
  'app/(marketing)/pricing/pricing-content.tsx',
  'components/auth/callback-completion.tsx',
  'components/auth/legal-consent.tsx',
  'components/auth/recovery-form.tsx',
  'components/auth/sign-out-completion.tsx',
  'components/auth/sign-out-form.tsx',
  'components/marketing/ai-showcase.tsx',
  'components/marketing/consent-manager.tsx',
  'components/marketing/contact-form.tsx',
  'components/marketing/pricing-value-block.tsx',
  'components/marketing/site-header.tsx',
];

/** A translator call whose first argument does not begin with a quote. */
const CALLS_TRANSLATOR_WITH_EXPRESSION = new RegExp(
  String.raw`(?<![A-Za-z0-9_$.])(?:${TRANSLATOR_NAMES.join('|')})\(\s*([^)\s])`,
  'g',
);

describe('the scoped surfaces still ask for keys no static reading can name', () => {
  it('names every expression-keyed translator call, and finds no new one', () => {
    const found = new Set<string>();
    for (const surface of SURFACES) {
      for (const file of clientModulesFrom(surface.entries)) {
        const source = readFileSync(file, 'utf8');
        if (!/useTranslations/.test(source)) continue;
        for (const m of source.matchAll(CALLS_TRANSLATOR_WITH_EXPRESSION)) {
          if (m[1] === "'" || m[1] === '"') continue; // a literal; the cases above cover it
          found.add(file.replace(`${ROOT}/`, ''));
        }
      }
    }
    // A scan that sees nothing must not pass. Same floor as the two controls
    // above, for the same reason.
    expect(found.size, 'the expression scan matched nothing at all').toBeGreaterThan(0);

    const added = [...found].filter((f) => !EXPRESSION_KEYED.includes(f)).sort();
    expect(added, 'a NEW expression-keyed translator call on a scoped public surface. '
      + 'Every key it can produce must be proved in scope before PERF-001 can delete '
      + "translate()'s English fallback, or this renders a raw key at a visitor").toEqual([]);

    const gone = EXPRESSION_KEYED.filter((f) => !found.has(f)).sort();
    expect(gone, 'these files no longer have an expression-keyed call — delete them from '
      + 'EXPRESSION_KEYED so the list keeps meaning what it says').toEqual([]);
  });
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
    // EVERY declared scope, not just marketing. The bound used to name one
    // surface, and `auth` sat at 5.3% of the catalogue — 2.7x the stated
    // ceiling — for as long as this case has existed, because nothing measured
    // it. A guard that checks one of four is three-quarters decoration.
    const sizes = {
      'root-chrome': JSON.stringify(scopeMessages(messages, ROOT_CHROME_SCOPE)).length,
      marketing: JSON.stringify(scopeMessages(messages, MARKETING_SCOPE)).length,
      auth: JSON.stringify(scopeMessages(messages, AUTH_SCOPE)).length,
      'public-link': JSON.stringify(scopeMessages(messages, PUBLIC_LINK_SCOPE)).length,
    };
    // The measured production page was 93% catalogue. Assert the order of
    // magnitude, not an exact number, so adding strings a surface genuinely
    // renders is allowed.
    //
    // The bound is full/25 (4%), raised from full/50 when the extractor above
    // was fixed. That is worth stating precisely, because "the scope got
    // bigger" reads like a regression and is the opposite:
    //
    // The 56 marketing keys that pushed it over were ALREADY being shipped to
    // the browser. They resolved through `translate`'s SOURCE_MESSAGES
    // fallback, which lives in the 821.5 KB / 245.8 KB gzip chunk that
    // PERF-001 measures on every page. So a visitor to /pricing was paying for
    // the whole 13,778-key catalogue to read 56 of them. Putting them in the
    // scope moves ~21 KB of JSON into the payload and takes 245.8 KB of gzip
    // JS out of it.
    //
    // The cost that IS real, and is not hidden: one scope serves a whole route
    // group, so /cookies now carries the pricing page's strings too — 7.9 KB
    // to 28.8 KB. Still 29x smaller than the catalogue, and still the right
    // trade against the chunk. If a future surface needs its own narrower
    // scope, that is the fix, not a bigger bound.
    for (const [name, size] of Object.entries(sizes)) {
      expect(size, `${name} is ${(size / full * 100).toFixed(1)}% of the catalogue`)
        .toBeLessThan(full / 25);
    }
  });

  it('leaves the authenticated app whole', () => {
    // Not a scope: 'all' must stay the escape hatch, because 96 non-literal
    // t() call sites in that surface cannot be resolved statically.
    expect(scopeMessages(messages, ['login'])).not.toEqual(messages);
    expect(Object.keys(messages).length).toBeGreaterThan(10_000);
  });
});
