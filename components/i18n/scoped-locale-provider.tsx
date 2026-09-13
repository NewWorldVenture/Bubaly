// components/i18n/scoped-locale-provider.tsx — a LocaleProvider carrying only
// the part of the catalogue a surface can actually use.
//
// Server component: it resolves the request's locale, narrows the catalogue to
// the given namespaces, and hands the result to the client provider. Nesting
// one of these inside the root layout's provider replaces the context for the
// subtree, which is what lets a marketing page ship 2 KB of strings while the
// authenticated app keeps all 812 KB.

import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getLocaleContext } from '@/lib/i18n/server';
import { scopeMessages } from '@/lib/i18n/scopes';

export async function ScopedLocaleProvider({
  namespaces,
  children,
}: {
  /** The namespaces this surface's client components use, or 'all' for the
   *  authenticated app, whose keys cannot be determined statically. */
  namespaces: readonly string[] | 'all';
  children: React.ReactNode;
}) {
  const { locale, source, messages } = await getLocaleContext();
  return (
    <LocaleProvider
      locale={locale}
      source={source}
      messages={namespaces === 'all' ? messages : scopeMessages(messages, namespaces)}
    >
      {children}
    </LocaleProvider>
  );
}
