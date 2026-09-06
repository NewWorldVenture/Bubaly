import type { Metadata } from 'next';
import Link from 'next/link';
import { Users, UserPlus, Building2, Star } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import {
  contactDisplayName, LEAD_STATUSES, LIFECYCLE_STAGES, LIFECYCLE_LABELS,
} from '@/lib/marketing/crm';
import type { Tables } from '@/lib/database.types';
import { saveContactAction, deleteContactAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'CRM · Contacts', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Contact = Tables<'crm_contacts'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

export default async function CrmPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data: contacts, error: contactsError } = await supabase
    .from('crm_contacts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);
  if (contactsError) {
    console.error('[admin-marketing-crm] contact read failed', contactsError);
    return <AdminCrmReadError />;
  }

  const list = (contacts ?? []) as Contact[];
  const customers = list.filter((c) => c.lifecycle_stage === 'customer').length;
  const companies = new Set(list.map((c) => c.company).filter(Boolean)).size;
  const mqls = list.filter((c) => c.lifecycle_stage === 'mql' || c.lifecycle_stage === 'sql').length;

  const stats = [
    { label: 'Contacts', value: list.length, icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Customers', value: customers, icon: Star, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Qualified (M/SQL)', value: mqls, icon: UserPlus, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Companies', value: companies, icon: Building2, tint: 'text-blue-400 bg-blue-500/15' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        {t('adminMarketingCrm.yourSingleSourceOfTruthFor')}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      {/* Add contact */}
      <Card>
        <h2 className="mb-3 text-base font-semibold">{t('adminMarketingCrm.addAContact')}</h2>
        <form action={saveContactAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input name="first_name" placeholder={t('adminMarketingCrm.firstName')} className={inputCls} />
          <input name="last_name" placeholder={t('adminMarketingCrm.lastName')} className={inputCls} />
          <input name="email" type="email" placeholder={t('adminMarketingCrm.email')} className={inputCls} />
          <input name="phone" type="tel" placeholder={t('adminMarketingCrm.phone')} className={inputCls} />
          <input name="company" placeholder={t('adminMarketingCrm.company')} className={inputCls} />
          <input name="lead_source" placeholder={t('adminMarketingCrm.leadSourceEGGoogle')} className={inputCls} />
          <select name="lead_status" defaultValue="new" className={inputCls}>
            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select name="lifecycle_stage" defaultValue="lead" className={inputCls}>
            {LIFECYCLE_STAGES.map((s) => <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>)}
          </select>
          <button type="submit" className={btnCls}>{t('adminMarketingCrm.addContact')}</button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-semibold">{t('adminMarketingCrm.contacts')}</h2>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t('adminMarketingCrm.noContactsYetAddOneAbove')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2">{t('adminMarketingCrm.name')}</th><th className="pb-2">{t('adminMarketingCrm.company')}</th>
                  <th className="pb-2">{t('adminMarketingCrm.lifecycle')}</th><th className="pb-2">{t('adminMarketingCrm.status')}</th>
                  <th className="pb-2">{t('adminMarketingCrm.source')}</th><th className="pb-2">{t('adminMarketingCrm.added')}</th><th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className="border-t border-border align-top">
                    <td className="py-2">
                      <p className="font-medium">{contactDisplayName(c)}</p>
                      {c.email && <p className="text-xs text-muted">{c.email}</p>}
                    </td>
                    <td className="py-2">{c.company ?? '—'}</td>
                    <td className="py-2">
                      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300">
                        {LIFECYCLE_LABELS[c.lifecycle_stage as keyof typeof LIFECYCLE_LABELS] ?? c.lifecycle_stage}
                      </span>
                    </td>
                    <td className="py-2 capitalize">{c.lead_status}</td>
                    <td className="py-2 text-xs text-muted">{c.lead_source ?? '—'}</td>
                    <td className="py-2 text-xs text-muted">{fmtDate(c.created_at)}</td>
                    <td className="py-2 text-right">
                      <form action={deleteContactAction.bind(null, c.id)}>
                        <button type="submit" className="text-xs text-muted hover:text-rose-400">Delete</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function AdminCrmReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">CRM Contacts</h1>
        <p className="mt-1 text-sm text-muted">Manage leads, prospects, and customer contacts.</p>
      </div>
      <ErrorState message="Could not load CRM contacts from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/crm" className="text-sm font-medium text-brand-text underline">Refresh CRM</Link>
    </div>
  );
}
