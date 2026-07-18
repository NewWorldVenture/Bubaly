import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-05 (agent-05 / CLAUDE-FRONTEND-01, PLA-0822): the Photos module had 8 icon-only
// controls with NO accessible name (WCAG 2.2 AA 4.1.2 Name/Role/Value) — the photo
// lightbox's prev/next/close and the favorite/edit/delete actions rendered only an
// icon, so a screen-reader/voice-control user heard "button" with no context and
// could not operate the lightbox (§23 workflow-blocking a11y). Each now carries an
// aria-label. This guard locks the labels in.

const src = fs.readFileSync('components/modules/photos-module.tsx', 'utf8');
const contacts = fs.readFileSync('components/modules/contacts-module.tsx', 'utf8');

describe('contacts module icon-only controls have accessible names (A-05 a11y)', () => {
  it('call/email quick-actions are labeled with the contact name', () => {
    expect(contacts).toContain('aria-label={`Call ${contact.name}`}');
    expect(contacts).toContain('aria-label={`Email ${contact.name}`}');
  });
});

describe('photos module icon-only controls have accessible names (A-05 a11y)', () => {
  it('lightbox navigation + close are labeled', () => {
    expect(src).toContain(`aria-label="Previous photo"`);
    expect(src).toContain(`aria-label="Next photo"`);
    expect(src).toContain(`aria-label="Close"`);
  });

  it('photo actions (favorite/edit/delete) are labeled', () => {
    expect(src).toContain(`aria-label="Delete photo"`);
    expect(src).toContain(`aria-label="Edit photo details"`);
    // Favorite toggles use a dynamic add/remove label.
    expect(src).toContain(`? 'Remove from favorites' : 'Add to favorites'`);
  });

  it('upload dropzone is keyboard-operable (role/tabindex/keydown + name)', () => {
    // The click-to-browse dropzone must be reachable + activatable by keyboard
    // (WCAG 2.1.1) and expose a name (WCAG 4.1.2), not just an onClick div.
    const drop = src.slice(src.indexOf('onDrop={handleDrop}'), src.indexOf('onDrop={handleDrop}') + 500);
    expect(drop).toContain('role="button"');
    expect(drop).toMatch(/tabIndex=\{busy \? -1 : 0\}/);
    expect(drop).toContain('onKeyDown=');
    expect(drop).toContain(`aria-label="Upload photos or videos"`);
  });

  it('no icon-only <button> is left without an accessible name', () => {
    // Every <button ...> that renders only an icon component must carry aria-label.
    // Heuristic: buttons whose 4-line block contains a JSX icon and no visible text
    // and no aria-label are failures. (Text-labeled tab/album/back buttons are ok.)
    const lines = src.split('\n');
    const offenders: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/<button\b/.test(lines[i])) continue;
      const block = lines.slice(i, i + 5).join(' ');
      const hasLabel = /aria-label|title=/.test(block);
      // visible text = a JSX expression like {k.label}/{album.name}/{label} or a bare word after >
      const hasText = /\{[^}]*\b(label|name|title|Albums)\b[^}]*\}|>\s*[A-Za-z]/.test(block);
      const iconOnly = /<[A-Z][a-zA-Z]+ (class|className)/.test(block) && !hasText;
      if (iconOnly && !hasLabel) offenders.push(i + 1);
    }
    expect(offenders, `icon-only buttons missing aria-label at lines: ${offenders.join(', ')}`).toEqual([]);
  });
});
