import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Shared 404 body for in-shell "not found" boundaries. Section-level
// not-found.tsx files render this INSIDE the app frame, so the sidebar/nav
// stays put and a missing record (a deleted chore, an old wallet link) reads
// as "this one thing is gone", not "the app broke". `backHref` points at the
// section's own home so the primary action is always one meaningful hop.
export async function AppNotFound({
  title = 'We couldn’t find that',
  description = 'It may have been removed, or the link is out of date. Everything else is right where you left it.',
  backHref = '/dashboard',
  backLabel = 'Go to dashboard',
}: {
  title?: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
}) {
  const t = await getTranslations();
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand-text">
        <Compass className="h-7 w-7" />
      </div>
      <h1 className="mt-5 text-2xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">{description}</p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Link href={backHref}><Button>{backLabel}</Button></Link>
        <Link href="/home"><Button variant="outline">{t('appNotFound.home')}</Button></Link>
      </div>
    </div>
  );
}
