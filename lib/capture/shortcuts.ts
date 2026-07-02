// lib/capture/shortcuts.ts — pure helpers for the Capture "jump directly to"
// shortcut layout. The visible set is user-customizable and now persists to
// Supabase (user_preferences.notification_prefs.captureShortcuts) so it follows
// the family member across devices, with localStorage as an offline cache.
// No React/Supabase here — just deterministic sanitization. Tested.

/** Where the persisted shortcut layout lives inside notification_prefs (jsonb). */
export const CAPTURE_SHORTCUTS_PREF_KEY = 'captureShortcuts';

/** Default visible shortcuts (keys must exist in the client SHORTCUT_CATALOG). */
export const DEFAULT_CAPTURE_SHORTCUTS = ['calendar', 'tasks', 'grocery', 'home', 'health', 'trip'];

/** Max shortcuts shown in the grid. */
export const MAX_CAPTURE_SHORTCUTS = 15;

/**
 * Sanitize a persisted/incoming shortcut list into a clean key array:
 * - drops non-strings and blanks,
 * - de-duplicates (first wins, order preserved),
 * - when `validKeys` is provided, keeps only keys in that set,
 * - caps at `max`.
 * Returns `[]` for anything that isn't a usable array (callers decide the
 * fallback) — keeping the function total and side-effect free.
 */
export function sanitizeShortcutKeys(
  input: unknown,
  validKeys?: readonly string[],
  max: number = MAX_CAPTURE_SHORTCUTS,
): string[] {
  if (!Array.isArray(input)) return [];
  const allow = validKeys ? new Set(validKeys) : null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    if (allow && !allow.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Resolve the layout to actually render: a sanitized list, or the defaults when
 * the saved layout is empty/invalid (so the grid is never blank).
 */
export function resolveShortcutKeys(
  input: unknown,
  validKeys?: readonly string[],
  max: number = MAX_CAPTURE_SHORTCUTS,
): string[] {
  const clean = sanitizeShortcutKeys(input, validKeys, max);
  return clean.length ? clean : sanitizeShortcutKeys(DEFAULT_CAPTURE_SHORTCUTS, validKeys, max);
}
