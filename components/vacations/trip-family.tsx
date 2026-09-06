'use client';

import { Users } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { TripCrudSection, type FieldDef } from './shared';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type VMember = Tables<'vacation_members'>;

const fields: FieldDef[] = [
  { name: 'member_id', label: 'Family member', type: 'member', half: true },
  { name: 'guest_name', label: 'or Guest name', type: 'text', half: true },
  { name: 'role', label: 'Role', type: 'select', half: true, options: [
    { value: 'adult', label: 'Adult' }, { value: 'child', label: 'Child' },
    { value: 'grandparent', label: 'Grandparent' }, { value: 'caregiver', label: 'Caregiver' },
  ] },
  { name: 'dietary_restrictions', label: 'Dietary restrictions', type: 'text', half: true },
  { name: 'accessibility_needs', label: 'Accessibility needs', type: 'text' },
  { name: 'medical_notes', label: 'Medical notes', type: 'textarea' },
  { name: 'preferences', label: 'Preferences', type: 'textarea' },
  { name: 'emergency_contact', label: 'Emergency contact', type: 'text' },
];

export function TripFamily({ vacationId }: { vacationId: string }) {
  const t = useTranslations();
  return (
    <TripCrudSection<VMember>
      table="vacation_members" vacationId={vacationId} title={t('tripFamily.whosGoing')} icon={Users}
      fields={fields} emptyText="No travelers added" addLabel="Add traveler"
      renderRow={(m, members) => {
        const fm = m.member_id ? members.get(m.member_id) : null;
        const name = fm?.display_name || m.guest_name || 'Traveler';
        return (
          <div className="flex items-start gap-3">
            <Avatar name={name} color={fm?.color ?? null} size={36} />
            <div className="min-w-0">
              <p className="font-semibold">{name}{m.role ? <span className="ml-1 text-xs font-normal text-muted">· {m.role}</span> : null}</p>
              <p className="mt-0.5 text-xs text-muted">
                {[m.dietary_restrictions && `🍽️ ${m.dietary_restrictions}`, m.accessibility_needs && `♿ ${m.accessibility_needs}`].filter(Boolean).join(' · ')}
              </p>
              {(m.medical_notes || m.preferences) && <p className="mt-1 text-sm text-muted">{[m.medical_notes, m.preferences].filter(Boolean).join(' · ')}</p>}
            </div>
          </div>
        );
      }}
    />
  );
}
