// Page audit — a page title does not carry the brand the root template adds.
//
// app/layout.tsx formats every page title with `template: '%s · Bubaly'`. A
// page whose own title already ended in the brand therefore shipped it twice:
// the crawl of www.bubaly.com on 2026-09-27 read "Send a gift · Bubaly · Bubaly",
// "Reviews · Bubaly · Bubaly" and "Share your feedback · Bubaly · Bubaly" on
// public pages, and 64 signed-in pages ("Smart Kitchen | Bubaly · Bubaly",
// "Deals · Marketplace | Bubaly · Bubaly", ...) carried the same literal.
// titleWithoutDoubledBrand (lib/marketing/seo.ts) already fixed the SEO-store
// titles; these were static `metadata` literals it never sees.
//
// A title that means to replace the template says so with `absolute`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...pages(p));
    else if (/^(page|layout)\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

// The page's own `title:` — a string literal directly under `metadata`, not
// `absolute:` and not an openGraph/twitter title (those are not templated).
const OWN_TITLE = /export const metadata(?::\s*Metadata)?\s*=\s*\{\s*title:\s*(['"`])((?:(?!\1).)*)\1/s;
const ENDS_IN_BRAND = /(?:^|[\s·|—–:-])Bubaly\s*$/i;

describe('page titles leave the brand to the template', () => {
  const files = pages('app').filter((f) => f !== join('app', 'layout.tsx'));

  it('found the pages it checks', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('no static page title ends in the brand', () => {
    const doubled = files.flatMap((file) => {
      const m = OWN_TITLE.exec(readFileSync(file, 'utf8'));
      return m && ENDS_IN_BRAND.test(m[2]) ? [`${file}: '${m[2]}'`] : [];
    });
    expect(doubled).toEqual([]);
  });

  // generateMetadata builds its title at request time, so the literal above
  // never sees it: `${t('filesHubModule.cloudTitle')} | Bubaly` read "Cloud
  // Storage | Bubaly · Bubaly" in the signed-in sweep. Any returned `title:`
  // template or string that ends in the brand is the same defect.
  it('no generated page title appends the brand either', () => {
    const doubled = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/(?<!absolute:\s*)\btitle:\s*(['"`])((?:(?!\1).)*?(?:·|\||—|–|-|:)\s*Bubaly\s*)\1/g)]
        .map((m) => `${file}: ${m[2]}`));
    expect(doubled).toEqual([]);
  });

  it('the rule would catch the shapes production shipped', () => {
    for (const title of ['Send a gift · Bubaly', 'Smart Kitchen | Bubaly', 'Deals · Marketplace | Bubaly']) {
      const src = `export const metadata: Metadata = { title: '${title}' };`;
      expect(ENDS_IN_BRAND.test(OWN_TITLE.exec(src)![2])).toBe(true);
    }
    expect(ENDS_IN_BRAND.test('Meet the Bubalys')).toBe(false);
  });
});
