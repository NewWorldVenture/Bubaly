import { getTranslations } from '@/lib/i18n/server';
import { ButtonLink } from '@/components/ui/button-link';

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center px-6 text-center">
      <p className="text-7xl font-bold gradient-text">404</p>
      <h1 className="mt-4 text-2xl font-semibold">{t('notFound.pageNotFound')}</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">{t('notFound.thePageYouReLooking')}</p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <ButtonLink href="/dashboard">{t('notFound.goToDashboard')}</ButtonLink>
        <ButtonLink href="/" variant="outline">{t('notFound.backToHome')}</ButtonLink>
      </div>
    </div>
  );
}
