import { describe, it, expect } from 'vitest';
import {
  detectPlatform, isSafePublicUrl, normalizeUrl, decodeEntities,
  parseMeta, inferKind, resolveImage, buildItemFromHtml,
} from '@/lib/social/unfurl';

describe('detectPlatform', () => {
  it('maps known hosts to platforms', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectPlatform('https://youtu.be/abc')).toBe('youtube');
    expect(detectPlatform('https://instagram.com/p/xyz')).toBe('instagram');
    expect(detectPlatform('https://www.tiktok.com/@a/video/1')).toBe('tiktok');
    expect(detectPlatform('https://x.com/a/status/1')).toBe('x');
    expect(detectPlatform('https://twitter.com/a/status/1')).toBe('x');
    expect(detectPlatform('https://www.facebook.com/a/posts/1')).toBe('facebook');
    expect(detectPlatform('https://www.linkedin.com/feed/update/1')).toBe('linkedin');
    expect(detectPlatform('https://www.reddit.com/r/x/comments/1')).toBe('reddit');
    expect(detectPlatform('https://pin.it/abc')).toBe('pinterest');
  });
  it('falls back to web for unknown hosts and junk', () => {
    expect(detectPlatform('https://example.com/article')).toBe('web');
    expect(detectPlatform('not a url')).toBe('web');
  });
});

describe('isSafePublicUrl', () => {
  it('accepts public http(s) urls', () => {
    expect(isSafePublicUrl('https://example.com')).toBe(true);
    expect(isSafePublicUrl('http://news.site.org/a')).toBe(true);
  });
  it('rejects non-http, localhost, and private ranges', () => {
    expect(isSafePublicUrl('ftp://example.com')).toBe(false);
    expect(isSafePublicUrl('javascript:alert(1)')).toBe(false);
    expect(isSafePublicUrl('http://localhost:3000')).toBe(false);
    expect(isSafePublicUrl('http://127.0.0.1')).toBe(false);
    expect(isSafePublicUrl('http://10.0.0.5')).toBe(false);
    expect(isSafePublicUrl('http://192.168.1.1')).toBe(false);
    expect(isSafePublicUrl('http://172.16.0.1')).toBe(false);
    expect(isSafePublicUrl('http://169.254.169.254')).toBe(false);
    expect(isSafePublicUrl('http://router.local')).toBe(false);
    expect(isSafePublicUrl('http://intranet')).toBe(false);
    expect(isSafePublicUrl('garbage')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('drops hash + tracking params, lowercases host', () => {
    expect(normalizeUrl('https://EXAMPLE.com/a?utm_source=x&id=5#frag'))
      .toBe('https://example.com/a?id=5');
  });
  it('removes a dangling question mark when only trackers existed', () => {
    expect(normalizeUrl('https://example.com/a?fbclid=xyz')).toBe('https://example.com/a');
  });
  it('is stable (idempotent) for the same logical link', () => {
    const a = normalizeUrl('https://x.com/a/status/1?s=20&utm_medium=share');
    const b = normalizeUrl('https://x.com/a/status/1');
    expect(a).toBe(b);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeEntities('it&#39;s &quot;great&quot;')).toBe('it’s "great"');
    expect(decodeEntities('caf&#233;')).toBe('café');
  });
});

describe('parseMeta', () => {
  const html = `
    <html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="Big News &amp; More" />
      <meta name="og:description" content="A short summary." >
      <meta content="https://cdn.site/img.jpg" property="og:image">
      <meta property="og:site_name" content="The Site">
      <meta property="og:type" content="video.other">
      <meta property="og:video:duration" content="754">
    </head><body>x</body></html>`;

  it('reads OG fields regardless of attribute order', () => {
    const m = parseMeta(html);
    expect(m.title).toBe('Big News & More');
    expect(m.description).toBe('A short summary.');
    expect(m.image).toBe('https://cdn.site/img.jpg');
    expect(m.siteName).toBe('The Site');
    expect(m.hasVideo).toBe(true);
    expect(m.duration).toBe('12:34');
  });

  it('falls back to <title> when og:title is missing', () => {
    expect(parseMeta('<title>Just A Title</title>').title).toBe('Just A Title');
  });

  it('detects twitter player card as video', () => {
    expect(parseMeta('<meta name="twitter:card" content="player">').hasVideo).toBe(true);
  });
});

describe('inferKind', () => {
  const base = { title: null, description: null, image: null, siteName: null, author: null, ogType: null, twitterCard: null, hasVideo: false, duration: null };
  it('video for youtube/tiktok and video meta', () => {
    expect(inferKind('youtube', base, false)).toBe('video');
    expect(inferKind('tiktok', base, false)).toBe('video');
    expect(inferKind('web', { ...base, hasVideo: true }, true)).toBe('video');
  });
  it('photo for instagram/pinterest with image', () => {
    expect(inferKind('instagram', base, true)).toBe('photo');
    expect(inferKind('pinterest', base, true)).toBe('photo');
  });
  it('link for generic web, post for social text', () => {
    expect(inferKind('web', base, false)).toBe('link');
    expect(inferKind('x', base, false)).toBe('post');
  });
});

describe('resolveImage', () => {
  it('resolves relative images against the page url', () => {
    expect(resolveImage('/img/a.jpg', 'https://site.com/post/1')).toBe('https://site.com/img/a.jpg');
    expect(resolveImage('https://cdn/x.jpg', 'https://site.com')).toBe('https://cdn/x.jpg');
    expect(resolveImage(null, 'https://site.com')).toBe(null);
  });
});

describe('buildItemFromHtml', () => {
  it('builds a complete YouTube video draft', () => {
    const html = `
      <title>ignored</title>
      <meta property="og:title" content="Funny Cats">
      <meta property="og:image" content="https://i.ytimg.com/t.jpg">
      <meta property="og:site_name" content="YouTube">
      <meta property="og:video:duration" content="95">`;
    const d = buildItemFromHtml('https://www.youtube.com/watch?v=abc&utm_source=share', html);
    expect(d.platform).toBe('youtube');
    expect(d.kind).toBe('video');
    expect(d.authorName).toBe('YouTube');
    expect(d.content).toBe('Funny Cats');
    expect(d.thumbnailUrl).toBe('https://i.ytimg.com/t.jpg');
    expect(d.mediaUrls).toEqual(['https://i.ytimg.com/t.jpg']);
    expect(d.durationLabel).toBe('1:35');
    expect(d.permalink).toBe('https://www.youtube.com/watch?v=abc'); // tracker stripped
    expect(d.externalId).toBe(d.permalink); // idempotency key = canonical url
  });

  it('joins title + description and pretty-names a generic host', () => {
    const html = `<meta property="og:title" content="Headline"><meta property="og:description" content="Details here.">`;
    const d = buildItemFromHtml('https://www.some-news.com/story', html);
    expect(d.platform).toBe('web');
    expect(d.kind).toBe('link');
    expect(d.authorName).toBe('Some-news');
    expect(d.content).toBe('Headline\n\nDetails here.');
  });

  it('falls back gracefully when there is no metadata', () => {
    const d = buildItemFromHtml('https://blank.example/x', '<html></html>');
    expect(d.platform).toBe('web');
    expect(d.content).toBe(null);
    expect(d.mediaUrls).toEqual([]);
    expect(d.authorName).toBe('Blank');
  });
});
