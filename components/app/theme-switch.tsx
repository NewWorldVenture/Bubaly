'use client';

// Dark/Light segmented control. Lives in the sidebar account card and the avatar
// menu, so it's reachable globally. Resolves "system" to the OS preference for the
// active state once mounted (avoids a hydration mismatch).
import { useEffect, useState } from 'react';
import { Moon, SunMedium } from 'lucide-react';
import { useTheme } from '@/components/theme/use-theme';
import { cn } from '@/lib/utils/cn';

export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const resolved = !mounted
    ? null
    : theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;

  return (
    <div className="grid grid-cols-2 rounded-xl border border-border bg-surface/40 p-1 text-sm">
      <button
        type="button"
        onClick={() => setTheme('dark')}
        aria-pressed={resolved === 'dark'}
        className={cn(
          'flex items-center justify-center gap-2 rounded-lg py-2.5 transition',
          resolved === 'dark' ? 'bg-brand/15 font-semibold text-brand' : 'text-muted hover:text-fg',
        )}
      >
        <Moon className="h-4 w-4" /> Dark
      </button>
      <button
        type="button"
        onClick={() => setTheme('light')}
        aria-pressed={resolved === 'light'}
        className={cn(
          'flex items-center justify-center gap-2 rounded-lg py-2.5 transition',
          resolved === 'light' ? 'bg-brand/15 font-semibold text-brand' : 'text-muted hover:text-fg',
        )}
      >
        <SunMedium className="h-4 w-4" /> Light
      </button>
    </div>
  );
}
