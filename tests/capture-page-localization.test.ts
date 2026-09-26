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
  // loadCaptureShortcuts answers a RESULT, not a bare array: a failed read has to
  // be distinguishable from "nothing saved" (see the type's own comment).
  state.load.mockReset().mockResolvedValue({ ok: true, keys: ['calendar', 'tasks'] });
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

  // A failed read must not reach the client as a confident answer. `null` is the
  // component's "no answer yet" value: it sends the grid down its cache + retry
  // path and keeps it from saving a guessed layout over the member's real one.
  it('hands the client "no answer" — never an empty layout — when the read failed', async () => {
    state.load.mockResolvedValue({ ok: false, error: 'canceling statement due to statement timeout' });
    const html = renderToStaticMarkup(await CapturePage({}));
    expect(html).toContain('data-shortcuts="null"');
    expect(html).not.toContain('data-shortcuts="[]"');
  });

  it('preserves login redirects before reading the saved shortcut layout', async () => {
    const redirect = new Error('NEXT_REDIRECT');
    state.auth.mockRejectedValue(redirect);
    await expect(CapturePage({})).rejects.toBe(redirect);
    expect(state.load).not.toHaveBeenCalled();
  });
});
