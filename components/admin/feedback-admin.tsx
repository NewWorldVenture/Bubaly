'use client';

// Super Admin feedback console. Receive every idea from the public board and act
// on it: move it through the roadmap (status + public note), pin it, reply as the
// Bubaly team, or remove spam — all wired to Supabase via super-admin server
// actions that revalidate the public /feedback board instantly.

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import {
  Loader2, Pin, PinOff, Trash2, Send, ChevronDown, ChevronRight,
  ArrowBigUp, MessageSquare, Search, Github, RefreshCw, Bell, Check, ExternalLink,
} from 'lucide-react';
import {
  STATUS_META, CATEGORY_META, FILTERABLE_STATUSES, KIND_META, KIND_ORDER,
  categoryMeta, statusMeta, kindMeta,
  type IdeaRow, type FeedbackStatus, type FeedbackKind,
} from '@/lib/feedback/board';
import { feedbackAdminSummary, filterIdeasForAdmin, type AdminFeedbackFilter } from '@/lib/feedback/admin';
import {
  updateIdeaAction, setIdeaPinnedAction, deleteIdeaAction, postTeamReplyAction,
  syncGithubNowAction, markAdminNotificationsReadAction,
} from '@/app/(app)/admin/feedback/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

export type AdminComment = { id: string; idea_id: string; author_name: string; is_team: boolean; body: string; created_at: string };
export type AdminNotification = { id: string; kind: string; title: string; body: string | null; url: string | null; is_read: boolean; created_at: string };

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function FeedbackAdmin({ ideas, comments, notifications = [], githubConfigured = false }: {
  ideas: IdeaRow[]; comments: AdminComment[]; notifications?: AdminNotification[]; githubConfigured?: boolean;
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [filter, setFilter] = useState<AdminFeedbackFilter>({ status: 'all', category: 'all' });
  const [kindFilter, setKindFilter] = useState<'all' | FeedbackKind>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [syncing, startSync] = useTransition();
  const [marking, startMark] = useTransition();

  const summary = useMemo(() => feedbackAdminSummary(ideas), [ideas]);
  const unreadNotes = notifications.filter((n) => !n.is_read);

  function runSync() {
    startSync(async () => {
      const res = await syncGithubNowAction();
      if (res.ok) success(res.summary); else toastError(res.error);
    });
  }
  function markAllRead() {
    startMark(async () => {
      const res = await markAdminNotificationsReadAction();
      if (!res.ok) toastError(res.error);
    });
  }
  const commentsByIdea = useMemo(() => {
    const m = new Map<string, AdminComment[]>();
    for (const c of comments) { const a = m.get(c.idea_id) ?? []; a.push(c); m.set(c.idea_id, a); }
    return m;
  }, [comments]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    let base = filterIdeasForAdmin(ideas, filter);
    if (kindFilter !== 'all') base = base.filter((i) => (i.kind ?? 'idea') === kindFilter);
    return q ? base.filter((i) => i.title.toLowerCase().includes(q) || (i.body ?? '').toLowerCase().includes(q) || (i.problem ?? '').toLowerCase().includes(q)) : base;
  }, [ideas, filter, kindFilter, q]);

  const cards: { label: string; value: number; tone: string }[] = [
    { label: 'Needs review', value: summary.needsReview, tone: 'text-amber-500' },
    { label: 'Active', value: summary.active, tone: 'text-purple-500' },
    { label: 'Shipped', value: summary.shipped, tone: 'text-emerald-500' },
    { label: 'Total ideas', value: summary.total, tone: 'text-fg' },
    { label: 'Total votes', value: summary.totalVotes, tone: 'text-brand-text' },
  ];

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-border bg-surface/40 p-4">
            <p className={cn('text-2xl font-black tabular-nums', c.tone)}>{c.value}</p>
            <p className="mt-0.5 text-xs text-muted">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Relay feed — new submissions + bot sync relays, with GitHub sync control */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-bold text-fg">
            <Bell className="h-4 w-4 text-brand-text" /> {t('feedbackAdmin.activityRelay')}
            {unreadNotes.length > 0 && <span className="rounded-full bg-brand px-2 py-0.5 text-[11px] font-bold text-brand-fg">{unreadNotes.length} new</span>}
          </p>
          <div className="flex items-center gap-2">
            {unreadNotes.length > 0 && (
              <button type="button" onClick={markAllRead} disabled={marking}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50">
                {marking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {t('feedbackAdmin.markAllRead')}
              </button>
            )}
            <button type="button" onClick={runSync} disabled={syncing}
              title={githubConfigured ? 'Backfill + reconcile with GitHub now' : 'Set GITHUB_TOKEN + GITHUB_FEEDBACK_REPO to enable'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition hover:opacity-90 disabled:opacity-50">
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {t('feedbackAdmin.syncGithubNow')}
            </button>
          </div>
        </div>
        {!githubConfigured && (
          <p className="mb-2 flex items-center gap-1.5 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            <Github className="h-3.5 w-3.5 shrink-0" /> {t('feedbackAdmin.githubTrackerIsDarkSet')} <code>GITHUB_TOKEN</code> + <code>GITHUB_FEEDBACK_REPO</code> {t('feedbackAdmin.toMirrorBugsAmpIdeasNotifications')}
          </p>
        )}
        {notifications.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('feedbackAdmin.noActivityYetNewSubmissionsAnd')}</p>
        ) : (
          <ul className="max-h-64 space-y-1.5 overflow-y-auto scrollbar-none">
            {notifications.slice(0, 30).map((n) => (
              <li key={n.id} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', n.is_read ? 'border-border/60 bg-transparent' : 'border-brand/25 bg-brand/5')}>
                <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', n.is_read ? 'bg-transparent' : 'bg-brand')} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-fg">{n.title}</p>
                  {n.body && <p className="mt-0.5 whitespace-pre-line text-muted">{n.body}</p>}
                  <p className="mt-0.5 text-[11px] text-muted/60">{fmt(n.created_at)}</p>
                </div>
                {n.url && <Link href={n.url} className="shrink-0 text-brand-text"><ExternalLink className="h-3.5 w-3.5" /></Link>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Kind: idea vs bug (the two lists) */}
          <FilterChip active={kindFilter === 'all'} onClick={() => setKindFilter('all')}>{t('feedbackAdmin.allTypes')}</FilterChip>
          {KIND_ORDER.map((k) => (
            <FilterChip key={k} active={kindFilter === k} onClick={() => setKindFilter(k)}>
              {KIND_META[k].emoji} {KIND_META[k].label}
            </FilterChip>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          <FilterChip active={filter.status === 'all'} onClick={() => setFilter((f) => ({ ...f, status: 'all' }))}>All</FilterChip>
          {FILTERABLE_STATUSES.map((s) => (
            <FilterChip key={s} active={filter.status === s} onClick={() => setFilter((f) => ({ ...f, status: s }))}>
              <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_META[s].dot)} /> {STATUS_META[s].label}
              <span className="text-muted/70">{summary.byStatus[s]}</span>
            </FilterChip>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filter.category}
            onChange={(e) => setFilter((f) => ({ ...f, category: e.target.value }))}
            className="h-9 rounded-lg border border-border bg-bg px-2 text-sm outline-none focus:border-brand"
          >
            <option value="all">{t('feedbackAdmin.allCategories')}</option>
            {Object.entries(CATEGORY_META).map(([k, v]) => <option key={k} value={k}>{v.emoji} {v.label}</option>)}
          </select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…"
              className="h-9 w-40 rounded-lg border border-border bg-bg pl-8 pr-2 text-sm outline-none focus:border-brand" />
          </div>
        </div>
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-10 text-center text-sm text-muted">
          {t('feedbackAdmin.noIdeasMatchThisFilter')}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((idea) => (
            <IdeaAdminCard
              key={idea.id}
              idea={idea}
              comments={commentsByIdea.get(idea.id) ?? []}
              expanded={expanded === idea.id}
              onToggle={() => setExpanded((e) => (e === idea.id ? null : idea.id))}
              onSuccess={success}
              onError={toastError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition',
        active ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted hover:bg-elevated hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function IdeaAdminCard({ idea, comments, expanded, onToggle, onSuccess, onError }: {
  idea: IdeaRow; comments: AdminComment[]; expanded: boolean; onToggle: () => void;
  onSuccess: (m: string) => void; onError: (m: string) => void;
}) {
  const t = useTranslations();
  const [status, setStatus] = useState<FeedbackStatus>((STATUS_META[idea.status as FeedbackStatus] ? idea.status : 'under_review') as FeedbackStatus);
  const [note, setNote] = useState(idea.admin_note ?? '');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const cat = categoryMeta(idea.category);
  const meta = statusMeta(idea.status);
  const kind = kindMeta(idea.kind ?? 'idea');
  const dirty = status !== idea.status || (note.trim() !== (idea.admin_note ?? '').trim());

  async function run(key: string, fn: () => Promise<{ ok: true } | { ok: false; error: string }>, okMsg: string) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) { onError(res.error); return false; }
    onSuccess(okMsg);
    return true;
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex items-start gap-3">
        {/* Votes */}
        <div className="flex shrink-0 flex-col items-center rounded-xl border border-border bg-bg px-3 py-2">
          <ArrowBigUp className="h-4 w-4 text-brand-text" />
          <span className="text-sm font-bold tabular-nums">{idea.vote_count}</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', kind.tone)}>
              {kind.emoji} {kind.label}
            </span>
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', meta.badge)}>
              <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} /> {meta.label}
            </span>
            <span className="text-[11px] text-muted">{cat.emoji} {cat.label}</span>
            {idea.github_issue_url && (
              <a href={idea.github_issue_url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-text hover:underline">
                <Github className="h-3 w-3" /> #{idea.github_issue_number}
              </a>
            )}
            {idea.pinned && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-text"><Pin className="h-3 w-3" /> {t('feedbackAdmin.pinned')}</span>}
            <span className="text-[11px] text-muted/70">· {idea.author_name} · {fmt(idea.created_at)}</span>
          </div>
          <h3 className="mt-1 text-sm font-bold text-fg">{idea.title}</h3>
          {idea.problem && <p className="mt-1 text-xs text-muted"><span className="font-semibold">Problem:</span> {idea.problem}</p>}
          {idea.body && <p className="mt-1 line-clamp-3 text-xs text-muted">{idea.body}</p>}
          {idea.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={idea.image_url} alt="" className="mt-2 max-h-40 rounded-lg border border-border object-cover" referrerPolicy="no-referrer" />
          )}

          <button type="button" onClick={onToggle} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-text">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {t('feedbackAdmin.actOnThisIdea')}
            {idea.comment_count > 0 && <span className="ml-1 inline-flex items-center gap-1 text-muted"><MessageSquare className="h-3 w-3" />{idea.comment_count}</span>}
          </button>
        </div>

        {/* Pin / delete */}
        <div className="flex shrink-0 gap-1">
          <button
            type="button" disabled={busy !== null}
            onClick={() => run('pin', () => setIdeaPinnedAction({ ideaId: idea.id, pinned: !idea.pinned }), idea.pinned ? 'Unpinned.' : 'Pinned to top.')}
            title={idea.pinned ? 'Unpin' : 'Pin to top'}
            className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50"
          >
            {idea.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
          <button
            type="button" disabled={busy !== null}
            onClick={() => {
              if (window.confirm('Delete this idea? This removes it and all its votes and comments. This cannot be undone.')) {
                void run('delete', () => deleteIdeaAction({ ideaId: idea.id }), 'Idea deleted.');
              }
            }}
            title={t('feedbackAdmin.deleteIdea')}
            className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
          {/* Status + roadmap note */}
          <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted">{t('feedbackAdmin.roadmapStatus')}</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as FeedbackStatus)}
                className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm outline-none focus:border-brand">
                {FILTERABLE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted">{t('feedbackAdmin.publicRoadmapNoteShownToMembers')}</label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000}
                placeholder={t('feedbackAdmin.eGGreatIdeaWereBuilding')}
                className="w-full resize-y rounded-lg border border-border bg-bg p-2 text-sm outline-none focus:border-brand" />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button" disabled={!dirty || busy !== null}
              onClick={() => run('update', () => updateIdeaAction({ ideaId: idea.id, status, note }), 'Idea updated.')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'update' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {t('feedbackAdmin.saveStatusAmpNote')}
            </button>
          </div>

          {/* Existing comments */}
          {comments.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted">{t('feedbackAdmin.conversation')}</p>
              {comments.map((c) => (
                <div key={c.id} className={cn('rounded-lg border p-2.5 text-xs', c.is_team ? 'border-brand/25 bg-brand/5' : 'border-border bg-bg')}>
                  <p className="font-semibold text-fg">{c.author_name}{c.is_team && <span className="ml-1 rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-brand-text">{t('feedbackAdmin.team')}</span>}</p>
                  <p className="mt-0.5 text-muted">{c.body}</p>
                </div>
              ))}
            </div>
          )}

          {/* Team reply */}
          <div className="flex items-start gap-2">
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} maxLength={2000}
              placeholder={t('feedbackAdmin.replyAsTheBubalyTeam')}
              className="w-full resize-y rounded-lg border border-border bg-bg p-2 text-sm outline-none focus:border-brand" />
            <button
              type="button" disabled={!reply.trim() || busy !== null}
              onClick={async () => { const ok = await run('reply', () => postTeamReplyAction({ ideaId: idea.id, body: reply }), 'Reply posted.'); if (ok) setReply(''); }}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-semibold text-brand-fg transition hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'reply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t('feedbackAdmin.reply')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
