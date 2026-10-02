import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// INT-O01. "Rate the app" opened https://apps.apple.com/ — the App Store's
// front page, which lists no Bubaly app. The review page carries the store
// listings an admin has configured and Bubaly's own review form.
describe('"Rate the app" leads somewhere a review can be left', () => {
  const profile = readFileSync('components/modules/profile-module.tsx', 'utf8');
  const row = profile.split('\n').find((line) => line.includes("t('profile.rateTheApp')")) ?? '';

  it('goes to the review page', () => {
    expect(row).toContain('href="/reviews/new"');
  });

  it('no longer opens a store front page with no listing on it', () => {
    expect(profile).not.toContain("'https://apps.apple.com/'");
  });

  it('the review page offers the configured store links', () => {
    const page = readFileSync('app/reviews/new/page.tsx', 'utf8');
    expect(page).toContain('app_store_url');
    expect(page).toContain('play_store_url');
  });
});
