import { describe, expect, it } from 'vitest';
import { nestedInteractive, sourceFiles } from './helpers/jsx-a11y-scan';

// P-39. The notes grid card and the recipe card were `role="button"` AND held
// their own buttons (open, pin, delete; open, favourite). A button's children
// are presentational, so assistive technology was told to ignore the inner
// controls; axe reports it as `nested-interactive` (serious). The MAIN-F-D06
// fix had moved each card's keyboard control onto a real inner <button>, and
// its own comment says the card "must not take role=button" — a merge kept
// both. B14's crawl never saw it because the persona family had no notes or
// recipes; the MAIN-F-D06 retest seeded a note and ran axe.

describe('a button holds no other control', () => {
  it('nothing in the app wraps a control in role="button"', () => {
    const sites = sourceFiles().flatMap((f) => nestedInteractive(f)).map((s) => `${s.file}:${s.line} ${s.what}`);
    expect(sites).toEqual([]);
  });

  it('the scan sees the shape it guards (guards the guard)', () => {
    const card = `export const C = () => <div role="button" tabIndex={0} onClick={f}><button onClick={g}>Pin</button></div>;`;
    expect(nestedInteractive('card.tsx', card)).toHaveLength(1);
    const link = `export const C = () => <div role="button"><a href="/x">x</a></div>;`;
    expect(nestedInteractive('link.tsx', link)).toHaveLength(1);
  });

  it('a drop zone that opens a hidden file input is one control', () => {
    const zone = `export const Z = () => <div role="button" tabIndex={0} onClick={f}><input type="file" className="hidden" /></div>;`;
    expect(nestedInteractive('zone.tsx', zone)).toHaveLength(0);
  });
});
