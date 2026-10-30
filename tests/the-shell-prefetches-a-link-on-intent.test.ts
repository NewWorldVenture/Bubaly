import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// PERF-001. The app shell's own links are on screen on every page, and a Next
// <Link> prefetches every link on screen: over ten member pages, 40 prefetch
// requests a page load on average, each one through middleware.ts's Supabase
// Auth getUser() and App Lock read. The shell's links became IntentLinks
// (components/ui/intent-link.tsx), which prefetch on hover, focus or touch, and
// the same ten pages caused 1,962 database statements instead of 4,396.
//
// tests/e2e/the-shell-prefetches-a-link-on-intent.spec.ts holds the behaviour
// in a browser. This holds which links are which, so a Link put back in the
// shell is caught without one.

const src = (path: string) => readFileSync(path, 'utf8');
const links = (source: string) => source.match(/<Link\s/g)?.length ?? 0;

describe('the shell prefetches a link on intent, not on sight', () => {
  it('draws the sidebar, the bell and the logo with IntentLinks only', () => {
    for (const file of ['components/app/nav-shared.tsx', 'components/app/notification-bell.tsx', 'components/brand/logo.tsx']) {
      const source = src(file);
      expect(links(source), file).toBe(0);
      expect(source, file).not.toContain("from 'next/link'");
      expect(source, file).toContain("import { IntentLink } from '@/components/ui/intent-link';");
    }
  });

  it("keeps the app shell's Links to its two menus, drawn only while one is open", () => {
    const shell = src('components/app/app-shell.tsx');
    const menus = [
      shell.slice(shell.indexOf('function FamilySwitcher('), shell.indexOf('function UserMenu(')),
      shell.slice(shell.indexOf('function UserMenu('), shell.indexOf('function SidebarDashboardLinks(')),
    ];
    for (const menu of menus) {
      expect(menu.indexOf('{open && (')).toBeGreaterThan(0);
      expect(menu.indexOf('<Link')).toBeGreaterThan(menu.indexOf('{open && ('));
    }
    expect(links(menus.reduce((rest, menu) => rest.replace(menu, ''), shell))).toBe(0);
    // The top bar's logo and share-an-idea links, and the phone's tab bar.
    expect(shell).toContain('<IntentLink href="/home" aria-label={t(\'nav.home\')} className="lg:hidden">');
    expect(shell).toContain('<IntentLink href="/feedback" aria-label={t(\'shell.shareIdea\')}');
    expect(shell).toContain('<IntentLink key={item.href} href={item.href} className={tabClass}>');
  });

  it('an IntentLink waits for a hover, focus or touch, and then prefetches as a Link does', () => {
    const link = src('components/ui/intent-link.tsx');
    // No prefetch of its own: a caller cannot put viewport prefetching back.
    expect(link).toContain("Omit<ComponentProps<typeof Link>, 'prefetch'>");
    // false until intent, then Next's default.
    expect(link).toContain('prefetch={intent ? null : false}');
    for (const handler of ['onMouseEnter', 'onFocus', 'onTouchStart']) {
      expect(link).toContain(`${handler}={(e) => { setIntent(true); ${handler}?.(e); }}`);
    }
  });
});
