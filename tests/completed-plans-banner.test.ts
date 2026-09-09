import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TimeSavedBanner } from '@/components/metric/time-saved-banner';
import { computeTimeSaved } from '@/lib/metric/time-saved';

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

describe('recorded-plan planning-time banner', () => {
  it('shows the modeling assumption and the excluded undated coverage', async () => {
    const rendered = textOf(await TimeSavedBanner({ result: { available: true, data: computeTimeSaved([{ kind: 'run', count: 2 }], 3) }, retryHref: '/home' }));
    expect(rendered).toContain('24 min modeled planning time');
    expect(rendered).toContain('2 recorded completed plans');
    expect(rendered).toContain('Assumes 12 minutes');
    expect(rendered).toContain('3 completed plans have no completion date');
    expect(rendered).not.toContain('things handled for you');
  });

  it('retains undated coverage when no dated plan is in the week', async () => {
    const rendered = textOf(await TimeSavedBanner({ result: { available: true, data: computeTimeSaved([{ kind: 'run', count: 0 }], 1) }, retryHref: '/home' }));
    expect(rendered).toContain('0 recorded completed plans');
    expect(rendered).toContain('1 completed plans have no completion date');
  });

  it('keeps unavailable distinct from an empty measured subset', async () => {
    const rendered = textOf(await TimeSavedBanner({ result: { available: false }, retryHref: '/home' }));
    expect(rendered).toContain('We could not read the recorded completed plans.');
    expect(rendered).toContain('Try again');
    expect(rendered).not.toContain('0 recorded');
    expect(await TimeSavedBanner({ result: { available: true, data: computeTimeSaved([{ kind: 'run', count: 0 }]) }, retryHref: '/home' })).toBeNull();
  });
});
