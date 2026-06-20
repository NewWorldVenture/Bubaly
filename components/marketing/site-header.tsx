'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { MARKETING_NAV } from '@/lib/constants/navigation';
import { cn } from '@/lib/utils/cn';

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between gap-4 px-5 sm:px-8">
        <Logo />

        <nav className="hidden h-full items-center gap-[30px] lg:flex">
          {MARKETING_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative inline-flex h-full items-center text-xs font-medium text-white/90 transition hover:text-white',
                pathname === item.href && 'text-violet-400',
              )}
            >
              {item.label}
              {pathname === item.href && (
                <span className="absolute inset-x-0 bottom-0 h-px rounded-full bg-violet-500" />
              )}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle className="h-9 w-9" />
          <Link href="/login" className="hidden h-9 items-center px-3 text-xs font-medium text-white/85 transition hover:text-white sm:inline-flex">
            Log in
          </Link>
          <Link href="/signup" className="hidden h-9 items-center rounded-full bg-gradient-to-r from-blue-500 to-violet-600 px-5 text-xs font-semibold text-white shadow-glow transition hover:brightness-110 sm:inline-flex">
            Get Started Free
          </Link>
          <button
            className="rounded-lg p-2 text-white lg:hidden focus-ring"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-border bg-bg/95 px-4 py-4 backdrop-blur-xl lg:hidden">
          <nav className="flex flex-col gap-1">
            {MARKETING_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  'rounded-lg px-3 py-3 text-base text-canvas hover:bg-elevated',
                  pathname === item.href && 'bg-violet-500/15 text-violet-300',
                )}
              >
                {item.label}
              </Link>
            ))}
            <div className="mt-3 flex gap-2">
              <Link href="/login" className="flex-1" onClick={() => setOpen(false)}>
                <Button variant="secondary" className="w-full">Log in</Button>
              </Link>
              <Link href="/signup" className="flex-1" onClick={() => setOpen(false)}>
                <Button className="w-full">Get Started Free</Button>
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
