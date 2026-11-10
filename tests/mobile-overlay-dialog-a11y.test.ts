import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 6 — a11y / screen readers) [M-013]: hand-rolled
// full-screen overlays that bypass the shared `Modal` primitive were missing dialog
// semantics, so mobile VoiceOver / TalkBack didn't announce them as modal dialogs or
// scope the reader to their contents. This adds `role="dialog"` + `aria-modal="true"`
// + an accessible name (via `aria-labelledby` → a real heading id) to the blocking
// overlays that lacked them, and keyboard ESC-to-close to the dismissible one.
// (The shared `Modal` already carries these; the wallet/contact dropdown
// dismiss-catchers are `aria-hidden` and correctly excluded.)

const dialogs = {
  exitIntent: 'components/marketing/exit-intent.tsx',
  appLock: 'components/app/app-lock-gate.tsx',
  rulesEditor: 'components/guardian/rules-editor.tsx',
  contactEditor: 'components/guardian/contact-list.tsx',
};

const labelIds: Record<keyof typeof dialogs, string> = {
  exitIntent: 'exit-intent-title',
  appLock: 'app-lock-title',
  rulesEditor: 'rules-editor-title',
  contactEditor: 'contact-editor-title',
};

// The opening tag of the element named by `aria-labelledby="<id>"`. Comments in
// these files quote `role="dialog" aria-modal="true"` too, so a whole-file search
// stays green after the attributes leave the markup; the tag itself cannot.
function dialogTag(src: string, id: string): string {
  const at = src.indexOf(`aria-labelledby="${id}"`);
  expect(at).toBeGreaterThan(-1);
  return src.slice(src.lastIndexOf('<', at), src.indexOf('>', at) + 1);
}

describe('hand-rolled full-screen overlays expose dialog semantics to screen readers', () => {
  for (const [name, file] of Object.entries(dialogs)) {
    it(`${name} (${file}) is a labeled modal dialog`, () => {
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toContain('role="dialog"');
      expect(src).toContain('aria-modal="true"');
      const id = labelIds[name as keyof typeof dialogs];
      // Named via aria-labelledby pointing at a heading that carries the same id.
      expect(src).toContain(`aria-labelledby="${id}"`);
      expect(src).toContain(`id="${id}"`);
      // ...and it is that same element that is the modal dialog.
      const tag = dialogTag(src, id);
      expect(tag).toMatch(/\srole="dialog"\s/);
      expect(tag).toMatch(/\saria-modal="true"\s/);
    });
  }

  it('the dismissible exit-intent modal also closes on Escape', () => {
    const src = fs.readFileSync(dialogs.exitIntent, 'utf8');
    // Escape now comes from the shared hook, along with the Tab trap and focus
    // restore this overlay never had.
    expect(src).toMatch(/useDialogBehavior/);
    // Imported and called with the offer's own close handler, on the ref the
    // dialog element carries: a comment mentioning the hook is none of those.
    expect(src).toMatch(/^import \{ useDialogBehavior \} from '@\/lib\/a11y\/use-dialog-behavior';$/m);
    expect(src).toMatch(/^\s*useDialogBehavior\(dialogRef,[^\n]*\bonClose: closeOffer\b/m);
    expect(dialogTag(src, labelIds.exitIntent)).toMatch(/\sref=\{dialogRef\}\s/);
    expect(fs.readFileSync('lib/a11y/use-dialog-behavior.ts', 'utf8')).toMatch(/e\.key === 'Escape'/);
  });
});
