import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A11Y-001: what the popup sweep found, held in the source. The country picker
// and the emoji panel are also checked as the browser renders them, in
// tests/e2e/a-popup-opens-closes-and-keeps-its-targets-apart.spec.ts.

const read = (f: string) => readFileSync(f, 'utf8');

describe('a popup is what it says it is', () => {
  it('the country picker: the list alone is the listbox, Escape closes it, and closing returns focus', () => {
    const src = read('components/ui/phone-input.tsx');
    expect(src).not.toMatch(/ref=\{panelRef\}\s*role="listbox"/); // the panel holds a search field too
    expect(src).toMatch(/<ul id=\{listId\} role="listbox" aria-label=\{tr\('phoneInput\.selectCountry'\)\}/);
    expect(src).toContain('<li key={c.code} role="none">');
    expect(src).toContain("onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}");
    expect(src).toMatch(/function close\(\) \{[^}]*triggerRef\.current\?\.focus\(\);/);
    expect(src).toContain('!triggerRef.current?.contains(e.target as Node)');
  });

  it("the money timeline: a week with nothing in it is not offered as a disclosure", () => {
    const src = read('components/modules/money-timeline-module.tsx');
    expect(src).toContain('disabled={!active}');
    expect(src).toContain('aria-expanded={active ? isOpen : undefined}');
    expect(src).not.toMatch(/aria-expanded=\{isOpen\}/);
  });

  it('the emoji panel takes its own width, so its grid does not shrink into the 32 px wrapper', () => {
    expect(read('components/modules/messages-module.tsx')).toContain('<div className="absolute bottom-11 left-0 z-20 w-max rounded-xl');
  });
});
