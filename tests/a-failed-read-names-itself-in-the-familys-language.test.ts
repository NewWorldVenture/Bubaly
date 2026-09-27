// A failed read names itself in the family's language — and the operator's in English.
//
// Four family-facing pages degrade rather than blank when a table is missing,
// and each says WHICH read is gone. The naming is the right call: on production
// the answer is usually one table the migration ledger has not reached, and
// "something failed" would not say which. But every name was an English literal
// lifted from the source — `'member profiles'`, `'meal plans'`, and on Calm the
// table's own shorthand, `'foi'`, which is not a word in any language.
//
// ── WHY THEY STAYED ENGLISH, AND WHAT ACTUALLY FIXED IT ──────────────────────
//
// The audit had already looked at these and declined to convert them, for a
// reason worth keeping: each line was built as `${label}: ${describeReadError()}`,
// and the second half is a PostgREST string nothing can translate. Translating
// the first half alone produces
//
//     Mitgliederprofile: relation "guardian_member_profiles" does not exist
//
// — one sentence, half in the reader's language and half in Postgres's, which is
// worse than either end. That is true, and it is an argument against joining the
// two halves, not against translating the first one. So the join is gone: the
// banner now takes `{ label, detail }` and renders the detail as <code>, which
// says "the machine is talking now" in no language at all.
//
// ── THE OPERATOR HALF IS A DECISION, NOT AN OVERSIGHT ────────────────────────
//
// Five more pages build the same diagnostic and are NOT converted: admin/,
// admin/reports/, admin/wallet/, admin/system/ and admin/users/. Every one is
// behind app/(app)/admin/layout.tsx, which redirects anyone who is not a super
// admin, so no parent and no child can reach them. Their banners are evidence
// for whoever is holding the pager, and evidence reads better in one language
// than in the reader's.
//
// That decision is only honest while it stays true, which is what the last case
// checks: an English joined diagnostic is allowed to exist ONLY on a page behind
// the super-admin gate. Move one of those pages out from behind the gate, or add
// a joined English diagnostic to a family page, and this fails by name.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { LOCALES } from '@/lib/i18n/locales';
import { getRawMessages, PLACEHOLDER_LOCALES, SOURCE_MESSAGES } from '@/lib/i18n/messages';

/** The pages a family can reach that degrade behind a PartialReadBanner. */
const FAMILY_PAGES = [
  'app/(app)/dashboard/activity/page.tsx',
  'app/(app)/dashboard/calm/page.tsx',
  'app/(app)/dashboard/command-center/page.tsx',
  'app/(app)/guardian/page.tsx',
];

/** The operator pages that keep the English joined form, on purpose. */
const OPERATOR_PAGES = [
  'app/(app)/admin/page.tsx',
  'app/(app)/admin/reports/page.tsx',
  'app/(app)/admin/system/page.tsx',
  'app/(app)/admin/users/page.tsx',
  'app/(app)/admin/wallet/page.tsx',
];

