// Page audit, signed-in sweep — a missing record inside the app is answered in
// place, in the reader's language, not thrown into the stream.
//
// Every page under app/(app) renders inside app/(app)/loading.tsx's Suspense
// boundary, so by the time a page found its record missing the shell had
// already been sent. `notFound()` there could no longer set a 404; it errored
// the streamed boundary instead, and the browser logged React #419 as an
// uncaught error on 13 of the sweep's not-found paths (/dashboard/vacations/<id>
// and its nine tabs, /marketplace/item/<id>, /wallet/children/<id>, …) while the
// visitor saw the not-found card anyway. 22 call sites now render <AppNotFound>
// themselves. And that card's copy was English literals in every language.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderTranslated } from './helpers/render-translated';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? files(p) : /^(page|layout)\.tsx$/.test(entry) ? [p] : [];
  });
}

describe('no page in the app throws notFound() into the stream', () => {
  it('every app/(app) page and layout answers a missing record itself', () => {
    const throwing = files(join('app', '(app)')).filter((file) =>
      readFileSync(file, 'utf8').split('\n').some((line) => /\bnotFound\(\)/.test(line.split('//')[0])));
    expect(throwing, 'return <AppNotFound … /> instead').toEqual([]);
  });
});

const DE = JSON.parse(readFileSync('lib/i18n/messages/de-DE.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', async () => {
  const messages = JSON.parse((await import('node:fs')).readFileSync('lib/i18n/messages/de-DE.json', 'utf8')) as Record<string, string>;
  return { getTranslations: async () => (key: string) => messages[key] ?? key };
});

describe('the not-found card speaks the reader\'s language', () => {
  it('renders the catalogue copy, not English literals', async () => {
    const { AppNotFound } = await import('@/components/app/app-not-found');
    const html = renderTranslated(await AppNotFound({ backHref: '/dashboard' }), 'de-DE');
    expect(DE['appNotFound.title']).toEqual(expect.any(String));
    expect(html).toContain(DE['appNotFound.title']);
    expect(html).toContain(DE['appNotFound.description']);
    expect(html).toContain(DE['notFound.goToDashboard']);
    expect(html).not.toContain('We couldn’t find that');
    expect(html).not.toContain('Go to dashboard');
  });
});
