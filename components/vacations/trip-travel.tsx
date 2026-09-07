'use client';

import { Plane, Car } from 'lucide-react';
import { fmtDate } from '@/lib/utils/format';
import { TripCrudSection, type FieldDef } from './shared';
import { TRANSPORT_KINDS, dollars, lookup } from '@/lib/vacations/meta';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Flight = Tables<'vacation_flights'>;
type Transport = Tables<'vacation_transportation'>;

const fmtDT = (s: string | null) => (s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

const flightFields: FieldDef[] = [
  { name: 'airline', label: 'Airline', type: 'text', half: true },
  { name: 'flight_number', label: 'Flight #', type: 'text', half: true },
  { name: 'depart_airport', label: 'From (airport)', type: 'text', half: true },
  { name: 'arrive_airport', label: 'To (airport)', type: 'text', half: true },
  { name: 'depart_at', label: 'Departs', type: 'datetime', half: true },
  { name: 'arrive_at', label: 'Arrives', type: 'datetime', half: true },
  { name: 'terminal', label: 'Terminal', type: 'text', half: true },
  { name: 'gate', label: 'Gate', type: 'text', half: true },
  { name: 'seats', label: 'Seats', type: 'text', half: true },
  { name: 'confirmation_code', label: 'Confirmation', type: 'text', half: true },
  { name: 'cost_cents', label: 'Cost ($)', type: 'money', half: true },
  { name: 'booked', label: 'Booked & confirmed', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

const transportFields: FieldDef[] = [
  { name: 'kind', label: 'Type', type: 'select', options: TRANSPORT_KINDS.map((k) => ({ value: k.value, label: k.label })), required: true, half: true },
  { name: 'provider', label: 'Provider', type: 'text', half: true },
  { name: 'from_location', label: 'From', type: 'text', half: true },
  { name: 'to_location', label: 'To', type: 'text', half: true },
  { name: 'depart_at', label: 'Departs', type: 'datetime', half: true },
  { name: 'arrive_at', label: 'Arrives', type: 'datetime', half: true },
  { name: 'distance_miles', label: 'Distance (mi)', type: 'number', half: true },
  { name: 'fuel_estimate_cents', label: 'Fuel est. ($)', type: 'money', half: true },
  { name: 'confirmation_code', label: 'Confirmation', type: 'text', half: true },
  { name: 'cost_cents', label: 'Cost ($)', type: 'money', half: true },
  { name: 'booked', label: 'Booked & confirmed', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export function TripTravel({ vacationId }: { vacationId: string }) {
  const tr = useTranslations();
  return (
    <div className="space-y-8">
      <TripCrudSection<Flight>
        table="vacation_flights" vacationId={vacationId} title={tr('tripTravel.flights')} icon={Plane}
        fields={flightFields} emptyText="No flights yet" addLabel="Add flight"
        orderBy={(a, b) => (a.depart_at ?? '').localeCompare(b.depart_at ?? '')}
        renderRow={(f) => (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{f.airline || 'Flight'} {f.flight_number}</p>
              {f.booked ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Booked</span>
                : <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">Not booked</span>}
            </div>
            <p className="mt-0.5 text-sm text-muted">{f.depart_airport || '?'} → {f.arrive_airport || '?'} · {fmtDT(f.depart_at)}{f.arrive_at ? ` – ${fmtDT(f.arrive_at)}` : ''}</p>
            <p className="mt-0.5 text-xs text-muted">
              {[f.terminal && `Terminal ${f.terminal}`, f.gate && `Gate ${f.gate}`, f.seats && `Seat ${f.seats}`, f.confirmation_code && `Conf ${f.confirmation_code}`, f.cost_cents != null && dollars(f.cost_cents)].filter(Boolean).join(' · ')}
            </p>
          </div>
        )}
      />
      <TripCrudSection<Transport>
        table="vacation_transportation" vacationId={vacationId} title={tr('tripTravel.groundTransportation')} icon={Car}
        fields={transportFields} emptyText="No transportation yet" addLabel="Add transport"
        orderBy={(a, b) => (a.depart_at ?? '').localeCompare(b.depart_at ?? '')}
        renderRow={(t) => {
          const k = lookup(TRANSPORT_KINDS, t.kind);
          return (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{k.emoji} {t.provider || k.label}</p>
                {t.booked && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">Booked</span>}
              </div>
              <p className="mt-0.5 text-sm text-muted">{[t.from_location, t.to_location].filter(Boolean).join(' → ') || k.label} · {fmtDT(t.depart_at)}</p>
              <p className="mt-0.5 text-xs text-muted">
                {[t.distance_miles != null && `${t.distance_miles} mi`, t.fuel_estimate_cents != null && `Fuel ${dollars(t.fuel_estimate_cents)}`, t.confirmation_code && `Conf ${t.confirmation_code}`, t.cost_cents != null && dollars(t.cost_cents)].filter(Boolean).join(' · ')}
              </p>
            </div>
          );
        }}
      />
    </div>
  );
}
