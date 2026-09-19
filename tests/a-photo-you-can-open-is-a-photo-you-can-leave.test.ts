// C2-01: the photo lightbox was a modal dialog that said so nowhere.
//
// components/modules/photos-module.tsx renders a full-screen overlay over the
// gallery with no `role`, no `aria-modal`, no Escape, no focus moved in, no
// focus trap and no scroll lock. Its only dismissal was a click on the
// backdrop. A keyboard user could open a photo and then had no way out of it
// and no way to reach the download, favourite or delete controls inside it; a
// screen-reader user was never told a dialog had opened at all, and could walk
// straight out of it into the gallery behind.
//
// The fix is NOT to swap it for `<Modal>`: the lightbox is full-bleed black
// chrome around a photo, and `<Modal>` is a titled panel — that would be a
// design change wearing an audit fix's clothes. It is to give both surfaces the
// same BEHAVIOUR from the same definition, which is what
// `lib/hooks/use-dialog-behavior.ts` now is. The contract itself is asserted in
// tests/modal-a11y-contract.test.ts (which follows the code into that hook) and
// exercised in tests/a-dialog-does-not-steal-the-caret.test.ts.
//
// What is left for this file is the part that is the lightbox's own: that it is
// wired to that hook and announces itself, and that the arrow keys walk the
// gallery — the chevrons are the only way to move between photos and they
// unmount at each end, so a keyboard user reaching the first photo had to close
// and reopen to see the second.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { galleryStep } from '@/lib/ui/gallery';

const SRC = readFileSync('components/modules/photos-module.tsx', 'utf8');

describe('the lightbox is a dialog, and says so', () => {
  it('gets its behaviour from the shared hook rather than a second copy', () => {
    expect(SRC).toMatch(/from '@\/lib\/hooks\/use-dialog-behavior'/);
    expect(SRC).toMatch(/useDialogBehavior<HTMLDivElement>\(lightboxOpen,/);
    // The ref the hook hands back has to reach the overlay, or the trap has no
    // boundary and the hook is imported scenery.
    expect(SRC).toMatch(/ref=\{lightboxRef\}/);
  });

  it('announces itself as a modal dialog with a name', () => {
    const overlay = SRC.slice(SRC.indexOf('ref={lightboxRef}'), SRC.indexOf('ref={lightboxRef}') + 600);
    expect(overlay).toMatch(/role="dialog"/);
    expect(overlay).toMatch(/aria-modal="true"/);
    // Named by the counter (and the caption when there is one) — both already on
    // screen, so the name is translated by construction rather than by a new key
    // in eleven locales.
    expect(overlay).toMatch(/aria-labelledby=/);
    expect(SRC).toMatch(/id=\{lightboxLabelId\}/);
    expect(SRC).toMatch(/id=\{lightboxCaptionId\}/);
  });
});

describe('arrow keys walk the gallery', () => {
  it('moves forward and back', () => {
    expect(galleryStep(0, 'ArrowRight', 20)).toBe(1);
    expect(galleryStep(5, 'ArrowLeft', 20)).toBe(4);
  });

  it('stops at both ends instead of wrapping, because the chevrons do', () => {
    expect(galleryStep(0, 'ArrowLeft', 20)).toBe(0);
    expect(galleryStep(19, 'ArrowRight', 20)).toBe(19);
  });

  it('leaves every other key alone, so nothing else is swallowed', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Escape', 'Tab', 'Enter', ' ', 'a']) {
      expect(galleryStep(3, key, 20), key).toBeNull();
    }
  });

  it('has no valid move in an empty or single-photo gallery', () => {
    expect(galleryStep(0, 'ArrowRight', 1)).toBe(0);
    expect(galleryStep(0, 'ArrowLeft', 1)).toBe(0);
    expect(galleryStep(0, 'ArrowRight', 0)).toBe(0);
  });
});
