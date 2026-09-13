// The root layout carries only its own chrome's strings now, so each surface
// outside a route group declares what its client components need. See
// lib/i18n/scopes.ts.
import { ScopedLocaleProvider } from '@/components/i18n/scoped-locale-provider';
import { PUBLIC_LINK_SCOPE } from '@/lib/i18n/scopes';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ScopedLocaleProvider namespaces={PUBLIC_LINK_SCOPE}>{children}</ScopedLocaleProvider>;
}
