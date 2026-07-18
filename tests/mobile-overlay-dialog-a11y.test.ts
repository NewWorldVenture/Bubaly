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
    });
  }

  it('the dismissible exit-intent modal also closes on Escape', () => {
    const src = fs.readFileSync(dialogs.exitIntent, 'utf8');
    expect(src).toMatch(/e\.key === 'Escape'/);
  });
});
