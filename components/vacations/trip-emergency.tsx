'use client';

import { useMemo } from 'react';
import { ShieldAlert, HeartPulse, Printer, Phone } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { TripCrudSection, type FieldDef } from './shared';
import type { Tables } from '@/lib/database.types';

type Contact = Tables<'vacation_emergency_contacts'>;
type Medical = Tables<'vacation_medical_information'>;

const contactFields: FieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'category', label: 'Type', type: 'select', half: true, options: [
    { value: 'doctor', label: 'Doctor' }, { value: 'insurance', label: 'Insurance' },
    { value: 'embassy', label: 'Embassy' }, { value: 'local_emergency', label: 'Local emergency' },
    { value: 'family', label: 'Family' }, { value: 'other', label: 'Other' },
  ] },
  { name: 'relationship', label: 'Relationship', type: 'text', half: true },
  { name: 'phone', label: 'Phone', type: 'text', half: true },
  { name: 'email', label: 'Email', type: 'text', half: true },
  { name: 'address', label: 'Address', type: 'text' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

const medicalFields: FieldDef[] = [
  { name: 'member_id', label: 'Family member', type: 'member', half: true },
  { name: 'blood_type', label: 'Blood type', type: 'text', half: true },
  { name: 'allergies', label: 'Allergies', type: 'textarea' },
  { name: 'conditions', label: 'Conditions', type: 'textarea' },
  { name: 'medications', label: 'Medications', type: 'textarea' },
  { name: 'insurance_provider', label: 'Insurance provider', type: 'text', half: true },
  { name: 'insurance_number', label: 'Insurance #', type: 'text', half: true },
  { name: 'physician', label: 'Physician', type: 'text', half: true },
  { name: 'physician_phone', label: 'Physician phone', type: 'text', half: true },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

function EmergencySummary({ vacationId }: { vacationId: string }) {
  const { familyId, members } = useApp();
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const { data: contacts, loading: contactsLoading, error: contactsError, refresh: refreshContacts } = useRealtimeQuery<Contact>({
    table: 'vacation_emergency_contacts', familyId, deps: [familyId, vacationId],
    fetcher: (sb) => sb.from('vacation_emergency_contacts').select('*').eq('family_id', familyId).eq('vacation_id', vacationId),
  });
  const { data: medical, loading: medicalLoading, error: medicalError, refresh: refreshMedical } = useRealtimeQuery<Medical>({
    table: 'vacation_medical_information', familyId, deps: [familyId, vacationId],
    fetcher: (sb) => sb.from('vacation_medical_information').select('*').eq('family_id', familyId).eq('vacation_id', vacationId),
  });

  if (contactsLoading || medicalLoading) return <LoadingBlock />;
  if (contactsError || medicalError) {
    return <ErrorState message="Could not load the emergency summary. Refresh and try again." onRetry={() => { void Promise.all([refreshContacts(), refreshMedical()]); }} />;
  }
  if (contacts.length === 0 && medical.length === 0) return null;

  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5 print:border-black">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-rose-200"><ShieldAlert className="h-5 w-5" /> Emergency summary</h2>
        <Button size="sm" variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
      </div>
      {contacts.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Contacts</p>
          <ul className="mt-1 space-y-1 text-sm">
            {contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium">{c.name}</span>
                {c.category && <span className="text-xs text-muted">({c.category})</span>}
                {c.phone && <a href={`tel:${c.phone}`} className="flex items-center gap-1 text-brand-text"><Phone className="h-3 w-3" /> {c.phone}</a>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {medical.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Medical</p>
          <ul className="mt-1 space-y-1 text-sm">
            {medical.map((m) => {
              const who = m.member_id ? memberMap.get(m.member_id)?.display_name : 'Traveler';
              return (
                <li key={m.id}>
                  <span className="font-medium">{who}</span>
                  {m.blood_type ? ` Â· ${m.blood_type}` : ''}
                  {m.allergies ? ` Â· Allergies: ${m.allergies}` : ''}
                  {m.medications ? ` Â· Meds: ${m.medications}` : ''}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function TripEmergency({ vacationId }: { vacationId: string }) {
  return (
    <div className="space-y-8">
      <EmergencySummary vacationId={vacationId} />
      <TripCrudSection<Contact>
        table="vacation_emergency_contacts" vacationId={vacationId} title="Emergency contacts" icon={ShieldAlert}
        fields={contactFields} emptyText="No emergency contacts" addLabel="Add contact"
        renderRow={(c) => (
          <div>
            <p className="font-semibold">{c.name}{c.category ? <span className="ml-1 text-xs font-normal text-muted">Â· {c.category}</span> : null}</p>
            <p className="mt-0.5 text-xs text-muted">{[c.relationship, c.phone, c.email, c.address].filter(Boolean).join(' Â· ')}</p>
          </div>
        )}
      />
      <TripCrudSection<Medical>
        table="vacation_medical_information" vacationId={vacationId} title="Medical information" icon={HeartPulse}
        fields={medicalFields} emptyText="No medical info" addLabel="Add medical info"
        renderRow={(m, members) => {
          const who = m.member_id ? members.get(m.member_id)?.display_name : 'Traveler';
          return (
            <div>
              <p className="font-semibold">{who}{m.blood_type ? <span className="ml-1 text-xs font-normal text-muted">Â· {m.blood_type}</span> : null}</p>
              <p className="mt-0.5 text-xs text-muted">{[m.allergies && `Allergies: ${m.allergies}`, m.conditions && `Conditions: ${m.conditions}`, m.medications && `Meds: ${m.medications}`, m.insurance_provider].filter(Boolean).join(' Â· ')}</p>
            </div>
          );
        }}
      />
    </div>
  );
}

