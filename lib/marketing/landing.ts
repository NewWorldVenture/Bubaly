// lib/marketing/landing.ts — pure helpers for public marketing landing pages.
// CTA resolution from the page's metadata + slug sanitisation, unit-tested.

/**
 * `label` is null when the page did not author one — the caller renders the
 * catalogue's default. It cannot be a string here: this is a pure helper with
 * no locale, and a hardcoded 'Get started free' is what shipped the CTA in
 * English on every /lp page in all seven languages. An admin-authored label is
 * returned as written, in whatever language the admin wrote it.
 */
export type LandingCta = { label: string | null; href: string };

/** The catalogue key the caller falls back to when `label` is null. */
export const DEFAULT_CTA_LABEL_KEY = 'landing.getStartedFree';

const DEFAULT_CTA_HREF = '/signup';

/** Resolve the CTA from a landing page's metadata, falling back to signup.
 *  Only same-origin paths or http(s) URLs are allowed (no javascript: etc.). */
export function landingCta(metadata: unknown): LandingCta {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const label = typeof m.cta_label === 'string' && m.cta_label.trim() ? m.cta_label.trim() : null;
  const rawHref = typeof m.cta_href === 'string' ? m.cta_href.trim() : '';
  return { label, href: safeHref(rawHref) };
}

/** Allow only "/path" (same-origin) or absolute http(s) URLs; else default. */
export function safeHref(href: string): string {
  if (!href) return DEFAULT_CTA_HREF;
  if (/[\u0000-\u001f\u007f]/.test(href)) return DEFAULT_CTA_HREF;
  if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')) return href;
  try {
    const url = new URL(href);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return href;
  } catch {
    // Invalid URLs use the safe same-origin default.
  }
  return DEFAULT_CTA_HREF;
}

/** Normalize a user-entered slug to lowercase kebab-case. */
export function normalizeSlug(input: string): string {
  return (input ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

/** Split body copy into paragraphs on blank lines (for rendering). */
export function bodyParagraphs(body: string | null | undefined): string[] {
  return (body ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}
