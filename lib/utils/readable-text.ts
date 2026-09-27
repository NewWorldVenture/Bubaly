// Text drawn on a colour the family chose (a member's avatar colour) has to be
// readable on it, and white is not readable on every colour: on #6366f1 it is
// 4.46:1, just under WCAG AA's 4.5:1 for normal text, and on the lighter
// palette colours it is far under. This picks white or black, whichever reads
// better. Pure black, not a softer near-black: white and black cross over at
// 4.58:1, so one of the two always clears AA, and a near-black does not on
// mid-tones like #6366f1.

const DARK_TEXT = '#000000';

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** The colour as [r, g, b], for #rgb and #rrggbb; null for anything else. */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map((d) => d + d).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number | null {
  const pa = parseHex(a), pb = parseHex(b);
  if (!pa || !pb) return null;
  const [hi, lo] = [luminance(pa), luminance(pb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * White or black text for a background, whichever has more contrast.
 * A colour this cannot read (a CSS variable, a named colour) keeps white,
 * which is what every caller drew before.
 */
export function readableTextOn(background: string | null | undefined): string {
  if (!background) return '#ffffff';
  const white = contrastRatio('#ffffff', background);
  const dark = contrastRatio(DARK_TEXT, background);
  if (white === null || dark === null) return '#ffffff';
  return white >= dark ? '#ffffff' : DARK_TEXT;
}
