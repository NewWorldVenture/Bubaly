'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { MARKETING_NAV } from '@/lib/constants/navigation';

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Logo />

        <nav className="hidden items-center gap-1 lg:flex">
          {MARKETING_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-muted transition hover:bg-elevated hover:text-fg"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/login" className="hidden sm:block">
            <Button variant="ghost" size="sm">Log in</Button>
          </Link>
          <Link href="/signup" className="hidden sm:block">
            <Button size="sm">Get started</Button>
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
        <div className="border-t border-border bg-bg/95 px-4 py-4 lg:hidden">
          <nav className="flex flex-col gap-1">
            {MARKETING_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-base text-fg hover:bg-elevated"
              >
                {item.label}
              </Link>
            ))}
            <div className="mt-3 flex gap-2">
              <Link href="/login" className="flex-1" onClick={() => setOpen(false)}>
                <Button variant="secondary" className="w-full">Log in</Button>
              </Link>
              <Link href="/signup" className="flex-1" onClick={() => setOpen(false)}>
                <Button className="w-full">Get started</Button>
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
