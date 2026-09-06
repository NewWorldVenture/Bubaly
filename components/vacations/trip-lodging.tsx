'use client';

import { BedDouble } from 'lucide-react';
import { fmtDate } from '@/lib/utils/format';
import { TripCrudSection, type FieldDef } from './shared';
import { LODGING_KINDS, dollars, lookup } from '@/lib/vacations/meta';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Lodging = Tables<'vacation_lodging'>;

const fields: FieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'kind', label: 'Type', type: 'select', options: LODGING_KINDS.map((k) => ({ value: k.value, label: k.label })), half: true },
  { name: 'phone', label: 'Phone', type: 'text', half: true },
  { name: 'address', label: 'Address', type: 'text' },
  { name: 'check_in', label: 'Check-in', type: 'date', half: true },
  { name: 'check_out', label: 'Check-out', type: 'date', half: true },
  { name: 'nightly_cents', label: 'Nightly ($)', type: 'money', half: true },
  { name: 'total_cents', label: 'Total ($)', type: 'money', half: true },
  { name: 'confirmation_code', label: 'Confirmation', type: 'text', half: true },
  { name: 'url', label: 'Link', type: 'text', half: true },
  { name: 'booked', label: 'Booked & confirmed', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export function TripLodging({ vacationId }: { vacationId: string }) {
  const t = useTranslations();
  return (
    <TripCrudSection<Lodging>
      table="vacation_lodging" vacationId={vacationId} title={t('tripLodging.lodging')} icon={BedDouble}
      fields={fields} emptyText="No lodging yet" addLabel="Add lodging"
      orderBy={(a, b) => (a.check_in ?? '').localeCompare(b.check_in ?? '')}
      renderRow={(l) => {
        const k = lookup(LODGING_KINDS, l.kind);
        return (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{k.emoji} {l.name}</p>
              {l.booked ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Booked</span>
                : <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">Not booked</span>}
            </div>
            {l.address && <p className="mt-0.5 text-sm text-muted">{l.address}</p>}
            <p className="mt-0.5 text-xs text-muted">
              {[l.check_in && `${fmtDate(l.check_in)}${l.check_out ? ` – ${fmtDate(l.check_out)}` : ''}`, l.nightly_cents != null && `${dollars(l.nightly_cents)}/night`, l.total_cents != null && `Total ${dollars(l.total_cents)}`, l.confirmation_code && `Conf ${l.confirmation_code}`].filter(Boolean).join(' · ')}
            </p>
          </div>
        );
      }}
    />
  );
}
