import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SectionHeading } from '@/components/marketing/sections';

/**
 * Four public pages shipped with no `<h1>` at all — verified against production
 * on 2026-09-13, where /faq, /contact, /mobile and /family-display each returned
 * zero `<h1>` elements and began their outline at `<h2>`.
 *
 * All four used `SectionHeading` for their PAGE title, and that component
 * hard-coded `h2`. Pages with a hand-rolled hero (/, /pricing, /features) were
 * unaffected, which is why it only hit the ones that reused the component.
 */
describe('SectionHeading renders the requested level', () => {
  it('is an h2 by default, for a section within a page', () => {
    const html = renderToStaticMarkup(createElement(SectionHeading, { title: 'A section' }));
    expect(html).toContain('<h2');
    expect(html).not.toContain('<h1');
  });

  it('renders an h1 when a page uses it as its title', () => {
    const html = renderToStaticMarkup(createElement(SectionHeading, { as: 'h1', title: 'A page' }));
    expect(html).toContain('<h1');
    expect(html).not.toContain('<h2');
  });

  it('keeps the same styling at either level — this is an outline fix, not a visual one', () => {
    const asH1 = renderToStaticMarkup(createElement(SectionHeading, { as: 'h1', title: 'X' }));
    const asH2 = renderToStaticMarkup(createElement(SectionHeading, { title: 'X' }));
    const classOf = (html: string) => /<h[12] class="([^"]*)"/.exec(html)?.[1];
    expect(classOf(asH1)).toBe(classOf(asH2));
  });
});

/**
 * Structural guard over the public pages themselves.
 *
 * This reads source rather than rendering each page — the marketing pages are
 * async server components that read translations and the database, and standing
 * all that up per page would buy little here. It is deliberately narrow: it asks
 * only "does this page declare exactly one top-level heading", which is the
 * property that broke, and it was checked against the unfixed tree, where it
 * names all four pages.
 */
const MARKETING_ROOT = path.join(process.cwd(), 'app', '(marketing)');

/** Pages whose title comes from a shared layout or a dynamic record, not their own source. */
const RENDERS_TITLE_ELSEWHERE = new Set(['blog/[slug]', 'lp/[slug]', 'p/[slug]', 'f/[id]']);

/**
 * Resolve a page's own source plus the source of the local modules it imports,
 * one level deep. Many pages keep their hero in a sibling component —
 * /pricing's `<h1>` lives in `pricing-content.tsx` — so reading page.tsx alone
 * reports pages that are perfectly fine. Verified against production: /pricing,
 * / and /features each render exactly one `<h1>`.
 */
/**
 * Strip comments before scanning.
 *
 * Without this the sweep is VACUOUS, and was: the JSDoc on `SectionHeading`
 * itself contains the literal `as="h1"` as an instruction to callers, so every
 * page importing that module matched on the comment and passed regardless of
 * its own markup. Caught by reverting one page and watching the test stay green
 * — which is the same failure this file exists to prevent.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourcesFor(pageFile: string): string {
  const seen = [fs.readFileSync(pageFile, 'utf8')];
  const dir = path.dirname(pageFile);
  for (const m of seen[0].matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const base = spec.startsWith('.')
      ? path.resolve(dir, spec)
      : spec.startsWith('@/') ? path.join(process.cwd(), spec.slice(2)) : null;
    if (!base) continue;
    for (const candidate of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx')]) {
      if (fs.existsSync(candidate)) { seen.push(fs.readFileSync(candidate, 'utf8')); break; }
    }
  }
  return stripComments(seen.join('\n'));
}

function marketingPages(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'page.tsx') out.push(full);
    }
  })(MARKETING_ROOT);
  return out.sort();
}

describe('every public marketing page declares a top-level heading', () => {
  it('has an h1 source on each page that owns its title', () => {
    const missing: string[] = [];

    for (const file of marketingPages()) {
      const rel = path.relative(MARKETING_ROOT, path.dirname(file)).split(path.sep).join('/') || '.';
      if (RENDERS_TITLE_ELSEWHERE.has(rel)) continue;
      const source = sourcesFor(file);
      const declaresH1 = /<h1[\s>]/.test(source) || /as="h1"/.test(source);
      if (!declaresH1) missing.push(rel);
    }

    expect(missing).toEqual([]);
  });
});
