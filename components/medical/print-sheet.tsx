'use client';

import { Printer, X } from 'lucide-react';
import type { Tables, RecordKind } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Provider = Tables<'health_providers'>;
type Policy = Tables<'insurance_policies'>;
type Profile = Tables<'medical_profiles'>;
type Member = Tables<'family_members'>;
type Medication = Tables<'medications'>;

const KIND_LABEL: Record<RecordKind, string> = { medical: 'Medical', dental: 'Dental' };

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function ageFrom(birthday: string | null): string {
  if (!birthday) return '';
  const b = new Date(birthday);
  if (Number.isNaN(b.getTime())) return '';
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return `${age}`;
}

/** A labelled row that prints cleanly (label left, value right). */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <span className="w-44 shrink-0 font-semibold text-gray-600">{label}</span>
      <span className="min-w-0 flex-1 text-gray-900">{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1.5 mt-5 border-b-2 border-gray-800 pb-1 text-base font-bold uppercase tracking-wide text-gray-900">
      {children}
    </h2>
  );
}

/** The shell: a fixed white overlay with a print toolbar (hidden when printing). */
function SheetShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations();
  return (
    <div className="print-sheet fixed inset-0 z-[120] overflow-y-auto bg-white">
      {/* Toolbar — excluded from print */}
      <div className="print-hide sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-gray-200" aria-label={t('printSheet.close')}>
            <X className="h-4 w-4" />
          </button>
          {t('printSheet.printPreview')}
        </div>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
        >
          <Printer className="h-4 w-4" /> {t('printSheet.printSaveAsPdf')}
        </button>
      </div>

      {/* The page itself */}
      <div className="print-page mx-auto max-w-[8.5in] px-8 py-8 text-gray-900">
        <header className="mb-4 flex items-start justify-between border-b-4 border-gray-900 pb-3">
          <div>
            <h1 className="text-2xl font-black">{title}</h1>
            {subtitle && <p className="text-sm text-gray-600">{subtitle}</p>}
          </div>
          <div className="text-right text-xs text-gray-500">
            <p className="font-bold text-gray-700">{t('printSheet.bubaly')}</p>
            <p>{t('printSheet.generated')} {formatDate(new Date().toISOString())}</p>
          </div>
        </header>
        {children}
        <footer className="mt-8 border-t border-gray-300 pt-3 text-center text-[10px] text-gray-400">
          {t('printSheet.confidentialHealthInformationGeneratedByBubaly')}
        </footer>
      </div>
    </div>
  );
}

/** Provider Info File — every doctor/dentist's contact details. */
export function ProviderInfoSheet({
  kind,
  member,
  providers,
  onClose,
}: {
  kind: RecordKind;
  member: Member | null;
  providers: Provider[];
  onClose: () => void;
}) {
  const t = useTranslations();
  const scopeLabel = member ? member.display_name : 'Whole Family';
  return (
    <SheetShell
      title={`${KIND_LABEL[kind]} Providers`}
      subtitle={`${scopeLabel} · ${providers.length} provider${providers.length === 1 ? '' : 's'}`}
      onClose={onClose}
    >
      {providers.length === 0 ? (
        <p className="py-8 text-center text-gray-500">{t('printSheet.noProvidersOnFile')}</p>
      ) : (
        <div className="space-y-5">
          {providers.map((p) => (
            <div key={p.id} className="rounded-lg border border-gray-300 p-4">
              <div className="flex items-baseline justify-between">
                <h3 className="text-lg font-bold">{p.name}</h3>
                {p.is_primary && (
                  <span className="rounded-full border border-gray-400 px-2 py-0.5 text-[10px] font-bold uppercase text-gray-600">
                    Primary
                  </span>
                )}
              </div>
              {p.specialty && <p className="text-sm font-medium text-gray-600">{p.specialty}</p>}
              <div className="mt-2">
                <Row label="Practice" value={p.practice_name} />
                <Row label="Phone" value={p.phone} />
                <Row label="Fax" value={p.fax} />
                <Row label="Email" value={p.email} />
                <Row label="Address" value={p.address} />
                <Row label="Notes" value={p.notes} />
              </div>
            </div>
          ))}
        </div>
      )}
    </SheetShell>
  );
}

