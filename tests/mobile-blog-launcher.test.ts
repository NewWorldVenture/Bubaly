import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';

// Mobile production-readiness (Phase 8 viewport + Phase 6 touch targets [M-022]):
// the in-app Blog launcher modal (components/app/blog-launcher.tsx) had two mobile
// defects. (1) The panel was h-[88vh] — a static viewport unit measured against the
// address-bar-retracted viewport on mobile Safari/Chrome, so with the URL bar
// showing the panel was ~as tall as the whole visible area and its header (Close
// button) was pushed behind the browser chrome (the M-001 class of bug). (2) The
// header Close + Open-in-new-tab controls go icon-only on mobile (text is
// `hidden sm:inline`) at ~28px — below the 44px minimum, and Close is the modal's
// escape control on a phone. This guard locks the dvh unit and the touch targets.

const launcher = readUiSource('components/app/blog-launcher.tsx');

describe('in-app blog launcher modal is mobile-correct (M-022)', () => {
  it('panel height uses the dynamic viewport unit (dvh), never a static vh', () => {
    expect(launcher).toContain('h-[88dvh]');
    // No bare `vh` height anywhere — static vh reintroduces the mobile clip.
    expect(launcher).not.toMatch(/h-\[\d+vh\]/);
  });

  it('the Close control is a >=44px tap target on touch', () => {
    // Grab the block around the Close button and assert the coarse escape is present.
    const closeIdx = launcher.indexOf('aria-label="Close blog"');
    expect(closeIdx).toBeGreaterThan(-1);
    const block = launcher.slice(closeIdx, closeIdx + 300);
    expect(block).toContain('coarse:min-h-11');
    expect(block).toContain('coarse:min-w-11');
  });

  it('the Open-in-new-tab control is a >=44px tap target on touch', () => {
    const idx = launcher.indexOf('Open the blog in a new tab');
    const block = launcher.slice(idx - 400, idx);
    expect(block).toContain('coarse:min-h-11');
    expect(block).toContain('coarse:min-w-11');
  });
});
