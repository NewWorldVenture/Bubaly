import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Audit C1-S9-97 — found by the page audit crawl: every missing record under
 * /dashboard (a deleted trip, an old contact or post link) rendered
 * AppNotFound's DEFAULT copy, and the defaults were English literals in the
 * parameter list — "We couldn’t find that", "Go to dashboard" — where no
 * catalogue scanner looks. The wallet's own label was a literal too.
 */
const locale = vi.hoisted(() => ({ code: 'de-DE' }));
vi.mock('@/lib/i18n/server', async () => {
  const { getRawMessages, translate } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) =>
      translate(getRawMessages(locale.code as never), key, params),
  };
});
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return { default: ({ href, children }: { href: string; children: React.ReactNode }) => createElement('a', { href }, children) };
});

const { AppNotFound } = await import('@/components/app/app-not-found');

describe('a missing record is reported in the family’s language (C1-S9-97)', () => {
  it('renders its default title, description and action from the catalogue', async () => {
    const html = renderToStaticMarkup(await AppNotFound({}));
    expect(html).toContain('Das konnten wir nicht finden');
    expect(html).toContain('Zur Übersicht');
    expect(html).not.toContain('We couldn’t find that');
    expect(html).not.toContain('Go to dashboard');
  });

  it('still takes a caller’s own copy over the defaults', async () => {
    const html = renderToStaticMarkup(await AppNotFound({ title: 'Eigener Titel' }));
    expect(html).toContain('Eigener Titel');
  });

  it('no caller passes an English literal as a label', () => {
    for (const f of ['app/(app)/dashboard/not-found.tsx', 'app/(app)/wallet/not-found.tsx']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/(title|description|backLabel)="[A-Z][^"]*"/);
    }
  });
});
