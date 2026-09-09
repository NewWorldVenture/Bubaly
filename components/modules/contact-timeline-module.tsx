'use client';

// Per-contact relationship timeline — mobile-first. Health card up top (last
// touch vs. cadence + a plain-language nudge), a log-interaction composer, and
// the merged timeline (logged interactions · inbox communications · birthdays).
import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Phone, MessageSquare, Gift, HandHeart, StickyNote, Users,
  Cake, Mail, HeartPulse, Plus, Loader2, Trash2, X, Sparkles, Copy, Check as CheckIcon, RefreshCw,
} from 'lucide-react';
import type { Tables } from '@/lib/database.types';
import type { TimelineEntry, ContactHealth, InteractionKind } from '@/lib/contacts/timeline';
import { INTERACTION_LABEL_KEY } from '@/lib/contacts/timeline';
import {
  logInteractionAction, deleteInteractionAction, draftReconnectMessageAction,
} from '@/app/(app)/dashboard/contacts/[id]/actions';
import { cn } from '@/lib/utils/cn';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';

type Tone = 'warm' | 'brief' | 'playful';
const TONES: { key: Tone; labelKey: string }[] = [
  { key: 'warm', labelKey: 'contactTimeline.toneWarm' }, { key: 'brief', labelKey: 'contactTimeline.toneBrief' }, { key: 'playful', labelKey: 'contactTimeline.tonePlayful' },
];

const ENTRY_ICON: Record<string, typeof Phone> = {
  visit: Users, call: Phone, message: MessageSquare, gift: Gift,
  favor: HandHeart, note: StickyNote, communication: Mail, birthday: Cake,
};

const HEALTH_STYLE: Record<ContactHealth['status'], { chip: string; labelKey: string }> = {
  fresh:      { chip: 'bg-emerald-500/15 text-emerald-300', labelKey: 'contactTimeline.statusFresh' },
  due:        { chip: 'bg-amber-500/15 text-amber-300', labelKey: 'contactTimeline.statusDue' },
  overdue:    { chip: 'bg-rose-500/15 text-rose-300', labelKey: 'reminders.overdue' },
  no_history: { chip: 'bg-white/[0.08] text-muted', labelKey: 'contactTimeline.statusNoHistory' },
};

const KIND_OPTIONS: InteractionKind[] = ['visit', 'call', 'message', 'gift', 'favor', 'note'];

