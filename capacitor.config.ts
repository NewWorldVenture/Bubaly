import type { CapacitorConfig } from '@capacitor/cli';

// Bubaly native shell (iOS / iPadOS / Android).
//
// The app is a dynamic Next.js application (SSR, server actions, Supabase auth
// over cookies). Rather than a static export that would break that wiring, the
// native shells load the hosted production app and add native capabilities on
// top (push, status bar, splash, deep links, haptics). This keeps 100% of the
// existing Supabase integration intact while shipping real App Store / Play
// Store binaries.
//
// Override the URL per environment with CAP_SERVER_URL (e.g. a LAN dev server,
// http://192.168.x.x:3000, with `allowNavigation` for OAuth/magic-link hosts).
const SERVER_URL = process.env.CAP_SERVER_URL || 'https://www.bubaly.com';

const config: CapacitorConfig = {
  appId: 'com.bubaly.bubaly',
  appName: 'Bubaly',
  // webDir is required by the CLI even when serving from a remote URL; the
  // generated public/ folder (icons, manifest) is a valid, present directory.
  webDir: 'public',
  ios: {
    contentInset: 'always',
    backgroundColor: '#090c14',
    limitsNavigationsToAppBoundDomains: true,
  },
  android: {
    backgroundColor: '#090c14',
  },
  server: {
    url: SERVER_URL,
    androidScheme: 'https',
    iosScheme: 'https',
    cleartext: SERVER_URL.startsWith('http://'),
    // Auth providers + Supabase need to load inside the shell during sign-in.
    allowNavigation: [
      'www.bubaly.com',
      'bubaly.com',
      '*.supabase.co',
      'accounts.google.com',
      '*.google.com',
    ],
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#090c14',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#090c14',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Keyboard: {
      resize: 'native',
    },
  },
};

export default config;
