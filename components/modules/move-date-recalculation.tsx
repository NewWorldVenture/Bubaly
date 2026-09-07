'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import {
  isMoveDate, isMoveDateResult, moveDateContextKey, sameMoveDatePreview,
  type MoveDatePreview, type MoveDateResult, type MoveDateReviewContext, type MoveDateTask,
} from '@/lib/moving/recalculation';

const reasons: Record<MoveDateTask['reason'], string> = {
  relative: 'Follows the move date', completed: 'Completed task: kept',
  skipped: 'Skipped task: kept', fixed: 'Fixed date: kept',
  no_date: 'No recorded deadline: kept', out_of_sync: 'Date differs from its recorded offset: kept',
};

export function MoveDateRecalculation({ context, move, onClose, onSaved }: {
  context: MoveDateReviewContext;
  move: { id: string; move_date: string; updated_at: string; status: string };
  onClose: () => void;
  onSaved: (result: MoveDateResult) => void;
}) {
  const t = useTranslations();
  const key = JSON.stringify([moveDateContextKey(context), move.id, move.move_date, move.updated_at, move.status]);
  const [date, setDate] = useState(move.move_date);
  const [reviewed, setReviewed] = useState<{ preview: MoveDatePreview; requestId: string } | null>(null);
  const [pending, setPending] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const liveKey = useRef(key);
  liveKey.current = key;
  const allowed = context.active && !!context.memberId && (context.role === 'parent' || context.role === 'adult')
    && move.status !== 'done' && move.status !== 'cancelled';

  useEffect(() => {
    mounted.current = true;
    busy.current = false;
    setDate(move.move_date);
    setReviewed(null);
    setPending(null);
    setError(null);
    return () => {
      mounted.current = false;
      generation.current += 1;
      controller.current?.abort();
    };
  }, [key, move.move_date]);

  function changeDate(value: string) {
    generation.current += 1;
    controller.current?.abort();
    busy.current = false;
    setPending(null);
    setReviewed(null);
    setError(null);
    setDate(value);
  }

  async function request(apply: boolean) {
    if (!mounted.current || liveKey.current !== key || busy.current || !allowed
      || !isMoveDate(date) || date === move.move_date || (apply && (!reviewed || reviewed.preview.toDate !== date))) return;
    const confirmed = apply ? reviewed : null;
    busy.current = true;
    setPending(apply ? 'apply' : 'preview');
    setError(null);
    if (!apply) setReviewed(null);
    const current = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const stillCurrent = () => mounted.current && liveKey.current === key && generation.current === current && !abort.signal.aborted;
    try {
      const response = await fetch('/api/moving/recalculate', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          familyId: context.familyId, memberId: context.memberId, moveId: move.id, date,
          ...(confirmed ? { expected: confirmed.preview, requestId: confirmed.requestId } : {}),
        }),
      });
      const body: unknown = await response.json();
      if (!stillCurrent()) return;
      if (!response.ok) {
        if ([403, 404, 409].includes(response.status)) setReviewed(null);
        setError(response.status === 409
          ? 'The move or its tasks changed. Review the current deadlines again before saving.'
          : response.status === 403
            ? 'Your current membership cannot change this move. No new review is available.'
            : response.status === 404
              ? 'This move is no longer available in the current household.'
              : apply
                ? 'The save could not be confirmed. Retry this reviewed change with the same request identifier, or refresh to see the current dates.'
                : 'Date recalculation is unavailable. No dates were changed; the database capability may not be deployed yet.');
        return;
      }
      if (!isMoveDateResult(body) || body.preview.familyId !== context.familyId || body.preview.memberId !== context.memberId
        || body.preview.moveId !== move.id || body.preview.fromDate !== move.move_date || body.preview.toDate !== date
        || body.applied !== apply || (confirmed && (body.requestId !== confirmed.requestId || !sameMoveDatePreview(body.preview, confirmed.preview)))) {
        setError(apply
          ? 'The save response could not be confirmed. Retry this same reviewed change or refresh; do not assume it failed.'
          : 'The review did not match this move. Refresh before trying again.');
        return;
      }
      if (apply) {
        setReviewed(null);
        onSaved(body);
      } else {
        setReviewed({ preview: body.preview, requestId: crypto.randomUUID() });
      }
    } catch {
      if (stillCurrent()) setError(apply
        ? 'The save response was lost. Retry this reviewed change with the same request identifier, or refresh to check the dates.'
        : 'The date review could not be loaded. No dates were changed.');
    } finally {
      if (stillCurrent()) {
        busy.current = false;
        setPending(null);
      }
    }
  }

  return (
    <Modal open title={t('moveDateRecalculation.reviewMoveDateChange')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">Recorded move date: {move.move_date}. Review every deadline before changing it.</p>
        <label className="block space-y-1 text-sm">
          <span>{t('moveDateRecalculation.newMoveDate')}</span>
          <Input aria-label={t('moveDateRecalculation.newMoveDate')} type="date" min="0001-01-01" max="9999-12-31" value={date}
            disabled={!allowed || pending !== null} onChange={(event) => changeDate(event.target.value)} />
        </label>
        <p className="text-xs text-muted">{t('moveDateRecalculation.onlyUnfinishedTasksExplicitlySet')}</p>
        {!allowed && <p role="alert" className="text-sm text-muted">{t('moveDateRecalculation.anActiveParentOrAdult')}</p>}
        {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
        <Button type="button" variant="secondary" onClick={() => request(false)} loading={pending === 'preview'}
          disabled={!allowed || pending !== null || !isMoveDate(date) || date === move.move_date}>{t('moveDateRecalculation.reviewDateChange')}</Button>
        {reviewed && (
          <section aria-label={t('moveDateRecalculation.reviewedDeadlineChanges')} className="space-y-3 rounded-xl border border-border p-3">
            <p className="text-sm font-semibold">{reviewed.preview.fromDate} to {reviewed.preview.toDate}</p>
            <p className="text-sm text-muted">{reviewed.preview.changes} deadlines shift; {reviewed.preview.tasks.length - reviewed.preview.changes} stay unchanged.</p>
            {reviewed.preview.tasks.length === 0 && <p className="text-sm text-muted">{t('moveDateRecalculation.noRecordedTasksOnlyThe')}</p>}
            <ul className="max-h-72 space-y-2 overflow-y-auto">
              {reviewed.preview.tasks.map((task) => (
                <li key={task.id} className="rounded-lg bg-surface/50 p-2 text-sm">
                  <p className="font-medium">{task.title}</p>
                  <p>{task.dueDate ?? 'No date'}{task.action === 'shift' ? ' to ' + task.nextDueDate : ' (unchanged)'}</p>
                  <p className="text-xs text-muted">{reasons[task.reason]}</p>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">{t('moveDateRecalculation.savingRecordsThisExactReview')}</p>
          </section>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('moveDateRecalculation.cancel')}</Button>
          <Button type="button" onClick={() => request(true)} loading={pending === 'apply'}
            disabled={!allowed || pending !== null || !reviewed || reviewed.preview.toDate !== date}>{t('moveDateRecalculation.applyReviewedDateChange')}</Button>
        </div>
      </div>
    </Modal>
  );
}
