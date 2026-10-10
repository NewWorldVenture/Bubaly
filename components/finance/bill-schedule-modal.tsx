'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { confirmBillScheduleAction } from '@/app/(app)/dashboard/billing/actions';
import { reportRefusal } from '@/lib/auth/step-up-client';
import { billAnchorDay, billCadence, billSchedulePatch, nextBillDueDate, BILL_CADENCES, MONTH_BASED_CADENCES, type BillCadence } from '@/lib/finance/bill-schedule';
import type { Tables } from '@/lib/database.types';

export function BillScheduleModal({ bill, isCurrent, onClose, onDone }: {
  bill: Tables<'bills'>; isCurrent: () => boolean; onClose: () => void; onDone: () => void;
}) {
  const t = useTranslations();
  const toast = useToast();
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [cadence, setCadence] = useState<BillCadence | ''>(() => billCadence(bill) ?? '');
  const [day, setDay] = useState(() => String(billAnchorDay(bill) ?? ''));
  const [saving, setSaving] = useState(false);
  const needsDay = cadence !== '' && MONTH_BASED_CADENCES.has(cadence);
  const choice = cadence ? { cadence, ...(needsDay ? { dueDay: Number(day) } : {}) } : null;
  const patch = choice ? billSchedulePatch(bill, choice) : null;
  const next = patch ? nextBillDueDate(bill.due_date, patch.recurrence, bill.due_date, patch.due_day) : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!choice || !patch || inFlight.current || !alive.current || !isCurrent()) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const result = await confirmBillScheduleAction({
        id: bill.id, family_id: bill.family_id, updated_at: bill.updated_at, due_date: bill.due_date,
        status: bill.status, is_recurring: bill.is_recurring, recurrence: bill.recurrence,
        ...(bill.due_day !== undefined ? { due_day: bill.due_day } : {}),
      }, choice);
      if (!alive.current || !isCurrent()) return;
      if (!result.ok) { reportRefusal(result, toast.error); return; }
      toast.success(t('bills.scheduleSaved'));
      onDone(); onClose();
    } catch {
      if (alive.current && isCurrent()) toast.error(t('bills.scheduleNotSaved'));
    } finally {
      inFlight.current = false;
      if (alive.current && isCurrent()) setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('bills.editSchedule')}>
      <form onSubmit={submit} className="space-y-4">
        <p className="font-semibold">{bill.name}</p>
        <p className="text-sm text-muted">{t('bills.scheduleKeepsDue', { date: bill.due_date })}</p>
        <p className="text-sm text-muted">{t('bills.scheduleDoesNotPay')}</p>
        <Field label={t('billing.recurrence')} required>{id => (
          <Select id={id} value={cadence} disabled={saving} required onChange={event => setCadence(event.target.value as BillCadence)}>
            <option value="" disabled>{t('bills.chooseRecurrence')}</option>
            {BILL_CADENCES.map(value => <option key={value} value={value}>{t(`billing.${value}`)}</option>)}
          </Select>
        )}</Field>
        {needsDay && <Field label={t('bills.dayOfMonth')} required>{id => (
          <Select id={id} value={day} disabled={saving} required onChange={event => setDay(event.target.value)}>
            <option value="" disabled>{t('bills.chooseDay')}</option>
            {Array.from({ length: 31 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}
          </Select>
        )}</Field>}
        {next && <p className="text-sm" role="status">{t('bills.scheduleNextCycle', { date: next })}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('bills.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!patch}>{t('bills.saveSchedule')}</Button>
        </div>
      </form>
    </Modal>
  );
}
