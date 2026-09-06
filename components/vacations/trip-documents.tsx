'use client';

import { FolderLock, AlertTriangle } from 'lucide-react';
import { fmtDate } from '@/lib/utils/format';
import { TripCrudSection, type FieldDef } from './shared';
import { DOC_KINDS, lookup } from '@/lib/vacations/meta';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Doc = Tables<'vacation_documents'>;

const fields: FieldDef[] = [
  { name: 'title', label: 'Title', type: 'text', required: true },
  { name: 'kind', label: 'Type', type: 'select', options: DOC_KINDS.map((k) => ({ value: k.value, label: k.label })), half: true },
  { name: 'member_id', label: 'Belongs to', type: 'member', half: true },
  { name: 'number', label: 'Number', type: 'text', half: true, placeholder: 'passport / visa #' },
  { name: 'file_url', label: 'File link', type: 'text', half: true },
  { name: 'issued_on', label: 'Issued', type: 'date', half: true },
  { name: 'expires_on', label: 'Expires', type: 'date', half: true },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

function expiryWarning(expires: string | null): boolean {
  if (!expires) return false;
  const d = new Date(expires + 'T00:00:00').getTime();
  const sixMonths = Date.now() + 1000 * 60 * 60 * 24 * 183;
  return d < sixMonths;
}

export function TripDocuments({ vacationId }: { vacationId: string }) {
  const t = useTranslations();
  return (
    <TripCrudSection<Doc>
      table="vacation_documents" vacationId={vacationId} title={t('tripDocuments.travelDocuments')} icon={FolderLock}
      fields={fields} emptyText="No documents yet" addLabel="Add document"
      orderBy={(a, b) => a.title.localeCompare(b.title)}
      renderRow={(d, members) => {
        const k = lookup(DOC_KINDS, d.kind);
        const who = d.member_id ? members.get(d.member_id) : null;
        const warn = expiryWarning(d.expires_on);
        return (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{k.emoji} {d.title}</p>
              {warn && <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300"><AlertTriangle className="h-3 w-3" /> Expiring</span>}
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {[k.label, who?.display_name, d.number && `#${d.number}`, d.expires_on && `Expires ${fmtDate(d.expires_on)}`].filter(Boolean).join(' · ')}
            </p>
            {d.file_url && <a href={d.file_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-brand-text hover:underline">Open file ↗</a>}
          </div>
        );
      }}
    />
  );
}
