import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const state = vi.hoisted(() => ({ locale: 'en-US' as LocaleCode, auth: vi.fn(), load: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => translate(getMessages(state.locale), key),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: state.auth }));
vi.mock('@/app/(app)/capture/shortcuts-actions', () => ({ loadCaptureShortcuts: state.load }));
vi.mock('@/components/capture/capture-shell', () => ({
  CaptureShell: ({ initialText, initialShortcuts }: { initialText: string; initialShortcuts: string[] }) =>
    createElement('section', { 'data-shortcuts': JSON.stringify(initialShortcuts) }, initialText),
}));
const { default: CapturePage, generateMetadata } = await import('@/app/(app)/capture/page');
const locales: LocaleCode[] = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];

beforeEach(() => {
  state.locale = 'en-US';
  state.auth.mockReset().mockResolvedValue({});
  state.load.mockReset().mockResolvedValue(['calendar', 'tasks']);
});

describe('Capture page locale and server boundaries', () => {
  it.each(locales)('uses the %s Capture heading in page metadata', async (locale) => {
    state.locale = locale;
    const expected = getRawMessages(locale)['captureShell.capture'];
    expect(expected).toBeTruthy();
    expect(await generateMetadata()).toEqual({ title: expected });
    expect(state.auth).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
  });

  it('keeps saved shortcut IDs and shared text in the authenticated first render', async () => {
    const html = renderToStaticMarkup(await CapturePage({ searchParams: Promise.resolve({ text: 'A shared school note' }) }));
    expect(html).toContain('A shared school note');
    expect(html).toContain('data-shortcuts="[&quot;calendar&quot;,&quot;tasks&quot;]"');
    expect(state.auth).toHaveBeenCalledOnce();
    expect(state.load).toHaveBeenCalledOnce();
    expect(state.auth.mock.invocationCallOrder[0]).toBeLessThan(state.load.mock.invocationCallOrder[0]);
  });

  it('preserves login redirects before reading the saved shortcut layout', async () => {
    const redirect = new Error('NEXT_REDIRECT');
    state.auth.mockRejectedValue(redirect);
    await expect(CapturePage({})).rejects.toBe(redirect);
    expect(state.load).not.toHaveBeenCalled();
  });
});
