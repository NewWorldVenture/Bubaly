// lib/blog/engagement.ts — pure validation/normalization for blog hearts +
// subscriptions. Kept DB-free so the rules are unit-testable; the API routes
// (/api/blog/like, /api/blog/subscribe) apply them before any Supabase write.

/** Lowercase, trim, and bound an email; returns null when it isn't plausibly one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  // Pragmatic shape check (full RFC validation is a losing game): one @, a dot
  // in the domain, no whitespace, no consecutive dots.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.includes('..')) return null;
  return email;
}

/** Bound + sanity-check the anonymous visitor id (bubaly_vid) used for ♥. */
export function normalizeVisitorId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (id.length < 8 || id.length > 100) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  return id;
}

/** Blog slugs are lowercase kebab-case; reject anything else before querying. */
export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const slug = raw.trim();
  if (slug.length < 3 || slug.length > 120) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  return slug;
}

/** Compact display form for like counts: 0..999, then 1.2k, 12k, 1.2m. */
export function formatLikeCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(Math.floor(n / 100_000) / 10).toFixed(1).replace(/\.0$/, '')}m`;
}

/** Allowed subscription sources (drives attribution, keeps the column tidy). */
export function normalizeSource(raw: unknown): string {
  const allowed = new Set(['blog', 'blog-sidebar', 'blog-footer', 'article']);
  return typeof raw === 'string' && allowed.has(raw) ? raw : 'blog';
}
