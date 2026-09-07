'use client';

// Inline Q&A on a listing detail page: the thread, an "Ask a question" box for
// non-owners, and an inline answer box for the owner. 100% Supabase + realtime.
import { useMemo, useState } from 'react';
import { MessageSquare, Send, CornerDownRight } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { isAnswered } from '@/lib/marketplace/questions';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Question = Tables<'marketplace_questions'>;

export function ListingQuestions({ listingId, isOwner }: { listingId: string; isOwner: boolean }) {
  const t = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const meId = selfMember?.id ?? null;

  const { data: questions } = useRealtimeQuery<Question>({
    table: 'marketplace_questions', familyId, deps: [familyId, listingId],
    fetcher: (sb) => sb.from('marketplace_questions').select('*').eq('family_id', familyId).eq('listing_id', listingId).order('created_at', { ascending: false }),
  });

  const nameOf = useMemo(() => {
    const m = new Map(members.map((x) => [x.id, x.display_name]));
    return (id: string | null) => (id ? m.get(id) ?? 'Someone' : 'Someone');
  }, [members]);

  const [asking, setAsking] = useState('');
  const [busy, setBusy] = useState(false);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!asking.trim()) return;
    if (!meId) { toastError(t('listingQuestions.joinTheFamilyAsA')); return; }
    setBusy(true);
    const { error } = await createClient().from('marketplace_questions').insert({
      family_id: familyId, listing_id: listingId, asker_member: meId, question: asking.trim(), created_by: userId,
    });
    setBusy(false);
    if (error) { toastError(describeDbError(error)); return; }
    setAsking('');
    success(t('listingQuestions.questionSent'));
  }

  const rows = questions ?? [];

  return (
    <div className="mt-8">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-fg">
        <MessageSquare className="h-4 w-4 text-brand-text" /> {t('listingQuestions.questions')}{rows.length > 0 ? ` (${rows.length})` : ''}
      </h2>

      {!isOwner && meId && (
        <form onSubmit={ask} className="mb-4 flex items-start gap-2">
          <textarea
            value={asking} onChange={(e) => setAsking(e.target.value)}
            placeholder={t('listingQuestions.askTheSellerAQuestionIs')}
            className="min-h-[2.5rem] flex-1 rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm outline-none focus:border-brand"
            rows={2}
          />
          <Button type="submit" disabled={busy || !asking.trim()}><Send className="h-4 w-4" /> Ask</Button>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t('listingQuestions.noQuestionsYet')}{isOwner ? ' — buyers can ask here.' : '. Be the first to ask.'}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((q) => (
            <li key={q.id} className="rounded-xl border border-border bg-surface/50 p-3">
              <div className="flex items-center gap-2">
                <Avatar name={nameOf(q.asker_member)} size={22} />
                <span className="text-sm font-medium text-fg">{nameOf(q.asker_member)}</span>
              </div>
              <p className="mt-1.5 text-sm text-fg">{q.question}</p>
              {isAnswered(q) ? (
                <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-brand/5 p-2 text-sm">
                  <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-text" />
                  <div>
                    <span className="text-xs font-medium text-brand-text">{nameOf(q.answered_by)}</span>
                    <p className="text-muted">{q.answer}</p>
                  </div>
                </div>
              ) : isOwner ? (
                <AnswerForm question={q} onAnswered={() => success(t('listingQuestions.answerPosted'))} onError={toastError} answererId={meId} />
              ) : (
                <p className="mt-1.5 text-xs text-muted">{t('listingQuestions.awaitingTheSellerSReply')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AnswerForm({ question, answererId, onAnswered, onError }: {
  question: Question; answererId: string | null; onAnswered: () => void; onError: (m: string) => void;
}) {
  const t = useTranslations();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    setBusy(true);
    const { error } = await createClient().from('marketplace_questions')
      .update({ answer: answer.trim(), answered_at: new Date().toISOString(), answered_by: answererId })
      .eq('id', question.id);
    setBusy(false);
    if (error) { onError(describeDbError(error)); return; }
    onAnswered();
  }
  return (
    <form onSubmit={submit} className="mt-2 flex items-start gap-2">
      <input
        value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer…"
        className="flex-1 rounded-lg border border-border bg-surface/40 px-3 py-1.5 text-sm outline-none focus:border-brand"
      />
      <Button type="submit" size="sm" disabled={busy || !answer.trim()}>{t('listingQuestions.reply')}</Button>
    </form>
  );
}
