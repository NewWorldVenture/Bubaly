// lib/navigation/customize.ts — pure helpers for the customizable Free-tier
// sidebar. The visible primary destinations are user-customizable (reorder, add,
// remove, shorten/lengthen) and persist to Supabase
// (user_preferences.notification_prefs.sidebarNav) so the layout follows the
// member across devices, with localStorage as an offline cache.
//
// AI Assistant, Settings, and Help & Support are intentionally NOT part of this
// list — they render as fixed chrome (top pill + footer) and are never editable.
//
// No React/Supabase here — just deterministic sanitization. Tested.

/** Where the persisted sidebar layout lives inside notification_prefs (jsonb). */
export const SIDEBAR_NAV_PREF_KEY = 'sidebarNav';

/** localStorage cache key for instant/offline first paint of the sidebar. */
export const SIDEBAR_NAV_STORAGE_KEY = 'bubaly.sidebarNav';

/** Same-tab broadcast so the live sidebar updates the moment Settings saves. */
export const SIDEBAR_NAV_EVENT = 'bubaly:sidebar-nav-changed';

/** Max primary destinations the sidebar will render. */
export const MAX_SIDEBAR_NAV = 20;

/** Routes that can never appear in the customizable list (fixed chrome). */
export const FIXED_NAV_ROUTES = new Set<string>([
  '/dashboard/assistant', // AI Assistant — pinned pill at the top
  '/dashboard/settings',  // Settings — footer
  '/dashboard/more',      // Help & Support — footer
]);

/**
 * Sanitize a persisted/incoming nav list into a clean href array:
 * - drops non-strings and blanks,
 * - de-duplicates (first wins, order preserved),
 * - drops the fixed-chrome routes (AI Assistant / Settings / Help),
 * - when `validKeys` is provided, keeps only keys in that set,
 * - caps at `max`.
 * Returns `[]` for anything that isn't a usable array — callers decide the
 * fallback, keeping the function total and side-effect free.
 */
export function sanitizeNavKeys(
  input: unknown,
  validKeys?: readonly string[],
  max: number = MAX_SIDEBAR_NAV,
): string[] {
  if (!Array.isArray(input)) return [];
  const allow = validKeys ? new Set(validKeys) : null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    if (FIXED_NAV_ROUTES.has(key)) continue;
    if (allow && !allow.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Resolve the layout to actually render: a sanitized list, or the defaults when
 * the saved layout is empty/invalid (so the sidebar is never blank).
 */
export function resolveNavKeys(
  input: unknown,
  defaults: readonly string[],
  validKeys?: readonly string[],
  max: number = MAX_SIDEBAR_NAV,
): string[] {
  const clean = sanitizeNavKeys(input, validKeys, max);
  return clean.length ? clean : sanitizeNavKeys(defaults, validKeys, max);
}
