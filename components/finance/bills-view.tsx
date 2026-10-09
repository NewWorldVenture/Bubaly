'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFamilyCalendarToday, useFamilyClock } from '@/components/i18n/use-format';
import { FileText, Plus, Trash2, Check, RotateCcw, Repeat, Bell } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { usd as usdIn, billDueStatus, billPaidPatch, billDateForAnchorDay, newBillDueDay, BILL_CADENCES, DUE_META, fmtDueDate as fmtDueDateIn } from '@/lib/finance/hub';
import { BILL_READ_CONTRACT, readCompleteBills, isMissingBillDueDay, saveBillPayment, saveBillPaymentBefore0488 } from '@/lib/finance/bills';
import { dueDayNotKeptQuestion, isDueDayNotKept, writeBillPatch, type DueDayNotKept } from '@/lib/finance/recurring';
import { useConfirm } from '@/components/ui/confirm';
import { BillPaymentModal } from '@/components/finance/bill-payment-modal';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';
import { todayInZone } from '@/lib/schedule/zoned';
import { isManager } from '@/lib/constants/roles';
import { BillScheduleModal } from '@/components/finance/bill-schedule-modal';

type Bill = Tables<'bills'>;
export type BillsMode = 'all' | 'autopay' | 'due';

const CATEGORIES = ['Housing', 'Utilities', 'Insurance', 'Subscriptions', 'Loans', 'Phone', 'Internet', 'Other'];

const MODE_META: Record<BillsMode, { title: string; desc: string; icon: typeof FileText }> = {
  all: { title: 'Bill Manager', desc: 'Track every bill, mark them paid, and never miss a due date.', icon: FileText },
  autopay: { title: 'Auto Pay', desc: 'Bills set to pay automatically each cycle.', icon: Repeat },
  due: { title: 'Due Reminders', desc: 'Upcoming and overdue bills that need your attention.', icon: Bell },
};

