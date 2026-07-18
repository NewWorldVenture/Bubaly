import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 6 — touch targets [M-024]):
// the blog's two primary engagement CTAs fell short of the 44px minimum tap
// target on touch. The Save (heart) pill (components/blog/heart-button.tsx) was
// px-4 py-2 (~36px) and appears twice per article; the Subscribe card button
// (components/blog/subscribe-form.tsx) was py-2.5 (~40px). Both grow to >=44px on
// coarse-pointer (touch) via coarse:min-h-11 while keeping the compact desktop
// density. This guard forbids a regression. (The subscribe *inline* variant at
// py-3 was already ~44px; the *input* height is covered by the M-002 font rule.)

const heart = fs.readFileSync('components/blog/heart-button.tsx', 'utf8');
const subscribe = fs.readFileSync('components/blog/subscribe-form.tsx', 'utf8');

describe('blog engagement CTAs meet the 44px touch-target minimum (M-024)', () => {
  it('the Save (heart) button is >=44px tall on touch', () => {
    // The one interactive <button> in the heart component carries the coarse escape.
    expect(heart).toMatch(/rounded-full border px-4 py-2 text-sm font-semibold transition coarse:min-h-11/);
  });

  it('the Subscribe button is >=44px tall on touch', () => {
    const btnIdx = subscribe.indexOf('type="submit"');
    expect(btnIdx).toBeGreaterThan(-1);
    const block = subscribe.slice(btnIdx, btnIdx + 400);
    expect(block).toContain('coarse:min-h-11');
  });
});
