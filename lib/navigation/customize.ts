// lib/navigation/customize.ts — pure helpers for the customizable Free-tier
// sidebar. Both the top-level destinations AND each expandable group's sub-pages
// are user-customizable (reorder, add, remove, shorten/lengthen) and persist to
// Supabase (user_preferences.notification_prefs.sidebarNav +
// .sidebarNavChildren) so the layout follows the member across devices, with
// localStorage as an offline cache.
//
// AI Assistant, Settings, and Help & Support are intentionally NOT part of this
// list — they render as fixed chrome (top pill + footer) and are never editable.
//
// No React/Supabase here — just deterministic sanitization. Tested.

/** Where the persisted top-level layout lives inside notification_prefs (jsonb). */
export const SIDEBAR_NAV_PREF_KEY = 'sidebarNav';

/** Where per-group sub-page layouts live: { parentHref: childHref[] }. */
export const SIDEBAR_NAV_CHILDREN_PREF_KEY = 'sidebarNavChildren';

/** localStorage cache keys for instant/offline first paint of the sidebar. */
export const SIDEBAR_NAV_STORAGE_KEY = 'bubaly.sidebarNav';
export const SIDEBAR_NAV_CHILDREN_STORAGE_KEY = 'bubaly.sidebarNavChildren';

/** Same-tab broadcast so the live sidebar updates the moment Settings saves.
 *  detail: { nav: string[]; children: Record<string, string[]> } */
export const SIDEBAR_NAV_EVENT = 'bubaly:sidebar-nav-changed';

/** Per-parent map of the sub-pages a member wants, in order. */
export type NavChildMap = Record<string, string[]>;

/** Max primary destinations the sidebar will render. Generous so a member can
 *  "Pin all services in my plan" without truncation (the rail scrolls). */
export const MAX_SIDEBAR_NAV = 200;

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
 * Add keys to a nav list (bulk "pin"): appends new keys after the current ones,
 * de-duplicated, chrome-stripped, restricted to `validKeys`, capped. Order of
 * existing pins is preserved; newly-pinned keys follow in `add` order.
 */
export function addNavKeys(
  current: readonly string[],
  add: readonly string[],
  validKeys?: readonly string[],
  max: number = MAX_SIDEBAR_NAV,
): string[] {
  return sanitizeNavKeys([...current, ...add], validKeys, max);
}

/** Remove keys from a nav list (bulk "unpin"). Order of the rest is preserved. */
export function removeNavKeys(current: readonly string[], remove: readonly string[]): string[] {
  const drop = new Set(remove);
  return current.filter((k) => typeof k === 'string' && k && !drop.has(k));
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

/**
 * Resolve the sub-pages to render under one expandable parent.
 * - Parent absent from the saved map → the full catalog order (default: show all).
 * - Parent present → the saved order, filtered to the catalog. This CAN be empty
 *   (the member removed every sub-page), which turns the parent into a plain link
 *   — a deliberate, re-addable outcome, so there is NO fallback-to-default here.
 */
export function resolveChildKeys(
  saved: NavChildMap | null | undefined,
  parentHref: string,
  childCatalogKeys: readonly string[],
): string[] {
  if (!saved || typeof saved !== 'object' || !Object.prototype.hasOwnProperty.call(saved, parentHref)) {
    return [...childCatalogKeys];
  }
  return sanitizeNavKeys(saved[parentHref], childCatalogKeys, MAX_SIDEBAR_NAV);
}

/**
 * Sanitize a persisted/incoming child map into a clean { parentHref: childHref[] }.
 * - drops non-object input and blank parent keys,
 * - when `validByParent` is given, drops unknown parents and filters each list to
 *   that parent's valid children,
 * - keeps explicitly-empty arrays (a removed-all group stays a plain link).
 */
export function sanitizeChildMap(
  input: unknown,
  validByParent?: ReadonlyMap<string, readonly string[]>,
): NavChildMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: NavChildMap = {};
  for (const [parent, arr] of Object.entries(input as Record<string, unknown>)) {
    if (!parent.trim()) continue;
    if (validByParent) {
      const valid = validByParent.get(parent);
      if (!valid) continue; // unknown parent → drop
      out[parent] = sanitizeNavKeys(arr, valid, MAX_SIDEBAR_NAV);
    } else {
      out[parent] = sanitizeNavKeys(arr, undefined, MAX_SIDEBAR_NAV);
    }
  }
  return out;
}
