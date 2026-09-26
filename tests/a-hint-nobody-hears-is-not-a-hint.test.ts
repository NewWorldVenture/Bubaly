// C2-03: `components/ui/input.tsx`'s `Field` described itself as "fully
// accessible" and rendered three of its four affordances as pictures only.
//
//   hint      a <p> with no id and nothing pointing at it — never read aloud.
//   error     a <p role="alert"> with no id, and no `aria-invalid` on the
//             control. The message is announced once as it appears; tab back to
//             the field afterwards and you are told nothing is wrong.
//   required  a red asterisk, announced as "star" or skipped entirely.
//
// The seventh instance this sweep of a boundary stated where a reader can see it
// and absent from the layer that enforces it — and the most widely used, at
// 1,066 call sites.
//
// These render the real component through `react-dom/server` and read the HTML
// back, so what is asserted is what a browser would receive, not what the source
// says. Written with `createElement` rather than JSX because the suite collects
// `tests/**/*.test.ts` — the same shape as tests/display-render.test.ts.
import { describe, expect, it } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Field, Input, Select, Textarea, type FieldControlProps } from '@/components/ui/input';

const ROOT = join(__dirname, '..');

type FieldProps = { label: string; hint?: string; error?: string; required?: boolean };

function render(props: FieldProps, child: (id: string, control: FieldControlProps) => ReactNode): string {
  return renderToStaticMarkup(h(Field, { ...props, children: child }));
}

/** The id React's useId generates is opaque; pull the attributes back out. */
function controlAttrs(html: string, tag: 'input' | 'select' | 'textarea' = 'input'): Record<string, string> {
  const open = html.match(new RegExp(`<${tag}\\b[^>]*>`));
  if (!open) throw new Error(`no <${tag}> in ${html}`);
  const attrs: Record<string, string> = {};
  for (const m of open[0].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

describe('the hint and the error reach the control', () => {
  it('describes the control by the hint it renders', () => {
    const html = render({ label: 'Label', hint: 'Optional' }, (id) => h(Input, { id }));
    const describedBy = controlAttrs(html)['aria-describedby'];
    expect(describedBy, 'the control must point at something').toBeTruthy();
    // And that something must be the hint paragraph, actually present.
    expect(html).toContain(`<p id="${describedBy}"`);
    expect(html.slice(html.indexOf(`<p id="${describedBy}"`))).toContain('Optional');
  });

  it('marks the control invalid and describes it by the error', () => {
    const html = render({ label: 'Label', error: 'Enter a number' }, (id) => h(Input, { id }));
    const attrs = controlAttrs(html);
    expect(attrs['aria-invalid'], 'a field with an error is an invalid field').toBe('true');
    expect(html).toContain(`<p id="${attrs['aria-describedby']}"`);
    expect(html).toContain('Enter a number');
  });

  it('never describes the control by a hint it is not rendering', () => {
    // The hint is hidden while an error shows — it always was, visually. A
    // description pointing at an element that is not in the document is worse
    // than no description: the reader is told there is more and finds nothing.
    const html = render(
      { label: 'Label', hint: 'Optional', error: 'Enter a number' },
      (id) => h(Input, { id }),
    );
    expect(html).not.toContain('Optional');
    for (const id of controlAttrs(html)['aria-describedby'].split(' ')) {
      expect(html, `described by a missing #${id}`).toContain(`<p id="${id}"`);
    }
  });

  it('announces a required field instead of drawing a star at it', () => {
    const html = render({ label: 'Label', required: true }, (id) => h(Input, { id }));
    expect(controlAttrs(html)['aria-required']).toBe('true');
    // The asterisk is decoration once the control says it itself; announcing
    // "star" after the label is noise.
    expect(html).toMatch(/<span[^>]*aria-hidden[^>]*>\*<\/span>/);
  });

  it('wires selects and textareas too, not only inputs', () => {
    const select = render({ label: 'L', hint: 'H' }, (id) => h(Select, { id }, h('option', null, 'a')));
    expect(controlAttrs(select, 'select')['aria-describedby']).toBeTruthy();

    const textarea = render({ label: 'L', error: 'E' }, (id) => h(Textarea, { id }));
    expect(controlAttrs(textarea, 'textarea')['aria-invalid']).toBe('true');
  });

  it('never overwrites what the call site set for itself', () => {
    const html = render({ label: 'L', hint: 'H' }, (id) => h(Input, { id, 'aria-describedby': 'mine' }));
    expect(controlAttrs(html)['aria-describedby']).toBe('mine');
  });

  it('hands the same props to the render prop, for call sites that build their own markup', () => {
    let seen: Partial<FieldControlProps> = {};
    render({ label: 'L', hint: 'H', required: true }, (id, control) => {
      seen = { ...control };
      return h(Input, { id });
    });
    expect(seen['aria-describedby']).toBeTruthy();
    expect(seen['aria-required']).toBe(true);
  });

  it('leaves a field with neither hint nor error exactly as it was', () => {
    const html = render({ label: 'L' }, (id) => h(Input, { id }));
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('aria-invalid');
  });

  it('does not put a description on a wrapper that cannot carry one', () => {
    // ~19 call sites hand back a <div> around a group of chips or radios.
    // `aria-describedby` on a div announces nothing, so `Field` leaves it alone
    // rather than landing the attribute somewhere it reads as fixed and is not.
    const html = render({ label: 'L', hint: 'H' }, () => h('div', null, h('button', null, 'chip')));
    expect(html).not.toContain('aria-describedby');
  });
});

// ── The sites this cannot reach ──────────────────────────────────────────────
// Counted rather than assumed away, because a fix that quietly skips some of its
// targets while reading as universal is this repository's characteristic defect.
// The number may only go down — the honest fix for a group of radios is a
// fieldset or a radiogroup, per component.
describe('the call sites Field cannot wire are bounded, and shrink', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.tsx')) out.push(p);
    }
    return out;
  }

  const WIRABLE = /^(Input|Select|Textarea|input|select|textarea)$/;

  function unwirable(): string[] {
    const found: string[] = [];
    for (const file of [...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'app'))]) {
      const src = readFileSync(file, 'utf8');
      // Only the render-prop Field from the UI kit. components/home/field.tsx is
      // a DIFFERENT component that wraps its child in a <label>, so its children
      // are elements rather than a function and none of this applies.
      if (!src.includes("from '@/components/ui/input'")) continue;
      for (const m of src.matchAll(/<Field\b/g)) {
        const tail = src.slice(m.index, m.index! + 2000);
        const arrow = tail.match(/>\s*\{\s*(?:\([\w,\s]*\)|\w+)\s*=>\s*(?:\(\s*)?/);
        if (!arrow) continue;
        const body = tail.slice(arrow.index! + arrow[0].length).trimStart();
        const tag = body.match(/^<([A-Za-z][A-Za-z0-9.]*)/);
        if (tag && WIRABLE.test(tag[1])) continue;
        found.push(`${relative(ROOT, file).split(sep).join('/')}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    return found;
  }

  it('is a known, bounded set', () => {
    const sites = unwirable();
    // Measured at 25 of 1,066 when C2-03 was fixed — 97.7% of call sites reached.
    // Lower it as groups become fieldsets; a rise
    // means a new Field was written that the wrapper cannot reach.
    expect(sites.length, `unwirable Field call sites:\n${sites.join('\n')}`).toBeLessThanOrEqual(25);
  });
});
