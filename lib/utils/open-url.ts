// lib/utils/open-url.ts — popup-blocker-safe "open URL known only after an
// await" (M-030). iOS Safari (and strict desktop blockers) silently drop a
// window.open() that is not in the synchronous call stack of a user gesture —
// the classic "View works on desktop, does nothing on iPhone" bug for
// signed-URL flows (tap → await createSignedUrl → open). The fix: pre-open a
// blank tab synchronously inside the gesture, then point it at the URL once
// resolved (or close it on failure). When even the pre-open is blocked, fall
// back to same-tab navigation so the tap always does something.
export function preOpenWindow(): { navigate: (url: string) => void; cancel: () => void } {
  const w = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
  if (w) {
    // Manual noopener: window.open(..., 'noopener') would return null, losing
    // the handle we need to navigate the tab after the await.
    try { w.opener = null; } catch { /* some browsers restrict this */ }
  }
  return {
    navigate: (url: string) => {
      if (w && !w.closed) w.location.href = url;
      else if (typeof window !== 'undefined') window.location.assign(url);
    },
    cancel: () => { try { w?.close(); } catch { /* already closed */ } },
  };
}
