'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { MARKETING_NAV } from '@/lib/constants/navigation';
import { cn } from '@/lib/utils/cn';

export function SiteHeader() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const pathname = usePathname();
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    // Do not accept an early interaction before hydration and mount effects settle.
    setReady(true);
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !headerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header
      ref={headerRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      // `sticky top-0` pins the header to the viewport's top edge — and with
      // `viewport-fit=cover` plus the black-translucent status bar (app/layout.tsx
      // `appleWebApp.statusBarStyle`), that edge is UNDERNEATH the iOS status bar.
      // The header did stay put; it stayed put behind the clock and the battery,
      // with its logo clipped by the notch, which reads as a header that slid up
      // and vanished. Padding by the top inset makes "the top" mean below the
      // status bar. `.app-topbar` already does this for the authenticated chrome
      // (app/globals.css) — the marketing header was the one that never got it.
      // The horizontal insets cover landscape, where the notch takes a side.
      className="sticky top-0 z-50 border-b border-border/70 bg-bg/95 pl-[var(--safe-left)] pr-[var(--safe-right)] pt-[var(--safe-top)] text-fg backdrop-blur-xl transition-colors duration-300"
    >
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
        <Logo className="[&>img]:h-11" />

        <nav aria-label={t('nav.mainNavigation')} className="hidden h-full items-center gap-7 lg:flex">
          {MARKETING_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isCurrent(item.href) ? 'page' : undefined}
              className={cn(
                'focus-visible:focus-ring relative inline-flex h-full items-center text-sm font-medium text-muted transition hover:text-fg xl:text-base',
                isCurrent(item.href) && 'text-brand-text',
              )}
            >
              {t(item.labelKey)}
              {isCurrent(item.href) && (
                <span className="absolute inset-x-0 bottom-0 h-px rounded-full bg-violet-500" />
              )}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* Header controls stay compact on desktop-with-a-mouse but grow to the
              44px minimum tap target on touch (coarse pointer) — WCAG 2.5.5 / Apple HIG. */}
          <ThemeToggle className="h-8 w-8 border border-border/80 bg-surface/70 text-fg hover:bg-elevated coarse:min-h-11 coarse:min-w-11" />
          {/* Phones (< sm) hide the Log in / Get Started pills below, leaving the
              primary CTA buried inside the closed drawer. Surface a compact
              "Get started" pill next to the menu button so the homepage always
              has a visible primary action without opening a menu. Placed before
              the desktop pill so it is the first "Get started" link in DOM order. */}
          <Link href="/welcome" className="inline-flex h-8 items-center whitespace-nowrap rounded-full bg-gradient-to-r from-blue-500 to-violet-600 px-3 text-[10px] font-semibold text-brand-fg shadow-glow transition hover:brightness-110 coarse:min-h-11 sm:hidden">
            {t('marketing.getStarted')}
          </Link>
          <Link href="/login" className="hidden h-8 items-center px-3 text-[10px] font-medium text-muted transition hover:text-fg coarse:min-h-11 sm:inline-flex">
            {t('marketing.logIn')}
          </Link>
          <Link href="/welcome" className="hidden h-8 items-center rounded-full bg-gradient-to-r from-blue-500 to-violet-600 px-5 text-[10px] font-semibold text-brand-fg shadow-glow transition hover:brightness-110 coarse:min-h-11 sm:inline-flex">
            {t('marketing.getStartedFree')}
          </Link>
          <button
            ref={menuButtonRef}
            type="button"
            disabled={!ready}
            className="inline-flex items-center justify-center rounded-lg p-2 text-fg coarse:min-h-11 coarse:min-w-11 lg:hidden focus-visible:focus-ring"
            onClick={() => setOpen((v) => !v)}
            aria-label={t('nav.toggleMenu')}
            aria-expanded={open}
            aria-controls="mobile-navigation"
          >
            {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

        <div id="mobile-navigation" hidden={!open} className="max-h-[calc(100dvh-3.5rem-var(--safe-top))] overflow-y-auto overscroll-contain border-t border-border/70 bg-bg/98 px-4 py-4 backdrop-blur-xl lg:hidden">
          <nav aria-label={t('nav.mobileNavigation')} className="flex flex-col gap-1">
            {MARKETING_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isCurrent(item.href) ? 'page' : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  'focus-visible:focus-ring rounded-lg px-3 py-3 text-base text-fg hover:bg-elevated/70',
                  isCurrent(item.href) && 'bg-brand/15 text-brand-text',
                )}
              >
                {t(item.labelKey)}
              </Link>
            ))}
            <div className="mt-3 flex gap-2">
              <Link href="/login" className="focus-visible:focus-ring inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-border bg-surface px-3 py-3 text-sm font-semibold text-fg hover:bg-elevated" onClick={() => setOpen(false)}>
                {t('marketing.logIn')}
              </Link>
              <Link href="/welcome" className="focus-visible:focus-ring inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-3 py-3 text-sm font-semibold text-brand-fg hover:brightness-110" onClick={() => setOpen(false)}>
                {t('marketing.getStartedFree')}
              </Link>
            </div>
          </nav>
        </div>
    </header>
  );
}
