'use client';

// Last-resort boundary: catches errors thrown in the ROOT layout itself, where
// app/error.tsx (a segment boundary) can't run because the layout — and its CSS
// import — never mounted. Next.js replaces the whole document with this, so it
// must render its own <html>/<body> and cannot rely on globals.css or Tailwind
// being present. Everything here is therefore inlined and self-contained.
import { useEffect } from 'react';
import { translate } from '@/lib/i18n/translate';
import { GLOBAL_ERROR_MESSAGES } from '@/lib/i18n/global-error-messages';

// Not `useTranslations()`, and not a LocaleProvider of its own either.
//
// This component is the boundary for an error thrown in the ROOT LAYOUT, so
// Next.js replaces the whole document and `app/layout.tsx` — the only thing
// that mounts a provider — never ran. It has therefore NEVER had one, in any
// locale, and its t() calls were resolving through translate()'s English
// fallback: already English-only for every visitor, always.
//
// lib/i18n/translate.ts removes that fallback so the 841 KB catalogue stops
// shipping to the browser, which would leave this page rendering
// `globalError.somethingWentWrong` at somebody whose session has just broken.
// So it carries its own four strings.
//
// Mounting a LocaleProvider here instead would mean inventing a locale and a
// source for a page that cannot know either, which dresses an English-only
// fallback up as localisation. Calling translate directly says what it is.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = (key: string) => translate(GLOBAL_ERROR_MESSAGES, key);
  useEffect(() => {
    console.error('[Bubaly] root error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1.25rem',
          padding: '1.5rem',
          textAlign: 'center',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: '#03090f',
          color: '#edf0f7',
        }}
      >
        <div
          aria-hidden
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 56,
            height: 56,
            borderRadius: 16,
            background: 'rgba(124, 93, 255, 0.16)',
            color: '#a78bfa',
            fontSize: 28,
            lineHeight: 1,
          }}
        >
          ⚠️
        </div>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600 }}>{t('globalError.somethingWentWrong')}</h1>
        <p style={{ margin: 0, maxWidth: 420, fontSize: '0.875rem', color: '#94a0b8', lineHeight: 1.6 }}>
          {t('globalError.bubalyHitAnUnexpectedErrorYour')}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              cursor: 'pointer',
              border: 'none',
              borderRadius: 12,
              padding: '0.625rem 1.25rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#ffffff',
              background: '#7c5dff',
            }}
          >
            {t('globalError.tryAgain')}
          </button>
          <a
            href="/home"
            style={{
              display: 'inline-block',
              textDecoration: 'none',
              borderRadius: 12,
              padding: '0.625rem 1.25rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#edf0f7',
              border: '1px solid rgba(237, 240, 247, 0.18)',
            }}
          >
            {t('globalError.reloadBubaly')}
          </a>
        </div>
        {error.digest && (
          <p style={{ margin: 0, fontSize: '0.75rem', color: '#6b7688' }}>
            Reference:{' '}
            <code style={{ background: 'rgba(237,240,247,0.08)', borderRadius: 4, padding: '0.1rem 0.35rem' }}>
              {error.digest}
            </code>
          </p>
        )}
      </body>
    </html>
  );
}
