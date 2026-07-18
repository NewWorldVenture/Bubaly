// Server-rendered JSON-LD structured data for the public marketing site. This
// feeds Google/Bing rich results (Organization knowledge panel, sitelinks,
// software/FAQ rich snippets). Everything here is factual — no fabricated
// ratings or reviews — so we never risk a structured-data spam penalty.

import { Fragment } from 'react';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

function JsonLd({ data }: { data: Record<string, unknown> }) {
  // Today every caller passes static, developer-authored data. As defense in
  // depth, escape `<` (as <) so a value can never break out of the
  // <script> tag with `</script>` — the standard safe way to inline JSON-LD —
  // in case a future caller ever passes dynamic/DB content.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}

/** Organization + WebSite + SoftwareApplication — render once, on the homepage. */
export function SiteStructuredData() {
  const organization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Bubaly',
    url: SITE_URL,
    logo: `${SITE_URL}/brand/bubaly-logo.png`,
    description:
      'Bubaly is the AI operating system for family life — it handles the logistics so families spend less time managing life and more time living it.',
    sameAs: [] as string[],
  };

  const website = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Bubaly',
    url: SITE_URL,
    publisher: { '@type': 'Organization', name: 'Bubaly' },
  };

  const application = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Bubaly',
    applicationCategory: 'LifestyleApplication',
    operatingSystem: 'Web, iOS, Android',
    description:
      'An AI-native family operating system: shared calendar, chores, meal planning, documents, reminders, and an assistant that takes real action — all private and family-scoped.',
    url: SITE_URL,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free Starter plan — no credit card required to begin.',
    },
  };

  return (
    <Fragment>
      <JsonLd data={organization} />
      <JsonLd data={website} />
      <JsonLd data={application} />
    </Fragment>
  );
}

/** FAQPage rich result — pass the same Q&A rendered on the page. */
export function FaqStructuredData({ items }: { items: { q: string; a: string }[] }) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
  return <JsonLd data={data} />;
}

type BlogPostSchemaInput = {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  category: string;
  date: string;
  heroImageUrl?: string;
  keywords?: string[];
  wordCount?: number;
};

/**
 * BlogPosting (Article) + BreadcrumbList for a single article. Feeds Google
 * "Article" rich results and gives answer engines (AEO) a clean, machine-
 * readable summary — headline, author, dates, section, image, keywords. All
 * values come from the DB, so JsonLd escapes `<` as defense in depth.
 */
export function BlogPostStructuredData(post: BlogPostSchemaInput) {
  const url = `${SITE_URL}/blog/${post.slug}`;
  const article = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    headline: post.title.slice(0, 110),
    description: post.excerpt,
    articleSection: post.category,
    ...(post.keywords && post.keywords.length ? { keywords: post.keywords.join(', ') } : {}),
    ...(post.wordCount ? { wordCount: post.wordCount } : {}),
    ...(post.heroImageUrl ? { image: [post.heroImageUrl] } : {}),
    datePublished: post.date,
    dateModified: post.date,
    author: { '@type': post.author.includes('Team') ? 'Organization' : 'Person', name: post.author },
    publisher: {
      '@type': 'Organization',
      name: 'Bubaly',
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/brand/bubaly-logo.png` },
    },
    url,
    isAccessibleForFree: true,
    inLanguage: 'en-US',
  };
  const breadcrumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Blog', item: `${SITE_URL}/blog` },
      { '@type': 'ListItem', position: 2, name: post.category, item: `${SITE_URL}/blog?category=${encodeURIComponent(post.category)}` },
      { '@type': 'ListItem', position: 3, name: post.title, item: url },
    ],
  };
  return (
    <Fragment>
      <JsonLd data={article} />
      <JsonLd data={breadcrumbs} />
    </Fragment>
  );
}

/** Blog (collection) schema for the /blog index — lists recent posts for crawlers. */
export function BlogListStructuredData({ posts }: { posts: { slug: string; title: string; excerpt: string; date: string }[] }) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'The Bubaly Blog',
    description: 'Practical advice, real stories, and smart tips to help your family stay organized and enjoy more time together.',
    url: `${SITE_URL}/blog`,
    publisher: { '@type': 'Organization', name: 'Bubaly', url: SITE_URL },
    blogPost: posts.slice(0, 25).map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title.slice(0, 110),
      description: p.excerpt,
      datePublished: p.date,
      url: `${SITE_URL}/blog/${p.slug}`,
    })),
  };
  return <JsonLd data={data} />;
}
