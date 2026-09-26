import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { localeOrDefault } from '@/lib/i18n/locales';
import { getMessages } from '@/lib/i18n/messages';

// Render a client component the way the product renders one: under a provider.
//
// This exists because of a change that is easy to mistake for a regression.
// `translate` used to read `messages[key] ?? SOURCE_MESSAGES[key] ?? key`, and
// that middle term is a static import of the en-US catalogue — which is why
// en-US shipped to the browser on 406 of 606 pages (PERF-001, 841,247 B raw /
// 251,553 B gzip, measured on a production build). It now reads
// `messages[key] ?? key`, and the English fallback lives in `getMessages`,
// which is where a catalogue belongs.
//
// The product is unaffected: every provider is handed a COMPLETE map, either
// the merged catalogue (`namespaces="all"`) or a scope proved complete by
// tests/i18n-client-scope.test.ts. What WAS affected is a test that rendered a
// component with no provider at all and asserted English prose — ten files, a
// hundred-odd cases. Those were passing on the fallback, which means they were
// asserting the copy of a component mounted in a way the product never mounts
// it.
//
// So this is not a workaround for the change; it is the change making a gap
// visible. A component that calls `useTranslations()` needs a provider, and
// these tests now say so.
export function renderTranslated(node: ReactNode, locale = 'en-US'): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    {
      locale: localeOrDefault(locale), source: 'default', messages: getMessages(localeOrDefault(locale).code),
    } as Parameters<typeof LocaleProvider>[0],
    node,
  ));
}

/** The same, for a tree that must also sit inside another provider. */
export function withLocale(node: ReactNode, locale = 'en-US'): ReactElement {
  return createElement(
    LocaleProvider,
    {
      locale: localeOrDefault(locale), source: 'default', messages: getMessages(localeOrDefault(locale).code),
    } as Parameters<typeof LocaleProvider>[0],
    node,
  );
}