export function BillsView({ mode }: { mode: BillsMode }) {
  // Date-only helpers read local calendar fields: give them the FAMILY's day (TIME-003).
  const familyToday = useFamilyCalendarToday();
  const clock = useFamilyClock();
  const t = useTranslations();
  // Money and dates follow the reader; the currency stays the money's own.
  const locale = useLocale();
  const usd = (amount: number) => usdIn(amount, locale.code);
  const fmtDueDate = (iso: string) => fmtDueDateIn(iso, locale.code);
  const { familyId, userId, role } = useApp();
  const { success, error: toastError } = useToast();
  const askConfirm = useConfirm();
  const meta = MODE_META[mode];

  const { data: rows, loading, error: readError, stale, refresh } = useRealtimeQuery<Bill>({
    table: 'bills', familyId, deps: [familyId, userId, BILL_READ_CONTRACT],
    fetcher: (sb) => readCompleteBills(sb, familyId),
  });

  const paymentOwner = useMemo(() => ({ familyId, userId, role }), [familyId, userId, role]);
  const [form, setForm] = useState<{ owner: typeof paymentOwner; ticket: number } | null>(null);
  const formTicket = useRef(0);
  const currentForm = useRef(form);
  currentForm.current = form?.owner === paymentOwner ? form : null;
  const [paymentSelection, setPaymentSelection] = useState<{ bill: Bill; owner: typeof paymentOwner; ticket: number } | null>(null);
  const paymentTicket = useRef(0);
  const currentPayment = useRef(paymentSelection);
  currentPayment.current = paymentSelection?.owner === paymentOwner ? paymentSelection : null;
  const paymentBill = paymentSelection?.owner === paymentOwner ? paymentSelection.bill : null;
  const scheduleOwner = paymentOwner;
  const [scheduleSelection, setScheduleSelection] = useState<{ bill: Bill; owner: typeof scheduleOwner; ticket: number } | null>(null);
  const scheduleTicket = useRef(0);
  const currentBillOwner = useRef(scheduleOwner);
  currentBillOwner.current = scheduleOwner;
  const currentSchedule = useRef(scheduleSelection);
  currentSchedule.current = scheduleSelection?.owner === scheduleOwner ? scheduleSelection : null;
  const scheduleBill = scheduleSelection?.owner === scheduleOwner ? scheduleSelection.bill : null;
  const canManage = isManager(role);
  const canWrite = () => canManage && currentBillOwner.current === scheduleOwner;
  function openForm() {
    if (!canWrite()) return;
    const selection = { owner: paymentOwner, ticket: ++formTicket.current };
    currentForm.current = selection; setForm(selection);
  }
  function openSchedule(bill: Bill) {
    if (!canWrite() || bill.family_id !== familyId) return;
    const selection = { bill, owner: scheduleOwner, ticket: ++scheduleTicket.current };
    currentSchedule.current = selection;
    setScheduleSelection(selection);
  }
  const bills = useMemo(() => loading || stale || readError ? [] : rows ?? [], [rows, loading, stale, readError]);

  const visible = useMemo(() => {
    if (mode === 'autopay') return bills.filter((b) => b.autopay);
    if (mode === 'due') return bills.filter((b) => b.status !== 'paid');
    return bills;
  }, [bills, mode]);

  const totalDue = useMemo(() => visible.filter((b) => b.status !== 'paid').reduce((s, b) => s + Number(b.amount), 0), [visible]);

  async function markPaid(b: Bill) {
    if (!canWrite() || b.family_id !== familyId) return;
    const reopen = b.status === 'paid';
    // Without bills.due_day (0488) a clamped roll moves only if the person says yes.
    const confirmClampedDay = (refusal: DueDayNotKept) => askConfirm(dueDayNotKeptQuestion(refusal, t, fmtDueDate, locale.code));
    let before0488: Awaited<ReturnType<typeof saveBillPaymentBefore0488>> = null;
    if (!reopen && !billPaidPatch(b, clock.todayKey())) {
      // A row read without due_day is paid as before 0488 once the database
      // confirms the column is missing; otherwise the person confirms its schedule.
      before0488 = b.due_day === undefined ? await saveBillPaymentBefore0488(createClient(), familyId, b, clock.todayKey(), canWrite, { confirmClampedDay }) : null;
      if (!before0488) {
        if (!canWrite()) return;
        const selection = { bill: b, owner: paymentOwner, ticket: ++paymentTicket.current };
        currentPayment.current = selection; setPaymentSelection(selection); return;
      }
    }
    // A restrictive RLS policy FILTERS an update/delete rather than raising, so
    // a refused write returns zero rows and no error. `.select('id')` is what
    // makes the difference visible — without it `data` is null either way.
    const { data: rows, error } = before0488 ?? await saveBillPayment(createClient(), familyId, b, clock.todayKey(), undefined, reopen, canWrite, { confirmClampedDay });
    if (!canWrite()) return;
    if (isDueDayNotKept(error)) { toastError(t('bills.dueDayNeedsDatabaseUpdate', { day: error.day })); return; }
    if (error) { toastError(isMissingBillDueDay(error) ? t('bills.scheduleUnavailable') : describeDbError(error)); return; }
    if (wroteNoRows(rows)) { toastError(t('errors.thatChangeWasNotSaved')); void refresh(); return; }
    success(reopen ? 'Reopened' : 'Marked paid');
    void refresh();
  }
  async function toggleAutopay(b: Bill) {
    if (!canWrite() || b.family_id !== familyId) return;
    const { data: rows, error } = await createClient().from('bills').update({ autopay: !b.autopay }).eq('id', b.id).eq('family_id', familyId).select('id');
    if (!canWrite()) return;
    if (error) { toastError(describeDbError(error)); return; }
    if (wroteNoRows(rows)) { toastError(t('errors.thatChangeWasNotSaved')); return; }
    success(b.autopay ? 'Auto Pay off' : 'Auto Pay on');
  }
  async function remove(id: string) {
    if (!canWrite()) return;
    if (!confirm(t('billsView.deleteThisBill'))) return;
    if (!canWrite()) return;
    const { data: rows, error } = await createClient().from('bills').delete().eq('id', id).eq('family_id', familyId).select('id');
    if (!canWrite()) return;
    if (error) { toastError(describeDbError(error)); return; }
    if (wroteNoRows(rows)) { toastError(t('errors.thatChangeWasNotSaved')); return; }
    success(t('billsView.deleted'));
  }

  const Row = ({ b }: { b: Bill }) => {
  const t = useTranslations();
    const ds = billDueStatus(b, familyToday);
    const dm = DUE_META[ds];
    return (
      <div className="group flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-3">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', dm.tint)}><FileText className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{b.name}</p>
          <p className="truncate text-xs text-muted">
            Due {fmtDueDate(b.due_date)}{b.category ? ` · ${b.category}` : ''}{b.is_recurring ? ' · recurring' : ''}
            {b.autopay && <span className="ml-1 inline-flex items-center gap-0.5 text-brand-text"><Repeat className="h-3 w-3" /> {t('bills.autoPay')}</span>}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold tabular-nums">{usd(Number(b.amount))}</p>
          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', dm.tint)}>{dm.label}</span>
        </div>
        {canManage && <div className="flex shrink-0 items-center gap-1">
          {isManager(role) && b.is_recurring && <Button size="sm" variant="outline" onClick={() => openSchedule(b)}>{t('bills.editSchedule')}</Button>}
          {mode !== 'due' && (
            <button onClick={() => toggleAutopay(b)} title={t('bills.toggleAutoPay')}
              className={cn('rounded-lg p-1.5 transition', b.autopay ? 'text-brand-text' : 'text-muted/50 hover:text-fg')}><Repeat className="h-4 w-4" /></button>
          )}
          <button onClick={() => markPaid(b)} title={b.status === 'paid' ? 'Reopen' : 'Mark paid'}
            className="rounded-lg p-1.5 text-muted/50 transition hover:text-emerald-400">{b.status === 'paid' ? <RotateCcw className="h-4 w-4" /> : <Check className="h-4 w-4" />}</button>
          <button onClick={() => remove(b.id)} className="rounded-lg p-1.5 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label={t('bills.delete')}><Trash2 className="h-4 w-4" /></button>
        </div>}
      </div>
    );
  };

  // For Due Reminders, group by urgency.
  const grouped = useMemo(() => {
    if (mode !== 'due') return null;
    const g: Record<string, Bill[]> = { overdue: [], due_soon: [], upcoming: [] };
    for (const b of visible) { const s = billDueStatus(b, familyToday); if (s !== 'paid') g[s].push(b); }
    return g;
  }, [visible, mode, familyToday]);

  return (
    <div className="module-page">
      <PageHeader title={meta.title} description={meta.desc}
        action={canManage ? <Button onClick={openForm}><Plus className="h-4 w-4" /> {t('bills.addBill')}</Button> : undefined} />

      {!loading && !stale && !readError && mode !== 'autopay' && visible.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <p className="text-xs text-muted">{mode === 'due' ? 'Outstanding' : 'Total unpaid'}</p>
          <p className="text-2xl font-black tabular-nums">{usd(totalDue)}</p>
        </div>
      )}

      {/* A failed read is not an empty bill list. Telling a family "no bills"
          when the query never came back is the one answer this page must not
          give: they stop looking, and the payment they were owed a reminder
          about is the one they miss. The error is checked before `loading`
          because `stale` already covers a refetch in flight — so a failure
          stays on screen instead of flickering back to a skeleton. */}
      {readError ? (
        <ErrorState message={t('billsView.couldNotLoadBills')} onRetry={() => { void refresh(); }} />
      ) : loading || stale ? <SkeletonList /> : visible.length === 0 ? (
        <EmptyState icon={meta.icon} title={mode === 'autopay' ? 'No Auto Pay bills' : mode === 'due' ? 'Nothing due' : 'No bills yet'}
          description={mode === 'autopay' ? 'Turn on Auto Pay for a bill to see it here.' : 'Add a bill to start tracking due dates.'}
          action={canManage ? <Button onClick={openForm}><Plus className="h-4 w-4" /> {t('bills.addBill')}</Button> : undefined} />
      ) : grouped ? (
        <div className="space-y-5">
          {(['overdue', 'due_soon', 'upcoming'] as const).map((k) => grouped[k].length > 0 && (
            <section key={k}>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">{DUE_META[k].label}</h2>
              <div className="space-y-2">{grouped[k].map((b) => <Row key={b.id} b={b} />)}</div>
            </section>
          ))}
        </div>
      ) : (
        <div className="space-y-2">{visible.map((b) => <Row key={b.id} b={b} />)}</div>
      )}

      {canManage && form?.owner === paymentOwner && <BillModal key={`${familyId}:${userId}:${form.ticket}`} familyId={familyId} userId={userId} defaultAutopay={mode === 'autopay'} isCurrent={() => canWrite() && currentForm.current === form} onClose={() => { if (currentForm.current === form) { currentForm.current = null; setForm(null); } }} />}
      {canManage && paymentBill && bills.some(b => b.id === paymentBill.id && b.family_id === familyId) && <BillPaymentModal key={`${familyId}:${userId}:${paymentBill.id}:${paymentSelection!.ticket}`} bill={paymentBill} familyId={familyId} isCurrent={() => canWrite() && currentPayment.current === paymentSelection} onClose={() => { if (currentPayment.current === paymentSelection) { currentPayment.current = null; setPaymentSelection(null); } }} onDone={() => { if (canWrite() && currentPayment.current === paymentSelection) void refresh(); }} />}
      {scheduleBill && isManager(role) && bills.some(b => b.id === scheduleBill.id && b.family_id === familyId) && <BillScheduleModal key={`${familyId}:${userId}:${scheduleBill.id}:${scheduleSelection!.ticket}`} bill={scheduleBill} isCurrent={() => currentSchedule.current === scheduleSelection && currentBillOwner.current === scheduleSelection!.owner} onClose={() => {
        if (currentSchedule.current !== scheduleSelection) return;
        currentSchedule.current = null; setScheduleSelection(null);
      }} onDone={() => { if (currentSchedule.current === scheduleSelection) void refresh(); }} />}
    </div>
  );
}

