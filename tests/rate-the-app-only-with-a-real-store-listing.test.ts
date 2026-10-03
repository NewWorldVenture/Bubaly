import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { storeListingUrl } from '@/lib/marketing/reputation';

// INT-O01, the owner's decision of 2026-10-02: "Rate the app" is hidden until a
// real app-store listing is configured. Not the App Store's front page (what it
// opened before), and not Bubaly's own /reviews/new form.

describe('storeListingUrl accepts a real listing and nothing else', () => {
  it('accepts an App Store app page and a Google Play details page', () => {
    expect(storeListingUrl({ app_store_url: 'https://apps.apple.com/us/app/bubaly/id1234567890' })).toBe('https://apps.apple.com/us/app/bubaly/id1234567890');
    expect(storeListingUrl({ play_store_url: 'https://play.google.com/store/apps/details?id=com.bubaly.app' })).toBe('https://play.google.com/store/apps/details?id=com.bubaly.app');
  });

  it('prefers the App Store listing when both are set', () => {
    expect(storeListingUrl({
      app_store_url: 'https://apps.apple.com/us/app/bubaly/id1',
      play_store_url: 'https://play.google.com/store/apps/details?id=com.bubaly.app',
    })).toBe('https://apps.apple.com/us/app/bubaly/id1');
  });

  it.each([
    ['nothing configured', {}],
    ['null settings', null],
    ['the App Store front page', { app_store_url: 'https://apps.apple.com/' }],
    ['an App Store page that names no app', { app_store_url: 'https://apps.apple.com/us/charts' }],
    ['plain http', { app_store_url: 'http://apps.apple.com/us/app/bubaly/id1' }],
    ['another host', { app_store_url: 'https://apps.apple.com.evil.example/us/app/x/id1' }],
    ['the Play front page', { play_store_url: 'https://play.google.com/store/apps' }],
    ['a Play page with no app id', { play_store_url: 'https://play.google.com/store/apps/details' }],
    ['Bubaly’s own review form', { app_store_url: '/reviews/new' }],
    ['seeder text', { app_store_url: 'Important task #1' }],
    ['credentials in the URL', { app_store_url: 'https://user:pw@apps.apple.com/us/app/x/id1' }],
  ])('rejects %s', (_label, settings) => {
    expect(storeListingUrl(settings as never)).toBeNull();
  });
});

describe('the profile row follows the listing', () => {
  const profile = readFileSync('components/modules/profile-module.tsx', 'utf8');
  const page = readFileSync('app/(app)/dashboard/profile/page.tsx', 'utf8');

  it('renders only when a listing was passed, and opens it with noopener', () => {
    expect(profile).toMatch(/\{storeListing && \(\s*<Row icon=\{Star\} label=\{t\('profile\.rateTheApp'\)\} onClick=\{\(\) => window\.open\(storeListing, '_blank', 'noopener,noreferrer'\)\}/);
  });

  it('never links the internal form or a store front page', () => {
    expect(profile).not.toContain('href="/reviews/new"');
    expect(profile).not.toContain("'https://apps.apple.com/'");
  });

  it('the page passes a validated listing, and none when the read failed', () => {
    expect(page).toContain("storeListing={listingQ.error ? null : storeListingUrl(listingQ.data)}");
  });
});
