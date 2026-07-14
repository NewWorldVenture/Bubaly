'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { ChevronUp, MessageCircle, Send, Loader2, Sparkles, Filter, Shield, Lightbulb } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  STATUS_META, FILTERABLE_STATUSES, CATEGORY_META, CATEGORY_ORDER, IMPACT_META, IMPACT_ORDER,
  AUDIENCE_META, AUDIENCE_ORDER, statusMeta, categoryMeta, impactMeta, sortIdeas, toggleVote,
  isFeedbackStatus, type IdeaRow, type FeedbackSort, type FeedbackStatus,
} from '@/lib/feedback/board';
import { submitIdeaAction, toggleVoteAction, addCommentAction, setIdeaStatusAction } from './actions';
import { FeedbackAttachmentUpload } from './feedback-attachment-upload';

type Comment = { id: string; author_name: string; is_team: boolean; body: string; created_at: string };

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const SORTS: { id: FeedbackSort; label: string }[] = [
  { id: 'top', label: 'Top' }, { id: 'trending', label: 'Trending' }, { id: 'new', label: 'Newest' },
];

// ── Share-your-idea form (inline card) ───────────────────────────────────────
function ShareIdeaForm({ userId, onCreated }: { userId: string; onCreated: (idea: IdeaRow) => void }) {
  const { success, error } = useToast();
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('other');
  const [impact, setImpact] = useState('helpful');
  const [audience, setAudience] = useState('me');
  const [imageUrl, setImageUrl] = useState('');
  const [pending, start] = useTransition();

  function reset() {
    setTitle(''); setProblem(''); setBody('');
    setCategory('other'); setImpact('helpful'); setAudience('me'); setImageUrl('');
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await submitIdeaAction({ title, problem, body, category, impact, audience, imageUrl });
      if (!res.ok || !res.id) { error(res.error ?? 'Could not submit your idea.'); return; }
      onCreated({
        id: res.id, title: title.trim(), problem: problem.trim() || null, body: body.trim() || null,
        category, impact, audience, status: 'under_review', admin_note: null, image_url: imageUrl.trim() || null,
        author_name: 'You', vote_count: 1, comment_count: 0, pinned: false, created_at: new Date().toISOString(),
      });
      success('Thanks! Your idea is on the board. 💡');
      reset();
    });
  }

  const field = 'w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm outline-none transition focus:border-brand';
  const label = 'mb-1.5 block text-xs font-semibold text-muted';

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className={label}>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoFocus
          placeholder="A quick, memorable summary" className={field} />
      </div>
      <div>
        <label className={label}>What problem would this solve?</label>
        <input value={problem} onChange={(e) => setProblem(e.target.value)} maxLength={2000}
          placeholder="Today, I struggle with…" className={field} />
      </div>
      <div>
        <label className={label}>Your idea</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={4}
          placeholder="Describe how it might work — even a rough sketch helps." className={cn(field, 'resize-y')} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className={label}>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
            {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_META[c].emoji} {CATEGORY_META[c].label}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Impact</label>
          <select value={impact} onChange={(e) => setImpact(e.target.value)} className={field}>
            {IMPACT_ORDER.map((i) => <option key={i} value={i}>{IMPACT_META[i].label}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>For you or others?</label>
          <select value={audience} onChange={(e) => setAudience(e.target.value)} className={field}>
            {AUDIENCE_ORDER.map((a) => <option key={a} value={a}>{AUDIENCE_META[a].label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className={label}>Add an image or file</label>
        <FeedbackAttachmentUpload value={imageUrl} onChange={setImageUrl} userId={userId} />
      </div>
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-xs text-muted">All fields optional except a title.</span>
        <div className="flex gap-2">
          <button type="button" onClick={reset} disabled={pending} className="rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-elevated disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={pending || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Submit idea
          </button>
        </div>
      </div>
    </form>
  );
}

// ── Comment thread (lazy-loaded on expand) ───────────────────────────────────
function CommentThread({ ideaId }: { ideaId: string }) {
  const { error } = useToast();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, start] = useTransition();

  async function load() {
    setLoading(true);
    try {
      const { createClient } = await import('@/lib/supabase/client');
      const sb = createClient();
      const { data } = await sb.from('feedback_comments')
        .select('id, author_name, is_team, body, created_at').eq('idea_id', ideaId).order('created_at', { ascending: true }).limit(200);
      setComments((data ?? []) as Comment[]);
    } finally { setLoading(false); }
  }
  if (comments === null && !loading) void load();

  function post(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    start(async () => {
      const res = await addCommentAction({ ideaId, body });
      if (!res.ok) { error(res.error ?? 'Could not post your comment.'); return; }
      setDraft('');
      await load();
    });
  }

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      {loading && <p className="py-2 text-center text-xs text-muted">Loading discussion…</p>}
      <div className="space-y-2.5">
        {(comments ?? []).map((c) => (
          <div key={c.id} className="flex gap-2.5">
            <span className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold',
              c.is_team ? 'bg-brand/20 text-brand-text' : 'bg-elevated text-muted')}>
              {c.is_team ? <Shield className="h-3.5 w-3.5" /> : c.author_name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs">
                <span className={cn('font-semibold', c.is_team && 'text-brand-text')}>{c.author_name}</span>
                {c.is_team && <span className="ml-1.5 rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand-text">Team</span>}
                <span className="ml-1.5 text-muted">{timeAgo(c.created_at)}</span>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{c.body}</p>
            </div>
          </div>
        ))}
        {comments !== null && comments.length === 0 && !loading && (
          <p className="py-1 text-xs text-muted">No comments yet — start the conversation.</p>
        )}
      </div>
      <form onSubmit={post} className="mt-3 flex items-center gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000}
          placeholder="Add a comment…" className="h-9 flex-1 rounded-lg border border-border bg-bg px-3 text-sm outline-none focus:border-brand" />
        <button type="submit" disabled={pending || !draft.trim()}
          className="inline-flex h-9 items-center gap-1 rounded-lg bg-brand px-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
    </div>
  );
}

