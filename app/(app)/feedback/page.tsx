import type { Metadata } from 'next';
import { Lightbulb, ArrowBigUp, Rocket, Heart } from 'lucide-react';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { LEGEND_STATUSES, STATUS_META, KIND_ORDER, KIND_META, statusTally, kindTally, type IdeaRow } from '@/lib/feedback/board';
import { cn } from '@/lib/utils/cn';
import { FeedbackBoard } from './feedback-board';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Feedback' };
export const dynamic = 'force-dynamic';

const STEPS = [
  { icon: Lightbulb, title: 'Share ideas', copy: 'Tell us what would make family life easier — big or small.' },
  { icon: ArrowBigUp, title: 'Upvote favorites', copy: 'Vote the ideas you love to the top so we know what matters most.' },
  { icon: Rocket, title: 'We build & improve', copy: 'The most-wanted ideas move onto our roadmap and get shipped.' },
];

export default async function FeedbackPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const [admin, ideasRes, votesRes] = await Promise.all([
    isSuperAdmin(),
    supabase.from('feedback_ideas')
      .select('id, title, problem, body, category, impact, audience, kind, status, admin_note, image_url, author_name, vote_count, comment_count, pinned, created_at')
      .order('pinned', { ascending: false }).order('vote_count', { ascending: false }).order('created_at', { ascending: false })
      .limit(400),
    supabase.from('feedback_votes').select('idea_id').eq('user_id', ctx.user.id).limit(1000),
  ]);

  const ideas = (ideasRes.data ?? []) as IdeaRow[];
  const votedIds = ((votesRes.data ?? []) as { idea_id: string }[]).map((v) => v.idea_id);
  const tally = statusTally(ideas);
  const kinds = kindTally(ideas);

  return (
    <div className="pb-28">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-brand/10 via-surface/40 to-amber-500/5 px-6 py-10 sm:px-10 sm:py-14">
        {/* Sunset / winding-path motif */}
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-70">
          <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-amber-400/20 blur-3xl" />
          <div className="absolute -left-10 bottom-0 h-56 w-56 rounded-full bg-brand/20 blur-3xl" />
          <svg className="absolute bottom-0 right-6 h-40 w-64 text-brand-text/25 sm:h-52 sm:w-96" viewBox="0 0 400 200" fill="none" aria-hidden>
            <circle cx="320" cy="60" r="34" className="fill-amber-400/40" />
            <path d="M10 190 C 120 150, 90 90, 200 90 S 320 40, 390 20" stroke="currentColor" strokeWidth="3" strokeDasharray="7 9" strokeLinecap="round" />
          </svg>
        </div>
        <div className="relative max-w-2xl">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-xs font-semibold text-brand-text">
            <Lightbulb className="h-3.5 w-3.5" /> {t('feedback.ideaBoard')}
          </span>
          <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl lg:text-5xl">{t('feedback.letAposSMakeLifeEasier')}</h1>
          <p className="mt-3 text-sm text-muted sm:text-base">{t('feedback.bubalyGetsBetterWhenYou')}</p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-surface/60 px-3 py-1 text-xs font-semibold text-brand-text ring-1 ring-brand/20">
            {t('feedback.smallIdeasBigImpact')}
          </p>
        </div>
      </section>

      {/* Mini steps */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title} className="flex items-start gap-3 rounded-2xl border border-border bg-surface/40 p-4">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text"><s.icon className="h-5 w-5" /></span>
            <div>
              <p className="text-sm font-bold"><span className="text-muted">{i + 1}.</span> {s.title}</p>
              <p className="mt-0.5 text-xs text-muted">{s.copy}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Board + rail */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <FeedbackBoard initialIdeas={ideas} votedIds={votedIds} userId={ctx.user.id} isSuperAdmin={admin} />
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          {/* How it works */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <h3 className="text-sm font-bold">{t('feedback.howItWorks')}</h3>
            <ol className="mt-3 space-y-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-bold text-brand-text">{i + 1}</span>
                  <div>
                    <p className="text-xs font-semibold">{s.title}</p>
                    <p className="text-[11px] text-muted">{s.copy}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* Ideas vs bugs */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <h3 className="text-sm font-bold">{t('feedback.onTheBoard')}</h3>
            <ul className="mt-3 space-y-2.5">
              {KIND_ORDER.map((k) => (
                <li key={k} className="flex items-center justify-between gap-2">
                  <span className="text-xs">{KIND_META[k].emoji} {KIND_META[k].label}</span>
                  <span className="text-[11px] font-semibold text-muted tabular-nums">{kinds[k]}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Status legend */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <h3 className="text-sm font-bold">{t('feedback.statusLegend')}</h3>
            <ul className="mt-3 space-y-2.5">
              {LEGEND_STATUSES.map((s) => (
                <li key={s} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-xs">
                    <span className={cn('h-2.5 w-2.5 rounded-full', STATUS_META[s].dot)} />
                    {STATUS_META[s].label}
                  </span>
                  <span className="text-[11px] font-semibold text-muted tabular-nums">{tally[s]}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {/* Footer band */}
      <div className="mt-10 rounded-3xl border border-border bg-gradient-to-r from-brand/10 via-surface/40 to-amber-500/5 px-6 py-8 text-center">
        <p className="text-lg font-black sm:text-xl">{t('feedback.yourIdeasYourLifeOurMission')}</p>
        <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted">
          {t('feedback.weAposReListening')} <Heart className="h-4 w-4 fill-rose-400 text-rose-400" />
        </p>
      </div>
    </div>
  );
}
