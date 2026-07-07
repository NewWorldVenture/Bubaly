// Server-rendered JSON-LD structured data for the public marketing site. This
// feeds Google/Bing rich results (Organization knowledge panel, sitelinks,
// software/FAQ rich snippets). Everything here is factual — no fabricated
// ratings or reviews — so we never risk a structured-data spam penalty.

import { Fragment } from 'react';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // JSON.stringify output is safe to inline; no user input flows in here.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
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
