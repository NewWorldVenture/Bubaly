import { getTranslations } from '@/lib/i18n/server';
import { Compass } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button-link';

// Shared 404 body for in-shell "not found" boundaries. Section-level
// not-found.tsx files render this INSIDE the app frame, so the sidebar/nav
// stays put and a missing record (a deleted chore, an old wallet link) reads
// as "this one thing is gone", not "the app broke". `backHref` points at the
// section's own home so the primary action is always one meaningful hop.
//
// The defaults come from the catalogue. They were English literals, so every
// missing record under /dashboard — a deleted trip, an old contact link — told
// a German or Portuguese family "We couldn’t find that". Audit C1-S9-97.
export async function AppNotFound({
  title,
  description,
  backHref = '/dashboard',
  backLabel,
}: {
  title?: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
}) {
  const t = await getTranslations();
  // The defaults were English literals, so every not-found state in the app
  // read English in every language (page audit, signed-in sweep).
  title ??= t('appNotFound.title');
  description ??= t('appNotFound.description');
  backLabel ??= t('notFound.goToDashboard');
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand-text">
        <Compass className="h-7 w-7" />
      </div>
      <h1 className="mt-5 text-2xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">{description}</p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <ButtonLink href={backHref}>{backLabel}</ButtonLink>
        <ButtonLink href="/home" variant="outline">{t('appNotFound.home')}</ButtonLink>
      </div>
    </div>
  );
}
