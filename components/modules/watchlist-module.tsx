'use client';

import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, Plus, Sparkles, Heart, ThumbsUp, ThumbsDown, Trash2, Pencil, Check, Clock, Popcorn, Star, Tv } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables, WatchKind, WatchService, WatchStatus, WatchVote } from '@/lib/database.types';
import {
  WATCH_KINDS, WATCH_SERVICES, WATCH_STATUSES, AGE_RATINGS, TIME_PRESETS, kindMeta, serviceLabel, ratingMinAge,
  ageOn, pickTonight, watchlistSummary,
} from '@/lib/watchlist/picker';

type Title = Tables<'watchlist_titles'>;
type Vote = Tables<'watchlist_votes'>;
type Session = Tables<'watch_sessions'>;

const todayIso = () => new Date().toISOString().slice(0, 10);
function fmtDate(d: string): string {
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function WatchlistModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const titles = useRealtimeQuery<Title>({
    table: 'watchlist_titles', familyId,
    fetcher: (s) => s.from('watchlist_titles').select('*').eq('family_id', familyId).order('priority').order('created_at', { ascending: false }),
    deps: [familyId],
  });
  const votes = useRealtimeQuery<Vote>({
    table: 'watchlist_votes', familyId,
    fetcher: (s) => s.from('watchlist_votes').select('*').eq('family_id', familyId),
    deps: [familyId],
  });
  const sessions = useRealtimeQuery<Session>({
    table: 'watch_sessions', familyId,
    fetcher: (s) => s.from('watch_sessions').select('*').eq('family_id', familyId).order('watched_on', { ascending: false }).limit(60),
    deps: [familyId],
  });

  const [audience, setAudience] = useState<string[]>([]);
  useEffect(() => { if (audience.length === 0 && members.length) setAudience(members.map((m) => m.id)); }, [members, audience.length]);
  const [minutes, setMinutes] = useState<number>(120);
  const [service, setService] = useState<WatchService | 'any'>('any');
  const [statusTab, setStatusTab] = useState<WatchStatus | 'all'>('want');
  const [kindFilter, setKindFilter] = useState<WatchKind | 'all'>('all');
  const [form, setForm] = useState<{ open: boolean; title: Title | null }>({ open: false, title: null });
  const [watchedForm, setWatchedForm] = useState<Title | null>(null);

  const today = useMemo(() => new Date(), []);
  const myMemberId = selfMember?.id ?? null;
  const ages = useMemo(() => members.filter((m) => audience.includes(m.id)).map((m) => ageOn(m.birthday, today)).filter((a): a is number => a !== null), [members, audience, today]);
  const tonight = useMemo(() => pickTonight(titles.data, votes.data, { audienceIds: audience, audienceAges: ages, availableMinutes: minutes, service }), [titles.data, votes.data, audience, ages, minutes, service]);
  const summary = useMemo(() => watchlistSummary(titles.data, sessions.data, today), [titles.data, sessions.data, today]);
  const filtered = useMemo(
    () => titles.data.filter((t) => (statusTab === 'all' || t.status === statusTab) && (kindFilter === 'all' || t.kind === kindFilter)),
    [titles.data, statusTab, kindFilter],
  );
  const myVote = (titleId: string): WatchVote | null => votes.data.find((v) => v.title_id === titleId && v.member_id === myMemberId)?.vote ?? null;
  const voteCounts = (titleId: string) => {
    const vs = votes.data.filter((v) => v.title_id === titleId);
    return { love: vs.filter((v) => v.vote === 'love').length, up: vs.filter((v) => v.vote === 'up').length, down: vs.filter((v) => v.vote === 'down').length };
  };
  const memberName = (id: string) => members.find((m) => m.id === id)?.display_name ?? 'Someone';

  async function castVote(title: Title, vote: WatchVote) {
    if (!myMemberId) return toastError('Join the family to vote');
    const supabase = createClient();
    const existing = votes.data.find((v) => v.title_id === title.id && v.member_id === myMemberId);
    const { error } = existing
      ? existing.vote === vote
        ? await supabase.from('watchlist_votes').delete().eq('id', existing.id)
        : await supabase.from('watchlist_votes').update({ vote }).eq('id', existing.id)
      : await supabase.from('watchlist_votes').insert({ family_id: familyId, title_id: title.id, member_id: myMemberId, vote, created_by: userId });
    if (error) return toastError(describeDbError(error));
  }

  async function setStatus(title: Title, status: WatchStatus) {
    const { error } = await createClient().from('watchlist_titles').update({ status }).eq('id', title.id);
    if (error) return toastError(describeDbError(error));
    success(`${title.title}: ${WATCH_STATUSES.find((s) => s.value === status)?.label}`);
  }

  async function deleteTitle(title: Title) {
    if (!confirm(`Remove “${title.title}” from the watchlist?`)) return;
    const { error } = await createClient().from('watchlist_titles').delete().eq('id', title.id);
    if (error) return toastError(describeDbError(error));
    success('Title removed');
  }

  async function deleteSession(session: Session) {
    const { error } = await createClient().from('watch_sessions').delete().eq('id', session.id);
    if (error) return toastError(describeDbError(error));
  }

  const loading = titles.loading || votes.loading || sessions.loading;
  const error = titles.error || votes.error || sessions.error;
  const refresh = () => { void titles.refresh(); void votes.refresh(); void sessions.refresh(); };
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load the watchlist. Refresh and try again." onRetry={refresh} />;

  const topPicks = tonight.picks.slice(0, 3);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Family Watchlist"
        description="One list for movie night: everyone votes, ages and runtimes are respected, and tonight’s pick is one tap instead of an hour of scrolling."
        action={<div className="flex items-center gap-2"><AiInsight kind="watchlist" iconOnly /><Button onClick={() => setForm({ open: true, title: null })}><Plus className="h-4 w-4" /> Add title</Button></div>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-brand/20 bg-brand/5 p-5 lg:col-span-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-text"><Popcorn className="h-4 w-4" /> Tonight</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Who’s watching:</span>
            {members.map((m) => {
              const on = audience.includes(m.id);
              return (
                <button key={m.id} aria-pressed={on} onClick={() => setAudience(on ? audience.filter((x) => x !== m.id) : [...audience, m.id])}
                  className={cn('rounded-full border px-3 py-1 text-xs coarse:min-h-11', on ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>
                  {m.display_name}{ageOn(m.birthday, today) !== null ? ` · ${ageOn(m.birthday, today)}` : ''}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Clock className="h-4 w-4 text-muted" />
            {TIME_PRESETS.map((m) => (
              <button key={m} aria-pressed={minutes === m} onClick={() => setMinutes(m)} className={cn('rounded-full border px-2.5 py-1 text-xs coarse:min-h-11', minutes === m ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{m} min</button>
            ))}
            <Select value={service} onChange={(e) => setService(e.target.value as WatchService | 'any')} aria-label="Service" className="w-auto">
              <option value="any">Any service</option>
              {WATCH_SERVICES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </div>

          {topPicks.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              {titles.data.some((t) => t.status === 'want' || t.status === 'watching')
                ? `Nothing fits tonight’s crowd and time${tonight.excluded[0] ? ` — closest: ${tonight.excluded[0].title.title} (${tonight.excluded[0].blockers.join('; ')})` : ''}.`
                : 'Add a few titles the family wants to watch and the picker takes it from there.'}
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {topPicks.map((p, i) => (
                <li key={p.title.id} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2', i === 0 ? 'border-brand/40 bg-brand/10' : 'border-border bg-surface/60')}>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-lg">{kindMeta(p.title.kind).emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{i === 0 ? '🏆 ' : ''}{p.title.title}{p.title.year ? ` (${p.title.year})` : ''}</p>
                    <p className="truncate text-xs text-muted">{p.reasons.join(' · ') || 'on the list'} · {serviceLabel(p.title.service)}</p>
                  </div>
                  <Button size="sm" onClick={() => setWatchedForm(p.title)}><Check className="h-3.5 w-3.5" /> We watched it</Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><Tv className="h-4 w-4 text-brand-text" /> Queue</div>
          <p className="mt-2 text-xl font-bold">{summary.text}</p>
          <p className="mt-1 text-xs text-muted">
            {summary.watchedThisMonth} watched this month{summary.avgRating !== null ? ` · avg rating ${summary.avgRating}/5` : ''}{summary.topService ? ` · mostly ${summary.topService}` : ''}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Status">
        {[{ value: 'want', label: 'Want to watch' }, { value: 'watching', label: 'Watching' }, { value: 'watched', label: 'Watched' }, { value: 'skipped', label: 'Skipped' }, { value: 'all', label: 'All' }].map((t) => (
          <button key={t.value} role="tab" aria-selected={statusTab === t.value} onClick={() => setStatusTab(t.value as WatchStatus | 'all')}
            className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', statusTab === t.value ? 'border-brand bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
            {t.label}
          </button>
        ))}
        <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as WatchKind | 'all')} aria-label="Kind" className="w-auto">
          <option value="all">All kinds</option>
          {WATCH_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}
        </Select>
        <span className="text-xs text-muted">{filtered.length} title{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {titles.data.length === 0 ? (
        <EmptyState icon={Clapperboard} title="The watchlist is empty" description="Add movies and shows the family keeps saying “we should watch that” about." action={<Button onClick={() => setForm({ open: true, title: null })}><Plus className="h-4 w-4" /> Add the first title</Button>} />
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2">
          {filtered.map((t) => {
            const mine = myVote(t.id);
            const counts = voteCounts(t.id);
            return (
              <li key={t.id} className="group flex items-center gap-3 rounded-2xl border border-border bg-surface/40 px-3 py-2.5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-xl">{kindMeta(t.kind).emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.title}{t.year ? <span className="text-muted"> ({t.year})</span> : null}</p>
                  <p className="truncate text-xs text-muted">
                    {t.age_rating ?? `${t.min_age}+`} · {t.runtime_min ? `${t.runtime_min} min` : 'runtime ?'} · {serviceLabel(t.service)}{t.genres.length ? ` · ${t.genres.join(', ')}` : ''}
                    {t.added_by ? ` · added by ${memberName(t.added_by)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-0.5">
                  <button onClick={() => castVote(t, 'love')} aria-label="Love it" aria-pressed={mine === 'love'} className={cn('rounded-lg p-1.5 text-xs', mine === 'love' ? 'text-rose-400' : 'text-muted hover:text-fg')}><Heart className="h-4 w-4" fill={mine === 'love' ? 'currentColor' : 'none'} />{counts.love > 0 && <span className="ml-0.5">{counts.love}</span>}</button>
                  <button onClick={() => castVote(t, 'up')} aria-label="Thumbs up" aria-pressed={mine === 'up'} className={cn('rounded-lg p-1.5 text-xs', mine === 'up' ? 'text-emerald-400' : 'text-muted hover:text-fg')}><ThumbsUp className="h-4 w-4" />{counts.up > 0 && <span className="ml-0.5">{counts.up}</span>}</button>
                  <button onClick={() => castVote(t, 'down')} aria-label="Thumbs down" aria-pressed={mine === 'down'} className={cn('rounded-lg p-1.5 text-xs', mine === 'down' ? 'text-amber-400' : 'text-muted hover:text-fg')}><ThumbsDown className="h-4 w-4" />{counts.down > 0 && <span className="ml-0.5">{counts.down}</span>}</button>
                </div>
                <div className="flex items-center gap-0.5 opacity-70 transition group-hover:opacity-100">
                  {t.status !== 'watched' && <button onClick={() => setWatchedForm(t)} aria-label={`Mark ${t.title} watched`} title="Watched" className="rounded-lg p-1.5 text-muted hover:text-fg"><Check className="h-4 w-4" /></button>}
                  {t.status === 'want' && <button onClick={() => setStatus(t, 'watching')} aria-label={`Start ${t.title}`} title="Started watching" className="rounded-lg p-1.5 text-muted hover:text-fg"><Tv className="h-4 w-4" /></button>}
                  <button onClick={() => setForm({ open: true, title: t })} aria-label={`Edit ${t.title}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => deleteTitle(t)} aria-label={`Remove ${t.title}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Star className="h-4 w-4 text-brand-text" /> Recent movie nights</div>
        {sessions.data.length === 0 ? (
          <p className="text-sm text-muted">Log what you watched and who was there — ratings feed future picks.</p>
        ) : (
          <ul className="space-y-1.5">
            {sessions.data.slice(0, 8).map((s) => (
              <li key={s.id} className="group flex items-center gap-3 rounded-xl border border-border px-3 py-2 text-sm">
                <span className="w-14 shrink-0 text-xs text-muted">{fmtDate(s.watched_on)}</span>
                <span className="min-w-0 flex-1 truncate">{s.title_name}<span className="text-xs text-muted"> · {s.member_ids.map(memberName).join(', ') || 'family'}</span></span>
                {s.rating ? <span className="shrink-0 text-xs text-amber-300">{'★'.repeat(s.rating)}</span> : null}
                <button onClick={() => deleteSession(s)} aria-label="Delete session" className="shrink-0 p-1 text-muted/50 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {form.open && (
        <TitleForm familyId={familyId} userId={userId} memberId={myMemberId} title={form.title} onClose={() => setForm({ open: false, title: null })} onSaved={(msg) => { setForm({ open: false, title: null }); success(msg); }} />
      )}
      {watchedForm && (
        <WatchedForm familyId={familyId} userId={userId} title={watchedForm} members={members} defaultAudience={audience} onClose={() => setWatchedForm(null)} onSaved={() => { setWatchedForm(null); success('Movie night logged'); }} />
      )}
    </div>
  );
}

function TitleForm({ familyId, userId, memberId, title, onClose, onSaved }: {
  familyId: string; userId: string; memberId: string | null; title: Title | null; onClose: () => void; onSaved: (message: string) => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [rating, setRating] = useState(title?.age_rating ?? 'PG');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('title') ?? '').trim();
    if (!name) return toastError('Title is required');
    setLoading(true);
    const payload = {
      title: name,
      kind: String(f.get('kind') ?? 'movie') as WatchKind,
      year: f.get('year') ? Number(f.get('year')) : null,
      genres: String(f.get('genres') ?? '').split(',').map((g) => g.trim().toLowerCase()).filter(Boolean),
      age_rating: rating || null,
      min_age: f.get('min_age') ? Number(f.get('min_age')) : ratingMinAge(rating),
      runtime_min: f.get('runtime_min') ? Number(f.get('runtime_min')) : null,
      service: String(f.get('service') ?? 'other') as WatchService,
      status: String(f.get('status') ?? 'want') as WatchStatus,
      priority: Number(f.get('priority') ?? 2),
      external_url: String(f.get('external_url') ?? '').trim() || null,
      notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = title
      ? await supabase.from('watchlist_titles').update(payload).eq('id', title.id)
      : await supabase.from('watchlist_titles').insert({ family_id: familyId, created_by: userId, added_by: memberId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved(title ? 'Title updated' : 'Added to the watchlist');
  }

  return (
    <Modal open title={title ? `Edit · ${title.title}` : 'Add to the watchlist'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus defaultValue={title?.title ?? ''} placeholder="The Great Garden Race" />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Kind">{(id) => <Select id={id} name="kind" defaultValue={title?.kind ?? 'movie'}>{WATCH_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}</Select>}</Field>
          <Field label="Year">{(id) => <Input id={id} name="year" type="number" min={1900} max={2100} defaultValue={title?.year ?? ''} />}</Field>
          <Field label="Runtime (min)">{(id) => <Input id={id} name="runtime_min" type="number" min={1} max={1440} defaultValue={title?.runtime_min ?? ''} placeholder="95" />}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Age rating" hint="Sets the minimum age">{(id) => <Select id={id} name="age_rating" value={rating} onChange={(e) => setRating(e.target.value)}>{AGE_RATINGS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select>}</Field>
          <Field label="Min age (override)">{(id) => <Input id={id} name="min_age" type="number" min={0} max={21} placeholder={String(ratingMinAge(rating))} defaultValue={title && title.min_age !== ratingMinAge(title.age_rating) ? title.min_age : ''} />}</Field>
          <Field label="Priority">{(id) => <Select id={id} name="priority" defaultValue={title?.priority ?? 2}><option value={1}>1 · Must watch</option><option value={2}>2 · Normal</option><option value={3}>3 · Someday</option></Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Where">{(id) => <Select id={id} name="service" defaultValue={title?.service ?? 'netflix'}>{WATCH_SERVICES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
          <Field label="Status">{(id) => <Select id={id} name="status" defaultValue={title?.status ?? 'want'}>{WATCH_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
        </div>
        <Field label="Genres" hint="Comma-separated">{(id) => <Input id={id} name="genres" defaultValue={title?.genres.join(', ') ?? ''} placeholder="family, adventure" />}</Field>
        <Field label="Link">{(id) => <Input id={id} name="external_url" type="url" defaultValue={title?.external_url ?? ''} placeholder="https://…" />}</Field>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" defaultValue={title?.notes ?? ''} placeholder="Grandpa recommended it; has a scary bit at 40 min…" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{title ? 'Save changes' : 'Add title'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function WatchedForm({ familyId, userId, title, members, defaultAudience, onClose, onSaved }: {
  familyId: string; userId: string; title: Title; members: Tables<'family_members'>[]; defaultAudience: string[]; onClose: () => void; onSaved: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [who, setWho] = useState<string[]>(defaultAudience);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('watch_sessions').insert({
      family_id: familyId, title_id: title.id, title_name: title.title, watched_on: String(f.get('watched_on') ?? '') || todayIso(),
      member_ids: who, rating: f.get('rating') ? Number(f.get('rating')) : null, minutes: title.runtime_min,
      notes: String(f.get('notes') ?? '').trim() || null, created_by: userId,
    });
    if (error) { setLoading(false); return toastError(describeDbError(error)); }
    const { error: statusError } = await supabase.from('watchlist_titles').update({ status: 'watched' }).eq('id', title.id);
    setLoading(false);
    if (statusError) return toastError(describeDbError(statusError));
    onSaved();
  }

  return (
    <Modal open title={`We watched · ${title.title}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="When">{(id) => <Input id={id} name="watched_on" type="date" defaultValue={todayIso()} />}</Field>
          <Field label="Family rating">{(id) => <Select id={id} name="rating" defaultValue="4"><option value="">No rating</option>{[5, 4, 3, 2, 1].map((r) => <option key={r} value={r}>{'★'.repeat(r)}</option>)}</Select>}</Field>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Who watched</p>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => {
              const on = who.includes(m.id);
              return <button type="button" key={m.id} aria-pressed={on} onClick={() => setWho(on ? who.filter((x) => x !== m.id) : [...who, m.id])} className={cn('rounded-full border px-3 py-1 text-xs coarse:min-h-11', on ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{m.display_name}</button>;
            })}
          </div>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" placeholder="Everyone loved the ending…" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}><Sparkles className="h-4 w-4" /> Log movie night</Button>
        </div>
      </form>
    </Modal>
  );
}
