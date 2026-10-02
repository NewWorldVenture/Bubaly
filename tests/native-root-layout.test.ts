import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n/server', () => ({ getLocaleContext: async () => ({ locale: { code: 'en', dir: 'ltr' }, source: 'default' }) }));
vi.mock('@/lib/i18n/scopes', () => ({ ROOT_CHROME_SCOPE: [], scopeMessages: () => ({}) }));
vi.mock('@/components/i18n/locale-provider', () => ({ LocaleProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/toast', () => ({ ToastProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/theme/theme-script', () => ({ ThemeScript: () => null }));
vi.mock('@/components/app/android-back-handler', () => ({ AndroidBackHandler: () => React.createElement('span', { 'data-native-back': true }) }));
vi.mock('@/components/native/native-bootstrap', () => ({ NativeBootstrap: () => React.createElement('span', { 'data-native-login-return': true }) }));
import RootLayout from '@/app/layout';

describe('native login return exists before authentication', () => {
  it('mounts one callback receiver for a signed-out login page alongside the single back handler', async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: React.createElement('form', { 'data-login-page': true }) }));
    expect(html).toContain('data-login-page');
    expect(html.match(/data-native-login-return/g)).toHaveLength(1);
    expect(html.match(/data-native-back/g)).toHaveLength(1);
  });
});
