import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';

// Mobile production-readiness (Phase 6 — touch targets & accessible names):
// icon-only controls must expose an accessible name (WCAG 4.1.2) so screen-reader
// / voice-control users can operate them, and must be reachable on touch (a
// hover-only reveal is invisible on a phone). This guard locks the app-wide sweep
// fixes: four icon-only buttons that had no name (shopping edit, inbox archive,
// concierge back, feedback submit), plus the inbox archive being touch-visible.

const shopping = readUiSource('components/modules/shopping-module.tsx');
const inbox = readUiSource('components/modules/inbox-module.tsx');
const concierge = readUiSource('components/modules/concierge-module.tsx');
const feedback = fs.readFileSync('app/(app)/feedback/feedback-board.tsx', 'utf8');

describe('icon-only controls expose an accessible name (Phase 6 a11y)', () => {
  it('shopping list edit button is labeled + focus-reachable', () => {
    expect(shopping).toContain('aria-label="Edit list"');
    // hover-reveal controls must also appear on keyboard focus.
    expect(shopping).toContain('focus-visible:opacity-100');
  });

  it('inbox archive button is labeled and visible on touch (not hover-only)', () => {
    expect(inbox).toContain('aria-label="Archive"');
    // On phones (no hover) the archive control must be shown, not hidden behind
    // group-hover; it reverts to hover-reveal only at sm+ (mouse).
    expect(inbox).toMatch(/flex sm:hidden sm:group-hover:flex/);
  });

  it('concierge back button is labeled', () => {
    expect(concierge).toContain('aria-label="Back"');
  });

  it('feedback submit (icon-only Send) is labeled', () => {
    expect(feedback).toContain('aria-label="Post feedback"');
  });
});
