import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { createServiceClient } from '@/lib/supabase/server';
import { readSocialLinksSnapshot } from '@/lib/server/social-links';
import { SocialLinksForm } from './social-links-form';

export const metadata: Metadata = { title: 'Admin · Social links', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminSocialLinksPage() {
  const t = await getTranslations();
  // Not a degrading read. A failed read used to arrive here as `{}`, which the
  // form below is unable to tell from "nothing is configured" — six blank inputs
  // and a Save that replaces the whole stored object. So when the read does not
  // answer, there is no form to save: the operator gets the failure and a reload.
  const snapshot = await readSocialLinksSnapshot(createServiceClient());

  return (
    <div className="module-page">
      <Link
        href="/admin/settings"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" />{' '}{t('socialLinks.settings')}</Link>

      <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">{t('socialLinks.socialLinks')}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Bubaly&apos;s own accounts. Each one you fill in becomes an icon in the marketing footer and is
        published as a <code className="text-xs">sameAs</code> entry in the site&apos;s Organization
        schema, which is how search engines tie these profiles to the brand.
      </p>

      <Card className="mt-6 max-w-2xl p-5 sm:p-6">
        {snapshot.ok ? (
          <SocialLinksForm links={snapshot.fields} revision={snapshot.revision} />
        ) : (
          <div role="alert">
            <p className="text-sm text-danger">{t('socialLinks.couldNotLoadSavedLinks')}</p>
            {/* A plain anchor, not next/link: a full load re-runs the read. */}
            <a href="/admin/settings/social-links" className="mt-3 inline-block text-sm font-medium text-brand-text underline">
              {t('socialLinks.reloadThisPage')}
            </a>
          </div>
        )}
      </Card>
    </div>
  );
}
