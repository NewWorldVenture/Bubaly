import { describe, expect, it } from 'vitest';
import {
  PROVIDERS, PLATFORMS, getProvider, isPlatform, PLATFORM_LABELS,
} from '@/lib/social/capabilities';

// Locks in the HONEST per-platform capability matrix. Asserting known API limits
// means a future change that fakes support for a non-existent capability breaks
// the build instead of shipping a lie.
describe('social provider capabilities', () => {
  it('covers all nine platforms with a definition each', () => {
    expect(PLATFORMS).toHaveLength(9);
    for (const p of PLATFORMS) {
      expect(PROVIDERS[p].platform).toBe(p);
      expect(PLATFORM_LABELS[p]).toBeTruthy();
    }
  });

  it('TikTok and YouTube are video-only (no image posts)', () => {
    expect(PROVIDERS.tiktok.media.image).toBe(false);
    expect(PROVIDERS.tiktok.media.maxImages).toBe(0);
    expect(PROVIDERS.youtube.media.video).toBe(true);
  });

  it('platforms needing Meta/TikTok/LinkedIn review are flagged', () => {
    expect(PROVIDERS.instagram.needsAppReview).toBe(true);
    expect(PROVIDERS.tiktok.needsAppReview).toBe(true);
    expect(PROVIDERS.linkedin.needsAppReview).toBe(true);
  });

  it('Reddit and X do not require app review', () => {
    expect(PROVIDERS.reddit.needsAppReview).toBe(false);
    expect(PROVIDERS.x.needsAppReview).toBe(false);
  });

  it('platforms without an inbox API are honestly marked unsupported', () => {
    expect(PROVIDERS.tiktok.inbox.supported).toBe(false);
    expect(PROVIDERS.pinterest.inbox.supported).toBe(false);
    expect(PROVIDERS.linkedin.inbox.supported).toBe(false);
  });

  it('Reddit has no post-level analytics API', () => {
    expect(PROVIDERS.reddit.analytics.supported).toBe(false);
  });

  it('every provider declares credential env vars and scopes', () => {
    for (const p of PLATFORMS) {
      expect(PROVIDERS[p].credentialEnv.length).toBeGreaterThan(0);
      expect(PROVIDERS[p].requiredScopes.length).toBeGreaterThan(0);
    }
  });

  it('isPlatform / getProvider behave as guards', () => {
    expect(isPlatform('x')).toBe(true);
    expect(isPlatform('myspace')).toBe(false);
    expect(getProvider('facebook').label).toBe('Facebook Pages');
  });

  it('character limits reflect real platform caps', () => {
    expect(PROVIDERS.x.charLimit).toBe(280);
    expect(PROVIDERS.threads.charLimit).toBe(500);
    expect(PROVIDERS.pinterest.charLimit).toBe(500);
  });
});
