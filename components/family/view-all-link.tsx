'use client';

// The "View all" link out of a `SectionCard`.
//
// It is its own client module for one reason: `family/shell.tsx` is imported by
// both server pages and client components, so it can run neither translator.
// This takes a single `href` string — the only thing that has to cross the
// server→client boundary — which is what lets the words be translated at all
// rather than shipped as an English default.
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';

export function ViewAllLink({ href }: { href: string }) {
  const t = useTranslations();
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-text">
      {t('shell.viewAll')}{' '}<ArrowRight className="h-3 w-3" />
    </Link>
  );
}
