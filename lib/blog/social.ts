// lib/blog/social.ts — social + backlink helpers for blog articles.
// Pure (no React/Supabase) so they're unit-testable and usable from server
// components and metadata alike.
//
// Every article gets:
//   • a set of social hashtags that ALWAYS include the brand tag #bubaly, plus
//     its category and content tags (camelCased into valid hashtags), so the
//     team can tag posts on social media consistently; and
//   • a canonical link back to Bubaly (SEO backlink + brand reference).

const BUBALY_URL = 'https://www.bubaly.com';
const BRAND_HASHTAG = '#bubaly';

export { BUBALY_URL, BRAND_HASHTAG };

/** Turn a free-text label ("AI & Technology", "mental load") into a single
 *  camelCased hashtag token ("#aiAndTechnology", "#mentalLoad"). */
function toHashtag(label: string): string {
  const words = label
    .replace(/&/g, ' and ')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  return `#${camel}`;
}

/** Social hashtags for an article — brand + category + tags, deduped
 *  (case-insensitively), with #bubaly always first. */
export function articleHashtags(post: { tags: string[]; category: string }): string[] {
  const candidates = [BRAND_HASHTAG, toHashtag(post.category), ...post.tags.map(toHashtag)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of candidates) {
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** The hashtags as one space-separated string (handy for share text / meta). */
export function hashtagString(post: { tags: string[]; category: string }): string {
  return articleHashtags(post).join(' ');
}

/** Keyword set for <meta keywords> / OG — content tags plus the brand and its
 *  hashtags, deduped. */
export function articleKeywords(post: { tags: string[]; category: string }): string[] {
  const base = [...post.tags, post.category, 'Bubaly', 'family organization', ...articleHashtags(post)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of base) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}
