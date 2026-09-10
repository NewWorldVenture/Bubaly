import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { SERVICE_CODES } from '@/lib/services/types';
import { purchaseApprovalPath } from '@/lib/purchases/private-result';
import { loadPrivatePurchaseAnswer } from '@/lib/services/purchases/private-result';
import { isManager } from '@/lib/constants/roles';
import { retryPurchaseAnswer } from './actions';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('purchaseAdvice.privateTitle') };
}

export default async function PrivatePurchasePage({ params, searchParams }: {
  params: Promise<{ approvalId: string }>;
  searchParams: Promise<{ retry?: string }>;
}) {
  const ctx = await requireUserContext();
  const { approvalId } = await params;
  const query = await searchParams;
  const t = await getTranslations();
  const scope = scopeFromUserContext(ctx, await createServer());
  const result = await loadPrivatePurchaseAnswer(scope, approvalId);
  if (!result.ok && result.code === SERVICE_CODES.denied) notFound();
  const report = result.ok ? result.data : null;
  const failed = !result.ok || query.retry === 'failed';
  const button = 'inline-flex items-center rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2';

  return <section className="mx-auto max-w-3xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">{t('purchaseAdvice.privateTitle')}</h1>
    {failed && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4">{t('purchaseAdvice.privateUnavailable')}</p>}
    {report?.kind === 'ready' && <p className="whitespace-pre-wrap leading-relaxed">{report.answer}</p>}
    {report?.kind === 'waiting' && <p className="text-muted">{t('purchaseAdvice.privateWaiting')}</p>}
    {report?.kind === 'waiting' && isManager(scope.role) && <Link href="/dashboard/trust" className={button}>{t('trust.trustPermissions')}</Link>}
    {report?.kind === 'declined' && <p className="text-muted">{t('purchaseAdvice.privateDeclined')}</p>}
    {report?.kind === 'retry' && <form action={retryPurchaseAnswer.bind(null, approvalId)}>
      {!failed && <p className="mb-4 text-muted">{t('purchaseAdvice.privateUnavailable')}</p>}
      <button type="submit" className={button}>{t('purchaseAdvice.privateRetry')}</button>
    </form>}
    {(!report || report.kind === 'waiting') && <Link href={purchaseApprovalPath(approvalId)} className={button}>{t('purchaseAdvice.privateRefresh')}</Link>}
  </section>;
}
