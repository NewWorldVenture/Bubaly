import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeScript } from '@/components/theme/theme-script';
import { ToastProvider } from '@/components/ui/toast';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://theagoras.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'FamilyOS — Run your family like a calm, connected team',
    template: '%s · FamilyOS',
  },
  description:
    'FamilyOS is an AI chief of staff for your household: calendar, chores, meals, grocery, school, sports, health, home maintenance, documents, and an assistant that takes real action.',
  applicationName: 'FamilyOS',
  keywords: [
    'family organizer', 'shared family calendar', 'chores app', 'meal planning',
    'family AI assistant', 'household management', 'family operating system',
  ],
  authors: [{ name: 'FamilyOS' }],
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'FamilyOS' },
  openGraph: {
    type: 'website',
    siteName: 'FamilyOS',
    title: 'FamilyOS — Run your family like a calm, connected team',
    description: 'An AI chief of staff for busy households. One calm place for everything.',
    url: SITE_URL,
  },
  twitter: { card: 'summary_large_image', title: 'FamilyOS', description: 'An AI chief of staff for busy households.' },
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
