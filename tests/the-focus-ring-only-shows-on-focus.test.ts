// The focus ring has to mean "this is focused".
//
// `.focus-ring` was declared with no selector of its own:
//
//     .focus-ring { @apply outline-none ring-2 ring-brand/60 ring-offset-2 ring-offset-bg; }
//
// which compiles to `outline: 2px solid transparent` plus an unconditional
// box-shadow ring. Two failures in one declaration: the ring is painted on the
// element at ALL times, so it carries no information, and the transparent
// outline is an author-origin rule that beats the browser's own
// `:focus-visible` outline — so the native indicator is gone as well. 202 of the
// 218 call sites are bare, including `components/ui/input.tsx` (the shared
// `Input`, `Textarea` and `Select`). The 16 that write
// `focus-visible:focus-ring` are all on the signed-out marketing surface and the
// kid login: the public site was fixed, the signed-in product was not.
// WCAG 2.1 AA 2.4.7.
//
// This compiles the real stylesheet with the project's real config and asserts
// on the emitted CSS, because the defect is invisible in the source: the class is
// NAMED focus-ring, and reading `@apply` tells you nothing about which selector
// it lands on. The two component classes that `@apply focus-ring` are checked
// too — Tailwind hoists the pseudo-class onto them, which is what makes this a
// one-line fix rather than 202 edits.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '../tailwind.config';

// Enough markup to make Tailwind emit the component classes under test. Scanning
// the whole repository would take seconds and add nothing: the question is what
// the DECLARATION compiles to, not which files use it.
const MARKUP = `
  <input class="focus-ring">
  <button class="focus-visible:focus-ring">ok</button>
  <button class="btn-cta">save</button>
  <button class="btn-inline">edit</button>
  <span class="outline-none">no outline, deliberately</span>
`;

const compiled = await postcss([
  tailwindcss({ ...tailwindConfig, content: [{ raw: MARKUP, extension: 'html' }] }),
]).process(readFileSync('app/globals.css', 'utf8'), { from: 'app/globals.css' });

/** Every emitted rule as { selector, declarations-as-text }. */
const rules: { selector: string; body: string }[] = [];
compiled.root.walkRules((rule) => {
  rules.push({
    selector: rule.selector,
    body: rule.nodes.map((n) => n.toString()).join(';'),
  });
});

/** A selector that only matches a focused element. */
const focusOnly = (selector: string) => /:focus(-visible|-within)?\b/.test(selector);
/**
 * Whether the rule ASSIGNS a ring, rather than merely referencing the variable.
 *
 * `shadow-glow` emits
 * `box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow)`
 * on the base rule — a reference with a transparent fallback, which is how an
 * unfocused .btn-cta keeps its glow and no ring. Matching the variable NAME
 * would call that a ring and the guard would fail on the correct output. Only
 * the assignment `--tw-ring-shadow: var(--tw-ring-inset) …` paints one.
 */
const paintsRing = (body: string) => /--tw-ring-shadow:\s*var\(--tw-ring-inset\)/.test(body);
const suppressesOutline = (body: string) => /outline:\s*2px solid transparent/.test(body);

describe('the focus ring is a focus indicator, not decoration', () => {
  it('emits .focus-ring only under a focus selector', () => {
    const bare = rules.filter((r) => /(^|[\s,>+~])\.focus-ring\b/.test(r.selector));
    expect(bare.length, 'the .focus-ring rule should be emitted at all').toBeGreaterThan(0);
    for (const rule of bare) {
      expect(focusOnly(rule.selector), `"${rule.selector}" paints the ring on an unfocused element`).toBe(true);
    }
  });

  // `focus-visible:focus-ring` compiles to `…:focus-visible:focus-visible` once
  // the declaration carries the pseudo-class itself. Duplicated, and still
  // matching — so the 16 call sites that already did the right thing keep working.
  it('keeps the 16 call sites that already scoped it themselves', () => {
    const variant = rules.find((r) => r.selector.includes('focus-visible\\:focus-ring'));
    expect(variant, 'the focus-visible:focus-ring variant should still be emitted').toBeDefined();
    expect(paintsRing(variant!.body)).toBe(true);
    expect(focusOnly(variant!.selector)).toBe(true);
  });

  // The two component classes that `@apply focus-ring`. Tailwind splits each into
  // a focus rule carrying the ring and a base rule carrying everything else; if
  // it ever stopped doing that, every .btn-cta in the app would go back to a
  // permanent ring and no focus indicator, and nothing else would notice.
  it.each(['btn-cta', 'btn-inline'])('.%s rings on focus and not before', (name) => {
    const base = rules.filter((r) => r.selector === `.${name}`);
    const focused = rules.filter((r) => r.selector === `.${name}:focus-visible`);
    expect(base.length, `.${name} should be emitted`).toBeGreaterThan(0);
    expect(focused.length, `.${name}:focus-visible should be emitted`).toBeGreaterThan(0);
    for (const rule of base) {
      expect(paintsRing(rule.body), `.${name} paints the ring unfocused`).toBe(false);
      expect(suppressesOutline(rule.body), `.${name} suppresses the native outline unfocused`).toBe(false);
    }
    expect(focused.some((r) => paintsRing(r.body))).toBe(true);
  });

  // The half that is easy to forget: `outline: 2px solid transparent` beats the
  // UA's :focus-visible outline, so leaving it on an unfocused element removes
  // the browser's own indicator even where no ring is painted.
  //
  // `.outline-none` is the exception and stays one: it is the raw utility, and a
  // developer writing class="outline-none" means it unconditionally.
  it('never suppresses the native outline on an unfocused element', () => {
    const offenders = rules
      .filter((r) => suppressesOutline(r.body) && !focusOnly(r.selector))
      .map((r) => r.selector)
      .filter((selector) => selector !== '.outline-none');
    expect(offenders).toEqual([]);
  });

  // Not a style question: an element with no visible focus state is unusable by
  // keyboard, and `tests/modal-a11y-contract.test.ts` verifies the modal TRAPS
  // focus — it needs somewhere visible to trap it to.
  it('still paints a ring worth seeing when focus does arrive', () => {
    const focused = rules.filter((r) => focusOnly(r.selector) && paintsRing(r.body));
    expect(focused.length).toBeGreaterThan(0);
    expect(focused.some((r) => r.body.includes('--tw-ring-color'))).toBe(true);
  });
});
