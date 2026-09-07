'use client';

// Client-only mount for the Kitchen Display shell.
//
// Why: React error boundaries CANNOT catch errors during server-side rendering
// — any SSR throw anywhere in the shell's tree escapes every per-widget
// boundary and crashes the whole kiosk into the segment error page as an
// opaque digest (exactly the "One moment… forever" loop). A wall display gains
// nothing from SSR'd widget HTML, so we render the shell in the browser only:
//   • the widget boundaries actually work — a bad tile degrades to "—",
//     the screen as a whole can no longer be taken down by render errors;
//   • if something top-level ever does throw, the boundary shows a REAL
//     error message instead of a redacted digest.
// The server page still does all data loading (guarded) and passes plain props.
import dynamic from 'next/dynamic';
import { useTranslations } from '@/components/i18n/locale-provider';
import type { ComponentProps } from 'react';
import type { DisplayShell } from './display-grid';

// A NAMED component rather than an inline arrow, because `loading:` is rendered
// as a component and only a component can hold a hook. The arrow it replaced sat
// at module scope, where `useTranslations()` would have run once, outside React.
function ShellLoading() {
  const t = useTranslations();
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#0b1020]">
      <p className="animate-pulse text-sm font-semibold uppercase tracking-[0.25em] text-white/30">{t('displayShellClient.bubalyKitchen')}</p>
    </div>
  );
}

const Shell = dynamic(() => import('./display-grid').then((m) => m.DisplayShell), {
  ssr: false,
  loading: ShellLoading,
});

export function DisplayShellClient(props: ComponentProps<typeof DisplayShell>) {
  return <Shell {...props} />;
}
