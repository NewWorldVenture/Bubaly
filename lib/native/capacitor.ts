// lib/native/capacitor.ts
// Tiny web-safe wrappers around Capacitor runtime detection. @capacitor/core is
// plain browser JS, so importing it in the web build is harmless — on the web,
// isNativePlatform() is false and every native call below short-circuits. This
// lets the SAME codebase run as the website, the installed PWA, and the native
// iOS/iPadOS/Android shells without branching the app.
import { Capacitor } from '@capacitor/core';

export type NativePlatform = 'ios' | 'android' | 'web';

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function getPlatform(): NativePlatform {
  try {
    return Capacitor.getPlatform() as NativePlatform;
  } catch {
    return 'web';
  }
}
