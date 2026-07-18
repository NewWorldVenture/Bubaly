import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 8 — safe areas & viewport): on mobile Safari
// and Android Chrome, `100vh` is TALLER than the visible viewport (it excludes the
// browser chrome), so full-height panels push their controls — a chat input, a
// primary button — behind the address bar or keyboard. Dynamic viewport units
// (`dvh`) size to the currently-visible area and fix it. These guards keep the
// full-height interactive surfaces and app shells on `dvh`, and forbid a
// regression to a bare mobile `100vh` / `min-h-screen`.

const files = {
  messages: 'components/modules/messages-module.tsx',
  concierge: 'components/modules/concierge-module.tsx',
  kidsLayout: 'app/(app)/kids/layout.tsx',
  gift: 'app/gift/[token]/page.tsx',
  pay: 'app/pay/[handle]/page.tsx',
};

describe('full-height mobile surfaces use dynamic viewport units (dvh)', () => {
  it('the messages panel is sized with dvh, not 100vh', () => {
    const src = fs.readFileSync(files.messages, 'utf8');
    expect(src).toContain('h-[calc(100dvh-var(--topbar-height)-1rem)]');
    expect(src).not.toContain('h-[calc(100vh-var(--topbar-height)-1rem)]');
  });

  it('the concierge panel is sized with dvh, not 100vh', () => {
    // M-017 moved the inline style (spaced calc) to Tailwind arbitrary values
    // that also clear the mobile bottom nav — keep asserting dvh (never vh).
    const src = fs.readFileSync(files.concierge, 'utf8');
    expect(src).toContain('h-[calc(100dvh-140px-4rem-var(--safe-bottom))]');
    expect(src).not.toMatch(/100vh/);
  });

  it('app shells / full-page layouts use min-h-dvh, not min-h-screen', () => {
    for (const f of [files.kidsLayout, files.gift, files.pay]) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, `${f} should not use bare min-h-screen`).not.toMatch(/\bmin-h-screen\b/);
      expect(src, `${f} should use min-h-dvh`).toContain('min-h-dvh');
    }
  });
});
