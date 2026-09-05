import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Bubaly ships two native tracks (docs/mobile.md): the Capacitor shell wrapping
// the hosted web app, and the Expo companion in mobile/. They are two DISTINCT
// iOS apps, so they must not share an identifier — App Store Connect binds one
// bundle id to one app record, and on a device the second install replaces the
// first rather than sitting beside it. That makes testing both at once
// impossible, and the failure is silent until submission.

const root = process.cwd();
const capacitor = readFileSync(resolve(root, 'capacitor.config.ts'), 'utf8');
const expo = JSON.parse(readFileSync(resolve(root, 'mobile/app.json'), 'utf8'));

function capacitorAppId(): string {
  const match = capacitor.match(/appId:\s*'([^']+)'/);
  expect(match, 'capacitor.config.ts must declare an appId').not.toBeNull();
  return match![1];
}

describe('native bundle identifiers', () => {
  it('gives the Capacitor shell and the Expo companion different iOS identifiers', () => {
    expect(capacitorAppId()).not.toBe(expo.expo.ios.bundleIdentifier);
  });

  it('gives them different Android package names', () => {
    expect(capacitorAppId()).not.toBe(expo.expo.android.package);
  });

  it('keeps both identifiers present and reverse-DNS shaped', () => {
    for (const id of [capacitorAppId(), expo.expo.ios.bundleIdentifier, expo.expo.android.package]) {
      expect(id).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
    }
  });
});
