'use client';

// Client because it reads the active locale through `useTranslations()`, and
// it is rendered straight from `app/(marketing)/layout.tsx` — a SERVER layout.
// Without the directive every marketing route rendered a 500 ("Attempted to
// call useTranslations() from the server"), which `next build` cannot see: the
// module graph is legal, only the render is not.
import { useTranslations } from '@/components/i18n/locale-provider';
/**
 * Skip-to-content link (WCAG 2.4.1 "Bypass Blocks"). Visually hidden until it
 * receives keyboard focus, at which point it appears top-left so keyboard and
 * screen-reader users can jump straight past the header/nav to the page's main
 * content. Must be the first focusable element in the DOM — render it at the top
 * of each layout, and give the corresponding <main> `id="main-content"`.
 */
export function SkipLink() {
  const t = useTranslations();
  return (
    <a
      href="#main-content"
      className="sr-only rounded-lg font-semibold focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:text-brand-fg focus:shadow-glow focus:outline-none focus:ring-2 focus:ring-brand/60"
    >{t('skipLink.skipToContent')}</a>
  );
}
