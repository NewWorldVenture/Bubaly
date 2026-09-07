'use client';

// Paperwork Inbox — mobile-first triage for family paperwork. Status filter
// chips, urgency-ranked cards with the AI-extracted action items, one-tap
// materialization (calendar event / reminder), and a paste-to-capture composer.
import { useMemo, useState, useTransition } from 'react';
import {
  Inbox, FileSignature, School, Stethoscope, Trophy, Receipt, PartyPopper,
  FileText, Plus, Check, CalendarPlus, BellPlus, Archive, RotateCcw, CalendarCheck,
  AlertTriangle, Clock, Loader2, X, Sparkles, Copy,
} from 'lucide-react';
import type { Tables, Json } from '@/lib/database.types';
import type { PaperworkAction, PaperworkKind } from '@/lib/paperwork/triage';
import { kindLabel } from '@/lib/paperwork/triage';
import {
  addPaperworkAction, materializePaperworkActionAction, setPaperworkStatusAction,
  draftPaperworkReplyAction,
} from '@/app/(app)/dashboard/paperwork/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

function draftFromMeta(meta: Json): string | null {
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (typeof (meta as Record<string, unknown>).draft_reply === 'string' ? (meta as Record<string, string>).draft_reply : null)
    : null;
}

type Item = Tables<'paperwork_items'>;
type StoredAction = PaperworkAction & { materialized_as: string | null; materialized_id: string | null };

const KIND_ICON: Record<PaperworkKind, typeof FileText> = {
  permission_slip: FileSignature,
  school_notice: School,
  medical_form: Stethoscope,
  sports: Trophy,
  bill_or_payment: Receipt,
  event_flyer: PartyPopper,
  // Triage recognises these two; `paperwork_items.kind` stores them as
  // bill_or_payment / event_flyer (0169's CHECK), so a row never carries them
  // today — but the map is exhaustive so the day the column widens, the icon
  // is already here rather than crashing on an undefined component.
  receipt: Receipt,
  reservation: CalendarCheck,
  other: FileText,
};

