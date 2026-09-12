'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus, CheckSquare, StickyNote, CalendarPlus, ShoppingCart, X, CalendarClock, Sparkles, Settings2, Check } from 'lucide-react';
import { useApp } from './app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { parseEvent, parseDueDate, suggestKind, splitItems } from '@/lib/capture/parse';
import { CaptureSaveError, saveCapture, undoCapture } from '@/lib/capture/save';
import { isOpenCaptureKey, isSaveHotkey, isTypingTarget } from '@/lib/capture/shortcut';
import { CaptureShortcuts } from '@/components/capture/capture-shortcuts';
import { useJourney } from '@/lib/analytics/use-journey';
import { describeDbError } from '@/lib/supabase/errors';
import { useTranslations } from '@/components/i18n/locale-provider';

/** Human "when" label for the live event preview, e.g. "Tomorrow at 3:00 PM". */
function formatWhen(startsAt: Date, allDay: boolean): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(startsAt); day.setHours(0, 0, 0, 0);
  const diffDays = Math.round((day.getTime() - today.getTime()) / 86400000);
  const dayLabel = diffDays === 0 ? 'Today'
    : diffDays === 1 ? 'Tomorrow'
    : startsAt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  if (allDay) return dayLabel;
  const time = startsAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${dayLabel} at ${time}`;
}

type CaptureType = 'task' | 'note' | 'event' | 'shopping';

const TYPES: { key: CaptureType; label: string; icon: typeof Plus; placeholder: string }[] = [
  { key: 'task', label: 'Task', icon: CheckSquare, placeholder: 'e.g. Pack lunches' },
  { key: 'note', label: 'Note', icon: StickyNote, placeholder: 'Jot something down…' },
  { key: 'event', label: 'Event', icon: CalendarPlus, placeholder: 'e.g. Dentist at 3pm' },
  { key: 'shopping', label: 'Shopping', icon: ShoppingCart, placeholder: 'e.g. Milk' },
];

export function QuickCapture() {
  const tr = useTranslations();
  const { familyId, userId, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CaptureType>('task');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [opening, setOpening] = useState(0);
  const [reviewHref, setReviewHref] = useState<string | null>(null);
  const owner = JSON.stringify([familyId, userId, selfMember?.id ?? null]);
  const lifetime = useRef({ mounted: false, owner, open: false, opening: 0, pending: null as object | null, review: false });
  const journey = useJourney('capture');

  function reset() { setText(''); setType('task'); }

  useLayoutEffect(() => {
    const current = lifetime.current;
    current.mounted = true;
    current.owner = owner;
    current.open = false;
    current.pending = null;
    current.review = false;
    setOpen(false); setSaving(false); setReviewHref(null); setCustomizing(false);
    setText(''); setType('task');
    return () => { current.mounted = false; current.open = false; current.opening++; current.pending = null; };
  }, [owner]);

  const begin = useCallback(() => {
    const current = lifetime.current;
    if (!current.mounted || current.open) return;
    current.open = true;
    setOpening(++current.opening);
    setOpen(true);
  }, []);

  function isCurrentOpening() {
    const current = lifetime.current;
    return current.mounted && current.owner === owner && current.open && current.opening === opening;
  }

  function close() {
    if (!isCurrentOpening() || lifetime.current.pending) return;
    lifetime.current.open = false;
    lifetime.current.opening++;
    setOpen(false); setCustomizing(false);
  }

  function editDraft(change: () => void) {
    if (!isCurrentOpening() || lifetime.current.pending || lifetime.current.review) return;
    // Editing also retires callbacks that captured an earlier type or text.
    setOpening(++lifetime.current.opening);
    change();
  }

  // Global shortcut: press "c" anywhere (outside a text field) to open capture.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (open || !isOpenCaptureKey(e)) return;
      const el = document.activeElement as HTMLElement | null;
      if (isTypingTarget(el?.tagName, el?.isContentEditable)) return;
      e.preventDefault();
      begin();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, begin]);

  // Telemetry: a capture "journey" starts when the sheet opens (Experience
  // Scorecard). Completion is recorded on a successful save below.
  useEffect(() => {
    if (open) journey.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || !familyId || !userId || !isCurrentOpening() || lifetime.current.pending || lifetime.current.review) return;
    const attempt = {};
    lifetime.current.pending = attempt;
    const isCurrent = () => isCurrentOpening() && lifetime.current.pending === attempt;
    setSaving(true);
    try {
      const res = await saveCapture(createClient(), { kind: type, text: value, familyId, userId, memberId: selfMember?.id ?? null, isCurrent });
      if (!isCurrent()) return;
      let undoUsed = false;
      success(
        res.count > 1 ? `${res.count} items added` : `${TYPES.find((t) => t.key === type)!.label} saved`,
        { label: 'Undo', onClick: async () => {
          // This deliberately names the earlier capture, even after a family
          // switch. A consumed toast callback must never dispatch twice.
          if (undoUsed || !res.undo.ids.length) return;
          undoUsed = true;
          try {
            await undoCapture(createClient(), res.undo);
            success(tr('quickCapture.undone'));
          } catch {
            toastError(tr('quickCapture.couldNotUndo'));
          }
        } },
      );
      journey.complete();
      reset();
      lifetime.current.open = false;
      lifetime.current.opening++;
      setOpen(false);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof CaptureSaveError && err.outcome === 'retired') return;
      if (err instanceof CaptureSaveError && err.outcome === 'uncertain') {
        lifetime.current.review = true;
        setReviewHref(err.href);
      } else {
        toastError(describeDbError(err, tr('quickCapture.couldNotSave')));
      }
    } finally {
      const current = lifetime.current;
      if (current.mounted && current.owner === owner && current.pending === attempt) {
        current.pending = null;
        setSaving(false);
      }
    }
  }

  const active = TYPES.find((t) => t.key === type)!;
  // Live "when" preview for events — parses "tomorrow at 3pm" as you type.
  const eventPreview = useMemo(() => {
    if (type !== 'event' || !text.trim()) return null;
    return parseEvent(text);
  }, [type, text]);

  // Live due-date preview for tasks — "Pay rent friday" → Due Fri, Jul 3.
  const taskPreview = useMemo(() => {
    if (type !== 'task' || !text.trim()) return null;
    const { title, dueDate } = parseDueDate(text);
    if (!dueDate) return null;
    const [y, m, d] = dueDate.split('-').map(Number);
    return { title, when: formatWhen(new Date(y, m - 1, d), true) };
  }, [type, text]);

  // Live item-count preview for shopping — "milk, eggs and bread" → 3 items.
  const shoppingItems = useMemo(() => {
    if (type !== 'shopping' || !text.trim()) return null;
    const items = splitItems(text);
    return items.length > 1 ? items : null;
  }, [type, text]);

  // Non-disruptive type suggestion: offer a one-tap switch when the text looks
  // like a different kind than the one selected. The user taps to apply, so it
  // never hijacks focus or the cursor mid-typing.
  const suggested = useMemo(() => {
    const v = text.trim();
    if (v.length < 3) return null;
    const guess = suggestKind(v);
    return guess === type ? null : guess;
  }, [text, type]);

  return (
    <>
      <button
        onClick={begin}
        aria-label={tr('quickCapture.quickCapture')}
        title={tr('quickCapture.quickCapturePressC')}
        className="fixed bottom-[calc(5rem+var(--safe-bottom))] right-[calc(1rem+var(--safe-right))] z-40 grid h-14 w-14 place-items-center rounded-full bg-brand text-white shadow-glow transition hover:brightness-110 active:scale-95 lg:bottom-6 lg:right-6"
      >
        <Plus className="h-7 w-7" />
      </button>

      <Modal
        open={open}
        onClose={close}
        title={tr('quickCapture.quickCapture')}
        headerAction={
          <button
            type="button"
            disabled={saving || !!reviewHref}
            onClick={() => { if (isCurrentOpening() && !lifetime.current.pending && !lifetime.current.review) setCustomizing((v) => !v); }}
            aria-pressed={customizing}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-brand-text transition hover:bg-brand/10"
          >
            {customizing ? <><Check className="h-3.5 w-3.5" /> {tr('quickCapture.done')}</> : <><Settings2 className="h-3.5 w-3.5" /> {tr('quickCapture.customize')}</>}
          </button>
        }
      >
        <form
          onSubmit={save}
          onKeyDown={(e) => { if (isSaveHotkey(e)) { e.preventDefault(); e.currentTarget.requestSubmit(); } }}
          className="space-y-4"
        >
          <div className="grid grid-cols-4 gap-2">
            {TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                disabled={saving || !!reviewHref}
                onClick={() => editDraft(() => setType(t.key))}
                className={cn('flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-xs font-medium transition',
                  type === t.key ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:bg-elevated')}
              >
                <t.icon className="h-5 w-5" />
                {t.label}
              </button>
            ))}
          </div>

          {/* Member's own shortcuts — only their picks show. The "Customize"
              toggle is hoisted into the modal header (controlled here). */}
          <CaptureShortcuts
            columns={4}
            heading=""
            onNavigate={close}
            editing={customizing}
            onEditingChange={(value) => { if (isCurrentOpening() && !lifetime.current.pending && !lifetime.current.review) setCustomizing(value); }}
            showCustomizeButton={false}
          />

          {suggested && (
            <button
              type="button"
              disabled={saving || !!reviewHref}
              onClick={() => editDraft(() => setType(suggested))}
              className="flex w-full items-center gap-1.5 rounded-lg bg-brand/5 px-3 py-2 text-left text-xs text-brand-text transition hover:bg-brand/10"
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span>{tr('quickCapture.looksLikeA')} <span className="font-semibold">{TYPES.find((t) => t.key === suggested)!.label.toLowerCase()}</span> {tr('quickCapture.tapToSwitch')}</span>
            </button>
          )}

          <Field label={active.label}>
            {(id) => type === 'note'
              ? <Textarea id={id} value={text} onChange={(e) => editDraft(() => setText(e.target.value))} disabled={saving || !!reviewHref} rows={4} placeholder={active.placeholder} autoFocus />
              : <Input id={id} value={text} onChange={(e) => editDraft(() => setText(e.target.value))} disabled={saving || !!reviewHref} placeholder={active.placeholder} autoFocus />}
          </Field>

          {type === 'shopping' && shoppingItems && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-brand-text">
              <ShoppingCart className="h-3.5 w-3.5" />
              {tr('quickCapture.adds')} {shoppingItems.length} items:
              <span className="text-muted">{shoppingItems.join(', ')}</span>
            </p>
          )}

          {type === 'task' && taskPreview && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-brand-text">
              <CalendarClock className="h-3.5 w-3.5" />
              Due {taskPreview.when}
              {taskPreview.title && taskPreview.title !== text.trim() && (
                <span className="text-muted">· “{taskPreview.title}”</span>
              )}
            </p>
          )}

          {type === 'event' && (
            eventPreview?.matched ? (
              <p className="flex items-center gap-1.5 text-xs font-medium text-brand-text">
                <CalendarClock className="h-3.5 w-3.5" />
                {formatWhen(eventPreview.startsAt, eventPreview.allDay)}
                {eventPreview.title && eventPreview.title !== text.trim() && (
                  <span className="text-muted">· “{eventPreview.title}”</span>
                )}
              </p>
            ) : (
              <p className="text-xs text-muted">{tr('quickCapture.tipAddATimeLikeTomorrow')}</p>
            )
          )}

          {reviewHref && (
            <div role="alert" className="space-y-2 rounded-xl border border-border bg-elevated p-3 text-sm">
              <p>{tr('quickCapture.saveUncertain')}</p>
              <a className="font-medium text-brand-text underline" href={reviewHref}>{tr('quickCapture.reviewCapture')}</a>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={saving} onClick={close}><X className="h-4 w-4" /> {tr('quickCapture.cancel')}</Button>
            <Button type="submit" loading={saving} disabled={!!reviewHref}><Plus className="h-4 w-4" /> {tr('quickCapture.save')}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
