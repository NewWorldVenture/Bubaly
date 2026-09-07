// Server-rendered JSON-LD structured data for the public marketing site. This
// feeds Google/Bing rich results (Organization knowledge panel, sitelinks,
// software/FAQ rich snippets). Everything here is factual — no fabricated
// ratings or reviews — so we never risk a structured-data spam penalty.

import { Fragment } from 'react';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { getCachedSocialLinks } from '@/lib/server/social-links';
import { getTranslations } from '@/lib/i18n/server';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

function JsonLd({ data }: { data: Record<string, unknown> }) {
  // Most callers pass static, developer-authored data, but Organization.sameAs
  // now carries admin-entered URLs out of app_settings. Escaping `<` (as <)
  // is what stops any value closing the <script> tag with `</script>` — the
  // standard safe way to inline JSON-LD. Those URLs are also parsed and
  // restricted to https before they are stored (lib/marketing/social-links.ts),
  // so this is the second of two gates, not the only one.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}

/** Organization + WebSite + SoftwareApplication — render once, on the homepage. */
export async function SiteStructuredData() {
  // The admin-entered profiles ONLY — deliberately not the footer's defaults.
  //
  // The footer falls back to the brand's canonical handles so its icon row
  // always draws; a link there that 404s is a small cosmetic miss. `sameAs` is
  // a different kind of statement: it tells search engines "these accounts are
  // this organisation", and asserting that about a profile nobody has confirmed
  // exists is a claim, not a placeholder. So this stays with what an admin
  // actually saved, and is empty until they do.
  const t = await getTranslations();
  const social = await getCachedSocialLinks();
  const t = await getTranslations();

  const organization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Bubaly',
    url: SITE_URL,
    logo: `${SITE_URL}/brand/bubaly-logo.png`,
    // The same outcome-language description the homepage's metadata uses.
    description: t('root.metaDescriptionOutcomes'),
    sameAs: Object.values(social),
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
    operatingSystem: t('structuredData.webIosAndroid'),
    description:
      t('structuredData.anAiNativeFamilyOperating'),
    url: SITE_URL,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      // There is no "Free Starter plan": the offer is a 5-day trial of Family
      // Basic, then a paid plan (lib/constants/plans.ts). Say exactly that.
      description: t('structuredData.offerTrial'),
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

/** Page-level schema for public marketing routes and their admin-managed FAQs. */
export async function MarketingPageStructuredData({
  path,
  name,
  description,
  questions = [],
}: {
  path: string;
  name: string;
  description: string;
  questions?: { q: string; a: string }[];
}) {
  const { locale } = await getLocaleContext();
  const pageUrl = `${SITE_URL}${path === '/' ? '' : path}`;
  return (
    <Fragment>
      <JsonLd data={{
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name,
        description,
        url: pageUrl,
        isPartOf: { '@type': 'WebSite', name: 'Bubaly', url: SITE_URL },
        inLanguage: locale.code,
      }} />
      {questions.length > 0 ? <FaqStructuredData items={questions} /> : null}
    </Fragment>
  );
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
export async function BlogPostStructuredData(post: BlogPostSchemaInput) {
  const { locale } = await getLocaleContext();
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
    inLanguage: locale.code,
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
export async function BlogListStructuredData({ posts }: { posts: { slug: string; title: string; excerpt: string; date: string }[] }) {
  const t = await getTranslations();
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: t('structuredData.theBubalyBlog'),
    description: t('structuredData.practicalAdviceRealStoriesAnd'),
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
