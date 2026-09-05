'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { MARKETING_NAV } from '@/lib/constants/navigation';
import { cn } from '@/lib/utils/cn';

export function SiteHeader() {
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
      className="sticky top-0 z-50 border-b border-border/70 bg-bg/95 text-fg backdrop-blur-xl transition-colors duration-300"
    >
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
        <Logo className="[&>img]:h-11" />

        <nav aria-label="Main navigation" className="hidden h-full items-center gap-7 lg:flex">
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
              {item.label}
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
            Get started
          </Link>
          <Link href="/login" className="hidden h-8 items-center px-3 text-[10px] font-medium text-muted transition hover:text-fg coarse:min-h-11 sm:inline-flex">
            Log in
          </Link>
          <Link href="/welcome" className="hidden h-8 items-center rounded-full bg-gradient-to-r from-blue-500 to-violet-600 px-5 text-[10px] font-semibold text-brand-fg shadow-glow transition hover:brightness-110 coarse:min-h-11 sm:inline-flex">
            Get Started Free
          </Link>
          <button
            ref={menuButtonRef}
            type="button"
            disabled={!ready}
            className="inline-flex items-center justify-center rounded-lg p-2 text-fg coarse:min-h-11 coarse:min-w-11 lg:hidden focus-visible:focus-ring"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={open}
            aria-controls="mobile-navigation"
          >
            {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

        <div id="mobile-navigation" hidden={!open} className="max-h-[calc(100dvh-3.5rem)] overflow-y-auto overscroll-contain border-t border-border/70 bg-bg/98 px-4 py-4 backdrop-blur-xl lg:hidden">
          <nav aria-label="Mobile navigation" className="flex flex-col gap-1">
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
                {item.label}
              </Link>
            ))}
            <div className="mt-3 flex gap-2">
              <Link href="/login" className="focus-visible:focus-ring inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-border bg-surface px-3 py-3 text-sm font-semibold text-fg hover:bg-elevated" onClick={() => setOpen(false)}>
                Log in
              </Link>
              <Link href="/welcome" className="focus-visible:focus-ring inline-flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-3 py-3 text-sm font-semibold text-brand-fg hover:brightness-110" onClick={() => setOpen(false)}>
                Get Started Free
              </Link>
            </div>
          </nav>
        </div>
    </header>
  );
}