function BillModal({ familyId, userId, defaultAutopay, onClose, isCurrent }: { familyId: string; userId: string; defaultAutopay: boolean; onClose: () => void; isCurrent: () => boolean }) {
  const t = useTranslations();
  const { family } = useApp();
  const { success, error: toastError } = useToast();
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [saving, setSaving] = useState(false);
  const [v, setV] = useState(() => {
    const dueDate = todayInZone(family?.timezone ?? 'UTC');
    return { name: '', amount: '', due_date: dueDate, due_day: String(newBillDueDay(dueDate, true, 'monthly') ?? ''), category: 'Utilities', is_recurring: true, recurrence: 'monthly', autopay: defaultAutopay };
  });
  const needsDay = v.is_recurring && ['monthly', 'quarterly', 'yearly'].includes(v.recurrence);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!alive.current || !isCurrent() || inFlight.current) return;
    if (!v.name.trim() || !v.amount) return toastError(t('billsView.addANameAndAmount'));
    inFlight.current = true; setSaving(true);
    try {
      const dueDay = needsDay ? Number(v.due_day) : null;
      const { error } = await writeBillPatch({
        family_id: familyId, name: v.name.trim(), amount: Math.abs(parseFloat(v.amount) || 0),
        due_date: v.due_date, category: v.category, is_recurring: v.is_recurring, autopay: v.autopay,
        recurrence: v.is_recurring ? v.recurrence : null, ...(dueDay !== null ? { due_day: dueDay } : {}),
        status: 'upcoming' as const, created_by: userId,
      }, p => alive.current && isCurrent() ? createClient().from('bills').insert(p) : Promise.resolve({ data: null, error: new Error('Bill view changed') }));
      if (!alive.current || !isCurrent()) return;
      if (error) return toastError(isMissingBillDueDay(error) ? t('bills.scheduleUnavailable') : describeDbError(error));
      success(t('billsView.billAdded'));
      onClose();
    } catch {
      if (alive.current && isCurrent()) toastError(t('errors.thatChangeWasNotSaved'));
    } finally {
      inFlight.current = false;
      if (alive.current && isCurrent()) setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('bills.addBill')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('bills.billName')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('billsView.electricBill')} required autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('bills.amount')}>{(id) => <Input id={id} type="number" inputMode="decimal" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} placeholder="120.00" required />}</Field>
          <Field label={t('bills.dueDate')}>{(id) => <Input id={id} type="date" value={v.due_date} onChange={(e) => setV({ ...v, due_date: e.target.value, due_day: String(newBillDueDay(e.target.value, true, 'monthly') ?? '') })} required />}</Field>
        </div>
        {v.is_recurring && <Field label={t('billing.recurrence')}>{(id) => (
          <Select id={id} value={v.recurrence} onChange={(e) => setV({ ...v, recurrence: e.target.value })}>
            {BILL_CADENCES.map((c) => <option key={c} value={c}>{t(`billing.${c}`)}</option>)}
          </Select>
        )}</Field>}
        {needsDay && <Field label={t('bills.dayOfMonth')} required>{(id) => (
          <Select id={id} value={v.due_day} onChange={(e) => setV({ ...v, due_day: e.target.value, due_date: billDateForAnchorDay(v.due_date, Number(e.target.value)) ?? v.due_date })} required>
            <option value="" disabled>{t('bills.chooseDay')}</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => <option key={day} value={day}>{day}</option>)}
          </Select>
        )}</Field>}
        <Field label={t('bills.category')}>{(id) => <Select id={id} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.is_recurring} onChange={(e) => setV({ ...v, is_recurring: e.target.checked })} /> {t('bills.recurring')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.autopay} onChange={(e) => setV({ ...v, autopay: e.target.checked })} /> {t('bills.autoPay')}</label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('bills.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!v.name.trim() || !v.amount}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}
