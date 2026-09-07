// lib/marketing/social-links.ts — Bubaly's own social profile URLs.
//
// Site-wide, not per-family: `public.social_settings` is the Social Command
// Center, where a family configures *its* posting. This is the company's own
// accounts, shown in the marketing footer and published as schema.org `sameAs`.
//
// This half is the catalogue and the validation, with no database in it, so the
// admin form (a client component) can share one platform list and one notion of
// a valid URL with the server that stores them. Reads and writes live in
// lib/server/social-links.ts, mirroring lib/features/tiers.ts vs
// lib/server/feature-tiers.ts.
//
// Nothing here is a secret, so it needs no encryption — but it is admin-entered
// text that ends up in an href, which is exactly the shape that turns into a
// javascript: link if nobody checks. Hence sanitizeSocialLinks: https only,
// real host, bounded length, and unknown platforms dropped.

/** Platforms the footer can render, in display order. */
export const SOCIAL_PLATFORMS = [
  { key: 'facebook', label: 'Facebook', placeholder: 'https://www.facebook.com/bubaly' },
  { key: 'youtube', label: 'YouTube', placeholder: 'https://www.youtube.com/@bubaly' },
  { key: 'x', label: 'X', placeholder: 'https://x.com/bubaly' },
  { key: 'instagram', label: 'Instagram', placeholder: 'https://www.instagram.com/bubaly' },
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'https://www.linkedin.com/company/bubaly' },
  { key: 'tiktok', label: 'TikTok', placeholder: 'https://www.tiktok.com/@bubaly' },
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]['key'];
export type SocialLinks = Partial<Record<SocialPlatform, string>>;

/**
 * The brand's canonical profile URLs, used when an admin has not set one.
 *
 * Without these the footer showed no icons at all until someone filled the
 * form in, which is a strange first impression: the row is part of the design,
 * not an optional extra. Each is the same URL the admin form offers as its
 * placeholder, so a default and a hand-entered value never disagree about what
 * the canonical handle is.
 *
 * These are defaults, not assertions — anything an admin saves wins, and
 * clearing a field falls back here rather than to nothing.
 */
export const DEFAULT_SOCIAL_LINKS: Record<SocialPlatform, string> = Object.fromEntries(
  SOCIAL_PLATFORMS.map((p) => [p.key, p.placeholder]),
) as Record<SocialPlatform, string>;

/**
 * Configured links over the defaults — what the footer should render.
 *
 * Kept separate from the stored value on purpose: the admin page must show
 * what is actually saved (so an empty field reads as empty), while the footer
 * wants something to draw for every platform.
 */
export function resolveSocialLinks(configured: SocialLinks): Record<SocialPlatform, string> {
  return { ...DEFAULT_SOCIAL_LINKS, ...sanitizeSocialLinks(configured) };
}

const PLATFORM_KEYS = new Set<string>(SOCIAL_PLATFORMS.map((p) => p.key));

/** A URL long enough for any real profile and short enough to bound the row. */
const MAX_URL = 300;

/**
 * One admin-entered URL, or null if it cannot be trusted in an href.
 *
 * Only https: a profile link is public and there is no reason to ship http, let
 * alone the javascript:/data: schemes that make a footer into an XSS vector.
 */
export function normalizeSocialUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.')) return null;
  return parsed.toString();
}

/** Stored value → the links we are willing to render. Never throws. */
export function sanitizeSocialLinks(value: unknown): SocialLinks {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean: SocialLinks = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!PLATFORM_KEYS.has(k)) continue;
    const url = normalizeSocialUrl(v);
    if (url) clean[k as SocialPlatform] = url;
  }
  return clean;
}
