// lib/blog/structured-data.ts — SEO + AEO structured data (schema.org JSON-LD) for
// blog articles and the blog index. Pure functions (no React/Supabase) so they are
// unit-testable and usable from both the article page and the index.
//
// SEO: `BlogPosting` gives Google rich-result eligibility (author, date, image,
//   publisher) and `BreadcrumbList` produces breadcrumb rich snippets.
// AEO (answer engines / voice — ChatGPT, Perplexity, Google SGE, Alexa): the
//   `speakable` spec marks the headline + summary as answer-ready, and an optional
//   `FAQPage` (only when an article ships real Q&A) feeds featured-snippet / voice
//   answers. We never fabricate FAQs — they're emitted only when present.

import type { BlogPost, BlogBlock } from './posts';

const SITE_NAME = 'Bubaly';
const DEFAULT_SITE_URL = 'https://www.bubaly.com';

export type FaqItem = { question: string; answer: string };

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL).replace(/\/$/, '');
}

/** Approximate word count from the article body — a real SEO signal for depth. */
export function wordCount(body: BlogBlock[]): number {
  return body.reduce((n, b) => n + (b.text ? b.text.trim().split(/\s+/).filter(Boolean).length : 0), 0);
}

/** The publisher Organization block, reused across every schema. */
function publisher(base: string) {
  return {
    '@type': 'Organization',
    name: SITE_NAME,
    url: base,
    logo: { '@type': 'ImageObject', url: `${base}/icon.png` },
  };
}

/** schema.org `BlogPosting` for a single article. */
export function blogPostingJsonLd(post: BlogPost, base = siteUrl()) {
  const url = `${base}/blog/${post.slug}`;
  const iso = (d: string) => {
    const parsed = new Date(d);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  };
  const published = iso(post.date);
  return {
    '@type': 'BlogPosting',
    '@id': url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    headline: post.title.slice(0, 110), // Google truncates headlines past ~110 chars
    description: post.excerpt,
    articleSection: post.category,
    keywords: post.tags.join(', '),
    wordCount: wordCount(post.body),
    inLanguage: 'en',
    ...(published ? { datePublished: published, dateModified: published } : {}),
    author: { '@type': 'Person', name: post.author },
    publisher: publisher(base),
    ...(post.heroImageUrl
      ? { image: { '@type': 'ImageObject', url: post.heroImageUrl, caption: post.heroImageAlt ?? post.title } }
      : {}),
    // AEO: mark the headline + intro as voice/answer-ready.
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.article-lede'] },
  };
}

/** schema.org `BreadcrumbList`: Home › Blog › Category › Title. */
export function breadcrumbJsonLd(post: BlogPost, base = siteUrl()) {
  const items = [
    { name: SITE_NAME, url: base },
    { name: 'Blog', url: `${base}/blog` },
    { name: post.category, url: `${base}/blog?category=${encodeURIComponent(post.category)}` },
    { name: post.title, url: `${base}/blog/${post.slug}` },
  ];
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

/** schema.org `FAQPage` — only emit when an article ships real Q&A (AEO). */
export function faqJsonLd(faq: FaqItem[]) {
  if (!faq.length) return null;
  return {
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}

/** Combine an article's schemas into one `@graph` document for a single script tag. */
export function articleGraph(post: BlogPost, faq: FaqItem[] = [], base = siteUrl()) {
  const graph: object[] = [blogPostingJsonLd(post, base), breadcrumbJsonLd(post, base)];
  const f = faqJsonLd(faq);
  if (f) graph.push(f);
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** schema.org `Blog` (`CollectionPage`) for the /blog index — lists recent posts. */
export function blogIndexJsonLd(posts: BlogPost[], base = siteUrl()) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    '@id': `${base}/blog`,
    url: `${base}/blog`,
    name: `${SITE_NAME} — Family Life, Organized`,
    description:
      'Fresh, practical writing on parenting, family organization, school, wellness, family finances, and AI for the home.',
    publisher: publisher(base),
    inLanguage: 'en',
    blogPost: posts.slice(0, 50).map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title.slice(0, 110),
      url: `${base}/blog/${p.slug}`,
      datePublished: (() => {
        const d = new Date(p.date);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
      })(),
      author: { '@type': 'Person', name: p.author },
    })),
  };
}
