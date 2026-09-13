// lib/marketing/page-types.ts — the marketing page families and the URL prefix
// each one publishes under.
//
// This lives apart from `lib/marketing/platform.ts` for one reason: the
// middleware needs it. `platform.ts` is `server-only` and reaches for
// `node:crypto`, so the Edge runtime cannot import it, and the list of public
// prefixes was therefore hand-copied into `middleware.ts` — where eight of the
// eleven were simply missing. Every published `/compare`, `/alternatives`,
// `/guides`, `/glossary`, `/audiences`, `/questions`, `/resources` and `/p`
// page answered 307 to /login for anonymous visitors and search engines alike.
//
// Pure data with no imports, so both sides read the same list and a new page
// type is reachable by construction rather than by remembering.

export type MarketingPageType =
  | 'landing' | 'question' | 'guide' | 'comparison' | 'alternative'
  | 'audience' | 'resource' | 'glossary' | 'feature' | 'blog' | 'custom';

export const PAGE_TYPES: { value: MarketingPageType; label: string; prefix: string }[] = [
  { value: 'landing', label: 'Landing page', prefix: '/lp' },
  { value: 'question', label: 'Question', prefix: '/questions' },
  { value: 'guide', label: 'Guide', prefix: '/guides' },
  { value: 'comparison', label: 'Comparison', prefix: '/compare' },
  { value: 'alternative', label: 'Alternative', prefix: '/alternatives' },
  { value: 'audience', label: 'Audience', prefix: '/audiences' },
  { value: 'resource', label: 'Resource', prefix: '/resources' },
  { value: 'glossary', label: 'Glossary', prefix: '/glossary' },
  { value: 'feature', label: 'Feature', prefix: '/features' },
  { value: 'blog', label: 'Blog', prefix: '/blog' },
  { value: 'custom', label: 'Custom', prefix: '/p' },
];

/**
 * Every prefix a published marketing page can live under. The page itself is
 * the authorization boundary — it renders only `status = 'published'` rows that
 * are not soft-deleted — so these carry no family data and must be reachable
 * without a session to be worth publishing at all.
 */
export const MARKETING_PUBLIC_PREFIXES: string[] = PAGE_TYPES.map((type) => type.prefix);
