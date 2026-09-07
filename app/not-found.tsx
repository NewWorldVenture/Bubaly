import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { Button } from '@/components/ui/button';

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center px-6 text-center">
      <p className="text-7xl font-bold gradient-text">404</p>
      <h1 className="mt-4 text-2xl font-semibold">{t('notFound.pageNotFound')}</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">
        The page you’re looking for doesn’t exist or may have moved. Here are a couple of ways back.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Link href="/dashboard"><Button>{t('notFound.goToDashboard')}</Button></Link>
        <Link href="/"><Button variant="outline">{t('notFound.backToHome')}</Button></Link>
      </div>
    </div>
  );
}
