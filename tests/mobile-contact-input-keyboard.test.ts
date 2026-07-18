import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase 7 — forms & keyboard) [M-015]: agent-05's M-006
// gave the money + search inputs their mobile keyboards, but the guardian **contact
// editor** (a non-module component it didn't sweep) had a phone + email input with no
// `type`/`inputMode`, so mobile browsers showed the plain alphabetic keyboard instead
// of the telephone keypad / email keyboard. This guard locks the correct mobile
// keyboard + autofill semantics onto those fields.

const FILE = 'components/guardian/contact-list.tsx';

describe('guardian contact editor inputs surface the right mobile keyboard', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  const line = (needle: string) => src.split('\n').find((l) => l.includes(needle)) ?? '';

  it('phone field uses the telephone keypad', () => {
    const phone = line("set('phone'");
    expect(phone).toContain('type="tel"');
    expect(phone).toContain('inputMode="tel"');
    expect(phone).toContain('autoComplete="tel"');
  });

  it('email field uses the email keyboard (no autocapitalize/spellcheck)', () => {
    const email = line("set('email'");
    expect(email).toContain('type="email"');
    expect(email).toContain('inputMode="email"');
    expect(email).toContain('autoComplete="email"');
    expect(email).toContain('autoCapitalize="none"');
  });
});
