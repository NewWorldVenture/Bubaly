// A page whose JavaScript chunk failed to load lands on an error boundary
// whose "Try again" is reset(), and reset() re-renders the same bundle, which
// asks for the same missing chunk and fails the same way. The chunk is missing
// because one request for it failed in transit, or because a deploy replaced
// it while the tab was open. Either way only a reload fetches it again.
//
// The page audit's production crawl hit it on 8 of 786 loads: one chunk
// answered 502, the chunk that answered was not JavaScript, and the page sat
// on "Something went wrong" until the visitor reloaded it themselves.
//
// So a boundary that catches a chunk failure reloads the page for them: once
// per page, and not again within RELOAD_WINDOW_MS, so a chunk that is really
// gone leaves the error page up rather than reloading forever. The Kitchen
// Display keeps its own, stricter policy (lib/display/recover.ts).
import { isStaleBundleError } from '@/lib/display/recover';

const RELOAD_KEY = 'bubaly.staleBundleReload';
export const RELOAD_WINDOW_MS = 60_000;

export interface LastReload { path: string; at: number }

/** The error names a chunk that failed to load (by its name or its message). */
export function isChunkFailure(error: { name?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return isStaleBundleError(`${error.name ?? ''}: ${error.message ?? ''}`);
}

/** Whether a boundary showing `error` on `path` should reload the page now. */
export function shouldReloadForChunkFailure(
  error: { name?: string; message?: string } | null | undefined,
  path: string,
  last: LastReload | null,
  now: number,
): boolean {
  if (!isChunkFailure(error)) return false;
  return !(last && last.path === path && now - last.at < RELOAD_WINDOW_MS);
}

function readLast(): LastReload | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastReload>;
    return typeof parsed.path === 'string' && typeof parsed.at === 'number' ? { path: parsed.path, at: parsed.at } : null;
  } catch {
    return null;
  }
}

/**
 * Called from an error boundary's effect. Reloads the page and returns true
 * when the error is a chunk failure this page has not just reloaded for;
 * otherwise returns false and the boundary shows its card. Without storage
 * (blocked, private mode) it does not reload, since it could not tell a
 * second failure from the first.
 */
export function reloadOnceForChunkFailure(error: { name?: string; message?: string } | null | undefined): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname + window.location.search;
  const now = Date.now();
  if (!shouldReloadForChunkFailure(error, path, readLast(), now)) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ path, at: now }));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
