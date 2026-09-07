import type { Metadata } from 'next';
import Link from 'next/link';
import { MessageSquare, CornerDownRight, ArrowRight } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { categorizeQuestions, type QuestionLike } from '@/lib/marketplace/questions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Questions · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

type QRow = QuestionLike & { id: string; question: string; answer: string | null; answered_by: string | null };

export default async function MarketplaceQuestionsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const meId = ctx.active.member.id;

  const [{ data: questions }, { data: listings }, { data: members }] = await settleAll([
    sb.from('marketplace_questions').select('id, listing_id, asker_member, question, answer, answered_by, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(500),
    sb.from('marketplace_listings').select('id, title, member_id').eq('family_id', familyId).limit(2000),
    sb.from('family_members').select('id, display_name').eq('family_id', familyId),
  ]);

  const titleOf = new Map((listings ?? []).map((l) => [l.id, l.title]));
  const nameOf = (id: string | null) => (id ? (members ?? []).find((m) => m.id === id)?.display_name ?? 'Someone' : 'Someone');
  const myListingIds = (listings ?? []).filter((l) => l.member_id === meId).map((l) => l.id);
  const { toAnswer, answered, mine } = categorizeQuestions((questions ?? []) as QRow[], meId, myListingIds);

  const QLink = ({ id, children }: { id: string; children: React.ReactNode }) => (
    <Link href={`/marketplace/item/${id}`} className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">{children} <ArrowRight className="h-3.5 w-3.5" /></Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t('marketplaceQuestions.questions')} description={t('questions.questionsOnYourListingsAnd')} />

      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold"><MessageSquare className="h-4 w-4 text-brand-text" /> {t('marketplaceQuestions.needsYourAnswer')} <span className="text-muted">({toAnswer.length})</span></h2>
        {toAnswer.length === 0 ? <p className="text-sm text-muted">{t('marketplaceQuestions.youreAllCaughtUp')}</p> : (
          <ul className="space-y-2">
            {toAnswer.map((q) => (
              <li key={q.id} className="flex items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{titleOf.get(q.listing_id) ?? 'Listing'}</p>
                  <p className="truncate text-muted">{nameOf(q.asker_member)} asked: “{q.question}”</p>
                </div>
                <QLink id={q.listing_id}>{t('questions.answer')}</QLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold"><CornerDownRight className="h-4 w-4 text-brand-text" /> {t('marketplaceQuestions.yourQuestions')} <span className="text-muted">({mine.length})</span></h2>
        {mine.length === 0 ? <p className="text-sm text-muted">{t('marketplaceQuestions.youHaventAskedAnythingYet')}</p> : (
          <ul className="space-y-2">
            {mine.map((q) => (
              <li key={q.id} className="rounded-xl border border-border bg-surface/50 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate font-medium">{titleOf.get(q.listing_id) ?? 'Listing'}</p>
                  <QLink id={q.listing_id}>{t('questions.view')}</QLink>
                </div>
                <p className="mt-0.5 text-muted">“{q.question}”</p>
                {q.answer && <p className="mt-1.5 rounded-lg bg-brand/5 p-2 text-fg"><span className="font-medium text-brand-text">{nameOf(q.answered_by)}:</span> {q.answer}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {answered.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted">{t('marketplaceQuestions.answeredOnYourListings')}{answered.length})</h2>
          <ul className="space-y-2">
            {answered.slice(0, 20).map((q) => (
              <li key={q.id} className="rounded-xl border border-border bg-surface/40 p-3 text-sm">
                <p className="truncate font-medium">{titleOf.get(q.listing_id) ?? 'Listing'}</p>
                <p className="text-muted">“{q.question}” — <span className="text-fg">{q.answer}</span></p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
