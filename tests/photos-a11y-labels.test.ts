import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';
import { auditIconButtonLabels } from '../scripts/audit-icon-button-labels.mjs';

// A-05 (agent-05 / CLAUDE-FRONTEND-01, PLA-0822): the Photos module had 8 icon-only
// controls with NO accessible name (WCAG 2.2 AA 4.1.2 Name/Role/Value) — the photo
// lightbox's prev/next/close and the favorite/edit/delete actions rendered only an
// icon, so a screen-reader/voice-control user heard "button" with no context and
// could not operate the lightbox (§23 workflow-blocking a11y). Each now carries an
// aria-label. This guard locks the labels in.

const src = readUiSource('components/modules/photos-module.tsx');
// Contact action names are exercised through the real component and all seven
// catalogues in contacts-localization.test.ts, including name interpolation.

describe('photos module icon-only controls have accessible names (A-05 a11y)', () => {
  it('lightbox navigation + close are labeled', () => {
    expect(src).toContain(`aria-label="Previous photo"`);
    expect(src).toContain(`aria-label="Next photo"`);
    expect(src).toContain(`aria-label="Close"`);
  });

  it('photo actions (favorite/edit/delete) are labeled', () => {
    expect(src).toContain(`aria-label="Delete photo"`);
    expect(src).toContain(`aria-label="Edit photo details"`);
    // Both favorite states are checked on the actual rendered controls in all
    // seven locales by photos-localization.test.ts, including click behavior.
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
    // This case used to re-implement the check as a line heuristic: for each
    // `<button`, join the next five lines and call it unnamed if that window holds
    // an icon component and no visible text. The window is the flaw. The list row's
    // open button opens with a conditional thumbnail — five lines of `<Play />` and
    // an `<img>` — and the caption that NAMES it is eleven lines down, so the
    // heuristic reported a button whose accessible name is its own visible text.
    //
    // Adding an aria-label to satisfy it would have been the wrong fix twice over:
    // it would override that visible caption, which is WCAG 2.5.3 Label in Name,
    // and it would invent a name for a control that already has a better one.
    //
    // So this delegates to the AST scanner instead, which parses the real JSX and
    // is strictly more accurate than the window it replaces — it knows a button's
    // whole subtree, and treats any non-JSX `{expression}` child as a name because
    // `{t('…')}` and `{label}` both put one there. The same scanner runs over the
    // entire app in tests/every-icon-button-has-a-name.test.ts; this case keeps the
    // assertion pinned to this file, where A-05 was found.
    const offenders = auditIconButtonLabels(['components/modules/photos-module.tsx']);
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.text}`),
      'icon-only buttons with no accessible name',
    ).toEqual([]);
  });
});
