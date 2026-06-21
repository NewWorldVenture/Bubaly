import { describe, expect, it } from 'vitest';
import {
  effectiveLength, charsRemaining, extractHashtags, extractMentions,
  validateForPlatform, hasBlockingErrors, derivePostStatus, canTransition,
} from '@/lib/social/content';

describe('character counting', () => {
  it('counts plain text by code points', () => {
    expect(effectiveLength('hello', 'facebook')).toBe(5);
  });

  it('weights URLs as 23 chars on X', () => {
    const body = 'see https://example.com/a/very/long/path/that/keeps/going';
    expect(effectiveLength(body, 'x')).toBe('see '.length + 23);
  });

  it('charsRemaining goes negative when over the limit', () => {
    const long = 'a'.repeat(281);
    expect(charsRemaining(long, 'x')).toBe(-1);
  });
});

describe('hashtag and mention extraction', () => {
  it('extracts and dedupes hashtags lowercased', () => {
    expect(extractHashtags('Love #Summer and #summer #Beach')).toEqual(['summer', 'beach']);
  });
  it('extracts mentions', () => {
    expect(extractMentions('hi @alice and @bob_99')).toEqual(['alice', 'bob_99']);
  });
});

describe('per-platform validation', () => {
  it('flags over-limit captions as errors', () => {
    const issues = validateForPlatform({ kind: 'text', body: 'a'.repeat(300) }, 'x');
    expect(hasBlockingErrors(issues, 'x')).toBe(true);
  });

  it('requires a video for TikTok', () => {
    const issues = validateForPlatform({ kind: 'video', body: 'hi', hasVideo: false }, 'tiktok');
    expect(issues.some((i) => i.severity === 'error' && /video/i.test(i.message))).toBe(true);
  });

  it('rejects images beyond the platform max', () => {
    const issues = validateForPlatform({ kind: 'image', body: 'hi', imageCount: 6 }, 'x');
    expect(issues.some((i) => /at most 4/.test(i.message))).toBe(true);
  });

  it('warns (not errors) on hashtags for Reddit', () => {
    const issues = validateForPlatform({ kind: 'text', body: 'hello #world' }, 'reddit');
    expect(hasBlockingErrors(issues, 'reddit')).toBe(false);
    expect(issues.some((i) => i.severity === 'warning')).toBe(true);
  });

  it('errors on a completely empty post', () => {
    const issues = validateForPlatform({ kind: 'text', body: '   ', imageCount: 0 }, 'facebook');
    expect(hasBlockingErrors(issues)).toBe(true);
  });

  it('accepts a valid short caption', () => {
    const issues = validateForPlatform({ kind: 'text', body: 'Hello world!' }, 'facebook');
    expect(hasBlockingErrors(issues)).toBe(false);
  });
});

describe('publish status state machine', () => {
  it('all published → published', () => {
    expect(derivePostStatus(['published', 'published'])).toBe('published');
  });
  it('mixed published + failed → partially_published', () => {
    expect(derivePostStatus(['published', 'failed'])).toBe('partially_published');
  });
  it('all failed → failed', () => {
    expect(derivePostStatus(['failed', 'failed'])).toBe('failed');
  });
  it('any still publishing → publishing', () => {
    expect(derivePostStatus(['published', 'publishing'])).toBe('publishing');
  });
  it('no targets → draft', () => {
    expect(derivePostStatus([])).toBe('draft');
  });

  it('enforces legal transitions', () => {
    expect(canTransition('draft', 'scheduled')).toBe(true);
    expect(canTransition('published', 'draft')).toBe(false);
    expect(canTransition('failed', 'publishing')).toBe(true);
  });
});