// ── Admin roadmap control ────────────────────────────────────────────────────
function StatusControl({ idea, onChanged }: { idea: IdeaRow; onChanged: (status: FeedbackStatus) => void }) {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  return (
    <select
      value={isFeedbackStatus(idea.status) ? idea.status : 'under_review'}
      disabled={pending}
      onChange={(e) => {
        const status = e.target.value;
        start(async () => {
          const res = await setIdeaStatusAction({ ideaId: idea.id, status });
          if (!res.ok) { error(res.error ?? 'Could not update status.'); return; }
          if (isFeedbackStatus(status)) { onChanged(status); success('Roadmap updated.'); }
        });
      }}
      className="rounded-lg border border-border bg-bg px-2 py-1 text-[11px] font-semibold outline-none focus:border-brand"
      aria-label="Set idea status"
    >
      {FILTERABLE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
    </select>
  );
}

// ── One idea row ─────────────────────────────────────────────────────────────
function IdeaCard({ idea, voted, onVote, isSuperAdmin, onStatus }: {
  idea: IdeaRow; voted: boolean; onVote: () => void; isSuperAdmin: boolean; onStatus: (s: FeedbackStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [voting, start] = useTransition();
  const { error } = useToast();
  const meta = statusMeta(idea.status);
  const cat = categoryMeta(idea.category);
  const imp = impactMeta(idea.impact);

  function vote() {
    start(async () => {
      const res = await toggleVoteAction(idea.id);
      if (!res.ok) { error(res.error ?? 'Could not record your vote.'); return; }
      onVote();
    });
  }

  return (
    <article className="rounded-2xl border border-border bg-surface/40 p-4 transition hover:border-border sm:p-5">
      <div className="flex gap-4">
        {/* Upvote pill */}
        <button
          type="button" onClick={vote} disabled={voting} aria-pressed={voted}
          className={cn(
            'flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-xl border text-center transition',
            voted ? 'border-brand bg-brand/10 text-brand-text' : 'border-border bg-bg text-muted hover:border-brand/50 hover:text-brand-text',
          )}
        >
          {voting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronUp className={cn('h-5 w-5', voted && 'scale-110')} />}
          <span className="text-sm font-black tabular-nums">{idea.vote_count}</span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="text-sm font-bold sm:text-base">{idea.title}</h3>
            <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', meta.badge)}>
              <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} /> {meta.label}
            </span>
          </div>
          {(idea.body || idea.problem) && (
            <p className="mt-1 line-clamp-2 text-sm text-muted">{idea.body || idea.problem}</p>
          )}
          {idea.admin_note && (
            <p className="mt-2 rounded-lg border border-brand/25 bg-brand/5 px-3 py-1.5 text-xs text-brand-text">
              <span className="font-semibold">Team note:</span> {idea.admin_note}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded-full bg-elevated px-2 py-0.5 font-medium">{cat.emoji} {cat.label}</span>
            <span className="rounded-full bg-elevated px-2 py-0.5 font-medium">{imp.label}</span>
            <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 hover:text-brand-text">
              <MessageCircle className="h-3.5 w-3.5" /> {idea.comment_count} {idea.comment_count === 1 ? 'comment' : 'comments'}
            </button>
            <span className="text-muted/70">· by {idea.author_name}</span>
            {isSuperAdmin && <span className="ml-auto"><StatusControl idea={idea} onChanged={onStatus} /></span>}
          </div>
          {open && <CommentThread ideaId={idea.id} />}
        </div>
      </div>
    </article>
  );
}

// ── The board ────────────────────────────────────────────────────────────────
export function FeedbackBoard({ initialIdeas, votedIds, userId, isSuperAdmin }: {
  initialIdeas: IdeaRow[]; votedIds: string[]; userId: string; isSuperAdmin: boolean;
}) {
  const [ideas, setIdeas] = useState<IdeaRow[]>(initialIdeas);
  const [voted, setVoted] = useState<string[]>(votedIds);
  const [sort, setSort] = useState<FeedbackSort>('top');
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const filtered = ideas.filter((i) =>
      (statusFilter === 'all' || i.status === statusFilter) &&
      (categoryFilter === 'all' || i.category === categoryFilter));
    return sortIdeas(filtered, sort);
  }, [ideas, sort, statusFilter, categoryFilter]);

  function handleVote(ideaId: string) {
    const { next, voted: nowVoted } = toggleVote(voted, ideaId);
    setVoted(next);
    setIdeas((prev) => prev.map((i) => i.id === ideaId ? { ...i, vote_count: Math.max(0, i.vote_count + (nowVoted ? 1 : -1)) } : i));
  }
  function handleStatus(ideaId: string, status: FeedbackStatus) {
    setIdeas((prev) => prev.map((i) => i.id === ideaId ? { ...i, status } : i));
  }
  function handleCreated(idea: IdeaRow) {
    setIdeas((prev) => [idea, ...prev]);
    setVoted((prev) => [...prev, idea.id]); // your own idea starts self-voted
  }

  const pill = (active: boolean) => cn(
    'rounded-full border px-3 py-1 text-xs font-semibold transition',
    active ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:border-brand/40 hover:text-fg',
  );

  return (
    <>
      {/* Share your idea — the primary inline submission card. */}
      <section className="rounded-2xl border border-border bg-surface/40 p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand-text"><Lightbulb className="h-5 w-5" /></span>
          <div>
            <h2 className="text-base font-bold sm:text-lg">Share your idea</h2>
            <p className="text-xs text-muted">Small ideas. Big impact.</p>
          </div>
        </div>
        <ShareIdeaForm userId={userId} onCreated={handleCreated} />
      </section>

      <div className="mt-8 flex items-center gap-2">
        <h2 className="text-lg font-bold sm:text-xl">Popular ideas</h2>
        <span className="rounded-full bg-elevated px-2 py-0.5 text-xs font-semibold text-muted tabular-nums">{ideas.length}</span>
      </div>

      {/* Sort + filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="mr-1 inline-flex rounded-xl border border-border bg-surface/40 p-0.5">
          {SORTS.map((s) => (
            <button key={s.id} onClick={() => setSort(s.id)}
              className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold transition', sort === s.id ? 'bg-brand text-white' : 'text-muted hover:text-fg')}>
              {s.label}
            </button>
          ))}
        </div>
        <Filter className="h-4 w-4 text-muted" />
        <button onClick={() => setStatusFilter('all')} className={pill(statusFilter === 'all')}>All status</button>
        {FILTERABLE_STATUSES.map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} className={pill(statusFilter === s)}>{STATUS_META[s].label}</button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button onClick={() => setCategoryFilter('all')} className={pill(categoryFilter === 'all')}>All categories</button>
        {CATEGORY_ORDER.map((c) => (
          <button key={c} onClick={() => setCategoryFilter(c)} className={pill(categoryFilter === c)}>{CATEGORY_META[c].emoji} {CATEGORY_META[c].label}</button>
        ))}
      </div>

      {/* List */}
      <div ref={listRef} className="mt-5 space-y-3">
        {visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-16 text-center">
            <p className="text-sm font-semibold">No ideas match these filters</p>
            <p className="mt-1 text-xs text-muted">Try clearing a filter, or add a new idea above.</p>
            <button
              onClick={() => { setStatusFilter('all'); setCategoryFilter('all'); }}
              className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-elevated">
              Clear filters
            </button>
          </div>
        ) : visible.map((idea) => (
          <IdeaCard key={idea.id} idea={idea} voted={voted.includes(idea.id)}
            onVote={() => handleVote(idea.id)} isSuperAdmin={isSuperAdmin}
            onStatus={(s) => handleStatus(idea.id, s)} />
        ))}
      </div>
    </>
  );
}
