'use client';

import { useState } from 'react';
import { useFamilyClock } from '@/components/i18n/use-format';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import type { Tables } from '@/lib/database.types';
import { billAnchorDay, billCadence, BILL_CADENCES, MONTH_BASED_CADENCES, type BillCadence } from '@/lib/finance/hub';
import { isMissingBillDueDay, saveBillPayment } from '@/lib/finance/bills';
import { createClient } from '@/lib/supabase/client';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';

/** Only rendered for an unknown schedule; an ambiguous legacy day is blank. */
export function BillPaymentModal({ bill, familyId, onClose, onDone }: {
  bill: Tables<'bills'>; familyId: string; onClose: () => void; onDone: () => void;
}) {
  const t = useTranslations();
  const clock = useFamilyClock();
  const { success, error: toastError } = useToast();
  const [cadence, setCadence] = useState<BillCadence | ''>(() => billCadence(bill) ?? '');
  const [day, setDay] = useState(() => String(billAnchorDay(bill) ?? ''));
  const [saving, setSaving] = useState(false);
  const needsDay = cadence !== '' && MONTH_BASED_CADENCES.has(cadence);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!cadence || (needsDay && !day) || saving) return;
    setSaving(true);
    try {
      const { data, error } = await saveBillPayment(createClient(), familyId, bill, clock.todayKey(), { cadence, ...(needsDay ? { dueDay: Number(day) } : {}) });
      if (error) { toastError(isMissingBillDueDay(error) ? t('bills.scheduleUnavailable') : describeDbError(error)); return; }
      if (wroteNoRows(data)) { toastError(t('errors.thatChangeWasNotSaved')); onDone(); onClose(); return; }
      success(t('billingModule.billMarkedAsPaid'));
      onDone(); onClose();
    } catch { toastError(t('errors.thatChangeWasNotSaved')); }
    finally { setSaving(false); }
  }

  return (
    <Modal open onClose={onClose} title={t('bills.confirmPaymentSchedule')}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">{bill.name} — {t('bills.scheduleNeeded')}</p>
        <Field label={t('billing.recurrence')} required>{(id) => (
          <Select id={id} value={cadence} onChange={(e) => setCadence(e.target.value as BillCadence)} required>
            <option value="" disabled>{t('bills.chooseRecurrence')}</option>
            {BILL_CADENCES.map((c) => <option key={c} value={c}>{t(`billing.${c}`)}</option>)}
          </Select>
        )}</Field>
        {needsDay && <Field label={t('bills.dayOfMonth')} required>{(id) => (
          <Select id={id} value={day} onChange={(e) => setDay(e.target.value)} required>
            <option value="" disabled>{t('bills.chooseDay')}</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        )}</Field>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('bills.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!cadence || (needsDay && !day)}>{t('billing.markPaid')}</Button>
        </div>
      </form>
    </Modal>
  );
}
