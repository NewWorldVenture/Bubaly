import { MAX_SIDEBAR_NAV, sanitizeNavKeys } from '@/lib/navigation/customize';

/** A personal preset moves the existing Outcomes destination first. All other
 * pins retain their order; a full layout is refused instead of dropping one. */
export function outcomeNavigationPreset(keys: readonly string[]): string[] | null {
  const current = sanitizeNavKeys(keys);
  if (!current.includes('/dashboard/outcomes') && current.length >= MAX_SIDEBAR_NAV) return null;
  return ['/dashboard/outcomes', ...current.filter((href) => href !== '/dashboard/outcomes')];
}
