// lib/display/recover.ts — kiosk recovery policy (pure, tested).
//
// Why this exists: the Kitchen Display is an always-open tab. Every deploy
// invalidates the JS chunks its bundle references, so the boundary's soft
// `reset()` (and the 2-minute router.refresh) can hit "Loading chunk failed" /
// stale-bundle errors that NO code fix can heal — the tab keeps re-rendering
// the same dead bundle and the error boundary loops forever. The only exit is a
// HARD reload (window.location.reload), which pulls the freshly deployed
// bundle. This module decides when to soft-reset vs hard-reload.

/** Errors that mean "this bundle is stale/broken — only a hard reload helps". */
export function isStaleBundleError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /chunkloaderror|loading chunk|failed to fetch dynamically imported|import(ing)? a module script failed|css chunk|text\/html.{0,3}is not a valid javascript/i.test(message);
}

/**
 * Escalation policy for the self-healing boundary:
 *  - a stale-bundle error → hard reload immediately (soft reset can never fix it);
 *  - anything else → try soft reset() twice (covers true transients), then hard
 *    reload — if two soft resets didn't clear it, the client bundle itself is
 *    the prime suspect and only a reload can swap it.
 */
export function shouldHardReload(consecutiveFailures: number, message: string | null | undefined): boolean {
  if (isStaleBundleError(message)) return true;
  return consecutiveFailures >= 2;
}

/** Hours an always-on tab may keep one bundle before a scheduled hard reload
 *  (picks up deploys even when nothing ever crashes). */
export const KIOSK_MAX_BUNDLE_AGE_HOURS = 12;

/** True when the tab's bundle is old enough for its scheduled refresh. */
export function isBundleStaleByAge(loadedAtMs: number, nowMs: number, maxHours: number = KIOSK_MAX_BUNDLE_AGE_HOURS): boolean {
  return nowMs - loadedAtMs >= maxHours * 3_600_000;
}