const sourceFiles = () =>
  execSync("git ls-files 'app/**/*.ts' 'app/**/*.tsx'", { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const read = (file: string) => readFileSync(file, 'utf8');

/**
 * A diagnostic that INTERPOLATES a name in front of a Postgres reason — the
 * half-translated shape, in either of its two wordings (`${label}: …` on five
 * pages, `Could not load “${label}”: …` on admin/users).
 */
const JOINED_DIAGNOSTIC = /\$\{[A-Za-z_][A-Za-z0-9_]*\}[^`]*\$\{describeReadError\(/;

/** The entries of a page's `readFailures` table, as written. */
function failureLabels(source: string): string[] {
  const block = source.match(/const readFailures = \(\[([\s\S]*?)\] as const\)/);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*\[([^,]+),/gm)].map((m) => m[1].trim());
}

/** Which of `keys` a locale's own catalogue does not carry. */
const missingFrom = (locale: string, keys: string[]) =>
  keys.filter((key) => !(key in getRawMessages(locale as never)));

describe('a failed read names itself in the family\'s language', () => {
  // Non-vacuity, and a review gate. Every page a family can reach that renders
  // this banner is listed above; a new one has to be added here deliberately,
  // which is the moment to decide whether its labels are translated.
  it('finds every family-facing page that renders the banner', () => {
    const withBanner = sourceFiles().filter(
      (file) => file.endsWith('.tsx') && read(file).includes('PartialReadBanner'),
    );
    const family = withBanner.filter((file) => !file.startsWith('app/(app)/admin/')).sort();
    expect(
      family,
      'A page outside /admin now renders a PartialReadBanner. Decide whether its '
        + 'read-failure labels are family-facing (translate them, and add it here) '
        + 'or operator evidence (say so, and gate it).',
    ).toEqual(FAMILY_PAGES);
  });

  it.each(FAMILY_PAGES)('%s names its failed reads from the catalogue', (file) => {
    const labels = failureLabels(read(file));
    // Non-vacuity: a page whose table this parser could not find would pass
    // every assertion below on an empty list.
    expect(labels.length, `no readFailures table parsed out of ${file}`).toBeGreaterThanOrEqual(5);
    for (const label of labels) {
      expect(label, `${file} still names a read with a literal`).toMatch(
        /^t\('[A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9]+'\)$/,
      );
    }
  });

  it.each(FAMILY_PAGES)('%s hands the banner two fields, not one sentence', (file) => {
    const source = read(file);
    expect(source).toMatch(/\.map\(\(\[label, (?:res|error)\]\) => \(\{ label, detail: describeReadError\(/);
    expect(
      source.match(JOINED_DIAGNOSTIC),
      `${file} joins a translated label onto an untranslatable Postgres string`,
    ).toBeNull();
    // The banner's own title is the page's prose and is translated too.
    expect(source, `${file} hardcodes its banner title`).toMatch(
      /<PartialReadBanner[\s\S]{0,160}?title=\{t\('[^']+'\)\}/,
    );
  });

  it('carries every key those pages ask for, in every locale declared complete', () => {
    const keys = new Set<string>();
    for (const file of FAMILY_PAGES) {
      const source = read(file);
      for (const label of failureLabels(source)) keys.add(label.slice(3, -2));
      const title = source.match(/<PartialReadBanner[\s\S]{0,160}?title=\{t\('([^']+)'\)\}/);
      if (title) keys.add(title[1]);
    }
    const asked = [...keys].sort();
    expect(asked.length, 'no keys were collected — the parser above went blind').toBeGreaterThanOrEqual(25);

    expect(missingFrom('en-US', asked), 'missing from the source catalogue').toEqual([]);
    const complete = LOCALES.map((l) => l.code).filter((code) => !PLACEHOLDER_LOCALES.includes(code));
    for (const locale of complete) {
      expect(
        missingFrom(locale, asked),
        `${locale} is a complete catalogue and these read-failure names never reached it`,
      ).toEqual([]);
    }
  });

  // Positive control for the check above: with the catalogues at parity, an
  // empty result is also what a broken lookup returns. Plant a key that is not
  // there and require every complete locale to report it.
  it('reports a key that is genuinely absent', () => {
    const planted = 'guardian.aKeyNoCatalogueHasEverHeldXyzzy';
    expect(planted in SOURCE_MESSAGES).toBe(false);
    for (const locale of ['en-US', 'de-DE', 'pt-PT']) {
      expect(missingFrom(locale, [planted])).toEqual([planted]);
    }
  });

  it('renders the name as prose and the Postgres reason as machine output', () => {
    const html = renderToStaticMarkup(
      createElement(PartialReadBanner, {
        title: 'Ein Teil dieser Ansicht konnte nicht geladen werden:',
        failures: [{ label: 'Mitgliederprofile', detail: 'permission denied for relation' }],
      }),
    );
    expect(html).toContain('Mitgliederprofile');
    expect(html).toContain('permission denied for relation');
    expect(html).toContain('<code');
    // The half-translated sentence is the thing this row was about. It must not
    // reassemble itself in the markup.
    expect(html).not.toContain('Mitgliederprofile: permission denied');
  });

  it('still renders an operator failure as the plain English line it is', () => {
    const html = renderToStaticMarkup(
      createElement(PartialReadBanner, {
        title: 'System overview is incomplete — some reads failed:',
        failures: ['profiles: permission denied for relation'],
      }),
    );
    expect(html).toContain('profiles: permission denied for relation');
    expect(html).not.toContain('<code');
  });

  // The decision, checked rather than asserted. An English diagnostic that
  // interpolates a Postgres reason is allowed — on a page no family can open.
  it('leaves the joined English form only behind the super-admin gate', () => {
    const joined = sourceFiles().filter((file) => JOINED_DIAGNOSTIC.test(read(file))).sort();
    expect(
      joined,
      'A joined `${label}: ${describeReadError()}` diagnostic exists somewhere new. '
        + 'On a family page it must become { label, detail } with a t() label; on an '
        + 'operator page, add it here.',
    ).toEqual(OPERATOR_PAGES);

    const layout = read('app/(app)/admin/layout.tsx');
    expect(layout).toContain('isSuperAdmin');
    expect(
      layout,
      'the English admin diagnostics are justified by this redirect — without it a '
        + 'family can reach them',
    ).toMatch(/if \(!superAdmin\) redirect\('\/dashboard'\)/);
  });
});
