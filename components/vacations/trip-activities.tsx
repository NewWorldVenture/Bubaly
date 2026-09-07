'use client';

import { Ticket, CalendarCheck } from 'lucide-react';
import { TripCrudSection, type FieldDef } from './shared';
import { dollars } from '@/lib/vacations/meta';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Activity = Tables<'vacation_activities'>;
type Reservation = Tables<'vacation_reservations'>;

const fmtDT = (s: string | null) => (s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unscheduled');

const activityFields: FieldDef[] = [
  { name: 'name', label: 'Activity', type: 'text', required: true },
  { name: 'category', label: 'Category', type: 'text', half: true, placeholder: 'attraction / tour / show' },
  { name: 'location', label: 'Location', type: 'text', half: true },
  { name: 'scheduled_at', label: 'When', type: 'datetime', half: true },
  { name: 'duration_min', label: 'Duration (min)', type: 'number', half: true },
  { name: 'cost_cents', label: 'Cost ($)', type: 'money', half: true },
  { name: 'url', label: 'Link', type: 'text', half: true },
  { name: 'family_friendly', label: 'Family-friendly', type: 'checkbox' },
  { name: 'booked', label: 'tripActivities.booked', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

const reservationFields: FieldDef[] = [
  { name: 'name', label: 'Reservation', type: 'text', required: true },
  { name: 'kind', label: 'Type', type: 'text', half: true, placeholder: 'dining / spa / tour' },
  { name: 'location', label: 'Location', type: 'text', half: true },
  { name: 'reserved_at', label: 'When', type: 'datetime', half: true },
  { name: 'party_size', label: 'Party size', type: 'number', half: true },
  { name: 'confirmation_code', label: 'Confirmation', type: 'text', half: true },
  { name: 'cost_cents', label: 'Cost ($)', type: 'money', half: true },
  { name: 'booked', label: 'tripActivities.booked', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export function TripActivities({ vacationId }: { vacationId: string }) {
  const t = useTranslations();
  return (
    <div className="space-y-8">
      <TripCrudSection<Activity>
        table="vacation_activities" vacationId={vacationId} title={t('tripActivities.activities')} icon={Ticket}
        fields={activityFields} emptyText="No activities yet" addLabel="Add activity"
        orderBy={(a, b) => (a.scheduled_at ?? '~').localeCompare(b.scheduled_at ?? '~')}
        renderRow={(a) => (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{a.name}</p>
              {a.family_friendly && <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-300">{t('tripActivities.family')}</span>}
              {a.booked && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Booked</span>}
            </div>
            <p className="mt-0.5 text-sm text-muted">{[a.category, a.location].filter(Boolean).join(' · ') || 'Activity'}</p>
            <p className="mt-0.5 text-xs text-muted">{[fmtDT(a.scheduled_at), a.duration_min && `${a.duration_min} min`, a.cost_cents != null && dollars(a.cost_cents)].filter(Boolean).join(' · ')}</p>
          </div>
        )}
      />
      <TripCrudSection<Reservation>
        table="vacation_reservations" vacationId={vacationId} title={t('tripActivities.reservations')} icon={CalendarCheck}
        fields={reservationFields} emptyText="No reservations yet" addLabel="Add reservation"
        orderBy={(a, b) => (a.reserved_at ?? '~').localeCompare(b.reserved_at ?? '~')}
        renderRow={(r) => (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{r.name}</p>
              {r.booked && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Booked</span>}
            </div>
            <p className="mt-0.5 text-sm text-muted">{[r.kind, r.location].filter(Boolean).join(' · ') || 'Reservation'}</p>
            <p className="mt-0.5 text-xs text-muted">{[fmtDT(r.reserved_at), r.party_size && `Party of ${r.party_size}`, r.confirmation_code && `Conf ${r.confirmation_code}`, r.cost_cents != null && dollars(r.cost_cents)].filter(Boolean).join(' · ')}</p>
          </div>
        )}
      />
    </div>
  );
}
