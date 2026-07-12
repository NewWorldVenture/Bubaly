'use client';

// Applies role-tailored display density app-wide: stamps `data-density` on
// <html> from the member's role (a kid gets a bigger, roomier app; a caregiver
// a slightly larger one; parents the default). A user override from Settings →
// Display comfort wins over the role default. Because Tailwind's sizes are rem
// units, the CSS in globals.css rescales the whole app from the root font size.
// Renders nothing; cleans the attribute up on unmount (so marketing pages, which
// don't mount this, are never scaled).
import { useEffect } from 'react';
import { useApp } from './app-context';
import { resolveDensity } from '@/lib/ui/role-surface';

export const COMFORT_STORAGE_KEY = 'bubaly_comfort';
export const COMFORT_CHANGE_EVENT = 'bubaly:comfort-change';

export function RoleDensity() {
  const { role } = useApp();

  useEffect(() => {
    const apply = () => {
      let override: string | null = null;
      try { override = localStorage.getItem(COMFORT_STORAGE_KEY); } catch { /* storage blocked */ }
      document.documentElement.dataset.density = resolveDensity(role, override);
    };
    apply();
    window.addEventListener(COMFORT_CHANGE_EVENT, apply);
    window.addEventListener('storage', apply); // sync across tabs
    return () => {
      window.removeEventListener(COMFORT_CHANGE_EVENT, apply);
      window.removeEventListener('storage', apply);
      delete document.documentElement.dataset.density;
    };
  }, [role]);

  return null;
}
