// lib/social/unfurl.ts — turn a pasted URL into a Social Feed item. PURE + tested.
//
// The Social Feed's live per-platform ingestion needs OAuth/API keys per network
// (integration-gated). This is the ungated path that works TODAY: paste any
// social or web link and we read its OpenGraph / Twitter-card metadata to build a
// real feed item — platform detected from the host, title → content, og:image →
// thumbnail, canonical permalink, kind (video/photo/link) inferred. No I/O here;
// the server action fetches the HTML and hands it to `buildItemFromHtml`.

import type { Platform } from '@/lib/social/feed';

/** Item kind matching the DB enum `social_item_kind`. */
export type ItemKind = 'post' | 'video' | 'photo' | 'link';

/** A draft item ready to insert into `social_reader_items`. */
export type UnfurlDraft = {
  platform: Platform | 'web';
  authorName: string;
  authorHandle: string | null;
  content: string | null;
  mediaUrls: string[];
  thumbnailUrl: string | null;
  permalink: string;
  kind: ItemKind;
  durationLabel: string | null;
  externalId: string;
};

// Query params that are pure tracking noise — stripped for a clean, canonical
// permalink + a stable idempotency key (so re-adding the same post is a no-op).
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'igshid', 'igsh', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
  'ref_url', 's', 'si', 'feature', 'spm', 'cmpid', 'cid', 'yclid', '_hsenc', '_hsmi',
];

const HOST_TO_PLATFORM: { match: (h: string) => boolean; platform: Platform }[] = [
  { match: (h) => /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(h), platform: 'youtube' },
  { match: (h) => /(^|\.)instagram\.com$/.test(h), platform: 'instagram' },
  { match: (h) => /(^|\.)tiktok\.com$/.test(h), platform: 'tiktok' },
  { match: (h) => /(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.watch$/.test(h), platform: 'facebook' },
  { match: (h) => /(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)t\.co$/.test(h), platform: 'x' },
  { match: (h) => /(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/.test(h), platform: 'linkedin' },
  { match: (h) => /(^|\.)reddit\.com$|(^|\.)redd\.it$/.test(h), platform: 'reddit' },
  { match: (h) => /(^|\.)pinterest\.[a-z.]+$|(^|\.)pin\.it$/.test(h), platform: 'pinterest' },
  { match: (h) => /(^|\.)whatsapp\.com$|(^|\.)wa\.me$/.test(h), platform: 'whatsapp' },
];

/** Detect the platform from a URL host. Unknown hosts → 'web' (generic link). */
export function detectPlatform(url: string): Platform | 'web' {
  const host = hostOf(url);
  if (!host) return 'web';
  for (const { match, platform } of HOST_TO_PLATFORM) if (match(host)) return platform;
  return 'web';
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** True for http(s) URLs that point at a public host (basic SSRF guard). */
export function isSafePublicUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (!host.includes('.') && !host.includes(':')) return false; // bare hostnames / no TLD
  // Block obvious private / link-local / loopback literals.
  if (/^127\./.test(host) || host === '0.0.0.0') return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  return true;
}

/** Canonicalize a URL: force host lowercase, drop the hash, strip tracking params. */
export function normalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim();
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
  // Drop a trailing "?" when no params remain.
  let out = u.toString();
  out = out.replace(/\?$/, '');
  return out;
}

/** Decode the handful of HTML entities that show up in OG meta content. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, '’')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => safeFromCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeFromCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function safeFromCode(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

export type PageMeta = {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  author: string | null;
  ogType: string | null;
  twitterCard: string | null;
  hasVideo: boolean;
  duration: string | null;
};

/**
 * Parse OpenGraph / Twitter-card / standard meta out of an HTML string.
 * Order-independent (reads `content` whichever side it's on) and resilient to
 * messy markup; falls back to <title> when og:title is absent.
 */
export function parseMeta(html: string): PageMeta {
  const metas = extractMetaTags(html);
  const get = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = metas.get(k.toLowerCase());
      if (v && v.trim()) return decodeEntities(v);
    }
    return null;
  };

  const titleTag = (() => {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return m ? decodeEntities(m[1].replace(/\s+/g, ' ')) : null;
  })();

  const durationSecs = get('og:video:duration', 'video:duration');
  const ogType = get('og:type');
  const twitterCard = get('twitter:card');

  return {
    title: get('og:title', 'twitter:title') ?? titleTag,
    description: get('og:description', 'twitter:description', 'description'),
    image: get('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'),
    siteName: get('og:site_name', 'application-name'),
    author: get('author', 'article:author', 'twitter:creator'),
    ogType,
    twitterCard,
    hasVideo: Boolean(get('og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player'))
      || (ogType?.startsWith('video') ?? false)
      || twitterCard === 'player',
    duration: formatDuration(durationSecs),
  };
}

function formatDuration(secs: string | null): string | null {
  if (!secs) return null;
  const n = parseInt(secs, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Pull every <meta> tag into a key→content map (property or name → content). */
function extractMetaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const tagRe = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
    const raw = tag[0];
    const key = attr(raw, 'property') ?? attr(raw, 'name') ?? attr(raw, 'itemprop');
    const content = attr(raw, 'content');
    if (key && content !== null) {
      const k = key.toLowerCase();
      if (!out.has(k)) out.set(k, content); // first wins
    }
  }
  return out;
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

/** Resolve a possibly-relative image URL against the page URL. */
export function resolveImage(image: string | null, pageUrl: string): string | null {
  if (!image) return null;
  try {
    return new URL(image, pageUrl).toString();
  } catch {
    return null;
  }
}

/** Infer the item kind from platform + parsed metadata. */
export function inferKind(platform: Platform | 'web', meta: PageMeta, hasImage: boolean): ItemKind {
  if (meta.hasVideo || platform === 'youtube' || platform === 'tiktok') return 'video';
  if (hasImage && (platform === 'instagram' || platform === 'pinterest')) return 'photo';
  if (platform === 'web') return 'link';
  return hasImage ? 'photo' : 'post';
}

/** Build a feed-item draft from a URL + its fetched HTML. */
export function buildItemFromHtml(url: string, html: string): UnfurlDraft {
  const permalink = normalizeUrl(url);
  const platform = detectPlatform(permalink);
  const meta = parseMeta(html);
  const image = resolveImage(meta.image, permalink);
  const host = hostOf(permalink) ?? 'the web';

  const authorName = meta.siteName?.trim() || prettyHost(host);
  const title = meta.title?.trim() || null;
  const description = meta.description?.trim() || null;
  // Title is the headline; add the description when it adds something new.
  const content = joinContent(title, description);
  const kind = inferKind(platform, meta, Boolean(image));

  return {
    platform,
    authorName,
    authorHandle: meta.author?.trim() ? normalizeHandle(meta.author) : null,
    content,
    mediaUrls: image ? [image] : [],
    thumbnailUrl: image,
    permalink,
    kind,
    durationLabel: meta.duration,
    externalId: permalink,
  };
}

function joinContent(title: string | null, description: string | null): string | null {
  if (title && description && !title.includes(description) && !description.includes(title)) {
    return `${title}\n\n${description}`;
  }
  return title ?? description;
}

function normalizeHandle(author: string): string {
  const a = author.trim();
  if (/^https?:\/\//i.test(a)) {
    const h = hostOf(a);
    return h ? `@${h.split('.')[0]}` : a;
  }
  return a.startsWith('@') ? a : `@${a.replace(/\s+/g, '')}`;
}

function prettyHost(host: string): string {
  const base = host.split('.').slice(-2, -1)[0] ?? host;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
