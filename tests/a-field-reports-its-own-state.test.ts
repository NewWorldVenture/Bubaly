// Two primitives that documented a guarantee they did not hold.
//
// `Field` in components/ui/input.tsx described itself as "fully accessible". The
// error is rendered with `role="alert"`, so it is ANNOUNCED ONCE when it appears
// — and then the control reported nothing at all. A user who tabs back to the
// field afterwards, or who reaches it any way other than at the instant the error
// appeared, is told the field is fine. WCAG 3.3.1 asks the FIELD to identify
// itself as in error; a message sitting near it is not the same thing.
//
// And both search sanitizers state their purpose as stopping a query that would
// "quietly match far more than the person typed" — while missing `*`. PostgREST
// accepts `*` as a SPELLING of `%` in a like/ilike value. It is not a SQL
// wildcard, which is exactly why a character class written against the LIKE
// grammar does not contain it, and why two independently-written sanitizers made
// the same omission. A search for `*` became `%%%%` and returned every row the
// caller could see.
//
// JSX-free on purpose: every one of this suite's 1,217 files is `.ts`, and
// vitest.config.ts includes only `tests/**/*.test.ts`. Adding the first `.tsx`
// would mean widening that glob for one file.
import { describe, expect, it } from 'vitest';
import { createElement, Fragment, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Field, Input, type FieldAria } from '@/components/ui/input';
import { sanitizeQuery } from '@/lib/services/search/index';

const field = (
  props: { label: string; error?: string; hint?: string },
  render: (id: string, aria: FieldAria) => ReactElement,
) => renderToStaticMarkup(createElement(Field, props, render));

const input = (extra: Record<string, unknown> = {}) => {
  const control = (id: string) => createElement(Input, { id, ...extra });
  control.displayName = 'TestInput';
  return control;
};

describe('Field marks the control, not just the page', () => {
  it('sets aria-invalid on the control when there is an error', () => {
    const out = field({ label: 'Amount', error: 'Too big' }, input());
    expect(out).toContain('aria-invalid="true"');
    // And the message is addressable, not merely present nearby.
    const describedBy = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    expect(describedBy, 'the control must point at a message').toBeTruthy();
    expect(out, 'and that id must exist on the error paragraph').toContain(`id="${describedBy}"`);
    expect(out).toContain('role="alert"');
  });

  it('does not claim invalid when the field is fine, and points at the hint instead', () => {
    const out = field({ label: 'Amount', hint: 'In dollars' }, input());
    expect(out, 'a healthy field must not report itself invalid').not.toContain('aria-invalid');
    const describedBy = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    expect(describedBy).toBeTruthy();
    expect(out).toContain(`id="${describedBy}"`);
    expect(out).toContain('In dollars');
  });

  it('says nothing when there is neither an error nor a hint', () => {
    const out = field({ label: 'Amount' }, input());
    expect(out).not.toContain('aria-invalid');
    expect(out).not.toContain('aria-describedby');
  });

  // The fix is applied CENTRALLY by cloning the render prop's element, which is
  // what makes 124 call sites correct without touching one of them. A call site
  // that sets either attribute itself must still win.
  it('never overwrites a value the call site set itself', () => {
    const out = field({ label: 'Amount', error: 'Too big' }, input({ 'aria-describedby': 'my-own-note' }));
    expect(out).toContain('aria-describedby="my-own-note"');
    expect(out, 'the error state still applies').toContain('aria-invalid="true"');
  });

  // A render prop returning something other than a single element is left exactly
  // as it was rather than guessed at — the second argument exists for those.
  it('leaves a multi-element render prop alone and hands it the props instead', () => {
    let seen: FieldAria | null = null;
    const out = field({ label: 'Range', error: 'Bad' }, (id, aria) => {
      seen = aria;
      return createElement(Fragment, null, createElement(Input, { id }), createElement(Input, {}));
    });
    expect(seen, 'the render prop receives what it needs to apply them itself')
      .toMatchObject({ 'aria-invalid': true });
    // Nothing was cloned onto the fragment, so neither input carries it.
    expect(out).not.toContain('aria-invalid="true"');
  });
});

describe('the search sanitizers know that * is a wildcard to PostgREST', () => {
  it('neutralises * alongside the SQL wildcards', () => {
    expect(sanitizeQuery('*')).toBe('');
    expect(sanitizeQuery('a*b')).toBe('a b');
    expect(sanitizeQuery('%_*')).toBe('');
    // The characters it already handled keep working.
    expect(sanitizeQuery('a%b_c')).toBe('a b c');
    expect(sanitizeQuery('  hello   world  ')).toBe('hello world');
  });

  it('leaves an ordinary query untouched', () => {
    expect(sanitizeQuery('school forms')).toBe('school forms');
    expect(sanitizeQuery("Emma's passport")).toBe("Emma's passport");
  });

  it('the AI-activity sanitizer escapes * too', async () => {
    // safeSearchTerm is module-private, so this asserts the character class it is
    // built from — which is the thing that was wrong — rather than reaching in.
    const fs = await import('node:fs');
    const source = fs.readFileSync('lib/ai/activity.ts', 'utf8');
    expect(source, 'the escape class must contain *').toMatch(/replace\(\/\[\\\\%_\*\]\/g/);
  });
});