/** Stored calendar dates have no time zone; format them without shifting days. */
function displayDate(value: string, locale: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function ContactTimelineModule({
  contact, timeline, health, interactionIds,
}: {
  contact: Tables<'family_contacts'>;
  timeline: TimelineEntry[];
  health: ContactHealth;
  interactionIds: string[];
}) {
  const tr = useTranslations();
  const locale = useLocale().code;
  const [composerOpen, setComposerOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const hs = HEALTH_STYLE[health.status];
  const loggedIds = new Set(interactionIds);

  const remove = (entryId: string) => {
    const rawId = entryId.replace(/^int-/, '');
    setBusyId(entryId);
    startTransition(async () => {
      await deleteInteractionAction({ id: rawId, contactId: contact.id });
      setBusyId(null);
    });
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
      <Link href="/dashboard/contacts" className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-fg">
        <ArrowLeft className="h-3.5 w-3.5" /> {tr('contactTimeline.allContacts')}
      </Link>

      {/* Header */}
      <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black sm:text-3xl">{contact.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {[contact.relationship, contact.organization, contact.specialty].filter(Boolean).join(' · ') || tr('contactTimeline.familyContact')}
            {contact.birthday_month && contact.birthday_day ? ` · 🎂 ${new Date(Date.UTC(2000, contact.birthday_month - 1, contact.birthday_day)).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : ''}
          </p>
        </div>
        <button
          onClick={() => setComposerOpen((v) => !v)}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-bold text-brand-fg transition hover:opacity-90"
        >
          {composerOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {composerOpen ? tr('home.close') : tr('contactTimeline.logTouch')}
        </button>
      </header>

      {/* Health card */}
      <section className="mt-5 rounded-2xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/12 ring-1 ring-brand/25">
            <HeartPulse className="h-5 w-5 text-brand-text" />
          </span>
          <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide', hs.chip)}>{tr(hs.labelKey)}</span>
          {health.daysSince != null && (
            <span className="text-xs text-muted">
              {tr('contactTimeline.lastTouch')} {new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-health.daysSince, 'day')}
              {health.cadenceDays ? ` · ${tr('contactTimeline.usualRhythm', { days: health.cadenceDays })}` : ''}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg">{health.suggestion}</p>
        <ReconnectDrafter contactId={contact.id} name={contact.name} />
      </section>

      {/* Composer */}
      {composerOpen && (
        <form
          action={(fd) => startTransition(async () => { await logInteractionAction(fd); setComposerOpen(false); })}
          className="mt-4 rounded-2xl border border-brand/30 bg-brand/[0.05] p-4"
        >
          <input type="hidden" name="contact_id" value={contact.id} />
          <div className="flex flex-wrap gap-1.5">
            {KIND_OPTIONS.map((k) => (
              <label key={k} className="cursor-pointer">
                <input type="radio" name="kind" value={k} defaultChecked={k === 'visit'} className="peer sr-only" />
                <span className="inline-flex h-8 items-center rounded-full border border-border px-3 text-xs font-semibold text-muted transition peer-checked:border-brand peer-checked:bg-brand/15 peer-checked:text-brand-text">
                  {tr(INTERACTION_LABEL_KEY[k])}
                </span>
              </label>
            ))}
          </div>
          <input
            name="title" required placeholder={tr('contactTimeline.whatHappenedEGSundayDinner')}
            className="mt-3 h-10 w-full rounded-xl border border-border bg-bg px-3 text-sm text-fg outline-none ring-brand/50 placeholder:text-muted focus:ring-2"
          />
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input name="occurred_on" type="date" defaultValue={new Date().toISOString().slice(0, 10)}
              className="h-10 rounded-xl border border-border bg-bg px-3 text-sm text-fg outline-none ring-brand/50 focus:ring-2" />
            <input name="amount" type="number" inputMode="decimal" step="0.01" min="0" placeholder={tr('contactTimeline.giftsOptional')}
              className="h-10 w-36 rounded-xl border border-border bg-bg px-3 text-sm text-fg outline-none ring-brand/50 placeholder:text-muted focus:ring-2" />
            <input name="note" placeholder={tr('contactTimeline.noteOptional')}
              className="h-10 flex-1 rounded-xl border border-border bg-bg px-3 text-sm text-fg outline-none ring-brand/50 placeholder:text-muted focus:ring-2" />
            <button type="submit" disabled={pending}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-60">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {tr('contactTimeline.logIt')}
            </button>
          </div>
        </form>
      )}

      {/* Timeline */}
      <section className="mt-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted">{tr('contactTimeline.timeline')}</h2>
        {timeline.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-border bg-surface p-6 text-center text-sm text-muted">
            {tr('contactTimeline.nothingHereYetLogYourFirst')}
          </p>
        ) : (
          <ol className="mt-3 space-y-0">
            {timeline.map((e) => {
              const Icon = ENTRY_ICON[e.kind] ?? StickyNote;
              const deletable = loggedIds.has(e.id.replace(/^int-/, '')) && e.id.startsWith('int-');
              return (
                <li key={e.id} className="relative flex gap-3 pb-5 pl-1 last:pb-0">
                  {/* Rail */}
                  <span className="absolute bottom-0 left-[21px] top-9 w-px bg-border" aria-hidden />
                  <span className={cn(
                    'z-10 grid h-9 w-9 shrink-0 place-items-center rounded-xl ring-1',
                    e.kind === 'birthday' ? 'bg-pink-500/12 ring-pink-400/25' : 'bg-white/[0.04] ring-white/10',
                  )}>
                    <Icon className={cn('h-4 w-4', e.kind === 'birthday' ? 'text-pink-400' : 'text-brand-text')} />
                  </span>
                  <div className="min-w-0 flex-1 rounded-2xl border border-border bg-surface p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{e.title}{e.amount != null ? ` · ${new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(e.amount)}` : ''}</p>
                        <p className="text-[11px] text-muted">{displayDate(e.date, locale)}</p>
                      </div>
                      {deletable && (
                        <button
                          onClick={() => remove(e.id)}
                          disabled={pending && busyId === e.id}
                          aria-label={tr('contactTimeline.deleteEntry')}
                          className="rounded-lg p-1.5 text-muted transition hover:bg-elevated hover:text-rose-400 disabled:opacity-50"
                        >
                          {busyId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      )}
                    </div>
                    {e.detail && <p className="mt-1 text-xs leading-relaxed text-muted">{e.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

/**
 * The "AI writes the message" lift: one tap drafts a short, ready-to-send
 * reconnect message grounded only in this contact's logged history, with tone
 * options, regenerate, and one-tap Copy. Honest inline error if no AI key.
 */
function ReconnectDrafter({ contactId, name }: { contactId: string; name: string }) {
  const tr = useTranslations();
  const [open, setOpen] = useState(false);
  const [tone, setTone] = useState<Tone>('warm');
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const draft = (t: Tone) => {
    setError(null);
    startTransition(async () => {
      const res = await draftReconnectMessageAction(contactId, t);
      if (res.ok) { setMessage(res.message); setOpen(true); }
      else { setError(res.error); setOpen(true); }
    });
  };

  const copy = async () => {
    if (!message) return;
    try { await navigator.clipboard.writeText(message); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="mt-3">
      {!open ? (
        <button
          onClick={() => draft(tone)}
          disabled={pending}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand/12 px-3 text-xs font-bold text-brand-text ring-1 ring-brand/25 transition hover:bg-brand/20 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {tr('contactTimeline.draftAMessageWithAi')}
        </button>
      ) : (
        <div className="rounded-xl border border-brand/25 bg-brand/[0.05] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-brand-text">
              <Sparkles className="h-3.5 w-3.5" /> {tr('contactTimeline.aiDraftFor')} {name}
            </div>
            <div className="flex items-center gap-1">
              {TONES.map((t) => (
                <button key={t.key}
                  onClick={() => { setTone(t.key); draft(t.key); }}
                  disabled={pending}
                  className={cn('h-7 rounded-full px-2.5 text-[11px] font-semibold transition disabled:opacity-60',
                    tone === t.key ? 'bg-brand/20 text-brand-text' : 'text-muted hover:bg-elevated')}
                >
                  {tr(t.labelKey)}
                </button>
              ))}
              <button onClick={() => setOpen(false)} aria-label={tr('contactTimeline.closeDraft')} className="rounded-lg p-1 text-muted hover:bg-elevated">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {error ? (
            <p className="mt-2 text-xs text-rose-300">{error}</p>
          ) : pending && !message ? (
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {tr('contactTimeline.writing')}</p>
          ) : message ? (
            <>
              <p className={cn('mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg', pending && 'opacity-50')}>{message}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <button onClick={copy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-xs font-bold text-brand-fg transition hover:opacity-90">
                  {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? tr('adminMarketingAssistant.copied') : tr('family.copy')}
                </button>
                <button onClick={() => draft(tone)} disabled={pending}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted transition hover:bg-elevated disabled:opacity-60">
                  <RefreshCw className={cn('h-3.5 w-3.5', pending && 'animate-spin')} /> {tr('contactTimeline.regenerate')}
                </button>
              </div>
              <p className="mt-2 text-[10px] text-muted">{tr('contactTimeline.aiDraftGroundedInYourLogged')}</p>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
