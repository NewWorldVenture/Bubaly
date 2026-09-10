import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { authorizeDocumentLink } from '@/lib/services/paperwork/link-access';
import { linkedDocumentSource } from '@/lib/services/paperwork/link';
import { DocumentLinkCapture } from '@/components/capture/document-link-capture';
import { getTranslations } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export default async function DocumentLinkPage({ searchParams }: { searchParams?: Promise<{ url?: string; messageId?: string }> }) {
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'documents', '/capture/link');
  const params = searchParams ? await searchParams : {};
  if ((params.url !== undefined && typeof params.url !== 'string') || (params.messageId !== undefined && typeof params.messageId !== 'string')) {
    const t = await getTranslations();
    return <p role="alert" className="module-page">{t('documentLink.invalid_url')}</p>;
  }
  const db = await createServer();
  const access = await authorizeDocumentLink(ctx, db, params.messageId !== undefined);
  const source = access.ok && params.messageId !== undefined ? await linkedDocumentSource(scopeFromUserContext(ctx, db), params.messageId) : null;
  if (!access.ok || (source && !source.ok)) {
    const t = await getTranslations();
    const reason = !access.ok ? access.reason : 'source_unavailable';
    return <div role="alert" className="module-page space-y-3"><p>{t(`documentLink.${reason}`)}</p>
      <a className="underline" href={params.messageId ? `/capture/link?messageId=${encodeURIComponent(params.messageId)}` : '/capture/link'}>{t('documentLink.retry')}</a></div>;
  }
  return <div className="module-page mx-auto max-w-2xl"><DocumentLinkCapture key={`${ctx.active.familyId}:${ctx.user.id}:${params.messageId ?? params.url ?? ''}`} initialUrl={params.messageId ? '' : (params.url ?? '').slice(0, 2_000)}
    messageId={params.messageId} candidates={source?.ok ? source.data.urls : []} expectedFamilyId={ctx.active.familyId} expectedUserId={ctx.user.id} /></div>;
}
