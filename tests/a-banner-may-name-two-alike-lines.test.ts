import { describe, expect, it } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { at } from './helpers/source-order';

// The PartialReadBanner keyed each line by its text, so two lines that read
// alike — two live surveys of one name, both past the response ceiling — were
// two children with one key, which React reports and may reconcile as one
// (review R5-CEILING-POLISH). Each line is keyed by its position too. The keys
// are read off the element the component returns; a static render drops them.
function lineKeys(node: ReactNode): (string | null)[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === 'ul') return Children.toArray(element.props.children).map((child) => (isValidElement(child) ? child.key : null));
  return Children.toArray(element.props.children).flatMap(lineKeys);
}

describe('PartialReadBanner', () => {
  const failures = ['NPS', 'NPS', { label: 'members', detail: 'x' }, { label: 'members', detail: 'y' }];

  it('gives two lines that read alike two keys', () => {
    const element = PartialReadBanner({ title: 'Not shown:', failures });
    const keys = lineKeys(element);
    expect(keys).toHaveLength(failures.length);
    expect(new Set(keys).size).toBe(failures.length);
  });

  it('still renders every line, in order', () => {
    const html = renderToStaticMarkup(PartialReadBanner({ title: 'Not shown:', failures }));
    expect(html.split('<li>NPS</li>')).toHaveLength(3);
    expect(at(html, '>x</code>')).toBeLessThan(at(html, '>y</code>'));
  });
});
