// Every reader of the AEO Knowledge Center renders it in the reader's language.
//
// WHY THIS EXISTS. The knowledge base is stored once, in English, because it is
// editorial content an admin maintains in /admin/marketing/aeo. Migration 0277
// added `marketing_aeo_question_translations` and `localizeAeoQuestions` to
// apply it — and MarketingAeoSection called it, so the homepage, /features,
// /how-it-works, /pricing and the rest were fine.
//
// Three other call sites read the same tables directly and never called it:
// /faq (the page whose ENTIRE SUBJECT is answers), every blog article's FAQ
// block — which also feeds its FAQPage structured data, so the English reached
// search engines as the article's schema — and the generated marketing pages
// under lib/marketing/public-pages.tsx. All three rendered a translated
// heading, translated chrome and an English accordion: exactly the
// half-translated state 0277 exists to end.
//
// Nothing in the build noticed, because each call site is correct on its own.
// The invariant is a RELATIONSHIP — read implies localize — so it is pinned
// here rather than left to whoever adds the next page.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const IGNORE_DIRS = new Set([
  'node_modules', '.next', '.git', 'out', 'dist', 'coverage',
  'test-results', 'playwright-report', 'ios', 'android', 'mobile',
  'tests', 'e2e', 'scripts', 'docs',
]);

/** The readers that return AEO questions for RENDERING. */
const READERS = /\b(?:readPublishedAeoQuestions(?:Cached)?|getPublishedAeoQuestions|readAeoQuestionsForPath(?:Cached)?|readAeoQuestionsForCategory(?:Cached)?|getAeoQuestionsForCategory)\s*\(/;

/** The module that DEFINES them is where the localizer lives, not a caller. */
const DEFINITION = join('lib', 'marketing', 'aeo.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Dot-directories are tooling, not the product. `.claude/worktrees` holds
    // whole checkouts of this repo, so walking into one reports every file in
    // it twice over — including the ones this test exists to keep fixed.
    if (entry.startsWith('.') || IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('AEO Knowledge Center localization', () => {
  const callers = walk(ROOT)
    .map((file) => ({ file: file.slice(ROOT.length + 1), source: readFileSync(file, 'utf8') }))
    .filter(({ file }) => file !== DEFINITION)
    .filter(({ source }) => READERS.test(source));

  it('has call sites to check (the regex still matches the readers)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  it('localizes at every call site', () => {
    const unlocalized = callers
      .filter(({ source }) => !source.includes('localizeAeoQuestions'))
      .map(({ file }) => file);
    expect(
      unlocalized,
      'these read the English Knowledge Center and render it without localizeAeoQuestions, '
        + 'so a reader in another language gets a translated page with an English accordion',
    ).toEqual([]);
  });
});
