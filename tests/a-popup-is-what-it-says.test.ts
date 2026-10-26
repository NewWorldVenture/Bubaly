import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './helpers/hover-reveals';

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
    expect(src).toMatch(/function onEscape\(e: React\.KeyboardEvent\) \{\s*if \(e\.key === 'Escape'\) \{ e\.stopPropagation\(\); close\(\); \}/);
    expect(src.match(/onKeyDown=\{onEscape\}/g)).toHaveLength(2); // the search field and each option: wherever focus is in the panel
    expect(src).toContain('onKeyDown={(e) => { if (open) onEscape(e); }}'); // and its button, before focus has moved into the panel
    expect(src).toMatch(/function close\(\) \{[^}]*triggerRef\.current\?\.focus\(\);/);
    expect(src).toContain('!triggerRef.current?.contains(e.target as Node)');
  });

  it("the money timeline: a week with nothing in it is not offered as a disclosure", () => {
    const src = read('components/modules/money-timeline-module.tsx');
    expect(src).toContain('disabled={!active}');
    expect(src).toContain('aria-expanded={active ? isOpen : undefined}');
    expect(src).not.toMatch(/aria-expanded=\{isOpen\}/);
  });

  // The admin console's popup sweep: the admins and support tickets rows'
  // "More actions" buttons said aria-haspopup="menu", but what opened was a
  // plain panel of buttons (no menu role, no menu items, no arrow keys), the
  // button exposed no expanded state, and Escape from inside the panel left
  // focus on <body>. They are disclosures now.
  it.each(['components/admin/admin-row-actions.tsx', 'components/admin/ticket-row-actions.tsx'])('%s: a disclosure that says it is open, and Escape returns to its button', (file) => {
    const src = read(file);
    expect(src).not.toContain('aria-haspopup');
    expect(src).toContain("aria-expanded={open} aria-controls={open ? panelId : undefined}");
    expect(src).toContain("<div id={panelId} role=\"group\" aria-label={t('a11y.moreActions')}");
    expect(src).toContain('useDismissOnEscape(open, () => { setOpen(false); triggerRef.current?.focus(); });');
    expect(src).toContain('<button ref={triggerRef}');
  });

  it('no button claims a menu that its file does not render', () => {
    const files = [...sourceFiles('components'), ...sourceFiles('app')].filter((f) => f.endsWith('.tsx'));
    const claims = files.filter((f) => { const s = read(f); return /aria-haspopup="menu"|aria-haspopup=\{?["']menu["']\}?/.test(s) && !/role="menu"/.test(s); });
    expect(claims).toEqual([]);
  });

  it('the emoji panel takes its own width, so its grid does not shrink into the 32 px wrapper', () => {
    expect(read('components/modules/messages-module.tsx')).toContain('<div className="absolute bottom-11 left-0 z-20 w-max rounded-xl');
  });
});
