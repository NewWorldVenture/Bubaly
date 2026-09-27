import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The signed-in phone crawl's second pass found the same failure on page after
// page: body copy in text-muted at 60% or 70% opacity, 3.33:1 and 4.15:1 on the
// dark surface, under WCAG AA's 4.5:1 ("Upload your first file to get
// started.", "All clear — nothing needs attention.", "13 guided steps"). Full
// text-muted clears it. So a text element — a lowercase tag whose own text is
// what the class colours — does not fade text-muted below full strength.
//
// Icons (capitalised components such as <ChevronRight>) are not text and keep
// their dimming. The global sidebar (app-shell's nav and free-tier-sidebar) is
// left exactly as it is: it is not shown at phone width, and it is changed only
// on the owner's word.
const LEFT_ALONE = new Set([join('components', 'app', 'app-shell.tsx'), join('components', 'app', 'free-tier-sidebar.tsx')]);
const TEXT_ELEMENT = /<(p|span|li|h[1-6]|code|label|div|time|dd|dt|small|em)\b[^<>]*?className="([^"]*?)"/g;
const FADED = /(?<![:\w-])text-muted\/(\d+)\b/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('faint text still reads', () => {
  const sources = [...files('app'), ...files('components')].filter((f) => !LEFT_ALONE.has(f));

  it('no text element draws text-muted below full strength', () => {
    const faded = sources.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
      [...line.matchAll(TEXT_ELEMENT)].flatMap((m) => [...m[2].matchAll(FADED)]
        .filter((f) => Number(f[1]) <= 80)
        .map((f) => `${file}:${i + 1} <${m[1]}> ${f[0]}`))));
    expect(faded).toEqual([]);
  });

  it('would catch the shapes the crawl found, and not an icon', () => {
    const line = '<p className="mt-2 text-sm text-muted/60">{text}</p><ChevronRight className="h-4 w-4 text-muted/50" />';
    const found = [...line.matchAll(TEXT_ELEMENT)].flatMap((m) => [...m[2].matchAll(FADED)].map((f) => f[0]));
    expect(found).toEqual(['text-muted/60']);
  });
});
