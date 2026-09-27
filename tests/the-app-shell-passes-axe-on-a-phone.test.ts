import { readFileSync } from 'node:fs';
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

  it("draws the marketing section's group labels at full muted strength", () => {
    const subnav = readFileSync('app/(app)/admin/marketing/marketing-subnav.tsx', 'utf8');
    expect(subnav).toContain('uppercase tracking-wider text-muted sm:w-32');
    expect(subnav).not.toContain('text-muted/70 sm:w-32');
  });
});
