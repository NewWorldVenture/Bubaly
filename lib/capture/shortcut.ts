// lib/capture/shortcut.ts — pure helpers for the global capture keyboard
// shortcut, kept DOM-free so they can be unit-tested.

export type KeyLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * True when focus is in a field where a bare keystroke should be typed, not
 * treated as a shortcut (so "c" in a search box doesn't open the capture sheet).
 */
export function isTypingTarget(tagName: string | null | undefined, isContentEditable = false): boolean {
  if (isContentEditable) return true;
  const tag = (tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** True when a keydown should open Quick Capture: a bare "c" with no modifiers. */
export function isOpenCaptureKey(e: KeyLike): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === 'c';
}

/** True for the "save now" chord (⌘/Ctrl + Enter), used inside the sheet. */
export function isSaveHotkey(e: KeyLike): boolean {
  return Boolean(e.metaKey || e.ctrlKey) && e.key === 'Enter';
}
