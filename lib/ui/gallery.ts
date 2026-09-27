/**
 * Where a left/right key lands in a gallery of `count` items.
 *
 * `null` means "not a step key", which is how a caller knows to leave the event
 * alone rather than swallowing it. At either end the CURRENT index comes back
 * rather than wrapping: the two chevrons in the photo lightbox unmount at the
 * ends, so wrapping would make the keyboard do something the mouse cannot, and
 * the "3 / 20" counter would jump to "20 / 20" with no visible cause.
 *
 * A count of zero has no valid index; the caller is not showing a lightbox at
 * all in that case, and the current index comes back untouched.
 */
export function galleryStep(index: number, key: string, count: number): number | null {
  const step = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
  if (step === 0) return null;
  const next = index + step;
  return next < 0 || next > count - 1 ? index : next;
}
