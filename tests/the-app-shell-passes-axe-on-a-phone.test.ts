import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Two of the signed-in phone crawl's axe failures were on every page, because
// they were in the shell: the top bar's logo link to /home had no name (an
// image-only link, axe link-name, 347 pages), and the admin marketing
// section's group labels were text-muted at 70% (4.13:1 on the dark surface,
// axe color-contrast, 40 pages). The avatar's contrast has its own test.

describe('the app shell on a phone', () => {
  it("names the top bar's logo link", () => {
    const shell = readFileSync('components/app/app-shell.tsx', 'utf8');
    expect(shell).toContain('<Link href="/home" aria-label={t(\'nav.home\')} className="lg:hidden">');
  });

  // The admin area has a top bar of its own (components/admin/admin-shell.tsx),
  // and the re-crawl found the same nameless logo link on all 79 /admin pages
  // after the app shell's was fixed. Any link whose only content is the logo
  // mark is held to it, wherever it is drawn.
  it('names every link whose only content is the logo mark', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
    });
    const bare = [...files('app'), ...files('components')].flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/<Link\b([^>]*)>\s*<LogoMark\b[^>]*\/>\s*<\/Link>/g)]
        .filter((m) => !/aria-label=/.test(m[1]))
        .map((m) => `${file}: <Link${m[1]}>`));
    expect(bare).toEqual([]);
  });

  it("draws the marketing section's group labels at full muted strength", () => {
    const subnav = readFileSync('app/(app)/admin/marketing/marketing-subnav.tsx', 'utf8');
    expect(subnav).toContain('uppercase tracking-wider text-muted sm:w-32');
    expect(subnav).not.toContain('text-muted/70 sm:w-32');
  });
});
