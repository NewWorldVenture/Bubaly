import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { createServiceClient } from '@/lib/supabase/server';
import { getSocialLinks } from '@/lib/server/social-links';
import { SocialLinksForm } from './social-links-form';

export const metadata: Metadata = { title: 'Admin · Social links', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminSocialLinksPage() {
  const links = await getSocialLinks(createServiceClient());

  return (
    <div className="module-page">
      <Link
        href="/admin/settings"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" /> Settings
      </Link>

      <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Social links</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Bubaly&apos;s own accounts. Each one you fill in becomes an icon in the marketing footer and is
        published as a <code className="text-xs">sameAs</code> entry in the site&apos;s Organization
        schema, which is how search engines tie these profiles to the brand.
      </p>

      <Card className="mt-6 max-w-2xl p-5 sm:p-6">
        <SocialLinksForm links={links} />
      </Card>
    </div>
  );
}
