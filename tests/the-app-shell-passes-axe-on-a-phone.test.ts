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
    expect(shell).toContain('<IntentLink href="/home" aria-label={t(\'nav.home\')} className="lg:hidden">');
  });

  // The admin area has a top bar of its own (components/admin/admin-shell.tsx),
  // and the re-crawl found the same nameless logo link on all 79 /admin pages
  // after the app shell's was fixed. Any link whose only content is the logo
  // mark is held to it, wherever it is drawn, an IntentLink (a Link that
  // prefetches on intent) as much as a Link.
  it('names every link whose only content is the logo mark', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
    });
    const bare = [...files('app'), ...files('components')].flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/<((?:Intent)?Link)\b([^>]*)>\s*<LogoMark\b[^>]*\/>\s*<\/\1>/g)]
        .filter((m) => !/aria-label=/.test(m[2]))
        .map((m) => `${file}: <${m[1]}${m[2]}>`));
    expect(bare).toEqual([]);
  });

  // The admin console's axe sweep at 1,280 px found the sidebar's two links
  // back to the family app 16 px tall and 20 px apart on all 79 /admin pages
  // (target-size, WCAG 2.5.8). Each is 24 px tall now.
  it("makes the admin sidebar's links back to the family app 24 px targets", () => {
    const shell = readFileSync('components/admin/admin-shell.tsx', 'utf8');
    for (const href of ['/dashboard/briefing', '/dashboard']) {
      expect(shell).toContain(`<Link href="${href}" className="flex min-h-6 items-center gap-1.5 px-1 text-xs text-muted hover:text-fg">`);
    }
  });

  it("draws the marketing section's group labels at full muted strength", () => {
    const subnav = readFileSync('app/(app)/admin/marketing/marketing-subnav.tsx', 'utf8');
    expect(subnav).toContain('uppercase tracking-wider text-muted sm:w-32');
    expect(subnav).not.toContain('text-muted/70 sm:w-32');
  });
});
