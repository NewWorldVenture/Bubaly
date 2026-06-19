import type { MetadataRoute } from 'next';

/** PWA manifest — enables "Add to Home Screen" and installable app behavior. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FamilyOS — Family Operating System',
    short_name: 'FamilyOS',
    description: 'An AI chief of staff for busy households.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#090c14',
    theme_color: '#090c14',
    categories: ['productivity', 'lifestyle', 'utilities'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
