import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeScript } from '@/components/theme/theme-script';
import { ToastProvider } from '@/components/ui/toast';
import { AndroidBackHandler } from '@/components/app/android-back-handler';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Bubaly — Less Life Admin. More Living Life.',
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
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'Bubaly',
    title: 'Bubaly — Less Life Admin. More Living Life.',
    description: 'The AI operating system for family life. Bubaly handles the logistics so your family can spend less time managing life and more time living it.',
    url: SITE_URL,
  },
  twitter: { card: 'summary_large_image', title: 'Bubaly — Less Life Admin. More Living Life.', description: 'The AI operating system for family life — so you spend less time managing life and more time living it.' },
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="font-sans antialiased">
        <AndroidBackHandler />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
