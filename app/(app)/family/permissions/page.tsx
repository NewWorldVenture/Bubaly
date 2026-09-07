import type { Metadata } from 'next';
import { ShieldCheck, Check, X } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ROLE_LABELS, ROLE_ORDER, ROLE_DESCRIPTIONS, type MemberRole } from '@/lib/constants/roles';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty } from '@/components/family/shell';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Permissions' };
export const dynamic = 'force-dynamic';

export default async function FamilyPermissionsPage() {
  const t = await getTranslations();
  await requireUserContext();
  const supabase = await createServer();
  const { data: perms } = await supabase
    .from('permissions')
    .select('role, resource, can_create, can_read, can_update, can_delete')
    .order('resource');

  const byResource = new Map<string, Map<string, { c: boolean; r: boolean; u: boolean; d: boolean }>>();
  for (const p of perms ?? []) {
    const row = byResource.get(p.resource) ?? new Map();
    row.set(p.role, { c: p.can_create, r: p.can_read, u: p.can_update, d: p.can_delete });
    byResource.set(p.resource, row);
  }
  const resources = [...byResource.keys()].sort();

  const Cell = ({ on }: { on: boolean }) =>
    on ? <Check className="mx-auto h-4 w-4 text-emerald-400" /> : <X className="mx-auto h-4 w-4 text-muted/30" />;

  return (
    <div className="space-y-5">
      <PageHeader title={t('familyPermissions.rolesPermissions')} description={t('permissions.theAccessModelBehindYour')} />

      <SectionCard title={t('familyPermissions.roleOverview')}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ROLE_ORDER.map((role) => (
            <li key={role} className="rounded-xl border border-border bg-surface/40 p-3">
              <p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-brand-text" /> {ROLE_LABELS[role]}</p>
              <p className="mt-1 text-xs text-muted">{ROLE_DESCRIPTIONS[role]}</p>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title={t('familyPermissions.permissionMatrix')} description={t('permissions.createReadUpdateDeletePer')}>
        {resources.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-2 pr-4 font-medium">{t('familyPermissions.resource')}</th>
                  {ROLE_ORDER.map((role) => <th key={role} className="px-2 py-2 text-center font-medium">{ROLE_LABELS[role].split(' ')[0]}</th>)}
                </tr>
              </thead>
              <tbody>
                {resources.map((res) => (
                  <tr key={res} className="border-t border-border">
                    <td className="py-2 pr-4 font-medium capitalize">{res.replace(/_/g, ' ')}</td>
                    {ROLE_ORDER.map((role) => {
                      const p = byResource.get(res)?.get(role);
                      return (
                        <td key={role} className="px-2 py-2 text-center">
                          {p ? (
                            <span className="inline-flex gap-0.5" title={`C${+p.c} R${+p.r} U${+p.u} D${+p.d}`}>
                              <Cell on={p.c} /><Cell on={p.r} /><Cell on={p.u} /><Cell on={p.d} />
                            </span>
                          ) : <X className="mx-auto h-4 w-4 text-muted/20" />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <MiniEmpty icon={ShieldCheck} text={t('permissions.permissionRulesLoadFromThe')} />
        )}
      </SectionCard>
    </div>
  );
}