const FILTERS = [
  { key: 'needs_action', label: 'Needs action' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
  { key: 'archived', label: 'Archived' },
] as const;

const URGENCY_RANK: Record<string, number> = { urgent: 0, soon: 1, normal: 2 };

function parseActions(j: Json): StoredAction[] {
  return Array.isArray(j) ? (j as unknown as StoredAction[]) : [];
}

export function PaperworkModule({ items }: { items: Item[] }) {
  const t = useTranslations();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('needs_action');
  const [composerOpen, setComposerOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const draftReply = (itemId: string) => {
    setBusyKey(`draft:${itemId}`);
    startTransition(async () => {
      const res = await draftPaperworkReplyAction(itemId);
      setBusyKey(null);
      if (res.ok) { setDrafts((d) => ({ ...d, [itemId]: res.draft })); setOpenDraft(itemId); success(t('paperworkModule.aiDraftedAReply')); }
      else toastError(res.error);
    });
  };
  const copyDraft = async (text: string) => {
    try { await navigator.clipboard.writeText(text); success(t('paperworkModule.copied')); } catch { toastError(t('paperworkModule.couldNotCopy')); }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items) c[it.status] = (c[it.status] ?? 0) + 1;
    return c;
  }, [items]);

  const visible = useMemo(
    () => items
      .filter((it) => it.status === filter)
      .sort((a, b) =>
        (URGENCY_RANK[a.urgency] ?? 2) - (URGENCY_RANK[b.urgency] ?? 2)
        || (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999')),
    [items, filter],
  );

  const materialize = (itemId: string, actionIndex: number) => {
    setBusyKey(`${itemId}:${actionIndex}`);
    startTransition(async () => {
      await materializePaperworkActionAction({ itemId, actionIndex });
      setBusyKey(null);
    });
  };

  const setStatus = (itemId: string, status: 'needs_action' | 'done' | 'archived') => {
    setBusyKey(itemId);
    startTransition(async () => {
      await setPaperworkStatusAction({ itemId, status });
      setBusyKey(null);
    });
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl">
            <Inbox className="h-6 w-6 text-brand-text" /> {t('paperwork.paperworkInbox')}
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted">{t('paperworkModule.pasteAnySlipFormOr')}</p>
        </div>
        <button
          onClick={() => setComposerOpen((v) => !v)}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-bold text-brand-fg transition hover:opacity-90"
        >
          {composerOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {composerOpen ? 'Close' : 'Add paperwork'}
        </button>
      </header>

      {/* Composer */}
      {composerOpen && <Composer onDone={() => setComposerOpen(false)} />}

      {/* Filter chips */}
      <div className="mt-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-bold transition',
              filter === f.key
                ? 'border-brand bg-brand/15 text-brand-text'
                : 'border-border text-muted hover:bg-elevated',
            )}
          >
            {f.label}
            {(counts[f.key] ?? 0) > 0 && (
              <span className={cn('rounded-full px-1.5 text-[10px]', filter === f.key ? 'bg-brand/20' : 'bg-elevated')}>
                {counts[f.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="mt-4 space-y-3">
        {visible.length === 0 && (
          <p className="rounded-2xl border border-border bg-surface p-6 text-center text-sm text-muted">
            {filter === 'needs_action'
              ? 'Inbox zero 🎉 — nothing needs your signature, payment, or reply.'
              : 'Nothing here yet.'}
          </p>
        )}
        {visible.map((it) => {
          const Icon = KIND_ICON[(it.kind as PaperworkKind)] ?? FileText;
          const actions = parseActions(it.actions);
          const busyItem = busyKey === it.id;
          return (
            <article key={it.id} className={cn(
              'rounded-2xl border p-4 transition',
              it.urgency === 'urgent' && it.status === 'needs_action'
                ? 'border-rose-400/40 bg-rose-500/[0.05]'
                : 'border-border bg-surface',
            )}>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] ring-1 ring-white/10">
                  <Icon className="h-5 w-5 text-brand-text" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold">{it.title}</h3>
                    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">
                      {kindLabel(it.kind as PaperworkKind)}
                    </span>
                    {it.urgency === 'urgent' && it.status === 'needs_action' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-300">
                        <AlertTriangle className="h-2.5 w-2.5" /> {t('paperwork.urgent')}
                      </span>
                    )}
                    {it.due_on && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                        <Clock className="h-2.5 w-2.5" /> due {it.due_on}
                      </span>
                    )}
                  </div>
                  {it.summary && <p className="mt-1 text-xs text-muted">{it.summary}{it.sender ? ` · from ${it.sender}` : ''}</p>}

                  {/* Extracted actions */}
                  {it.status !== 'archived' && actions.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      {actions.map((a, i) => {
                        const done = Boolean(a.materialized_id);
                        const busy = busyKey === `${it.id}:${i}`;
                        const isEvent = a.kind === 'schedule' || a.kind === 'rsvp';
                        return (
                          <div key={i} className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-bg/40 px-3 py-2">
                            <span className={cn('min-w-0 flex-1 truncate text-xs', done ? 'text-muted line-through' : 'text-fg')}>
                              {a.label}{a.amount != null ? ` · $${a.amount}` : ''}{a.due_on ? ` · by ${a.due_on}` : ''}
                            </span>
                            {done ? (
                              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-emerald-400">
                                <Check className="h-3 w-3" /> {a.materialized_as === 'calendar_event' ? 'On calendar' : 'Reminder set'}
                              </span>
                            ) : (
                              <button
                                onClick={() => materialize(it.id, i)}
                                disabled={pending && busy}
                                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-brand/15 px-2.5 text-[11px] font-bold text-brand-text transition hover:bg-brand/25 disabled:opacity-60"
                              >
                                {busy ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : isEvent ? <CalendarPlus className="h-3 w-3" /> : <BellPlus className="h-3 w-3" />}
                                {isEvent ? 'Add to calendar' : 'Remind me'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* AI-drafted reply — "fill it out for me" */}
                  {it.status !== 'archived' && (() => {
                    const draft = drafts[it.id] ?? draftFromMeta(it.meta);
                    const drafting = busyKey === `draft:${it.id}`;
                    return (
                      <div className="mt-3">
                        <button
                          onClick={() => (draft && openDraft !== it.id ? setOpenDraft(it.id) : draft ? setOpenDraft(null) : draftReply(it.id))}
                          disabled={drafting}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 text-xs font-bold text-violet-300 transition hover:bg-violet-500/20 disabled:opacity-60"
                        >
                          {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                          {drafting ? 'Drafting…' : draft ? (openDraft === it.id ? 'Hide AI reply' : 'View AI reply') : 'Draft reply with AI'}
                        </button>
                        {draft && openDraft === it.id && (
                          <div className="mt-2 rounded-xl border border-violet-400/20 bg-violet-500/[0.04] p-3">
                            <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg/90">{draft}</p>
                            <button onClick={() => copyDraft(draft)}
                              className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-300 hover:underline">
                              <Copy className="h-3 w-3" /> {t('paperwork.copyReply')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Row actions */}
                  <div className="mt-3 flex items-center gap-2">
                    {it.status !== 'done' && it.status !== 'archived' && (
                      <button onClick={() => setStatus(it.id, 'done')} disabled={busyItem}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted transition hover:bg-elevated disabled:opacity-60">
                        <Check className="h-3.5 w-3.5" /> {t('paperwork.markDone')}
                      </button>
                    )}
                    {it.status !== 'archived' ? (
                      <button onClick={() => setStatus(it.id, 'archived')} disabled={busyItem}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted transition hover:bg-elevated disabled:opacity-60">
                        <Archive className="h-3.5 w-3.5" /> {t('paperwork.archive')}
                      </button>
                    ) : (
                      <button onClick={() => setStatus(it.id, 'needs_action')} disabled={busyItem}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted transition hover:bg-elevated disabled:opacity-60">
                        <RotateCcw className="h-3.5 w-3.5" /> {t('paperwork.reopen')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Composer({ onDone }: { onDone: () => void }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(fd) => startTransition(async () => { await addPaperworkAction(fd); onDone(); })}
      className="mt-4 rounded-2xl border border-brand/30 bg-brand/[0.05] p-4"
    >
      <label htmlFor="pw-text" className="text-xs font-bold uppercase tracking-wide text-muted">
        {t('paperwork.pasteThePaperworkText')}
      </label>
      <textarea
        id="pw-text"
        name="text"
        required
        rows={5}
        placeholder={'e.g. "Field trip to the Science Museum — please sign and return the permission slip with the $12 fee by March 3rd…"'}
        className="mt-2 w-full rounded-xl border border-border bg-bg p-3 text-sm text-fg outline-none ring-brand/50 placeholder:text-muted focus:ring-2"
      />
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          name="sender"
          placeholder={t('paperwork.fromSchoolCoachClinicOptional')}
          className="h-10 flex-1 rounded-xl border border-border bg-bg px-3 text-sm text-fg outline-none ring-brand/50 placeholder:text-muted focus:ring-2"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t('paperwork.triageIt')}
        </button>
      </div>
    </form>
  );
}
