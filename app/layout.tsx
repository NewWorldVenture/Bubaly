import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeScript } from '@/components/theme/theme-script';
import { ToastProvider } from '@/components/ui/toast';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Bubaly — The AI Operating System for Family Life',
    template: '%s · Bubaly',
  },
  description:
    'Less managing life, more living it. Bubaly is the AI Operating System for family life — quietly coordinating calls, emails, forms, scheduling, reminders, and the invisible work of running a household so your family can focus on what matters most.',
  applicationName: 'Bubaly',
  keywords: [
    'family operating system', 'AI family assistant', 'shared family calendar',
    'household management', 'family front desk', 'AI scheduling', 'reduce mental load',
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
    title: 'Bubaly — The AI Operating System for Family Life',
    description: 'Less Managing Life. More Living It. The AI Operating System that handles the invisible work of running a household.',
    url: SITE_URL,
  },
  twitter: { card: 'summary_large_image', title: 'Bubaly — The AI Operating System for Family Life', description: 'Less Managing Life. More Living It.' },
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
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
