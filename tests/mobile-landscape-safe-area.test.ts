import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 8 — safe areas & viewport) [M-014]: the
// full-screen camera is edge-to-edge (`fixed inset-0 bg-black`) with its controls
// pinned to the horizontal edges — the close/switch buttons in the top bar and the
// shutter row. It padded the top/bottom safe areas but NOT the left/right ones, so
// on a notched phone held in **landscape** the side notch / rounded corners overlap
// those controls. This guard locks all four safe-area insets onto the camera shell.
// (Portrait and non-notched devices report 0 for these insets, so it's a no-op there.)

const CAMERA = 'components/ui/camera-capture.tsx';

describe('full-screen camera clears the safe area on all sides (landscape notch)', () => {
  const src = fs.readFileSync(CAMERA, 'utf8');
  const shell = src.split('\n').find((l) => l.includes('fixed inset-0') && l.includes('bg-black')) ?? '';

  it('the camera shell exists as an edge-to-edge fixed overlay', () => {
    expect(shell).toContain('fixed inset-0');
  });

  it('pads every safe-area inset (top, bottom, left, right)', () => {
    expect(shell).toContain('pt-[var(--safe-top)]');
    expect(shell).toContain('pb-[var(--safe-bottom)]');
    expect(shell).toContain('pl-[var(--safe-left)]');
    expect(shell).toContain('pr-[var(--safe-right)]');
  });
});