/** Check-In Sheet — everything needed to fill out an intake form. */
export function CheckInSheet({
  kind,
  member,
  profile,
  policy,
  providers,
  medications,
  onClose,
}: {
  kind: RecordKind;
  member: Member;
  profile: Profile | null;
  policy: Policy | null;
  providers: Provider[];
  medications: Medication[];
  onClose: () => void;
}) {
  const t = useTranslations();
  const age = ageFrom(member.birthday);
  const primary = providers.find((p) => p.is_primary) ?? providers[0] ?? null;
  const medList = medications.length
    ? medications.map((m) => [m.name, m.dosage].filter(Boolean).join(' ')).join(', ')
    : profile?.current_medications || 'None reported';

  return (
    <SheetShell
      title={`${KIND_LABEL[kind]} Check-In`}
      subtitle={`${member.display_name}${age ? ` · Age ${age}` : ''}`}
      onClose={onClose}
    >
      <SectionTitle>{t('printSheet.patient')}</SectionTitle>
      <Row label={t('printSheet.name')} value={member.display_name} />
      <Row label={t('printSheet.dateOfBirth')} value={member.birthday ? formatDate(member.birthday) : undefined} />
      <Row label="Age" value={age || undefined} />
      <Row label={t('printSheet.bloodType')} value={profile?.blood_type} />

      <SectionTitle>{t('printSheet.insurance')}</SectionTitle>
      {policy ? (
        <>
          <Row label={t('printSheet.insurer')} value={policy.insurer} />
          <Row label={t('printSheet.plan')} value={[policy.plan_name, policy.plan_type].filter(Boolean).join(' · ') || undefined} />
          <Row label={t('printSheet.memberPolicy')} value={policy.policy_number} />
          <Row label={t('printSheet.group')} value={policy.group_number} />
          <Row label={t('printSheet.rxBin')} value={policy.rx_bin} />
          <Row label={t('printSheet.rxPcn')} value={policy.rx_pcn} />
          <Row label={t('printSheet.rxGroup')} value={policy.rx_group} />
          <Row label={t('printSheet.memberServices')} value={policy.customer_service_phone} />
        </>
      ) : (
        <p className="py-1.5 text-sm text-gray-500">No {KIND_LABEL[kind].toLowerCase()} {t('printSheet.insuranceOnFile')}</p>
      )}

      <SectionTitle>{t('printSheet.primaryProvider')}</SectionTitle>
      {primary ? (
        <>
          <Row label={t('printSheet.name')} value={primary.name} />
          <Row label={t('printSheet.specialty')} value={primary.specialty} />
          <Row label={t('printSheet.practice')} value={primary.practice_name} />
          <Row label={t('printSheet.phone')} value={primary.phone} />
        </>
      ) : (
        <Row label={t('printSheet.primaryPhysician')} value={profile?.primary_physician ?? 'Not on file'} />
      )}

      <SectionTitle>{t('printSheet.medicalHistory')}</SectionTitle>
      <Row label={t('printSheet.allergies')} value={profile?.allergies || 'None reported'} />
      <Row label={t('printSheet.conditions')} value={profile?.conditions || 'None reported'} />
      <Row label={t('printSheet.currentMedications')} value={medList} />
      <Row label={t('printSheet.immunizations')} value={profile?.immunizations} />
      {kind === 'dental' && <Row label={t('printSheet.dentalNotes')} value={profile?.dental_notes} />}

      <SectionTitle>{t('printSheet.pharmacyEmergencyContact')}</SectionTitle>
      <Row label={t('printSheet.preferredPharmacy')} value={profile?.preferred_pharmacy} />
      <Row label={t('printSheet.pharmacyPhone')} value={profile?.pharmacy_phone} />
      <Row
        label={t('printSheet.emergencyContact')}
        value={
          profile?.emergency_contact_name
            ? [
                profile.emergency_contact_name,
                profile.emergency_contact_relation ? `(${profile.emergency_contact_relation})` : '',
                profile.emergency_contact_phone || '',
              ]
                .filter(Boolean)
                .join(' ')
            : undefined
        }
      />
      {profile?.notes && (
        <>
          <SectionTitle>{t('printSheet.additionalNotes')}</SectionTitle>
          <p className="whitespace-pre-wrap py-1.5 text-sm text-gray-900">{profile.notes}</p>
        </>
      )}
    </SheetShell>
  );
}
