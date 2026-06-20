'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTheme } from './use-theme';
import { resolveTheme } from './theme-core';
import { cn } from '@/lib/utils/cn';

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const prefersLight =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  const resolved = resolveTheme(theme, prefersLight);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
      className={cn(
        'inline-flex h-10 w-10 items-center justify-center rounded-full glass text-fg transition hover:bg-elevated focus-ring',
        className,
      )}
    >
      {/* Render nothing theme-specific until mounted to avoid hydration mismatch. */}
      {mounted && resolved === 'dark' ? (
        <Moon className="h-5 w-5" />
      ) : (
        <Sun className="h-5 w-5" />
      )}
    </button>
  );
}
