import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeScript } from '@/components/theme/theme-script';
import { ToastProvider } from '@/components/ui/toast';
import { AndroidBackHandler } from '@/components/app/android-back-handler';
import { LAUNCH_SCREENS, launchScreenHref, launchScreenMedia } from '@/lib/pwa/launch-screens';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getLocaleContext } from '@/lib/i18n/server';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Bubaly — Less Managing Life. More Living It.',
    template: '%s · Bubaly',
  },
  description:
    'Bubaly is the AI operating system for family life. It quietly handles the logistics—phone calls, emails, scheduling, paperwork, reminders, and everyday coordination—so your family can spend less time managing life and more time living it.',
  applicationName: 'Bubaly',
  keywords: [
    'family organizer', 'shared family calendar', 'chores app', 'meal planning',
    'family AI assistant', 'household management', 'family operating system',
  ],
  authors: [{ name: 'Bubaly' }],
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Bubaly' },
  icons: {
    icon: [
      { url: '/icons/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'Bubaly',
    title: 'Bubaly — Less Managing Life. More Living It.',
    description: 'The AI operating system for family life. Bubaly handles the logistics so your family can spend less time managing life and more time living it.',
    url: SITE_URL,
  },
  twitter: { card: 'summary_large_image', title: 'Bubaly — Less Managing Life. More Living It.', description: 'The AI operating system for family life — so you spend less time managing life and more time living it.' },
  // Relative canonical resolves per-route against metadataBase, so every page
  // gets a self-referential canonical (https://www.bubaly.com<path>). This stops
  // duplicate URL variants — non-www, trailing slash, query strings, and the
  // *.vercel.app preview domains — from being indexed as separate pages.
  alternates: { canonical: './' },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#090c14' },
    { media: '(prefers-color-scheme: light)', color: '#f5f7fc' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved server-side from cookie → edge geo → Accept-Language, so the first
  // paint is already in the visitor's language. Doing this in the browser would
  // flash English on every load for everyone outside the US.
  const { locale, source, messages } = await getLocaleContext();

  return (
    <html lang={locale.code} dir={locale.dir} suppressHydrationWarning>
      <head>
        <ThemeScript />
        {/* Next emits the standard `mobile-web-app-capable` for appleWebApp.capable.
            iOS before 15.4 only honours the apple-prefixed name, and without it those
            devices open the home-screen icon in a Safari tab with browser chrome
            instead of standalone. Harmless on newer iOS, which accepts both. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* Per-device launch images — see lib/pwa/launch-screens.ts. */}
        {LAUNCH_SCREENS.map((screen) => (
          <link
            key={launchScreenHref(screen)}
            rel="apple-touch-startup-image"
            href={launchScreenHref(screen)}
            media={launchScreenMedia(screen)}
          />
        ))}
      </head>
      <body className="font-sans antialiased">
        <AndroidBackHandler />
        <LocaleProvider locale={locale} source={source} messages={messages}>
          <ToastProvider>{children}</ToastProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
