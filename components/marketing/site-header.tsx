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
    <header className="sticky top-0 z-50 border-b border-border/70 bg-bg/95 text-fg backdrop-blur-xl transition-colors duration-300">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
        <Logo className="[&>img]:h-11" />

        <nav className="hidden h-full items-center gap-7 lg:flex">
          {MARKETING_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative inline-flex h-full items-center text-[10px] font-medium text-muted transition hover:text-fg',
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
          <ThemeToggle className="h-8 w-8 border border-border/80 bg-surface/70 text-fg hover:bg-elevated" />
          <Link href="/login" className="hidden h-8 items-center px-3 text-[10px] font-medium text-muted transition hover:text-fg sm:inline-flex">
            Log in
          </Link>
          <Link href="/welcome" className="hidden h-8 items-center rounded-full bg-gradient-to-r from-blue-500 to-violet-600 px-5 text-[10px] font-semibold text-brand-fg shadow-glow transition hover:brightness-110 sm:inline-flex">
            Get Started Free
          </Link>
          <button
            className="rounded-lg p-2 text-fg lg:hidden focus-ring"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-border/70 bg-bg/98 px-4 py-4 backdrop-blur-xl lg:hidden">
          <nav className="flex flex-col gap-1">
            {MARKETING_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  'rounded-lg px-3 py-3 text-base text-fg hover:bg-elevated/70',
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
              <Link href="/welcome" className="flex-1" onClick={() => setOpen(false)}>
                <Button className="w-full">Get Started Free</Button>
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
